# SEMA Foundation Access

Local-first Foundation service for the administrative records shared by SEMA applications. It has no VectorForge, ListingForge, marketplace, or artwork workflow code.

## A service's settings (v0.12.0, D-204)

- `POST /v1/access/service-settings` saves an organization's choice of a service's settings, such as `{ "organizationId": "3-9rJ", "serviceKey": "neo.ai.claude", "values": { "model": "claude-sonnet-5-5" } }`, optionally for one workspace, whose values replace the organization's. A value given as `null` or `""` is cleared; with none left, the record is removed.
- The policy answer for a capability command gives them in `choices.settings`, by service key; Core hands each service its own with the work. The service offers the choices; it uses its own default for a value it does not offer.

## Notes on capabilities and services (v0.11.0, D-196 to D-198)

- `POST /v1/access/item-notes` saves the note on a capability or a service by `kind` (`capability` or `service`) and `key`: `summary` (what it does), `details`, `dependencies` (each `{ kind, name, note }`, kind one of account, setting, program, network, software, file, other) and `examples` (each `{ title, operation, request, result, note }`). A note with nothing in it is removed. At most 64 KB.
- `GET /v1/access/item-notes/<kind>/<key>` reads one, with the administrator key or Core's policy key; Core joins it with its records to describe the item.

## The organization's choices (v0.10.0, D-190 to D-195)

- `POST /v1/access/capability-choices` saves an organization's choices for a capability, optionally for one job and one workspace: `services`, an ordered list (a service key, or `key@version`) that is both what is allowed and the order tried, and `way`, the default way of choosing. Leaving out both removes the record.
- `POST /v1/access/organizations/:id/service-approval` and `/workspaces/:id/service-approval` with `{ "on": true }` turn on approval before first use; it is off unless turned on.
- `POST /v1/access/service-approvals` approves one service version for an organization; `/service-approvals/:id/revoke` withdraws it.
- `POST /v1/access/policy/evaluate` with `capabilityKey` (and `jobKey`, `workspaceId`) also returns the organization the command belongs to and its `choices`. A workspace Access does not know allows nothing.

## Existing Core policy configuration

Keep the Core policy configuration you already installed. In a completed Core
policy setup, `SEMA_POLICY_KEY` must continue to match Core, and
`SEMA_APPLICATION_KEY` / `SEMA_APPLICATION_SECRET` must remain the existing
Foundation Access application credential registered in Core. Do not blank or
replace any of those values for this update.

The policy endpoint is service-to-service only. It resolves a registered
application key to its Foundation application record and permits an operation
only when an unexpired, unretracted application grant matches that operation
(exact, `prefix.*`, or `core.*`).

## v0.3.0 local accounts, sessions, and administration

Foundation Access now owns local human sign-in records. It stores password
hashes and session records separately from the normal administrative index, so
an index export does not include password hashes or session tokens.

- Passwords are salted and hashed with Node's `scrypt` implementation; no
  plaintext password is stored.
- Sign-in returns a short-lived signed bearer session token. Applications will
  later exchange or validate that token through their own session boundary.
- Password reset and account disable revoke that user's active sessions.
- Login attempts are rate-limited by account: ten failed attempts lock that
  account for fifteen minutes.
- Existing users are preserved. An administrator assigns an initial password
  to the already-bootstrapped owner; no placeholder account or automatic grant
  is created.

This release provides the authority service and administrator API only. The
System Console is its administration client; it does not store passwords or
make permission decisions. This release also adds explicit, audited update
endpoints for user display names, memberships, organizations, workspaces, node
descriptions, application registry records, and grant revocation. VectorForge and
ListingForge remain on their current sign-in path until that integration is
tested.

## What it owns

- users, organizations, workspaces, memberships, and workspace storage registrations;
- application definitions and manifests;
- node descriptions: the name and a note for a node in SEMA Core's tree that has no organization or user record (a site, a machine, a group of people). Core holds the tree itself; an organization or user record with the same ID is already that node's name;
- catalog records for capabilities/services and their discovery → verification → install → activation lifecycle;
- scoped access-grant records.

Core remains the only issuer of permanent IDs and the audit authority. This service requests an ID from Core for each durable Foundation record and records the corresponding audit action. It never manufactures random permanent IDs.

## Deliberate v0.1.0 boundary

The service is a local administrative control-plane service. It does not replace Core policy enforcement, it does not make an application runnable only while this service is open, and it does not grant VectorForge, ListingForge, or the Resource Facility any access automatically. The Resource Facility remains private until it is upgraded to ask for a policy decision from this service/Core boundary.

The on-disk JSON store is the portable local-first persistence adapter for this initial package. Its contract is intentionally isolated in `src/store.ts` so a PostgreSQL implementation can replace it without changing the HTTP contracts.

## Setup

1. Copy `.env.example` to `.env` and replace every placeholder with a strong unique local value. Create a session key with:

   ```powershell
   node -e "console.log(require('node:crypto').randomBytes(48).toString('base64url'))"
   ```

   Put the result in `SEMA_AUTH_SESSION_KEY`. Do not reuse the Core policy key,
   application secret, or Resource Facility key for this value.
2. In `SEMA-Core`, set `SEMA_CORE_ADMIN_IDS` only after the Core host authorization upgrade is installed. During the current temporary loopback Core host phase, do not expose Core beyond `127.0.0.1`.
3. Install dependencies and start the service:

   ```powershell
   npm install
   npm run build
   npm start
   ```

4. Run the one-time bootstrap through the future System Console, or by calling `POST /v1/access/bootstrap` with `x-sema-access-bootstrap-key` and a body such as:

   ```json
   {
     "userDisplayName": "Mike Mingle",
     "organizationDisplayName": "NEO Software",
     "workspaces": ["Software Development", "Artwork & Production"]
   }
   ```

The bootstrap endpoint succeeds only once. Remove the bootstrap key from the environment after the first successful setup.

### Assign the initial owner password

For an existing bootstrapped installation, use the administrator key once to
assign the owner a password. The future System Console will do this through its
interface; until then, in PowerShell:

```powershell
$headers = @{ 'x-sema-access-admin-key' = '<your Foundation Access admin key>' }
$index = Invoke-RestMethod 'http://127.0.0.1:4340/v1/access/index' -Headers $headers
$owner = $index.users | Where-Object { $_.email -eq 'your-email@example.com' } | Select-Object -First 1
$body = @{ email = 'your-email@example.com'; password = '<a unique password of at least 12 characters>' } | ConvertTo-Json
$writeHeaders = @{ 'x-sema-access-admin-key' = '<your Foundation Access admin key>'; 'content-type' = 'application/json' }
Invoke-RestMethod "http://127.0.0.1:4340/v1/access/users/$($owner.id)/credentials" -Method Post -Headers $writeHeaders -Body $body
```

Do not paste the administrator key or password into a chat, script archive, or
source package.

## Important lifecycle rules

- A capability may be discovered without being usable.
- Catalog release lifecycle is explicit: `DISCOVERED → INSTALLED → ACTIVE`; verification status is separate.
- Application manifest import declares requested authority; it grants nothing.
- `POST /v1/access/node-descriptions` `{nodeId, displayName, note?}` sets or changes a node's name, one record per node, audited. It is refused for an ID that has an organization or user record. Access's own node records, from before Core kept the tree, were removed in 0.7.0; an older data file drops them when it is next saved.
- This package provides management records and Core application-policy evaluation. Multi-party rehome handshakes, signatures, package download/verification, and user sign-in remain later implementation work.
