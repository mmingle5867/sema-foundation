import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { createResourceServer } from './server.js';
import { ResourceStore } from './store.js';
import { CoreLink, startInstances } from './core-link.js';
const port = Number(process.env.PORT ?? 4330); const host = process.env.HOST ?? '127.0.0.1';
const policyUrl = process.env.SEMA_FOUNDATION_ACCESS_URL; const policyKey = process.env.SEMA_POLICY_KEY;
if (!policyUrl || !policyKey) throw new Error('SEMA_FOUNDATION_ACCESS_URL and SEMA_POLICY_KEY are required for resource policy enforcement.');
const version = (JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }).version;
const server = await createResourceServer(new ResourceStore(process.env.SEMA_RESOURCE_STORE ?? './data'), process.env.SEMA_RESOURCE_ADMIN_KEY ?? 'replace-this-before-use', { url: policyUrl, key: policyKey });
await new Promise<void>((resolve) => server.listen(port, host, resolve));
console.log(`SEMA Foundation Resource v${version} listening at http://${host}:${port}`);
// Resource's running copy is recorded with Core and checks in on a timer (SEMA_RESOURCE_CHECK_IN_SECONDS, default 60;
// 0 turns check-ins off). Until Core accepts it, it tries again at each tick. Needs the grants core.capabilities.read and
// core.services.run. Without Core, Resource still serves.
let stopInstances = async () => {};
try {
  const link = await CoreLink.open();
  if (!link) console.warn('SEMA_RESOURCE_CORE_APPLICATION_SECRET is not set, so Resource does not record itself with Core.');
  else {
    const seconds = Number(process.env.SEMA_RESOURCE_CHECK_IN_SECONDS ?? 60);
    const running = startInstances(link, Number.isFinite(seconds) ? seconds * 1000 : 60_000, (line) => console.log(line));
    stopInstances = () => running.stop();
  }
} catch (error) { console.warn(`Resource could not open its link to Core: ${error instanceof Error ? error.message : String(error)}. It carries on serving files.`); }
// Stopping: on Ctrl+C, or when the Console's stop script writes a file named .sema-stop into this folder (a background
// process on Windows cannot be sent Ctrl+C). Either way the running copies are recorded as stopped before Resource ends.
let stopping = false;
const shutdown = (why: string) => {
  if (stopping) return;
  stopping = true;
  console.log(`Stopping (${why}).`);
  void stopInstances().finally(() => { server.close(() => process.exit(0)); server.closeAllConnections(); });
};
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => shutdown(signal));
const stopRequest = join(process.cwd(), '.sema-stop');
setInterval(() => { if (existsSync(stopRequest)) { rmSync(stopRequest, { force: true }); shutdown('stop requested by the System Console'); } }, 1000).unref();
