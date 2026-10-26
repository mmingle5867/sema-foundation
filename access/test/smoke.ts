import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AuthStore } from '../src/auth-store.js';
import { AccessStore } from '../src/store.js';
import { CoreClient } from '../src/core-client.js';
import { createAccessServer } from '../src/server.js';

let sequence = 0;
const core = createServer(async (request, response) => {
  if (request.method === 'POST' && request.url === '/v1/core/identifiers/reservations') {
    sequence += 1;
    response.writeHead(201, { 'content-type': 'application/json' });
    return response.end(JSON.stringify({ reservation: { id: `reservation-${sequence}` }, identifiers: [{ id: `3-${sequence}` }] }));
  }
  if (request.method === 'POST' && (request.url === '/v1/core/identifiers/consume' || request.url === '/v1/core/runtime/audits')) { response.writeHead(200, { 'content-type': 'application/json' }); return response.end('{}'); }
  response.writeHead(404); response.end();
});
await new Promise<void>((resolve) => core.listen(4319, '127.0.0.1', resolve));
const dataDirectory = await mkdtemp(join(tmpdir(), 'sema-foundation-access-'));
const store = new AccessStore(dataDirectory);
const authStore = new AuthStore(dataDirectory);
await store.initialize();
await authStore.initialize();
const access = createAccessServer({ store, authStore, core: new CoreClient('http://127.0.0.1:4319'), adminKey: 'admin', bootstrapKey: 'bootstrap', policyKey: 'policy', sessionKey: 'a-local-test-session-key-that-is-long-enough', sessionTtlMinutes: 60 });
await new Promise<void>((resolve) => access.listen(4349, '127.0.0.1', resolve));
try {
  const bootstrap = await fetch('http://127.0.0.1:4349/v1/access/bootstrap', { method: 'POST', headers: { 'content-type': 'application/json', 'x-sema-access-bootstrap-key': 'bootstrap' }, body: JSON.stringify({ userDisplayName: 'Mike Mingle', email: 'mike@example.test', organizationDisplayName: 'NEO Software', workspaces: ['Software Development', 'Artwork & Production'], rootNodeDisplayName: 'NEO Software Local Node' }) });
  assert.equal(bootstrap.status, 201);
  const initial = await bootstrap.json() as { user: { id: string }; organization: { id: string } };
  const personResponse = await fetch('http://127.0.0.1:4349/v1/access/users', { method: 'POST', headers: { 'content-type': 'application/json', 'x-sema-access-admin-key': 'admin' }, body: JSON.stringify({ displayName: 'New Person' }) });
  assert.equal(personResponse.status, 201);
  const person = await personResponse.json() as { user: { id: string; email?: string } };
  assert.equal(person.user.email, undefined);
  const personCredentials = await fetch(`http://127.0.0.1:4349/v1/access/users/${person.user.id}/credentials`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-sema-access-admin-key': 'admin' }, body: JSON.stringify({ email: 'new.person@example.test', password: 'a-secure-local-test-password' }) });
  assert.equal(personCredentials.status, 200);
  const personMembership = await fetch('http://127.0.0.1:4349/v1/access/memberships', { method: 'POST', headers: { 'content-type': 'application/json', 'x-sema-access-admin-key': 'admin' }, body: JSON.stringify({ userId: person.user.id, organizationId: initial.organization.id, roleKeys: ['workspace.member'] }) });
  assert.equal(personMembership.status, 201);
  const profile = await fetch(`http://127.0.0.1:4349/v1/access/users/${initial.user.id}/profile`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-sema-access-admin-key': 'admin' }, body: JSON.stringify({ displayName: 'Michael Mingle' }) });
  assert.equal(profile.status, 200);
  const credentials = await fetch(`http://127.0.0.1:4349/v1/access/users/${initial.user.id}/credentials`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-sema-access-admin-key': 'admin' }, body: JSON.stringify({ email: 'mike@example.test', password: 'a-secure-local-test-password' }) });
  assert.equal(credentials.status, 200);
  const rejectedLogin = await fetch('http://127.0.0.1:4349/v1/access/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'mike@example.test', password: 'incorrect-password' }) });
  assert.equal(rejectedLogin.status, 401);
  const login = await fetch('http://127.0.0.1:4349/v1/access/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'mike@example.test', password: 'a-secure-local-test-password' }) });
  assert.equal(login.status, 200);
  const signedIn = await login.json() as { accessToken: string };
  const me = await fetch('http://127.0.0.1:4349/v1/access/auth/me', { headers: { authorization: `Bearer ${signedIn.accessToken}` } });
  assert.equal(me.status, 200);
  const logout = await fetch('http://127.0.0.1:4349/v1/access/auth/logout', { method: 'POST', headers: { authorization: `Bearer ${signedIn.accessToken}` } });
  assert.equal(logout.status, 200);
  const expired = await fetch('http://127.0.0.1:4349/v1/access/auth/me', { headers: { authorization: `Bearer ${signedIn.accessToken}` } });
  assert.equal(expired.status, 401);
  // A node in Core's tree gets its name here. An organization or user record with the same ID is already its name.
  const adminHeaders = { 'content-type': 'application/json', 'x-sema-access-admin-key': 'admin' };
  const describeNode = (body: unknown) => fetch('http://127.0.0.1:4349/v1/access/node-descriptions', { method: 'POST', headers: adminHeaders, body: JSON.stringify(body) });
  const site = await describeNode({ nodeId: '3-9rJ-3', displayName: 'Office', note: 'Main building' });
  assert.equal(site.status, 200);
  assert.deepEqual(Object.keys(await site.json()).sort(), ['displayName', 'nodeId', 'note', 'updatedAt']);
  assert.equal((await describeNode({ nodeId: '3-9rJ-3', displayName: 'NEO Software office' })).status, 200, 'saving again changes the name');
  const named = (await (await fetch('http://127.0.0.1:4349/v1/access/index', { headers: adminHeaders })).json()) as { nodeDescriptions: Array<{ nodeId: string; displayName: string; note?: string }> };
  assert.deepEqual(named.nodeDescriptions.map((entry) => [entry.nodeId, entry.displayName, entry.note ?? null]), [['3-9rJ-3', 'NEO Software office', null]], 'one description per node, replaced in place');
  assert.equal((await describeNode({ nodeId: initial.organization.id, displayName: 'Other' })).status, 400, 'an organization keeps its name on its organization record');
  assert.equal((await describeNode({ nodeId: initial.user.id, displayName: 'Other' })).status, 400, 'a user keeps its name on its user record');
  assert.equal((await describeNode({ nodeId: '3--3', displayName: 'Bad' })).status, 400);
  assert.equal((await describeNode({ nodeId: '3-9rJ-4' })).status, 400, 'a name is required');
  assert.equal((await fetch('http://127.0.0.1:4349/v1/access/node-descriptions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ nodeId: '3-4', displayName: 'x' }) })).status, 403);
  assert.equal((await fetch('http://127.0.0.1:4349/v1/access/nodes', { headers: adminHeaders })).status, 404, 'the old node records are gone');
  const application = await fetch('http://127.0.0.1:4349/v1/access/applications/import', { method: 'POST', headers: { 'content-type': 'application/json', 'x-sema-access-admin-key': 'admin' }, body: JSON.stringify({ applicationKey: 'vectorforge', displayName: 'VectorForge', version: '0.71.3', manifest: { declaredActions: ['asset.import', 'asset.publish'] } }) });
  assert.equal(application.status, 201);
  const applicationRecord = await application.json() as { id: string };
  // An application outside SEMA (D-177): each installation gets its own basis, a fresh ID from Core.
  const admin = { 'content-type': 'application/json', 'x-sema-access-admin-key': 'admin' };
  // An application's key is its permanent name; an outside one starts with its company and is never sema.
  const register = (applicationKey: string, outside: boolean) => fetch('http://127.0.0.1:4349/v1/access/applications/import', { method: 'POST', headers: admin, body: JSON.stringify({ applicationKey, displayName: 'X', version: '0.1.0', outside }) });
  for (const [key, outsideApp, why] of [['Neo.Inventory', true, 'capitals'], ['neo inventory', true, 'a space'], ['neo..inventory', true, 'an empty part'], ['inventory', true, 'no company'], ['sema.inventory', true, 'reserved'], ['neo_inventory', false, 'an underscore']] as const) {
    const refused = await register(key, outsideApp);
    assert.equal(refused.status, 400, `${key} is refused: ${why}`);
    assert.match(((await refused.json()) as { error: string }).error, /Invalid applicationKey/);
  }
  const outsideResponse = await fetch('http://127.0.0.1:4349/v1/access/applications/import', { method: 'POST', headers: admin, body: JSON.stringify({ applicationKey: 'neo.inventory', displayName: 'Inventory', version: '0.1.0', outside: true }) });
  assert.equal(outsideResponse.status, 201);
  const outsideApp = await outsideResponse.json() as { id: string; outside: { bases: unknown[] } };
  assert.deepEqual(outsideApp.outside, { bases: [] });
  const addBasis = (applicationId: string, label: string, headers: Record<string, string> = admin) => fetch(`http://127.0.0.1:4349/v1/access/applications/${applicationId}/bases`, { method: 'POST', headers, body: JSON.stringify({ label }) });
  const office = await addBasis(outsideApp.id, 'Office PC');
  assert.equal(office.status, 201);
  const officeBody = await office.json() as { basis: { id: string; label: string }; application: { outside: { bases: Array<{ id: string }> } } };
  const shop = await (await addBasis(outsideApp.id, 'Shop laptop')).json() as { basis: { id: string }; application: { outside: { bases: Array<{ id: string }> } } };
  assert.notEqual(officeBody.basis.id, shop.basis.id, 'each installation has its own basis');
  assert.notEqual(officeBody.basis.id, outsideApp.id, "the application's own ID is never a basis");
  assert.deepEqual(shop.application.outside.bases.map((basis) => basis.id), [officeBody.basis.id, shop.basis.id]);
  assert.equal((await addBasis(outsideApp.id, 'office pc')).status, 400, 'labels do not repeat');
  assert.equal((await addBasis(applicationRecord.id, 'Office PC')).status, 400, 'only an outside application gets bases');
  assert.equal((await addBasis(outsideApp.id, 'Another', { 'content-type': 'application/json' })).status, 403, 'administration is required');
  const noteResponse = await fetch('http://127.0.0.1:4349/v1/access/testing-notes', { method: 'POST', headers: { 'content-type': 'application/json', 'x-sema-access-admin-key': 'admin' }, body: JSON.stringify({ subjectKind: 'APPLICATION', subjectId: applicationRecord.id, kind: 'CHANGE_REQUEST', priority: 'NORMAL', title: 'Add clear test feedback', detail: 'Capture review notes for later implementation.' }) });
  assert.equal(noteResponse.status, 201);
  const note = await noteResponse.json() as { id: string };
  const packetResponse = await fetch('http://127.0.0.1:4349/v1/access/change-packets', { method: 'POST', headers: { 'content-type': 'application/json', 'x-sema-access-admin-key': 'admin' }, body: JSON.stringify({ noteIds: [note.id] }) });
  assert.equal(packetResponse.status, 201);
  const coreNoteResponse = await fetch('http://127.0.0.1:4349/v1/access/testing-notes', { method: 'POST', headers: { 'content-type': 'application/json', 'x-sema-access-admin-key': 'admin' }, body: JSON.stringify({ subjectKind: 'CORE', subjectId: 'sema.core', kind: 'TEST_NOTE', priority: 'LOW', title: 'Core health note', detail: 'Capture a Core-specific testing note.' }) });
  assert.equal(coreNoteResponse.status, 201);
  const grant = await fetch('http://127.0.0.1:4349/v1/access/grants', { method: 'POST', headers: { 'content-type': 'application/json', 'x-sema-access-admin-key': 'admin' }, body: JSON.stringify({ granteeKind: 'APPLICATION', granteeId: applicationRecord.id, operations: ['core.identifiers.*'] }) });
  assert.equal(grant.status, 201);
  const decision = await fetch('http://127.0.0.1:4349/v1/access/policy/evaluate', { method: 'POST', headers: { 'content-type': 'application/json', 'x-sema-access-policy-key': 'policy' }, body: JSON.stringify({ applicationKey: 'vectorforge', operation: 'core.identifiers.reserve' }) });
  assert.deepEqual(await decision.json(), { allowed: true, applicationKey: 'vectorforge', operation: 'core.identifiers.reserve' });
  const catalog = await fetch('http://127.0.0.1:4349/v1/access/catalog/releases', { method: 'POST', headers: { 'content-type': 'application/json', 'x-sema-access-admin-key': 'admin' }, body: JSON.stringify({ capabilityKey: 'sema.image.vectorize', providerKey: 'selo', serviceKey: 'vectorize.local', version: '1.0.0', displayName: 'Local Vectorize' }) });
  assert.equal(catalog.status, 201);
  const release = await catalog.json() as { id: string };
  const transition = await fetch(`http://127.0.0.1:4349/v1/access/catalog/releases/${release.id}/transition`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-sema-access-admin-key': 'admin' }, body: JSON.stringify({ trustStatus: 'VERIFIED', status: 'ACTIVE' }) });
  assert.equal(transition.status, 200);
  // The organization's choices (D-190 to D-195).
  const post = (path: string, value: unknown, headers: Record<string, string> = admin) => fetch(`http://127.0.0.1:4349${path}`, { method: 'POST', headers, body: JSON.stringify(value) });
  const organizationId = initial.organization.id;
  const workspaces = await (await fetch('http://127.0.0.1:4349/v1/access/workspaces', { headers: admin })).json() as Array<{ id: string; organizationId: string }>;
  const workspaceId = workspaces[0]!.id;
  const evaluate = async (value: Record<string, unknown>) => (await post('/v1/access/policy/evaluate', { applicationKey: 'vectorforge', ...value }, { 'content-type': 'application/json', 'x-sema-access-policy-key': 'policy' })).json() as Promise<Record<string, unknown>>;
  assert.equal((await post('/v1/access/grants', { granteeKind: 'APPLICATION', granteeId: applicationRecord.id, operations: ['capability.sema.ai.generate'], organizationId })).status, 201);
  // No record: nothing narrowed, no approval needed.
  assert.deepEqual(await evaluate({ operation: 'capability.sema.ai.generate', capabilityKey: 'sema.ai.generate' }), { allowed: true, applicationKey: 'vectorforge', operation: 'capability.sema.ai.generate', organizationId, choices: { lists: [], approvalRequired: false, approved: [], settings: {} } });
  assert.deepEqual(Object.keys(await evaluate({ operation: 'capability.sema.ai.generate' })).sort(), ['allowed', 'applicationKey', 'operation'], 'without a capability the answer is as before');
  const choose = (value: Record<string, unknown>) => post('/v1/access/capability-choices', { organizationId, capabilityKey: 'sema.ai.generate', ...value });
  assert.equal((await choose({ services: ['neo.ai.claude', 'neo.ai.local@1.2.0'], way: 'dynamic' })).status, 200);
  assert.equal((await choose({ jobKey: 'listing-copy', services: ['neo.ai.claude'] })).status, 200);
  assert.equal((await choose({ workspaceId, way: 'consensus' })).status, 200);
  for (const [bad, why] of [[{ services: [] }, 'an empty list'], [{ services: ['Neo.Claude'] }, 'capitals'], [{ services: ['a@1@2'] }, 'two versions'], [{ services: ['a', 'a'] }, 'a repeat'], [{ way: 'policy' }, 'not a default way'], [{ workspaceId: 'nope', way: 'bound' }, 'an unknown workspace']] as const) assert.equal((await choose(bad)).status, 400, `refused: ${why}`);
  assert.equal((await choose({ way: 'bound' }).then(() => post('/v1/access/capability-choices', { organizationId, capabilityKey: 'sema.ai.generate', way: 'bound' }, { 'content-type': 'application/json' }))).status, 403, 'administration is required');
  await choose({ services: ['neo.ai.claude', 'neo.ai.local@1.2.0'], way: 'dynamic' });
  // In a workspace, for the job: the most specific list first, the workspace's way.
  const inWorkspace = await evaluate({ operation: 'capability.sema.ai.generate', capabilityKey: 'sema.ai.generate', jobKey: 'listing-copy', workspaceId });
  assert.deepEqual(inWorkspace.choices, { lists: [['neo.ai.claude'], ['neo.ai.claude', 'neo.ai.local@1.2.0']], way: 'consensus', approvalRequired: false, approved: [], settings: {} });
  assert.equal(inWorkspace.workspaceId, workspaceId);
  assert.deepEqual((await evaluate({ operation: 'capability.sema.ai.generate', capabilityKey: 'sema.ai.generate' })).choices, { lists: [['neo.ai.claude', 'neo.ai.local@1.2.0']], way: 'dynamic', approvalRequired: false, approved: [], settings: {} }, 'another job or no workspace: only what applies');
  assert.equal((await evaluate({ operation: 'capability.sema.ai.generate', capabilityKey: 'sema.ai.generate', workspaceId: 'unknown' })).allowed, false, 'an unknown workspace allows nothing');
  // Approval before first use: off unless turned on; per service version.
  assert.equal((await post(`/v1/access/workspaces/${workspaceId}/service-approval`, { on: true })).status, 200);
  assert.equal(((await evaluate({ operation: 'capability.sema.ai.generate', capabilityKey: 'sema.ai.generate', workspaceId })).choices as { approvalRequired: boolean }).approvalRequired, true, 'a workspace may turn it on for itself');
  assert.equal(((await evaluate({ operation: 'capability.sema.ai.generate', capabilityKey: 'sema.ai.generate' })).choices as { approvalRequired: boolean }).approvalRequired, false, 'not for the rest of the organization');
  assert.equal((await post(`/v1/access/organizations/${organizationId}/service-approval`, { on: 'yes' })).status, 400);
  assert.equal((await post(`/v1/access/organizations/${organizationId}/service-approval`, { on: true })).status, 200);
  const approvalResponse = await post('/v1/access/service-approvals', { organizationId, serviceVersionId: '3-sv1', serviceKey: 'neo.ai.claude', version: '0.3.2' });
  assert.equal(approvalResponse.status, 201);
  const approval = await approvalResponse.json() as { id: string };
  assert.equal((await post('/v1/access/service-approvals', { organizationId, serviceVersionId: '3-sv1', serviceKey: 'neo.ai.claude', version: '0.3.2' })).status, 400, 'approved once');
  assert.deepEqual((await evaluate({ operation: 'capability.sema.ai.generate', capabilityKey: 'sema.ai.generate' })).choices, { lists: [['neo.ai.claude', 'neo.ai.local@1.2.0']], way: 'dynamic', approvalRequired: true, approved: ['3-sv1'], settings: {} });
  assert.equal((await post(`/v1/access/service-approvals/${approval.id}/revoke`, {})).status, 200);
  assert.deepEqual(((await evaluate({ operation: 'capability.sema.ai.generate', capabilityKey: 'sema.ai.generate' })).choices as { approved: string[] }).approved, [], 'a revoked approval no longer counts');
  // Saving with neither services nor way removes the record.
  assert.deepEqual(await (await choose({})).json(), { removed: true });
  assert.deepEqual(((await evaluate({ operation: 'capability.sema.ai.generate', capabilityKey: 'sema.ai.generate' })).choices as { lists: unknown[] }).lists, []);
  // A service's settings (D-204): the organization's, with a workspace's values replacing them, given with the may answer.
  const setting = (value: Record<string, unknown>) => post('/v1/access/service-settings', { organizationId, serviceKey: 'neo.ai.claude', ...value });
  assert.equal((await setting({ values: { model: 'claude-sonnet-5-5', effort: 'low' } })).status, 200);
  assert.equal((await setting({ workspaceId, values: { model: 'claude-haiku-5-5' } })).status, 200);
  const settingsOf = async (value: Record<string, unknown>) => ((await evaluate({ operation: 'capability.sema.ai.generate', capabilityKey: 'sema.ai.generate', ...value })).choices as { settings: unknown }).settings;
  assert.deepEqual(await settingsOf({}), { 'neo.ai.claude': { model: 'claude-sonnet-5-5', effort: 'low' } });
  assert.deepEqual(await settingsOf({ workspaceId }), { 'neo.ai.claude': { model: 'claude-haiku-5-5', effort: 'low' } }, 'the workspace replaces the model, keeps the effort');
  for (const [bad, why] of [[{ values: [] }, 'a list'], [{ values: { Model: 'x' } }, 'a setting name'], [{ values: { model: 5 } }, 'a value'], [{ serviceKey: 'Neo AI', values: { model: 'x' } }, 'a service key'], [{ workspaceId: 'nope', values: { model: 'x' } }, 'an unknown workspace']] as const) assert.equal((await setting(bad)).status, 400, `refused: ${why}`);
  assert.equal((await post('/v1/access/service-settings', { organizationId, serviceKey: 'neo.ai.claude', values: { model: 'x' } }, { 'content-type': 'application/json' })).status, 403, 'administration is required');
  assert.deepEqual(((await (await setting({ values: { effort: null } })).json()) as { values: unknown }).values, { model: 'claude-sonnet-5-5' }, 'a setting given as null is cleared');
  assert.deepEqual(await (await setting({ workspaceId, values: { model: '' } })).json(), { removed: true }, 'with none left, the record goes');
  assert.deepEqual(await settingsOf({ workspaceId }), { 'neo.ai.claude': { model: 'claude-sonnet-5-5' } });
  await setting({ values: { model: null } });
  assert.deepEqual(await settingsOf({}), {});
  // Notes on capabilities and services (D-196 to D-198).
  const itemNote = { kind: 'service', key: 'neo.ai.claude', summary: 'Answers Ask an AI with Claude.', details: 'Uses the Messages API.', dependencies: [{ kind: 'account', name: 'Anthropic', note: 'An API account.' }, { kind: 'setting', name: 'ANTHROPIC_API_KEY' }], examples: [{ title: 'Listing copy', operation: 'generate', request: { job: { key: 'listing-copy' } }, result: { title: 'A mug' } }] };
  const saved = await post('/v1/access/item-notes', itemNote);
  assert.equal(saved.status, 200);
  assert.deepEqual(Object.keys(await saved.json()).sort(), ['dependencies', 'details', 'examples', 'key', 'kind', 'summary', 'updatedAt']);
  const read = (headers: Record<string, string>) => fetch('http://127.0.0.1:4349/v1/access/item-notes/service/neo.ai.claude', { headers });
  assert.equal(((await (await read({ 'x-sema-access-policy-key': 'policy' })).json()) as { summary: string }).summary, 'Answers Ask an AI with Claude.', 'Core reads notes with the policy key');
  assert.equal((await read({ 'x-sema-access-admin-key': 'admin' })).status, 200);
  assert.equal((await read({})).status, 403);
  assert.equal((await fetch('http://127.0.0.1:4349/v1/access/item-notes/capability/neo.ai.claude', { headers: admin })).status, 404, 'kinds are kept apart');
  for (const [bad, why] of [[{ ...itemNote, kind: 'node' }, 'a kind'], [{ ...itemNote, key: 'Neo AI' }, 'a key'], [{ ...itemNote, dependencies: [{ kind: 'friend', name: 'x' }] }, 'a dependency kind'], [{ ...itemNote, dependencies: [{ kind: 'account' }] }, 'a dependency with no name'], [{ ...itemNote, examples: [{ title: 'x' }] }, 'an example with no request'], [{ ...itemNote, summary: 'x'.repeat(1001) }, 'a long summary']] as const) assert.equal((await post('/v1/access/item-notes', bad)).status, 400, `refused: ${why}`);
  assert.equal((await post('/v1/access/item-notes', itemNote, { 'content-type': 'application/json' })).status, 403, 'administration is required to write');
  assert.equal(((await (await fetch('http://127.0.0.1:4349/v1/access/index', { headers: admin })).json()) as { itemNotes: unknown[] }).itemNotes.length, 1, 'saving again replaces the itemNote');
  assert.deepEqual(await (await post('/v1/access/item-notes', { kind: 'service', key: 'neo.ai.claude' })).json(), { removed: true }, 'an empty itemNote is removed');
  assert.equal((await read({ 'x-sema-access-policy-key': 'policy' })).status, 404);
  console.log('Foundation Access smoke test passed.');
} finally {
  await new Promise<void>((resolve, reject) => access.close((error) => error ? reject(error) : resolve()));
  await new Promise<void>((resolve, reject) => core.close((error) => error ? reject(error) : resolve()));
}
