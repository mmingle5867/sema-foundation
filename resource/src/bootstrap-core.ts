import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { RESOURCE_CATALOG_CAPABILITY, RESOURCE_DELIVERY_CAPABILITY } from './contracts.js';
import { CoreLink, RESOURCE_SERVICE_KEY, resourceVersion } from './core-link.js';

/**
 * Set-up, run by hand (npm run sema:core:bootstrap): registers Foundation Resource with Core. Safe to run again; what
 * already exists is left alone.
 *
 * 1. The two capability contracts, read from SEMA-Capabilities (SEMA_CAPABILITIES_DIRECTORY, or beside SEMA-Foundation).
 * 2. This Resource version as a service of each, and its installation on this machine.
 * 3. The old single records, which programs still read to find Resource's address, until they use the new ones.
 *
 * Grants needed in Foundation Access: core.capabilities.read; and only while this runs, core.capabilities.register,
 * core.services.install and core.capabilities.approve (the names are in the reserved sema. namespace, D-104), given
 * with an end time.
 */
const link = await CoreLink.open();
if (!link) throw new Error('SEMA_RESOURCE_CORE_APPLICATION_SECRET is not set. Resource needs its own key and secret to register its signing key with Core: set SEMA_RESOURCE_CORE_APPLICATION_KEY (default sema.foundation.resource) and SEMA_RESOURCE_CORE_APPLICATION_SECRET in Resource\'s .env, add the same key and secret to Core\'s SEMA_APPLICATION_CLIENTS_JSON, and give that application its grants in Foundation Access.');
console.log(`Signing with Resource's key ${link.keyId}.`);
const facility = (process.env.SEMA_RESOURCE_URL ?? process.env.SEMA_RESOURCE_FACILITY_URL ?? 'http://127.0.0.1:4330').replace(/\/$/, '');
const definitions = resolve(process.env.SEMA_CAPABILITIES_DIRECTORY ?? join(process.cwd(), '..', '..', 'SEMA-Capabilities'), 'definitions');

type Definition = { capabilityKey: string; version: string; operations: Array<{ key: string; required: boolean }> };
const contracts: Definition[] = [
  [RESOURCE_CATALOG_CAPABILITY, '1.1.0'],
  [RESOURCE_DELIVERY_CAPABILITY, '1.0.1'],
].map(([key, version]) => JSON.parse(readFileSync(join(definitions, key, `${version}.json`), 'utf8')) as Definition);

let records = await link.records();
for (const contract of contracts) {
  let capability = records.capabilities.find((item) => item.capabilityKey === contract.capabilityKey && item.version === contract.version);
  if (!capability) { capability = await link.call('POST', '/v1/core/capabilities/versions', contract); console.log(`Published ${contract.capabilityKey} ${contract.version} as ${capability!.id}.`); }
  let service = records.services.find((item) => item.serviceKey === RESOURCE_SERVICE_KEY && item.version === resourceVersion && item.capabilityVersionId === capability!.id);
  if (!service) {
    service = await link.call('POST', '/v1/core/services/versions', {
      serviceKey: RESOURCE_SERVICE_KEY, version: resourceVersion, capabilityVersionId: capability!.id, displayName: 'SEMA Foundation Resource',
      operations: contract.operations.map((operation) => operation.key),
      declarations: { runsWhere: 'device', offline: true, systems: ['windows', 'linux', 'macos'] },
    });
    console.log(`Published Resource ${resourceVersion} for ${contract.capabilityKey} as ${service!.id}.`);
  }
  if (!records.installations.some((item) => item.serviceVersionId === service!.id)) {
    const installation = await link.call<{ id: string }>('POST', '/v1/core/services/installations', { serviceVersionId: service!.id });
    console.log(`Installed it on this machine as ${installation.id}.`);
  }
  records = await link.records();
}

// The old single records, kept until VectorForge and the others find Resource through the new ones.
async function registerOld(capabilityKey: string, displayName: string, endpointPath: string) {
  await link!.call('POST', '/v1/core/runtime/capabilities', { capabilityKey, displayName, description: 'Policy-controlled Foundation resource facility.', providerKey: RESOURCE_SERVICE_KEY, version: '1.0.0', metadata: { endpointUrl: `${facility}${endpointPath}`, contractVersion: '1.0.0', localFirst: true, referenceOnly: true, policyControlled: true } });
}
await registerOld(RESOURCE_CATALOG_CAPABILITY, 'Discover Shared Resources', '/v1/resources/catalog');
await registerOld(RESOURCE_DELIVERY_CAPABILITY, 'Deliver Shared Resource Content', '/v1/resources');
console.log('SEMA Foundation Resource registered with Core.');
