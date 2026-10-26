import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import type { AccessGrant, AccessGroup, AccessIndex, ApplicationDefinition, CapabilityChoice, DependencyKind, ItemDependency, ItemExample, ItemNote, ServiceSetting, CatalogRelease, ChangePacket, ChoosingWay, Delegation, GroupMembership, OrganizationChoices, RoleDefinition, NodeDescription, ServiceApproval, StorageLocation, TestingNote, User, Workspace, Organization, Membership } from './contracts.js';
import { AuthStore } from './auth-store.js';
import { authenticateToken, bearerToken, createCredential, issueSession, normalizeEmail, verifyPassword, workspacesForUser } from './auth.js';
import { AccessStore } from './store.js';
import { CoreClient } from './core-client.js';
/** Read from package.json, so the version is written in one place only. */
const ACCESS_VERSION = (JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }).version;

const json = (response: ServerResponse, status: number, value: unknown) => { response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); response.end(JSON.stringify(value)); };
async function body(request: IncomingMessage) { const chunks: Buffer[] = []; let length = 0; for await (const chunk of request) { const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk); length += value.length; if (length > 256 * 1024) throw new Error('Request body exceeds 256 KiB'); chunks.push(value); } const source = Buffer.concat(chunks).toString('utf8').trim(); return source ? JSON.parse(source) as Record<string, unknown> : {}; }
const text = (value: unknown, name: string) => { if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} is required`); return value.trim(); };
const optional = (value: unknown) => typeof value === 'string' && value.trim() ? value.trim() : undefined;
const stringArray = (value: unknown, name: string) => { if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string' || !entry.trim())) throw new Error(`${name} must be a non-empty string array`); return (value as string[]).map((entry) => entry.trim()); };
const optionalStringArray = (value: unknown, fallback: string[]) => value === undefined ? fallback : stringArray(value, 'roleKeys');
const recordStatus = (value: unknown) => { const status = text(value, 'status') as User['status']; if (!['ACTIVE', 'SUSPENDED', 'RETIRED'].includes(status)) throw new Error('Invalid record status'); return status; };

/**
 * An application's key is its permanent name: lowercase letters and digits, words joined by dots or hyphens. An
 * application outside SEMA (D-177) also starts with its company (at least two parts, such as neo.inventory) and never
 * with sema., which is reserved for SEMA's own programs.
 */
function applicationKeyOf(value: unknown, outside: boolean) {
  const key = text(value, 'applicationKey');
  if (key.length > 100 || !/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/.test(key)) throw new Error('Invalid applicationKey: use lowercase letters and digits, with words joined by dots or hyphens, at most 100 characters (for example neo.inventory)');
  if (outside && !key.includes('.')) throw new Error('Invalid applicationKey for an outside application: start with your company, then the application, joined by a dot (for example neo.inventory)');
  if (outside && (key === 'sema' || key.startsWith('sema.'))) throw new Error('Invalid applicationKey for an outside application: sema. is reserved for SEMA\'s own programs');
  return key;
}

const KEY = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/;
const keyOf = (value: unknown, name: string) => { const key = text(value, name); if (key.length > 120 || !KEY.test(key)) throw new Error(`Invalid ${name}: use lowercase letters and digits, with words joined by dots or hyphens`); return key; };
/** A list entry names a service key, or one exact version as key@version. */
const serviceEntry = (value: unknown) => { const entry = text(value, 'services entry'); const [key, version, extra] = entry.split('@'); if (extra !== undefined || !KEY.test(key ?? '') || (version !== undefined && !/^[0-9A-Za-z.+-]{1,40}$/.test(version))) throw new Error(`Invalid services entry ${entry}: a service key, or key@version`); return entry; };

const DEPENDENCY_KINDS: DependencyKind[] = ['account', 'setting', 'program', 'network', 'software', 'file', 'other'];
const longText = (value: unknown, name: string, max: number) => { if (value === undefined || value === null || value === '') return undefined; if (typeof value !== 'string' || value.length > max) throw new Error(`Invalid ${name}: text of at most ${max} characters`); return value.trim() || undefined; };
/** A note as saved: checked, trimmed, and small enough to send with every description. */
function itemNoteOf(payload: Record<string, unknown>): ItemNote {
  const kind = text(payload.kind, 'kind') as ItemNote['kind'];
  if (kind !== 'capability' && kind !== 'service') throw new Error('Invalid kind: capability or service');
  if (payload.dependencies !== undefined && (!Array.isArray(payload.dependencies) || payload.dependencies.length > 30)) throw new Error('Invalid dependencies: a list of at most 30');
  if (payload.examples !== undefined && (!Array.isArray(payload.examples) || payload.examples.length > 10)) throw new Error('Invalid examples: a list of at most 10');
  const dependencies = ((payload.dependencies ?? []) as Array<Record<string, unknown>>).map((entry): ItemDependency => {
    if (!entry || typeof entry !== 'object') throw new Error('Invalid dependencies: each is { kind, name, note }');
    const dependencyKind = text(entry.kind, 'dependency kind') as DependencyKind;
    if (!DEPENDENCY_KINDS.includes(dependencyKind)) throw new Error(`Invalid dependency kind ${dependencyKind}: ${DEPENDENCY_KINDS.join(', ')}`);
    const note = longText(entry.note, 'dependency note', 500);
    return { kind: dependencyKind, name: longText(entry.name, 'dependency name', 120) ?? text(undefined, 'dependency name'), ...(note ? { note } : {}) };
  });
  const examples = ((payload.examples ?? []) as Array<Record<string, unknown>>).map((entry): ItemExample => {
    if (!entry || typeof entry !== 'object' || entry.request === undefined) throw new Error('Invalid examples: each is { title, operation, request, result, note }, with a request');
    const operation = longText(entry.operation, 'example operation', 60), note = longText(entry.note, 'example note', 1000);
    return { title: longText(entry.title, 'example title', 200) ?? text(undefined, 'example title'), ...(operation ? { operation } : {}), request: entry.request, ...(entry.result !== undefined ? { result: entry.result } : {}), ...(note ? { note } : {}) };
  });
  const summary = longText(payload.summary, 'summary', 1000), details = longText(payload.details, 'details', 8000);
  const note: ItemNote = { kind, key: keyOf(payload.key, 'key'), ...(summary ? { summary } : {}), ...(details ? { details } : {}), dependencies, examples, updatedAt: new Date().toISOString() };
  if (JSON.stringify(note).length > 64 * 1024) throw new Error('Invalid note: at most 64 KB in all; shorten the examples');
  return note;
}

/** The services' settings for an organization, with a workspace's values replacing its organization's (D-204). */
export function settingsFor(index: AccessIndex, organizationId: string, workspaceId: string | undefined): Record<string, Record<string, string>> {
  const settings: Record<string, Record<string, string>> = {};
  const apply = (record: ServiceSetting) => { settings[record.serviceKey] = { ...settings[record.serviceKey], ...record.values }; };
  index.serviceSettings.filter((record) => record.organizationId === organizationId && !record.workspaceId).forEach(apply);
  if (workspaceId) index.serviceSettings.filter((record) => record.organizationId === organizationId && record.workspaceId === workspaceId).forEach(apply);
  return settings;
}

/**
 * The choices that apply to a command for a capability (D-193): the organization's and the workspace's records, for the
 * capability and for its job, most specific first. Core keeps a service only if every list allows it, so a workspace can
 * only narrow its organization; the default way is the most specific one set.
 */
export function choicesFor(index: AccessIndex, organizationId: string, workspaceId: string | undefined, capabilityKey: string, jobKey: string | undefined): OrganizationChoices {
  const records = index.capabilityChoices
    .filter((record) => record.organizationId === organizationId && record.capabilityKey === capabilityKey && (!record.workspaceId || record.workspaceId === workspaceId) && (!record.jobKey || record.jobKey === jobKey))
    .sort((a, b) => (Number(Boolean(b.workspaceId)) * 2 + Number(Boolean(b.jobKey))) - (Number(Boolean(a.workspaceId)) * 2 + Number(Boolean(a.jobKey))));
  const organization = index.organizations.find((entry) => entry.id === organizationId);
  const workspace = workspaceId ? index.workspaces.find((entry) => entry.id === workspaceId) : undefined;
  return {
    lists: records.filter((record) => record.services).map((record) => record.services!),
    ...(records.find((record) => record.way) ? { way: records.find((record) => record.way)!.way } : {}),
    approvalRequired: organization?.serviceApproval === true || workspace?.serviceApproval === true,
    approved: index.serviceApprovals.filter((approval) => approval.organizationId === organizationId && !approval.revokedAt).map((approval) => approval.serviceVersionId),
    settings: settingsFor(index, organizationId, workspaceId),
  };
}

export function createAccessServer(input: { store: AccessStore; authStore: AuthStore; core: CoreClient; adminKey: string; bootstrapKey: string; policyKey: string; sessionKey: string; sessionTtlMinutes: number }) {
  const admin = (request: IncomingMessage) => input.adminKey !== 'replace-with-a-strong-local-admin-key' && request.headers['x-sema-access-admin-key'] === input.adminKey;
  const bootstrap = (request: IncomingMessage) => input.bootstrapKey !== 'replace-with-a-one-time-bootstrap-key' && request.headers['x-sema-access-bootstrap-key'] === input.bootstrapKey;
  const audit = async (action: string, ids: string[], evidence: Record<string, unknown> = {}) => input.core.audit(action, ids, evidence);
  return createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    try {
      if (request.method === 'GET' && url.pathname === '/v1/access/health') { const index = await input.store.load(); return json(response, 200, { status: 'ACTIVE', service: 'sema.foundation.access', version: ACCESS_VERSION, bootstrapped: Boolean(index.bootstrappedAt), authentication: 'LOCAL_PASSWORD_SESSION', coreRequests: input.core.proof }); }
      if (request.method === 'GET' && url.pathname === '/v1/access/index') { if (!admin(request)) return json(response, 403, { error: 'Administration is required.' }); return json(response, 200, await input.store.load()); }

      if (request.method === 'POST' && url.pathname === '/v1/access/policy/evaluate') {
        if (request.headers['x-sema-access-policy-key'] !== input.policyKey) return json(response, 403, { error: 'Policy evaluation is not authorized.' });
        const payload = await body(request); const applicationKey = text(payload.applicationKey, 'applicationKey'); const operation = text(payload.operation, 'operation'); const index = await input.store.load();
        // For a capability command Core also sends the capability, its job and the command's workspace, and gets back the
        // organization the command belongs to and its choices (D-193).
        const workspaceId = optional(payload.workspaceId); const capabilityKey = optional(payload.capabilityKey); const jobKey = optional(payload.jobKey);
        const workspace = workspaceId ? index.workspaces.find((entry) => entry.id === workspaceId && entry.status === 'ACTIVE') : undefined;
        const application = index.applications.find((candidate) => candidate.applicationKey === applicationKey && candidate.status === 'ACTIVE');
        const now = Date.now();
        // A grant allows the operation; with a workspace, only a grant that reaches that workspace counts, and an unknown workspace allows nothing.
        const allowing = application ? index.grants.filter((grant) => grant.granteeKind === 'APPLICATION' && grant.granteeId === application.id && !grant.revokedAt && (!grant.expiresAt || Date.parse(grant.expiresAt) > now) && grant.operations.some((candidate) => candidate === operation || candidate === 'core.*' || (candidate.endsWith('.*') && operation.startsWith(candidate.slice(0, -1))))
          && (!workspaceId || Boolean(workspace && (!grant.organizationId || grant.organizationId === workspace.organizationId) && (!grant.workspaceId || grant.workspaceId === workspace.id)))) : [];
        const allowed = allowing.length > 0;
        if (!capabilityKey || !allowed) return json(response, 200, { allowed, applicationKey, operation });
        // The command's workspace, else the organization of the grant that allowed it.
        const organizationId = workspace?.organizationId ?? allowing.find((grant) => grant.organizationId)?.organizationId;
        const choices: OrganizationChoices = organizationId ? choicesFor(index, organizationId, workspace?.id, capabilityKey, jobKey) : { lists: [], approvalRequired: false, approved: [], settings: {} };
        return json(response, 200, { allowed, applicationKey, operation, ...(organizationId ? { organizationId } : {}), ...(workspace ? { workspaceId: workspace.id } : {}), choices });
      }

      if (request.method === 'GET' && /^\/v1\/access\/item-notes\/(capability|service)\/[^/]+$/.test(url.pathname)) {
        if (!admin(request) && request.headers['x-sema-access-policy-key'] !== input.policyKey) return json(response, 403, { error: 'Reading notes needs the administrator key or the policy key.' });
        const [, , , , kind, rawKey] = url.pathname.split('/'); const key = decodeURIComponent(rawKey ?? '');
        const note = (await input.store.load()).itemNotes.find((entry) => entry.kind === kind && entry.key === key);
        return note ? json(response, 200, note) : json(response, 404, { error: `No note for ${kind} ${key}` });
      }
      if (request.method === 'POST' && url.pathname === '/v1/access/auth/login') {
        const payload = await body(request);
        let email: string;
        try { email = normalizeEmail(text(payload.email, 'email')); } catch { return json(response, 401, { error: 'Email or password is incorrect.' }); }
        const password = typeof payload.password === 'string' ? payload.password : '';
        const requestedWorkspaceId = optional(payload.workspaceId);
        const index = await input.store.load();
        const user = index.users.find((candidate) => candidate.email?.trim().toLowerCase() === email);
        const state = await input.authStore.load();
        const credential = state.credentials.find((candidate) => candidate.emailNormalized === email);
        const now = Date.now();
        if (!user || user.status !== 'ACTIVE' || !credential || (credential.lockedUntil && Date.parse(credential.lockedUntil) > now) || !(await verifyPassword(credential, password))) {
          await input.authStore.update((next) => {
            const target = next.credentials.find((candidate) => candidate.emailNormalized === email);
            if (!target) return;
            target.failedLoginCount += 1;
            if (target.failedLoginCount >= 10) { target.lockedUntil = new Date(Date.now() + 15 * 60_000).toISOString(); target.failedLoginCount = 0; }
          });
          return json(response, 401, { error: 'Email or password is incorrect.' });
        }
        const workspaces = workspacesForUser({ user, workspaces: index.workspaces, memberships: index.memberships });
        const workspaceId = requestedWorkspaceId ?? (workspaces.length === 1 ? workspaces[0]!.id : undefined);
        if (workspaceId && !workspaces.some((workspace) => workspace.id === workspaceId)) return json(response, 403, { error: 'The selected workspace is not available to this user.' });
        const issued = issueSession({ userId: user.id, workspaceId, ttlMinutes: input.sessionTtlMinutes, signingKey: input.sessionKey });
        await input.authStore.update((next) => {
          const target = next.credentials.find((candidate) => candidate.userId === user.id);
          if (target) { target.failedLoginCount = 0; target.lockedUntil = undefined; }
          next.sessions = next.sessions.filter((session) => !session.revokedAt && Date.parse(session.expiresAt) > Date.now());
          next.sessions.push(issued.session);
        });
        await audit('foundation-access.auth.login', [user.id], { workspaceId });
        return json(response, 200, { accessToken: issued.accessToken, expiresAt: issued.session.expiresAt, user, workspaces, workspaceId });
      }

      if (request.method === 'GET' && url.pathname === '/v1/access/auth/me') {
        const state = await input.authStore.load();
        const authenticated = authenticateToken(bearerToken(request.headers.authorization), state, input.sessionKey);
        const index = await input.store.load();
        const user = index.users.find((candidate) => candidate.id === authenticated.userId && candidate.status === 'ACTIVE');
        if (!user) return json(response, 401, { error: 'The signed-in user is no longer active.' });
        const workspaces = workspacesForUser({ user, workspaces: index.workspaces, memberships: index.memberships });
        return json(response, 200, { user, workspaceId: authenticated.workspaceId, workspaces, expiresAt: authenticated.session.expiresAt });
      }

      if (request.method === 'POST' && url.pathname === '/v1/access/auth/logout') {
        const state = await input.authStore.load();
        const authenticated = authenticateToken(bearerToken(request.headers.authorization), state, input.sessionKey);
        await input.authStore.update((next) => { const session = next.sessions.find((candidate) => candidate.id === authenticated.session.id); if (session) session.revokedAt = new Date().toISOString(); });
        await audit('foundation-access.auth.logout', [authenticated.userId]);
        return json(response, 200, { success: true });
      }

      if (request.method === 'POST' && url.pathname === '/v1/access/bootstrap') {
        if (!bootstrap(request)) return json(response, 403, { error: 'A valid one-time bootstrap key is required.' });
        const payload = await body(request); const index = await input.store.load(); if (index.bootstrappedAt) return json(response, 409, { error: 'Foundation Access is already bootstrapped.' });
        const user: User = { id: await input.core.issue('USER', { purpose: 'initial-owner' }), displayName: text(payload.userDisplayName, 'userDisplayName'), email: optional(payload.email), status: 'ACTIVE', createdAt: new Date().toISOString() };
        const organization: Organization = { id: await input.core.issue('ORGANIZATION', { purpose: 'initial-owner-organization' }), displayName: text(payload.organizationDisplayName, 'organizationDisplayName'), status: 'ACTIVE', createdAt: new Date().toISOString() };
        const workspaces: Workspace[] = await Promise.all(stringArray(payload.workspaces, 'workspaces').map(async (displayName) => ({ id: await input.core.issue('WORKSPACE', { organizationId: organization.id }), organizationId: organization.id, displayName, kind: 'GENERAL', status: 'ACTIVE' as const, createdAt: new Date().toISOString() })));
        const membership: Membership = { id: await input.core.issue('MEMBERSHIP', { userId: user.id, organizationId: organization.id }), userId: user.id, organizationId: organization.id, roleKeys: ['organization.owner'], status: 'ACTIVE', createdAt: new Date().toISOString() };
        index.users.push(user); index.organizations.push(organization); index.workspaces.push(...workspaces); index.memberships.push(membership); index.bootstrappedAt = new Date().toISOString(); await input.store.save(index);
        await audit('foundation-access.bootstrap.completed', [user.id, organization.id, membership.id, ...workspaces.map((workspace) => workspace.id)]);
        return json(response, 201, { user, organization, workspaces, membership });
      }

      if (!admin(request)) return json(response, 403, { error: 'Administration is required.' });
      if (request.method === 'GET' && url.pathname === '/v1/access/users') return json(response, 200, (await input.store.load()).users);
      if (request.method === 'GET' && url.pathname === '/v1/access/organizations') return json(response, 200, (await input.store.load()).organizations);
      if (request.method === 'GET' && url.pathname === '/v1/access/workspaces') return json(response, 200, (await input.store.load()).workspaces);
      if (request.method === 'GET' && url.pathname === '/v1/access/applications') return json(response, 200, (await input.store.load()).applications);
      if (request.method === 'GET' && url.pathname === '/v1/access/catalog/releases') return json(response, 200, (await input.store.load()).catalogReleases);
      if (request.method === 'GET' && url.pathname === '/v1/access/testing-notes') return json(response, 200, (await input.store.load()).testingNotes);
      if (request.method === 'GET' && url.pathname === '/v1/access/change-packets') return json(response, 200, (await input.store.load()).changePackets);

      if (request.method === 'POST' && url.pathname === '/v1/access/testing-notes') {
        const payload = await body(request); const index = await input.store.load(); const subjectKind = text(payload.subjectKind, 'subjectKind') as TestingNote['subjectKind']; const subjectId = text(payload.subjectId, 'subjectId'); let subjectLabel: string; let subjectVersion: string | undefined; let applicationId: string | undefined; let applicationKey: string | undefined;
        if (subjectKind === 'APPLICATION') { const application = index.applications.find((entry) => entry.id === subjectId); if (!application) throw new Error('Application target does not exist'); subjectLabel = application.displayName; subjectVersion = optional(payload.subjectVersion) ?? application.version; applicationId = application.id; applicationKey = application.applicationKey; }
        else if (subjectKind === 'CAPABILITY' || subjectKind === 'SERVICE') { const release = index.catalogReleases.find((entry) => entry.id === subjectId); if (!release) throw new Error('Capability or service target does not exist'); subjectLabel = release.displayName; subjectVersion = optional(payload.subjectVersion) ?? release.version; }
        else if (subjectKind === 'CORE') { if (subjectId !== 'sema.core') throw new Error('Invalid Core target'); subjectLabel = 'SEMA Core'; subjectVersion = optional(payload.subjectVersion); }
        else if (subjectKind === 'SYSTEM_CONSOLE') { if (subjectId !== 'sema.system.console') throw new Error('Invalid System Console target'); subjectLabel = 'SEMA System Console'; subjectVersion = optional(payload.subjectVersion); }
        else throw new Error('Invalid testing note target');
        const kind = text(payload.kind, 'kind') as TestingNote['kind']; const priority = text(payload.priority, 'priority') as TestingNote['priority']; if (!['TEST_NOTE', 'DEFECT', 'CHANGE_REQUEST', 'QUESTION'].includes(kind) || !['LOW', 'NORMAL', 'HIGH', 'CRITICAL'].includes(priority)) throw new Error('Invalid note kind or priority');
        const now = new Date().toISOString(); const note: TestingNote = { id: await input.core.issue('TESTING_NOTE', { subjectKind, subjectId }), applicationId, applicationKey, applicationVersion: subjectVersion, subjectKind, subjectId, subjectLabel, subjectVersion, kind, priority, title: text(payload.title, 'title'), detail: text(payload.detail, 'detail'), status: 'OPEN', selectedForPacket: false, createdAt: now, updatedAt: now, history: [{ at: now, action: 'CREATED' }] };
        await input.store.update((next) => { next.testingNotes.push(note); }); await audit('testing-note.created', [note.id, ...(applicationId ? [applicationId] : [])], { subjectKind, subjectId, kind, priority }); return json(response, 201, note);
      }
      if (request.method === 'POST' && /^\/v1\/access\/testing-notes\/[^/]+$/.test(url.pathname)) {
        const noteId = decodeURIComponent(url.pathname.split('/')[4] ?? ''); const payload = await body(request); const note = await input.store.update((index) => { const target = index.testingNotes.find((entry) => entry.id === noteId); if (!target) throw new Error('Testing note does not exist'); const status = text(payload.status, 'status') as TestingNote['status']; if (!['OPEN', 'DEFERRED', 'REJECTED', 'SELECTED', 'IMPLEMENTED'].includes(status)) throw new Error('Invalid testing note status'); const resolution = optional(payload.resolution); target.status = status; target.selectedForPacket = payload.selectedForPacket === true; target.updatedAt = new Date().toISOString(); target.history.push({ at: target.updatedAt, action: status, detail: resolution }); return target; }); await audit('testing-note.updated', [note.id, ...(note.applicationId ? [note.applicationId] : [])], { status: note.status }); return json(response, 200, note);
      }
      if (request.method === 'POST' && url.pathname === '/v1/access/change-packets') {
        const payload = await body(request); const noteIds = stringArray(payload.noteIds, 'noteIds'); const index = await input.store.load(); const notes = index.testingNotes.filter((note) => noteIds.includes(note.id)); if (notes.length !== noteIds.length) throw new Error('One or more testing notes do not exist'); const first = notes[0]; if (!first || notes.some((note) => note.subjectKind !== first.subjectKind || note.subjectId !== first.subjectId)) throw new Error('A Change Packet may contain notes for one target only'); const summary = ['# Proposed change packet', '', `Target: ${first.subjectLabel}`, `Target type: ${first.subjectKind}`, `Version: ${first.subjectVersion ?? 'not recorded'}`, '', '## Requested changes', ...notes.map((note, position) => `${position + 1}. [${note.kind}/${note.priority}] ${note.title}\n   ${note.detail}`), '', '## Acceptance checks', ...notes.map((note, position) => `${position + 1}. Confirm: ${note.title}`), '', '## Record handling', 'Selected testing notes are attached below. Rejected and deferred notes are intentionally excluded unless later selected.'].join('\n'); const packet: ChangePacket = { id: await input.core.issue('CHANGE_PACKET', { subjectKind: first.subjectKind, subjectId: first.subjectId }), applicationId: first.applicationId, applicationKey: first.applicationKey, subjectKind: first.subjectKind, subjectId: first.subjectId, subjectLabel: first.subjectLabel, subjectVersion: first.subjectVersion, createdAt: new Date().toISOString(), noteIds, summary, status: 'DRAFT' };
        await input.store.update((next) => { next.changePackets.push(packet); for (const note of next.testingNotes) if (noteIds.includes(note.id)) { note.status = 'SELECTED'; note.selectedForPacket = true; note.updatedAt = packet.createdAt; note.history.push({ at: packet.createdAt, action: 'INCLUDED_IN_CHANGE_PACKET', detail: packet.id }); } }); await audit('change-packet.created', [packet.id, ...(first.applicationId ? [first.applicationId] : []), ...noteIds]); return json(response, 201, packet);
      }

      if (request.method === 'POST' && url.pathname === '/v1/access/users') {
        const payload = await body(request);
        const displayName = text(payload.displayName, 'displayName');
        const user: User = { id: await input.core.issue('USER', { purpose: 'user-administration-person-record' }), displayName, status: 'ACTIVE', createdAt: new Date().toISOString() };
        await input.store.update((next) => { next.users.push(user); });
        await audit('foundation-access.user.created', [user.id]);
        return json(response, 201, { user });
      }

      if (request.method === 'POST' && /^\/v1\/access\/users\/[^/]+\/credentials$/.test(url.pathname)) {
        const userId = decodeURIComponent(url.pathname.split('/')[4] ?? '');
        const payload = await body(request);
        const email = normalizeEmail(text(payload.email, 'email'));
        const password = text(payload.password, 'password');
        const user = await input.store.update((next) => {
          const target = next.users.find((candidate) => candidate.id === userId);
          if (!target) throw new Error('User does not exist');
          if (target.email && target.email.trim().toLowerCase() !== email) throw new Error('email does not match the user record');
          if (next.users.some((candidate) => candidate.id !== userId && candidate.email?.trim().toLowerCase() === email)) throw new Error('email is already registered');
          target.email = email;
          return target;
        });
        const credential = await createCredential(user.id, email, password);
        await input.authStore.update((next) => {
          if (next.credentials.some((candidate) => candidate.userId !== userId && candidate.emailNormalized === email)) throw new Error('email is already registered');
          next.credentials = next.credentials.filter((candidate) => candidate.userId !== userId);
          next.credentials.push(credential);
          for (const session of next.sessions) if (session.userId === userId && !session.revokedAt) session.revokedAt = new Date().toISOString();
        });
        await audit('foundation-access.user.credentials.reset', [userId]);
        return json(response, 200, { userId, email: user.email, sessionsRevoked: true });
      }

      if (request.method === 'POST' && /^\/v1\/access\/users\/[^/]+\/status$/.test(url.pathname)) {
        const userId = decodeURIComponent(url.pathname.split('/')[4] ?? '');
        const payload = await body(request);
        const status = recordStatus(payload.status);
        const user = await input.store.update((next) => { const target = next.users.find((candidate) => candidate.id === userId); if (!target) throw new Error('User does not exist'); target.status = status; return target; });
        if (status !== 'ACTIVE') await input.authStore.update((next) => { for (const session of next.sessions) if (session.userId === userId && !session.revokedAt) session.revokedAt = new Date().toISOString(); });
        await audit('foundation-access.user.status.changed', [userId], { status });
        return json(response, 200, user);
      }

      if (request.method === 'POST' && /^\/v1\/access\/users\/[^/]+\/profile$/.test(url.pathname)) {
        const userId = decodeURIComponent(url.pathname.split('/')[4] ?? ''); const payload = await body(request);
        const user = await input.store.update((next) => { const target = next.users.find((candidate) => candidate.id === userId); if (!target) throw new Error('User does not exist'); target.displayName = text(payload.displayName, 'displayName'); return target; });
        await audit('foundation-access.user.profile.updated', [userId]); return json(response, 200, user);
      }

      if (request.method === 'POST' && url.pathname === '/v1/access/memberships') {
        const payload = await body(request); const userId = text(payload.userId, 'userId'); const organizationId = text(payload.organizationId, 'organizationId'); const workspaceId = optional(payload.workspaceId); const roleKeys = optionalStringArray(payload.roleKeys, ['workspace.member']);
        const membership: Membership = { id: await input.core.issue('MEMBERSHIP', { userId, organizationId, workspaceId }), userId, organizationId, workspaceId, roleKeys, status: 'ACTIVE', createdAt: new Date().toISOString() };
        await input.store.update((index) => { if (!index.users.some((entry) => entry.id === userId && entry.status === 'ACTIVE')) throw new Error('userId does not exist or is not active'); if (!index.organizations.some((entry) => entry.id === organizationId && entry.status === 'ACTIVE')) throw new Error('organizationId does not exist or is not active'); if (workspaceId && !index.workspaces.some((entry) => entry.id === workspaceId && entry.organizationId === organizationId && entry.status === 'ACTIVE')) throw new Error('workspaceId does not exist for organizationId'); if (index.memberships.some((entry) => entry.userId === userId && entry.organizationId === organizationId && entry.workspaceId === workspaceId && entry.status === 'ACTIVE')) throw new Error('An active matching membership already exists'); index.memberships.push(membership); });
        await audit('foundation-access.membership.created', [membership.id, userId, organizationId, ...(workspaceId ? [workspaceId] : [])]); return json(response, 201, membership);
      }

      if (request.method === 'POST' && /^\/v1\/access\/memberships\/[^/]+$/.test(url.pathname)) {
        const membershipId = decodeURIComponent(url.pathname.split('/')[4] ?? ''); const payload = await body(request); const roles = optionalStringArray(payload.roleKeys, []); const status = recordStatus(payload.status);
        const membership = await input.store.update((index) => { const target = index.memberships.find((entry) => entry.id === membershipId); if (!target) throw new Error('Membership does not exist'); target.roleKeys = roles; target.status = status; return target; });
        await audit('foundation-access.membership.updated', [membership.id, membership.userId, membership.organizationId], { status }); return json(response, 200, membership);
      }

      if (request.method === 'POST' && url.pathname === '/v1/access/roles') { const payload = await body(request); const role: RoleDefinition = { id: await input.core.issue('ROLE'), key: text(payload.key, 'key'), displayName: text(payload.displayName, 'displayName'), description: optional(payload.description), scopeKind: text(payload.scopeKind, 'scopeKind') as RoleDefinition['scopeKind'], status: 'ACTIVE', createdAt: new Date().toISOString() }; if (!['ORGANIZATION', 'WORKSPACE'].includes(role.scopeKind)) throw new Error('Invalid role scopeKind'); await input.store.update((index) => { if (index.roleDefinitions.some((entry) => entry.key === role.key)) throw new Error('role key is already registered'); index.roleDefinitions.push(role); }); await audit('foundation-access.role.created', [role.id], { key: role.key, scopeKind: role.scopeKind }); return json(response, 201, role); }
      if (request.method === 'POST' && url.pathname === '/v1/access/groups') { const payload = await body(request); const organizationId = text(payload.organizationId, 'organizationId'); const workspaceId = optional(payload.workspaceId); const group: AccessGroup = { id: await input.core.issue('GROUP', { organizationId, workspaceId }), organizationId, workspaceId, displayName: text(payload.displayName, 'displayName'), description: optional(payload.description), status: 'ACTIVE', createdAt: new Date().toISOString() }; await input.store.update((index) => { if (!index.organizations.some((entry) => entry.id === organizationId && entry.status === 'ACTIVE')) throw new Error('organizationId does not exist or is not active'); if (workspaceId && !index.workspaces.some((entry) => entry.id === workspaceId && entry.organizationId === organizationId && entry.status === 'ACTIVE')) throw new Error('workspaceId does not exist for organizationId'); index.groups.push(group); }); await audit('foundation-access.group.created', [group.id, organizationId, ...(workspaceId ? [workspaceId] : [])]); return json(response, 201, group); }
      if (request.method === 'POST' && url.pathname === '/v1/access/group-memberships') { const payload = await body(request); const groupId = text(payload.groupId, 'groupId'); const userId = text(payload.userId, 'userId'); const membership: GroupMembership = { id: await input.core.issue('GROUP_MEMBERSHIP', { groupId, userId }), groupId, userId, status: 'ACTIVE', createdAt: new Date().toISOString() }; await input.store.update((index) => { const group = index.groups.find((entry) => entry.id === groupId && entry.status === 'ACTIVE'); if (!group) throw new Error('groupId does not exist or is not active'); if (!index.users.some((entry) => entry.id === userId && entry.status === 'ACTIVE')) throw new Error('userId does not exist or is not active'); if (index.groupMemberships.some((entry) => entry.groupId === groupId && entry.userId === userId && entry.status === 'ACTIVE')) throw new Error('An active matching group membership already exists'); index.groupMemberships.push(membership); }); await audit('foundation-access.group-membership.created', [membership.id, groupId, userId]); return json(response, 201, membership); }
      if (request.method === 'POST' && url.pathname === '/v1/access/delegations') { const payload = await body(request); const delegatorUserId = text(payload.delegatorUserId, 'delegatorUserId'); const delegateUserId = text(payload.delegateUserId, 'delegateUserId'); const organizationId = text(payload.organizationId, 'organizationId'); const workspaceId = optional(payload.workspaceId); const effectiveAt = text(payload.effectiveAt, 'effectiveAt'); const expiresAt = text(payload.expiresAt, 'expiresAt'); if (delegatorUserId === delegateUserId) throw new Error('A user cannot delegate to themselves'); if (!Number.isFinite(Date.parse(effectiveAt)) || !Number.isFinite(Date.parse(expiresAt)) || Date.parse(expiresAt) <= Date.parse(effectiveAt)) throw new Error('Delegation expiry must be after its effective time'); const delegation: Delegation = { id: await input.core.issue('DELEGATION', { delegatorUserId, delegateUserId, organizationId, workspaceId }), delegatorUserId, delegateUserId, organizationId, workspaceId, applicationKey: optional(payload.applicationKey), operations: stringArray(payload.operations, 'operations'), effectiveAt, expiresAt, note: optional(payload.note), createdAt: new Date().toISOString() }; await input.store.update((index) => { for (const id of [delegatorUserId, delegateUserId]) if (!index.users.some((entry) => entry.id === id && entry.status === 'ACTIVE')) throw new Error('Both delegator and delegate must be active users'); if (!index.memberships.some((entry) => entry.userId === delegatorUserId && entry.organizationId === organizationId && entry.status === 'ACTIVE')) throw new Error('Delegator lacks an active organization membership'); if (!index.memberships.some((entry) => entry.userId === delegateUserId && entry.organizationId === organizationId && entry.status === 'ACTIVE')) throw new Error('Delegate lacks an active organization membership'); if (workspaceId && !index.workspaces.some((entry) => entry.id === workspaceId && entry.organizationId === organizationId && entry.status === 'ACTIVE')) throw new Error('workspaceId does not exist for organizationId'); index.delegations.push(delegation); }); await audit('foundation-access.delegation.created', [delegation.id, delegatorUserId, delegateUserId, organizationId, ...(workspaceId ? [workspaceId] : [])], { operations: delegation.operations, expiresAt }); return json(response, 201, delegation); }
      if (request.method === 'POST' && /^\/v1\/access\/delegations\/[^/]+\/revoke$/.test(url.pathname)) { const delegationId = decodeURIComponent(url.pathname.split('/')[4] ?? ''); const delegation = await input.store.update((index) => { const target = index.delegations.find((entry) => entry.id === delegationId); if (!target) throw new Error('Delegation does not exist'); if (!target.revokedAt) target.revokedAt = new Date().toISOString(); return target; }); await audit('foundation-access.delegation.revoked', [delegation.id, delegation.delegatorUserId, delegation.delegateUserId]); return json(response, 200, delegation); }

      if (request.method === 'POST' && /^\/v1\/access\/organizations\/[^/]+$/.test(url.pathname)) { const organizationId = decodeURIComponent(url.pathname.split('/')[4] ?? ''); const payload = await body(request); const organization = await input.store.update((index) => { const target = index.organizations.find((entry) => entry.id === organizationId); if (!target) throw new Error('Organization does not exist'); target.displayName = text(payload.displayName, 'displayName'); target.status = recordStatus(payload.status); return target; }); await audit('foundation-access.organization.updated', [organizationId], { status: organization.status }); return json(response, 200, organization); }
      if (request.method === 'POST' && url.pathname === '/v1/access/organizations') { const payload = await body(request); const organization: Organization = { id: await input.core.issue('ORGANIZATION'), displayName: text(payload.displayName, 'displayName'), status: 'ACTIVE', createdAt: new Date().toISOString() }; await input.store.update((index) => { index.organizations.push(organization); }); await audit('organization.created', [organization.id]); return json(response, 201, organization); }
      if (request.method === 'POST' && /^\/v1\/access\/workspaces\/[^/]+$/.test(url.pathname)) { const workspaceId = decodeURIComponent(url.pathname.split('/')[4] ?? ''); const payload = await body(request); const workspace = await input.store.update((index) => { const target = index.workspaces.find((entry) => entry.id === workspaceId); if (!target) throw new Error('Workspace does not exist'); target.displayName = text(payload.displayName, 'displayName'); target.kind = text(payload.kind, 'kind'); target.status = recordStatus(payload.status); return target; }); await audit('foundation-access.workspace.updated', [workspaceId, workspace.organizationId], { status: workspace.status }); return json(response, 200, workspace); }
      if (request.method === 'POST' && url.pathname === '/v1/access/workspaces') { const payload = await body(request); const organizationId = text(payload.organizationId, 'organizationId'); const workspace: Workspace = { id: await input.core.issue('WORKSPACE', { organizationId }), organizationId, displayName: text(payload.displayName, 'displayName'), kind: optional(payload.kind) ?? 'GENERAL', status: 'ACTIVE', createdAt: new Date().toISOString() }; await input.store.update((index) => { if (!index.organizations.some((organization) => organization.id === organizationId)) throw new Error('organizationId does not exist'); index.workspaces.push(workspace); }); await audit('workspace.created', [workspace.id, organizationId]); return json(response, 201, workspace); }
      if (request.method === 'POST' && url.pathname === '/v1/access/node-descriptions') {
        // The name of a node in Core's tree, set or changed. An organization or user record with the same ID is already that node's name.
        const payload = await body(request); const nodeId = text(payload.nodeId, 'nodeId'); if (!nodeId.split('-').every(Boolean)) throw new Error('Invalid nodeId: it must be hyphen-separated non-empty segments');
        const description = await input.store.update((index) => {
          if (index.organizations.some((entry) => entry.id === nodeId)) throw new Error('This node is an organization, so its name cannot be set here: change it on the organization record');
          if (index.users.some((entry) => entry.id === nodeId)) throw new Error('This node is a user, so its name cannot be set here: change it on the user record');
          const next: NodeDescription = { nodeId, displayName: text(payload.displayName, 'displayName'), ...(optional(payload.note) ? { note: optional(payload.note) } : {}), updatedAt: new Date().toISOString() };
          const at = index.nodeDescriptions.findIndex((entry) => entry.nodeId === nodeId); if (at >= 0) index.nodeDescriptions[at] = next; else index.nodeDescriptions.push(next); return next;
        });
        await audit('foundation-access.node-description.saved', [nodeId], { displayName: description.displayName }); return json(response, 200, description);
      }
      if (request.method === 'POST' && url.pathname === '/v1/access/applications/import') { const payload = await body(request); const applicationKey = applicationKeyOf(payload.applicationKey, payload.outside === true); const manifest = (payload.manifest && typeof payload.manifest === 'object' && !Array.isArray(payload.manifest) ? payload.manifest : {}) as Record<string, unknown>; const application: ApplicationDefinition = { id: await input.core.issue('APPLICATION', { applicationKey }), applicationKey, displayName: text(payload.displayName, 'displayName'), vendor: optional(payload.vendor), version: text(payload.version, 'version'), description: optional(payload.description), manifest, status: 'ACTIVE', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), ...(payload.outside === true ? { outside: { bases: [] } } : {}) }; await input.store.update((index) => { if (index.applications.some((candidate) => candidate.applicationKey === applicationKey)) throw new Error('applicationKey is already registered'); index.applications.push(application); }); await audit('application.registered', [application.id], { applicationKey, ...(application.outside ? { outside: true } : {}) }); return json(response, 201, application); }
      // An installation of an outside application gets its own basis: a fresh ID from Core, recorded under the application (D-177).
      if (request.method === 'POST' && /^\/v1\/access\/applications\/[^/]+\/bases$/.test(url.pathname)) { const applicationId = decodeURIComponent(url.pathname.split('/')[4] ?? ''); const payload = await body(request); const label = text(payload.label, 'label'); const current = (await input.store.load()).applications.find((entry) => entry.id === applicationId); if (!current) throw new Error('Application does not exist'); if (!current.outside) throw new Error('Bases cannot be issued to this application: it was not registered as outside SEMA'); if (current.outside.bases.some((basis) => basis.label.toLowerCase() === label.toLowerCase())) throw new Error(`This application already has a basis labelled ${label}`); const basis = { id: await input.core.issue('APPLICATION_BASIS', { applicationId, applicationKey: current.applicationKey, label }), label, issuedAt: new Date().toISOString() }; const application = await input.store.update((index) => { const target = index.applications.find((entry) => entry.id === applicationId)!; target.outside = { bases: [...(target.outside?.bases ?? []), basis] }; target.updatedAt = new Date().toISOString(); return target; }); await audit('application.basis.issued', [application.id, basis.id], { applicationKey: application.applicationKey, label }); return json(response, 201, { application, basis }); }
      if (request.method === 'POST' && /^\/v1\/access\/applications\/[^/]+$/.test(url.pathname)) { const applicationId = decodeURIComponent(url.pathname.split('/')[4] ?? ''); const payload = await body(request); const application = await input.store.update((index) => { const target = index.applications.find((entry) => entry.id === applicationId); if (!target) throw new Error('Application does not exist'); target.displayName = text(payload.displayName, 'displayName'); target.vendor = optional(payload.vendor); target.version = text(payload.version, 'version'); target.description = optional(payload.description); target.status = recordStatus(payload.status); target.updatedAt = new Date().toISOString(); return target; }); await audit('application.updated', [application.id], { applicationKey: application.applicationKey, status: application.status }); return json(response, 200, application); }
      if (request.method === 'POST' && url.pathname === '/v1/access/catalog/releases') { const payload = await body(request); const release: CatalogRelease = { id: await input.core.issue('SERVICE_RELEASE'), capabilityKey: text(payload.capabilityKey, 'capabilityKey'), providerKey: text(payload.providerKey, 'providerKey'), serviceKey: text(payload.serviceKey, 'serviceKey'), version: text(payload.version, 'version'), displayName: text(payload.displayName, 'displayName'), packageUri: optional(payload.packageUri), packageHash: optional(payload.packageHash), manifest: (payload.manifest && typeof payload.manifest === 'object' && !Array.isArray(payload.manifest) ? payload.manifest : {}) as Record<string, unknown>, trustStatus: 'UNVERIFIED', status: 'DISCOVERED', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }; await input.store.update((index) => { index.catalogReleases.push(release); }); await audit('catalog.release.discovered', [release.id], { capabilityKey: release.capabilityKey, serviceKey: release.serviceKey }); return json(response, 201, release); }
      if (request.method === 'POST' && /^\/v1\/access\/catalog\/releases\/[^/]+\/transition$/.test(url.pathname)) { const releaseId = decodeURIComponent(url.pathname.split('/')[5] ?? ''); const payload = await body(request); const trustStatus = text(payload.trustStatus, 'trustStatus') as CatalogRelease['trustStatus']; const status = text(payload.status, 'status') as CatalogRelease['status']; if (!['UNVERIFIED', 'VERIFIED', 'REJECTED'].includes(trustStatus) || !['DISCOVERED', 'INSTALLED', 'ACTIVE', 'DISABLED', 'REMOVED'].includes(status)) throw new Error('Invalid release lifecycle status'); const release = await input.store.update((index) => { const target = index.catalogReleases.find((candidate) => candidate.id === releaseId); if (!target) throw new Error('Catalog release does not exist'); target.trustStatus = trustStatus; target.status = status; target.updatedAt = new Date().toISOString(); return target; }); await audit('catalog.release.transitioned', [release.id], { trustStatus, status }); return json(response, 200, release); }
      // A note on a capability or a service (D-196 to D-198): saved in place by kind and key. With nothing in it, removed.
      if (request.method === 'POST' && url.pathname === '/v1/access/item-notes') {
        const note = itemNoteOf(await body(request));
        const empty = !note.summary && !note.details && !note.dependencies.length && !note.examples.length;
        await input.store.update((index) => { index.itemNotes = index.itemNotes.filter((entry) => !(entry.kind === note.kind && entry.key === note.key)); if (!empty) index.itemNotes.push(note); });
        await audit('foundation-access.item-note.saved', [], { kind: note.kind, key: note.key, removed: empty });
        return json(response, 200, empty ? { removed: true } : note);
      }
      // An organization's choice of a service's settings (D-204): saved in place for its organization, workspace and service.
      // A setting given as null or "" is cleared; with none left, the record is removed.
      if (request.method === 'POST' && url.pathname === '/v1/access/service-settings') {
        const payload = await body(request); const organizationId = text(payload.organizationId, 'organizationId'); const workspaceId = optional(payload.workspaceId); const serviceKey = keyOf(payload.serviceKey, 'serviceKey');
        if (!payload.values || typeof payload.values !== 'object' || Array.isArray(payload.values)) throw new Error('Invalid values: an object of setting names and values, such as { "model": "claude-sonnet-5-5" }');
        const given = Object.entries(payload.values as Record<string, unknown>);
        if (given.length > 20) throw new Error('Invalid values: at most 20 settings');
        for (const [name, value] of given) {
          if (!/^[a-z][a-z0-9-]{0,39}$/.test(name)) throw new Error(`Invalid setting name ${name}: lowercase letters, digits and hyphens`);
          if (value !== null && value !== '' && (typeof value !== 'string' || value.length > 100)) throw new Error(`Invalid value for ${name}: text of at most 100 characters`);
        }
        const saved = await input.store.update((index) => {
          if (!index.organizations.some((entry) => entry.id === organizationId)) throw new Error('organizationId does not exist');
          if (workspaceId && !index.workspaces.some((entry) => entry.id === workspaceId && entry.organizationId === organizationId)) throw new Error('workspaceId does not exist for organizationId');
          const same = (record: ServiceSetting) => record.organizationId === organizationId && record.workspaceId === workspaceId && record.serviceKey === serviceKey;
          const values: Record<string, string> = { ...index.serviceSettings.find(same)?.values };
          for (const [name, value] of given) { if (value === null || value === '') delete values[name]; else values[name] = (value as string).trim(); }
          index.serviceSettings = index.serviceSettings.filter((record) => !same(record));
          if (!Object.keys(values).length) return undefined;
          const record: ServiceSetting = { organizationId, ...(workspaceId ? { workspaceId } : {}), serviceKey, values, updatedAt: new Date().toISOString() };
          index.serviceSettings.push(record);
          return record;
        });
        await audit('foundation-access.service-setting.saved', [organizationId, ...(workspaceId ? [workspaceId] : [])], { serviceKey, values: saved?.values ?? null });
        return json(response, 200, saved ?? { removed: true });
      }
      // An organization's choices for a capability (D-190): saved in place for its organization, workspace, capability and job.
      // With neither services nor way, the record is removed.
      if (request.method === 'POST' && url.pathname === '/v1/access/capability-choices') {
        const payload = await body(request); const organizationId = text(payload.organizationId, 'organizationId'); const workspaceId = optional(payload.workspaceId);
        const capabilityKey = keyOf(payload.capabilityKey, 'capabilityKey'); const jobKey = payload.jobKey === undefined || payload.jobKey === null || payload.jobKey === '' ? undefined : keyOf(payload.jobKey, 'jobKey');
        let services: string[] | undefined;
        if (payload.services !== undefined && payload.services !== null) {
          if (!Array.isArray(payload.services) || !payload.services.length || payload.services.length > 50) throw new Error('Invalid services: list 1 to 50 entries, or leave it out to allow every service');
          services = payload.services.map(serviceEntry);
          if (new Set(services).size !== services.length) throw new Error('Invalid services: an entry is repeated');
        }
        let way: ChoosingWay | undefined;
        if (payload.way !== undefined && payload.way !== null && payload.way !== '') { way = text(payload.way, 'way') as ChoosingWay; if (!['bound', 'dynamic', 'consensus'].includes(way)) throw new Error('Invalid way: bound, dynamic or consensus'); }
        const saved = await input.store.update((index) => {
          if (!index.organizations.some((entry) => entry.id === organizationId)) throw new Error('organizationId does not exist');
          if (workspaceId && !index.workspaces.some((entry) => entry.id === workspaceId && entry.organizationId === organizationId)) throw new Error('workspaceId does not exist for organizationId');
          const same = (record: CapabilityChoice) => record.organizationId === organizationId && record.workspaceId === workspaceId && record.capabilityKey === capabilityKey && record.jobKey === jobKey;
          index.capabilityChoices = index.capabilityChoices.filter((record) => !same(record));
          if (!services && !way) return undefined;
          const record: CapabilityChoice = { organizationId, ...(workspaceId ? { workspaceId } : {}), capabilityKey, ...(jobKey ? { jobKey } : {}), ...(services ? { services } : {}), ...(way ? { way } : {}), updatedAt: new Date().toISOString() };
          index.capabilityChoices.push(record);
          return record;
        });
        await audit('foundation-access.capability-choice.saved', [organizationId, ...(workspaceId ? [workspaceId] : [])], { capabilityKey, ...(jobKey ? { jobKey } : {}), services: services ?? null, way: way ?? null });
        return json(response, 200, saved ?? { removed: true });
      }
      // Approval before first use, on or off, for an organization or a workspace (D-192).
      if (request.method === 'POST' && /^\/v1\/access\/(organizations|workspaces)\/[^/]+\/service-approval$/.test(url.pathname)) {
        const [, , , kind, rawId] = url.pathname.split('/'); const id = decodeURIComponent(rawId ?? ''); const payload = await body(request);
        if (typeof payload.on !== 'boolean') throw new Error('on is required: true or false');
        const on = payload.on;
        const target = await input.store.update((index) => {
          const record = kind === 'organizations' ? index.organizations.find((entry) => entry.id === id) : index.workspaces.find((entry) => entry.id === id);
          if (!record) throw new Error(`${kind === 'organizations' ? 'Organization' : 'Workspace'} does not exist`);
          if (on) record.serviceApproval = true; else delete record.serviceApproval;
          return record;
        });
        await audit('foundation-access.service-approval.set', [id], { on });
        return json(response, 200, target);
      }
      // An administrator approves one service version for an organization (D-191).
      if (request.method === 'POST' && url.pathname === '/v1/access/service-approvals') {
        const payload = await body(request); const organizationId = text(payload.organizationId, 'organizationId'); const serviceVersionId = text(payload.serviceVersionId, 'serviceVersionId');
        const serviceKey = keyOf(payload.serviceKey, 'serviceKey'); const version = text(payload.version, 'version');
        const approval: ServiceApproval = { id: await input.core.issue('SERVICE_APPROVAL', { organizationId, serviceVersionId }), organizationId, serviceVersionId, serviceKey, version, approvedAt: new Date().toISOString() };
        await input.store.update((index) => {
          if (!index.organizations.some((entry) => entry.id === organizationId)) throw new Error('organizationId does not exist');
          if (index.serviceApprovals.some((entry) => entry.organizationId === organizationId && entry.serviceVersionId === serviceVersionId && !entry.revokedAt)) throw new Error('This service version is already approved for this organization');
          index.serviceApprovals.push(approval);
        });
        await audit('foundation-access.service.approved', [approval.id, organizationId, serviceVersionId], { serviceKey, version });
        return json(response, 201, approval);
      }
      if (request.method === 'POST' && /^\/v1\/access\/service-approvals\/[^/]+\/revoke$/.test(url.pathname)) {
        const approvalId = decodeURIComponent(url.pathname.split('/')[4] ?? '');
        const approval = await input.store.update((index) => { const target = index.serviceApprovals.find((entry) => entry.id === approvalId); if (!target) throw new Error('Approval does not exist'); if (!target.revokedAt) target.revokedAt = new Date().toISOString(); return target; });
        await audit('foundation-access.service.approval-revoked', [approval.id, approval.organizationId, approval.serviceVersionId]);
        return json(response, 200, approval);
      }
      if (request.method === 'POST' && url.pathname === '/v1/access/grants') { const payload = await body(request); const grant: AccessGrant = { id: await input.core.issue('ACCESS_GRANT'), granteeKind: text(payload.granteeKind, 'granteeKind') as AccessGrant['granteeKind'], granteeId: text(payload.granteeId, 'granteeId'), operations: stringArray(payload.operations, 'operations'), organizationId: optional(payload.organizationId), workspaceId: optional(payload.workspaceId), applicationKey: optional(payload.applicationKey), issuedByUserId: optional(payload.issuedByUserId), expiresAt: optional(payload.expiresAt), createdAt: new Date().toISOString() }; if (!['USER', 'APPLICATION', 'GROUP'].includes(grant.granteeKind)) throw new Error('Invalid granteeKind'); await input.store.update((index) => { index.grants.push(grant); }); await audit('access.grant.created', [grant.id, grant.granteeId]); return json(response, 201, grant); }
      if (request.method === 'POST' && /^\/v1\/access\/grants\/[^/]+\/revoke$/.test(url.pathname)) { const grantId = decodeURIComponent(url.pathname.split('/')[4] ?? ''); const grant = await input.store.update((index) => { const target = index.grants.find((entry) => entry.id === grantId); if (!target) throw new Error('Grant does not exist'); if (!target.revokedAt) target.revokedAt = new Date().toISOString(); return target; }); await audit('access.grant.revoked', [grant.id, grant.granteeId]); return json(response, 200, grant); }
      return json(response, 404, { error: 'Foundation Access endpoint not found.' });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Foundation Access error';
      const status = /bearer session token|Session token|Session is no longer active/i.test(message) ? 401 : /required|does not exist|already|Invalid|cannot|valid email|password must|password is too long|does not match/i.test(message) ? 400 : 500;
      return json(response, status, { error: message, traceId: randomUUID() });
    }
  });
}
