import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { AddressInfo } from 'node:net';
import { CoreLink, ownInstallations, startInstances } from '../src/core-link.js';

// Resource with a real Core host (in memory, from Core's built folder): the set-up script publishes the contracts, the
// service and its installation; starting records instances that check in and stop. Needs Core built (npm run build).
const coreDirectory = resolve(process.env.SEMA_CORE_DIRECTORY ?? join(process.cwd(), '..', '..', 'SEMA-Core'));
const Core = await import(pathToFileURL(join(coreDirectory, 'dist', 'index.js')).href);
const granted = new Set(['core.capabilities.read', 'core.capabilities.register', 'core.services.install', 'core.services.run']);
const allow = async ({ actorId, resource }: { actorId: string | null; resource: string }) => actorId === 'sema.foundation.resource' && granted.has(resource);
const store = new Core.InMemorySemaCoreHostStore();
const core = new Core.SemaCore(store, { installationId: '3', maxReservationSize: 25 });
const registry = new Core.CapabilityRegistry(new Core.InMemoryCapabilityStore(), async (typeCode: string, metadata: object) => (await core.issueIdentifier(typeCode, metadata)).id, async () => '3');
const host = new Core.SemaCoreHost(core, store, { canRead: allow, canAdminister: allow }, undefined, undefined, undefined, { machine: await new Core.MemoryKeyStore().open(), clients: new Core.InMemoryClientKeyStore(), nonces: new Core.NonceMemory() }, registry);
await host.initialize({ actorId: null });
const server = await Core.startCoreHostHttpServer(host, { port: 0, applicationClients: [{ applicationKey: 'sema.foundation.resource', secret: 'test-secret' }] });
const dir = await mkdtemp(join(tmpdir(), 'sema-resource-core-'));
const env = { ...process.env, SEMA_CORE_URL: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, SEMA_RESOURCE_CORE_APPLICATION_SECRET: 'test-secret', SEMA_RESOURCE_KEY_FILE: join(dir, 'resource-key'), SEMA_CORE_DIRECTORY: coreDirectory };
const bootstrap = () => new Promise<{ code: number | null; output: string }>((done) => {
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/bootstrap-core.ts'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = ''; child.stdout.on('data', (chunk) => { output += chunk; }); child.stderr.on('data', (chunk) => { output += chunk; });
  child.on('close', (code) => done({ code, output }));
});
const records = async () => (await host.capabilityRecordList({ actorId: 'sema.foundation.resource' }));

try {
  // The contracts are sema. names: without the approval permission, nothing is published.
  const refused = await bootstrap();
  assert.notEqual(refused.code, 0);
  assert.match(refused.output, /reserved sema. namespace/);
  assert.equal((await records()).capabilities.length, 0);

  granted.add('core.capabilities.approve');
  const first = await bootstrap();
  assert.equal(first.code, 0, first.output);
  granted.delete('core.capabilities.approve');
  let list = await records();
  assert.deepEqual(list.capabilities.filter((item: { legacy: boolean }) => !item.legacy).map((item: { capabilityKey: string; version: string; approved: boolean }) => [item.capabilityKey, item.version, item.approved]).sort(), [['sema.foundation.resource.catalog', '1.1.0', true], ['sema.foundation.resource.delivery', '1.0.1', true]]);
  const services = list.services.filter((item: { legacy: boolean }) => !item.legacy);
  assert.deepEqual(services.map((item: { serviceKey: string; operations: string[] }) => [item.serviceKey, item.operations.join()]).sort(), [['sema.foundation.resource-facility', 'list'], ['sema.foundation.resource-facility', 'read']]);
  assert.equal(ownInstallations(list).length, 2, 'installed once for each capability version');
  assert.equal(list.capabilities.filter((item: { legacy: boolean }) => item.legacy).length, 2, 'the old records are still written for programs that read them');

  // Running it again, without the approval, changes nothing.
  const issued = (await store.getHostStatistics()).identifiers.issued;
  const again = await bootstrap();
  assert.equal(again.code, 0, again.output);
  assert.deepEqual((await records()).services.length, list.services.length);
  assert.equal((await records()).installations.length, list.installations.length);
  assert.ok((await store.getHostStatistics()).identifiers.issued - issued <= 2, 'only the audit entries of the old route use IDs');

  // Starting: one instance per installation, checking in on the timer, stopped at the end.
  const link = (await CoreLink.open(env))!;
  const lines: string[] = [];
  const stop = await startInstances(link, 100, (line) => lines.push(line));
  list = await records();
  assert.equal(list.instances.length, 2);
  assert.ok(list.instances.every((item: { state: string; capacity: number; resources: { memoryFreeMb?: number } }) => item.state === 'RUNNING' && item.capacity === 4 && typeof item.resources.memoryFreeMb === 'number'));
  const startedAt = list.instances[0].lastCheckInAt;
  await new Promise((wait) => setTimeout(wait, 400));
  assert.ok((await records()).instances[0].lastCheckInAt > startedAt, 'it checks in');
  await stop();
  assert.ok((await records()).instances.every((item: { state: string }) => item.state === 'STOPPED'));
  assert.deepEqual(lines.filter((line) => /failed/.test(line)), []);

  // Without the permission to run, starting says why, and Resource carries on (start.ts catches it).
  granted.delete('core.services.run');
  await assert.rejects(() => startInstances(link, 0, () => {}), /core.services.run administration is not authorized/);
  console.log('Resource and Core test passed.');
} finally {
  await new Promise<void>((done) => { server.close(() => done()); server.closeAllConnections(); });
  await rm(dir, { recursive: true, force: true });
}
