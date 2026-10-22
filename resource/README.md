# SEMA Foundation Resource v0.4.0

This is the policy-controlled boundary for published resources. It stores only explicitly published versions and never accepts private source paths, application databases, or end-user share credentials.

Set a strong `SEMA_RESOURCE_ADMIN_KEY`, start the service, then run `npm run sema:core:bootstrap`. Application services publish approved bytes with the service credential. Receiving applications use their application key and receive only resources covered by an explicit grant.

This release adds a mandatory Foundation Access policy check before the catalog or resource bytes are returned. Set these values in the service `.env`:

```env
SEMA_FOUNDATION_ACCESS_URL="http://127.0.0.1:4340"
SEMA_POLICY_KEY="the-same-policy-key-used-by-Foundation-Access"
```

Both gates must pass: Foundation Access must authorize the application's requested operation, and the service must have an unexpired exact resource/version grant. `GET /v1/resources/admin/index` is loopback administration data only and requires `x-sema-admin-key`; it exists for System Console's Resource Access page. It never returns resource bytes.

This local v0.2.0 establishes the contracts and audit boundary. It is intentionally loopback-only; enterprise service identities, signed user sessions, encrypted offline caches, and remote shared-storage adapters will be added through the same policy contract rather than embedded in Forge applications.

## Groups (0.3.0)

Files shared together, such as every output of one artwork, belong to a group. `POST /v1/resources/groups` (service credential) saves or replaces a group: `{groupId, workspaceId, ownerId, title, description?, categories: [{categoryId, name, path}], source: {applicationKey, artworkId?}}`. The group's ID is the ID of the thing the files came from, so sharing again updates the same group and no new ID is used. A published file names its group with `groupId` in its metadata; publishing into a group that does not exist is refused. The group keeps no list of its files: which files belong is read from their `groupId`.

The catalog (contract 1.1.0) returns `groups` beside `resources`: only groups holding at least one file the caller may see. Description and categories are as they were when shared, so a consumer has them even when the source application is closed.


## Capability records (0.4.0)

`npm run sema:core:bootstrap` registers Resource with Core the new way (D-151, D-159), and is safe to run again:

1. the two contracts, read from SEMA-Capabilities: `sema.foundation.resource.catalog` 1.1.0 (operation `list`) and `sema.foundation.resource.delivery` 1.0.1 (operation `read`);
2. this Resource version as a service of each (`sema.foundation.resource-facility`), and its installation on this machine;
3. the old single records, which programs still read to find Resource's address.

When Resource starts it records one running instance per installation with Core, checks in every `SEMA_RESOURCE_CHECK_IN_SECONDS` (default 60) with the memory it has free, and stops them when it stops. If Core cannot be reached, Resource says so and carries on serving files.

Grants Resource's application needs in Foundation Access: `core.capabilities.read`, `core.capabilities.register`, `core.services.install`, `core.services.run`; and `core.capabilities.approve` only while the set-up script runs the first time (the names are in the reserved `sema.` namespace), revoked afterwards.

`npm test` runs the smoke test, and a test of the set-up and instances against a real Core host in memory (needs Core built).
