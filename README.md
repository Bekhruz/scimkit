# scimkit

**SCIM 2.0 provisioning for Node.js and NestJS.** Let Okta, Microsoft Entra ID and any SCIM client create,
update and deactivate the users and groups of your application, free and self-hosted.

[![npm version](https://img.shields.io/npm/v/scimkit.svg)](https://www.npmjs.com/package/scimkit)
[![license](https://img.shields.io/npm/l/scimkit.svg)](LICENSE)
[![node](https://img.shields.io/node/v/scimkit.svg)](package.json)

```ts
import { ScimModule } from 'scimkit/nestjs';
import { PostgresScimStore } from 'scimkit/postgres';
import { bearerTokenAuth, ScimTokens } from 'scimkit';

ScimModule.forRoot({
  store: new PostgresScimStore({ pool }),
  authenticate: bearerTokenAuth(tokens), // one token per customer organization
  hooks: {
    onEvent: (event) => {
      if (event.type === 'user.deactivated') return sessions.revokeAll(event.id);
    },
  },
});
```

```console
$ npx scimkit verify https://app.example.com/scim/v2 --token $SCIM_TOKEN
SCIM 2.0 core protocol (RFC 7643, RFC 7644)
  ✔ Advertises its features at /ServiceProviderConfig
  ✔ Creates a user (201, Location, meta)
  ...
Okta provisioning
  ✔ Deactivates the user with a path-less replace
  ...
Microsoft Entra ID provisioning
  ✔ Removes the member with a value list
  ...
57 passed, 0 failed, 0 skipped in 0.4s
```

## Why

When a B2B product starts selling to larger companies, their IT teams ask for SCIM: their identity provider
(Okta, Microsoft Entra ID, OneLogin, JumpCloud, ...) should create accounts when people join, update them
when they change teams and switch them off the day they leave. Hosted directory-sync services charge per
customer connection, typically around $125 a month for each one, which adds up quickly when every enterprise
customer needs its own.

SCIM is an open standard ([RFC 7643](https://www.rfc-editor.org/rfc/rfc7643) and
[RFC 7644](https://www.rfc-editor.org/rfc/rfc7644)). scimkit is an independent, MIT-licensed implementation of
it that runs inside your application: no extra service, no per-connection fees, and the data stays in your
database.

## Highlights

- **The whole protocol.** Users, Groups, the Enterprise User extension and your own resource types and
  schemas. The full filter grammar, PATCH with value paths, sorting, pagination, `attributes` and
  `excludedAttributes`, ETags and `If-Match`, `/.search`, `/Bulk` with `bulkId` references, `/Me`, and the
  discovery endpoints.
- **Works with the clients you will meet.** A lenient compatibility mode accepts what Okta and Microsoft
  Entra ID actually send, such as `"op": "Replace"`, `"active": "False"`, a bare id as the manager value, and
  removing members by value list. Each of these is listed [below](#compatibility). `strict` mode follows the
  RFCs to the letter.
- **A conformance checker included.** `scimkit verify` replays the request sequences Okta and Entra send,
  plus the core protocol, against any SCIM endpoint (yours, or one written without scimkit), then cleans up.
  It is also available as an API for your own test suite.
- **Multi-tenant from the start.** Every operation is scoped to the tenant of the bearer token. Per-tenant
  tokens are stored as SHA-256 hashes and compared in constant time; they can expire and be revoked.
- **Storage your way.** A PostgreSQL store (JSONB, indexed, transactional, with group membership in its own
  table) and an in-memory store come built in. Or implement a five-method repository over your own tables.
  [See the example](examples/custom-repository/repositories.ts).
- **Hooks and events.** Reject writes, for example when a tenant is out of seats. React to
  `user.deactivated`, `group.members.added` and the other events. Receive passwords, which are never
  stored, through a hook.
- **Any framework.** A NestJS module (Express or Fastify), a Node `(req, res)` handler for `http`, Express and
  Connect, and a Fetch `Request → Response` handler for Hono, Bun, Deno and Next.js.
- **No runtime dependencies.** `pg` and NestJS are optional peer dependencies, used only by the entries that
  need them. ESM and CommonJS, with types for both.

## Install

```sh
pnpm add scimkit
pnpm add pg          # for PostgreSQL storage and the database CLI commands
```

Node.js 22.12 or later. NestJS 10, 11 or 12. PostgreSQL 13 or later.

## Quick start

### NestJS

```ts
import { Module } from '@nestjs/common';
import pg from 'pg';
import { bearerTokenAuth, ScimTokens } from 'scimkit';
import { ScimModule } from 'scimkit/nestjs';
import { PostgresScimStore, PostgresTokenStore } from 'scimkit/postgres';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const store = new PostgresScimStore({ pool });
const tokens = new ScimTokens(new PostgresTokenStore({ pool }));

@Module({
  imports: [
    ScimModule.forRoot({
      store,
      authenticate: bearerTokenAuth(tokens),
      // Exempt the SCIM routes from your global session guard; SCIM clients bring their own token.
      decorators: [Public()],
    }),
  ],
})
export class AppModule {}
```

Create the tables once, or on every start, since migrations are idempotent and safe to run concurrently:

```sh
npx scimkit migrate --database-url "$DATABASE_URL"
```

The module serves SCIM at `/scim/v2` (below any global prefix) on Express and on Fastify. `forRootAsync`
takes `imports`, `inject` and `useFactory`, or `useClass` / `useExisting`. The `ScimServer` is exported for
injection. The complete example, with a global guard, Postgres-or-memory storage and session revocation, is
in [`examples/nestjs`](examples/nestjs/app.module.ts).

### Express or Node `http`

```ts
import express from 'express';
import { createNodeHandler, MemoryScimStore, ScimServer, staticTokenAuth } from 'scimkit';

const scim = new ScimServer({
  store: new MemoryScimStore(),
  authenticate: staticTokenAuth({ token: process.env.SCIM_TOKEN!, tenantId: 'default' }),
});

const app = express();
app.use('/scim/v2', createNodeHandler(scim));
app.listen(3000);
```

With plain `http`: `createServer(createNodeHandler(scim, { basePath: '/scim/v2' }))`.

### Hono, Bun, Deno, Next.js

```ts
import { createFetchHandler } from 'scimkit';

const handle = createFetchHandler(scim, { basePath: '/scim/v2' });

// Hono:     app.all('/scim/v2/*', (c) => handle(c.req.raw));
// Bun:      Bun.serve({ fetch: handle });
// Next.js:  export const GET = handle, POST = handle, PUT = handle, PATCH = handle, DELETE = handle;
```

## Connect an identity provider

1. Issue a token for the customer's organization:

   ```sh
   npx scimkit token create --tenant acme --label "Okta production" --database-url "$DATABASE_URL"
   ```

2. In the identity provider, enter the base URL (`https://app.example.com/scim/v2`) and the token as an
   HTTP bearer token.
3. Check the endpoint with `npx scimkit verify https://app.example.com/scim/v2 --token <token>` before you
   switch provisioning on.

Step-by-step guides: [Okta](docs/okta.md) · [Microsoft Entra ID](docs/entra.md).

## Tenants and tokens

Every request runs in a tenant: the `tenantId` of the principal that `authenticate` returns. Repositories
receive it in `context.tenantId`, and the built-in stores keep each tenant's resources apart, including
uniqueness: two customers may both have `ann@example.com`.

```ts
import { bearerTokenAuth, ScimTokens } from 'scimkit';
import { PostgresTokenStore } from 'scimkit/postgres';

const tokens = new ScimTokens(new PostgresTokenStore({ pool }));
const { token, record } = await tokens.issue('acme', { label: 'Okta', expiresAt: inOneYear });
// token: scim_9f2c…_Qk3…  shown once; only its SHA-256 hash is stored.
await tokens.revoke(record.id);
```

| Function                                | Use                                                             |
| --------------------------------------- | --------------------------------------------------------------- |
| `bearerTokenAuth(tokens)`               | Tokens issued by `ScimTokens`, one or more per tenant.          |
| `bearerTokenAuth((token) => principal)` | Your own verification, such as a JWT or an API key table.       |
| `staticTokenAuth({ token, tenantId })`  | Fixed tokens from configuration, for single-tenant deployments. |
| `authenticate: (request) => principal`  | Anything else: mTLS headers, path-based tenants, ...            |

Tokens look like `scim_<24 hex>_<43 base64url>`; the prefix makes leaked tokens easy to find with secret
scanners. `lastUsedAt` is recorded at most once a minute.

## Storage

### PostgreSQL

```ts
const store = new PostgresScimStore({
  pool, // a pg.Pool
  schema: 'public', // default
  tablePrefix: 'scim_', // default: scim_resources, scim_group_members, scim_tokens, scim_migrations
  memberReferences: 'reject', // or 'ignore' to drop members that do not exist
});
await store.migrate();
```

Resources live in one table with their attributes as JSONB (GIN-indexed), plus indexed columns for `id`,
`externalId`, `userName` (unique per tenant, case-insensitively) and `displayName`. Group membership has its
own table with foreign keys, so deleting a user removes it from its groups and membership queries stay
indexed. Every write is a transaction, versions use optimistic concurrency, and SCIM filters compile to
parameterized SQL that gives exactly the results of the in-memory evaluator (a shared contract suite runs
against both). `migrationSql()` returns the DDL for your own migration tool.

### Your own tables

Implement `ScimRepository` for each resource type and pass `repositories: { User, Group }`:

```ts
interface ScimRepository {
  create(context, attributes): Promise<StoredResource>;
  get(context, id, options?): Promise<StoredResource | undefined>;
  list(context, query): Promise<ListResult>;
  replace(context, id, attributes, options?): Promise<StoredResource>;
  delete(context, id, options?): Promise<boolean>;
}
```

scimkit validates and normalizes attributes before they reach you, applies PATCH operations, checks
`If-Match`, projects attributes and builds every response, so a repository only stores and finds data.
`simpleEquality(query.filter)` turns the filters identity providers send (`userName eq "x"`,
`id eq "g" and members[value eq "u"]`) into plain conditions for a WHERE clause.
[`examples/custom-repository`](examples/custom-repository/repositories.ts) maps SCIM onto a typical
`users` / `teams` schema and passes every `scimkit verify` check. [Read the guide](docs/custom-repository.md).

### Memory

`new MemoryScimStore()` behaves like the PostgreSQL store and suits tests, examples and prototypes.

## Hooks and events

```ts
new ScimServer({
  // ...
  hooks: {
    // Before anything is stored: throw to reject, return attributes to store instead.
    beforeWrite: async ({ action, context, attributes }) => {
      if (action === 'create' && (await seats.remaining(context.tenantId)) === 0) {
        throw ScimError.forbidden('This organization has no seats left.');
      }
      return undefined;
    },
    // After a write is stored.
    onEvent: async (event) => {
      switch (event.type) {
        case 'user.deactivated':
          await sessions.revokeAll(event.id);
          break;
        case 'group.members.added':
          await permissions.grant(event.id, event.members);
          break;
      }
    },
    // Passwords sent by the client go here and nowhere else.
    setPassword: async (context, { id, password }) => auth.setPassword(id, password),
  },
});
```

Events: `resource.created`, `resource.updated` (with `previous` and `operation: 'replace' | 'patch'`),
`resource.deleted`, `user.deactivated`, `user.reactivated`, `group.members.added` and
`group.members.removed`. They are delivered after the write has been stored. A failing handler is logged and
does not change the response, so for guaranteed delivery write to an outbox inside your repository.

## Compatibility

`compatibility: 'lenient'` (the default) accepts the following departures from RFC 7643/7644, all of which
real clients send. `compatibility: 'strict'` rejects them.

| Accepted in lenient mode                                                                                      | Sent by            |
| ------------------------------------------------------------------------------------------------------------- | ------------------ |
| `"True"` / `"False"` for booleans, numeric strings for numbers                                                | Microsoft Entra ID |
| A bare id as the value of a complex attribute (`manager: "<id>"`)                                             | Microsoft Entra ID |
| Schema URIs the server does not know in `schemas`; missing `schemas`                                          | Microsoft Entra ID |
| A value filter that matches nothing on add/replace creates the value (`phoneNumbers[type eq "mobile"].value`) | Microsoft Entra ID |
| Read-only attributes inside a path-less PATCH value (`{"id": ..., "displayName": ...}`) are ignored           | Okta               |
| Unknown attributes are ignored (and logged at debug level)                                                    | many               |
| A single value where an array is expected                                                                     | many               |
| Flattened extension keys (`"urn:...:enterprise:2.0:User:department": "R&D"`)                                  | many               |
| Extension attributes without their URN prefix in filters, when unambiguous                                    | many               |
| Endpoint and query parameter names in any case; any request content type                                      | many               |
| Envelopes without `schemas` (PatchOp, SearchRequest, BulkRequest); bulk POSTs without `bulkId`                | many               |

In both modes PATCH operation names are case-insensitive, and a `remove` with a value list removes only the
listed values. That is how Entra removes group members, and the literal RFC reading would remove all of
them.

## Supported features

| Feature                                                  | Status                                                                            |
| -------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `/Users`, `/Groups`, custom resource types               | ✔ create, read, replace, patch, delete, list, `/.search`                          |
| Enterprise User extension, custom schemas and extensions | ✔ `defineSchema`, `defineResourceType`, `customizeSchema`                         |
| Filters                                                  | ✔ `eq ne co sw ew gt ge lt le pr`, `and or not`, value paths, URN-qualified paths |
| PATCH                                                    | ✔ add, remove, replace; paths with value filters and sub-attributes; atomic       |
| Sorting and pagination                                   | ✔ `sortBy`, `sortOrder`, `startIndex`, `count`                                    |
| `attributes`, `excludedAttributes`                       | ✔ on every read and write                                                         |
| ETags                                                    | ✔ `ETag`, `If-Match` (412), `If-None-Match` (304)                                 |
| `/Bulk`                                                  | ✔ `bulkId` references (also forward), `failOnErrors`, limits                      |
| `/.search` across resource types                         | ✔ without `sortBy`                                                                |
| `/Me`                                                    | ✔ with the `me` option                                                            |
| `/ServiceProviderConfig`, `/ResourceTypes`, `/Schemas`   | ✔                                                                                 |
| Group membership in a User's `groups`                    | ✔ direct memberships; nested groups as members                                    |
| Password changes                                         | ✔ through the `setPassword` hook; never stored                                    |

## `scimkit verify`

```sh
npx scimkit verify <base-url> [--token <token>] [--profile rfc,okta,entra] [--json] [--keep] [--header "Name: value"]
```

| Profile | Checks                                                                                                                                                                                                                                  |
| ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `rfc`   | Discovery, media type, create (201, Location, meta), uniqueness (409), case-insensitive filters, pagination, projection, PUT, PATCH, errors, `If-Match`, group membership, deletes                                                      |
| `okta`  | Okta's sequence: lookup before create, create with password and empty groups, PUT profile updates, path-less deactivate/reactivate, group push, rename with the id in the value, member removal                                         |
| `entra` | Entra's sequence: enterprise extension, value-filter updates, adding missing values, manager by bare id, `"False"`, groups with a non-SCIM schema URI, `excludedAttributes=members`, membership checks by filter, removal by value list |

Resources are named `scimkit-verify-<random>-…@example.com` and deleted afterwards (`--keep` leaves them in
place). The exit code is 1 when a check fails. Programmatically:

```ts
import { verifyScimEndpoint, formatReport } from 'scimkit/verify';

const report = await verifyScimEndpoint({ baseUrl, token, profiles: ['okta', 'entra'] });
expect(report.failed).toBe(0);
```

The profiles reproduce the request shapes these providers document and send. They help you find problems
early and do not replace a test with a real tenant before you go live.

## Configuration

`new ScimServer(options)`, or `ScimModule.forRoot(options)`:

| Option                                                                           | Default                        | Description                                                                                  |
| -------------------------------------------------------------------------------- | ------------------------------ | -------------------------------------------------------------------------------------------- |
| `authenticate`                                                                   | required                       | `(request) => principal \| undefined`; the principal carries `tenantId`.                     |
| `store`                                                                          |                                | Serves every resource type without an entry in `repositories`.                               |
| `repositories`                                                                   |                                | `{ [resourceTypeName]: ScimRepository }`.                                                    |
| `resourceTypes`                                                                  | User (with Enterprise), Group  | Resource types to serve.                                                                     |
| `baseUrl`                                                                        | derived from the request       | Absolute URL of the SCIM root, for `Location`, `meta.location`, `$ref`.                      |
| `compatibility`                                                                  | `'lenient'`                    | `'lenient'` or `'strict'`, see [Compatibility](#compatibility).                              |
| `hooks`                                                                          |                                | `beforeWrite`, `onEvent`, `setPassword`.                                                     |
| `logger`                                                                         | warnings and errors to console | `{ debug, info, warn, error }`; `silentLogger` discards. The Nest module uses Nest's logger. |
| `bulk`                                                                           | `true`                         | Serve `/Bulk`.                                                                               |
| `discoveryRequiresAuthentication`                                                | `true`                         | Require a token for the discovery endpoints.                                                 |
| `me`                                                                             |                                | `(context) => ({ resourceType, id })` for `/Me`.                                             |
| `documentationUri`, `authenticationSchemes`                                      |                                | Advertised in `/ServiceProviderConfig`.                                                      |
| `limits.maxResults`                                                              | 200                            | Most resources per page.                                                                     |
| `limits.defaultCount`                                                            | 100                            | Page size without `count`.                                                                   |
| `limits.maxPatchOperations`                                                      | 1000                           | Operations per PATCH.                                                                        |
| `limits.maxBulkOperations`, `limits.maxBulkPayloadBytes`                         | 1000, 1 MiB                    | Bulk limits.                                                                                 |
| `limits.maxFilterLength`, `limits.maxFilterDepth`, `limits.maxFilterComparisons` | 4096, 32, 128                  | Filter limits.                                                                               |

NestJS adds `path` (`'scim/v2'`), `decorators`, `bodyLimit` (5 MiB), `trustProxy` and `global`. The Node and
Fetch handlers take `basePath` and `bodyLimit`, and the Node handler also takes `trustProxy`.

## API

| Entry              | Exports                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `scimkit`          | `ScimServer`, `MemoryScimStore`, `ScimError`, `ScimTokens`, `MemoryTokenStore`, `bearerTokenAuth`, `staticTokenAuth`, `createNodeHandler`, `createFetchHandler`, `defineSchema`, `defineResourceType`, `customizeSchema`, `UserResourceType`, `GroupResourceType`, `USER_SCHEMA`, `GROUP_SCHEMA`, `ENTERPRISE_USER_SCHEMA`, `parseFilter`, `evaluateFilter`, `simpleEquality`, `consoleLogger`, `silentLogger`, and the types |
| `scimkit/postgres` | `PostgresScimStore`, `PostgresTokenStore`, `migrate`, `migrationSql`                                                                                                                                                                                                                                                                                                                                                          |
| `scimkit/nestjs`   | `ScimModule`, `SCIM_OPTIONS`                                                                                                                                                                                                                                                                                                                                                                                                  |
| `scimkit/verify`   | `verifyScimEndpoint`, `formatReport`, `rfcProfile`, `oktaProfile`, `entraProfile`                                                                                                                                                                                                                                                                                                                                             |

`server.handle(request)` takes a framework-neutral request (`method`, `path`, `query`, `headers`, `body`,
`baseUrl`) and resolves to `{ status, headers, body }`. It never throws, which makes it easy to adapt to any
framework and to test.

## Architecture

```
 Okta / Entra / any SCIM client
            │  HTTPS + bearer token
 ┌──────────▼──────────────────────────────────────────────────────────────┐
 │ adapters      ScimModule (NestJS) · createNodeHandler · createFetchHandler │
 ├──────────────────────────────────────────────────────────────────────────┤
 │ ScimServer    routing · authentication → tenant · discovery · bulk       │
 │               filter parser → resolved filter · PATCH engine             │
 │               validation & normalization · projection · ETags · hooks    │
 ├──────────────────────────────────────────────────────────────────────────┤
 │ repositories  PostgresScimStore · MemoryScimStore · your ScimRepository  │
 └──────────────────────────────────────────────────────────────────────────┘
```

More in [docs/architecture.md](docs/architecture.md).

## Security

- Tokens are stored as SHA-256 hashes, compared in constant time, and can expire and be revoked.
- Tenant isolation is enforced in every query of the built-in stores and tested.
- Filters compile to parameterized SQL, and identifiers are validated. Filter length, depth and size are
  limited, as are PATCH and bulk sizes and request bodies.
- Passwords never reach storage or responses. Prototype-polluting keys (`__proto__`, ...) are dropped.
- Unexpected errors are logged with a request id and answered with a generic 500.

Report vulnerabilities as described in [SECURITY.md](SECURITY.md).

## Development

There is no hosted CI to wait for: the full gate runs on your machine.

```sh
pnpm install          # also installs the pre-push hook
pnpm ci               # format, lint, typecheck, tests + coverage against a disposable PostgreSQL, build, package checks, audit
pnpm ci:matrix        # Node.js 22/24/26 in clean containers, PostgreSQL 13/16/17/18
pnpm release          # everything a release needs, ending with `npm publish --dry-run`
```

See [CONTRIBUTING.md](CONTRIBUTING.md) and [docs/local-ci.md](docs/local-ci.md).

## License

[MIT](LICENSE). scimkit is an independent implementation of the SCIM standard. It is not affiliated with or
endorsed by Okta, Microsoft or any identity provider; their names are used only to describe compatibility.
