import { readFileSync } from 'node:fs';
import { freemem } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * How Resource talks to Core: signed requests (RFC 9421) with Resource's own key, using Core's shared client code from
 * Core's folder (SEMA_CORE_DIRECTORY, or SEMA-Core beside SEMA-Foundation). Resource proves who it is with its key and
 * secret only to register that key. Like anything that calls Core, it needs its own key and secret in Resource's .env,
 * an entry for that key in Core's SEMA_APPLICATION_CLIENTS_JSON, and an application record in Foundation Access with
 * its grants.
 */
export const RESOURCE_SERVICE_KEY = 'sema.foundation.resource-facility';
export const resourceVersion = (JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }).version;

type Signing = { keyId: string; fetch(method: string, url: URL, body?: Buffer, headers?: Record<string, string>): Promise<Response> };
export type CoreRecords = {
  capabilities: Array<{ id: string; capabilityKey: string; version: string }>;
  services: Array<{ id: string; serviceKey: string; version: string; capabilityVersionId: string; legacy: boolean }>;
  installations: Array<{ id: string; serviceVersionId: string }>;
};

export class CoreLink {
  private constructor(private readonly core: string, private readonly signing: Signing) {}
  get keyId() { return this.signing.keyId; }

  /** Undefined when Resource has no secret set, so it cannot register its key. */
  static async open(env: NodeJS.ProcessEnv = process.env) {
    const secret = env.SEMA_RESOURCE_CORE_APPLICATION_SECRET;
    if (!secret) return undefined;
    const core = (env.SEMA_CORE_URL ?? 'http://127.0.0.1:4310').replace(/\/$/, '');
    const coreDirectory = resolve(env.SEMA_CORE_DIRECTORY ?? join(process.cwd(), '..', '..', 'SEMA-Core'));
    const { openCoreClientSigning } = await import(pathToFileURL(join(coreDirectory, 'dist', 'keys', 'client-signing.js')).href) as { openCoreClientSigning(input: { keyFile: string; coreUrl: string; applicationKey: string; secret: string }): Promise<Signing> };
    const signing = await openCoreClientSigning({
      keyFile: env.SEMA_RESOURCE_KEY_FILE ?? join(process.cwd(), 'keys', process.platform === 'win32' ? 'resource-key.dpapi' : 'resource-key.pem'),
      coreUrl: core, applicationKey: env.SEMA_RESOURCE_CORE_APPLICATION_KEY ?? 'sema.foundation.resource', secret,
    });
    return new CoreLink(core, signing);
  }

  /** Sends a signed request and returns Core's answer, or throws with Core's own words when it refuses. */
  async call<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    const response = await this.signing.fetch(method, new URL(`${this.core}${path}`), body === undefined ? undefined : Buffer.from(JSON.stringify(body)), body === undefined ? {} : { 'content-type': 'application/json' });
    const text = await response.text();
    if (!response.ok) {
      let message = text;
      try { message = (JSON.parse(text) as { error?: { message?: string } }).error?.message ?? text; } catch { /* plain text */ }
      throw new Error(`Core refused ${method} ${path} (${response.status}): ${message}`);
    }
    return JSON.parse(text) as T;
  }

  records() { return this.call<CoreRecords>('GET', '/v1/core/capabilities/records'); }
}

/** The installations of this Resource version on this machine: one per capability version it serves. */
export function ownInstallations(records: CoreRecords, version = resourceVersion) {
  const services = records.services.filter((service) => service.serviceKey === RESOURCE_SERVICE_KEY && service.version === version && !service.legacy);
  return records.installations.filter((installation) => services.some((service) => service.id === installation.serviceVersionId));
}

/**
 * Resource's running copies (D-151): one instance per installation, recorded with Core, checking in on a timer with the
 * memory it has free (D-158), and stopped when Resource stops. Resource starts before Foundation Access, so Core may not
 * be able to check its permissions yet: until it is recorded, it tries again at every tick. Core being down never stops
 * Resource serving files; it says so once and carries on. `ready` settles after the first try.
 */
export function startInstances(link: CoreLink, intervalMs: number, log: (line: string) => void = console.log) {
  const resources = () => ({ memoryFreeMb: Math.round(freemem() / 1_048_576) });
  let instances: string[] | undefined;
  let lastProblem = '';
  const tick = async () => {
    try {
      if (!instances) {
        const installations = ownInstallations(await link.records());
        if (!installations.length) throw new Error(`Resource ${resourceVersion} is not installed with Core yet: run npm run sema:core:bootstrap`);
        const recorded: string[] = [];
        for (const installation of installations) recorded.push((await link.call<{ id: string }>('POST', '/v1/core/services/instances', { installationId: installation.id, capacity: 4, resources: resources() })).id);
        instances = recorded;
        log(`Recorded with Core as instance ${instances.join(', ')}.`);
      } else {
        await Promise.all(instances.map((instanceId) => link.call('POST', '/v1/core/services/instances/check-in', { instanceId, resources: resources() })));
      }
      if (lastProblem) { lastProblem = ''; log('Core is answering again.'); }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message !== lastProblem) { lastProblem = message; log(`${instances ? 'Check-in with Core failed' : 'Resource could not record itself with Core yet'}: ${message}. It carries on serving files${intervalMs > 0 ? ' and tries again' : ''}.`); }
    }
  };
  const ready = tick();
  const timer = intervalMs > 0 ? setInterval(() => { void tick(); }, intervalMs) : undefined;
  timer?.unref();
  return {
    ready,
    /** The instances recorded so far, if any. */
    get instances() { return instances ?? []; },
    async stop() {
      if (timer) clearInterval(timer);
      await ready;
      await Promise.all((instances ?? []).map((instanceId) => link.call('POST', '/v1/core/services/instances/stop', { instanceId }).catch(() => undefined)));
    },
  };
}
