# Architecture

## Layers

```
adapters            src/nestjs  src/adapters/node.ts  src/adapters/fetch.ts
                    turn framework requests into ScimHttpRequest and write ScimHttpResponse back
protocol            src/protocol/server.ts   routing, authentication, discovery, bulk, root search,
                                             retries, hooks and events
                    src/protocol/query.ts    list parameters; src/protocol/bulk.ts  bulk envelope and bulkIds
domain              src/schema    attribute and schema definitions, resource types, compiled lookups
                    src/filter    lexer/parser → FilterExpression → resolve → ResolvedFilter → evaluate
                    src/patch     PATCH path parser and engine
                    src/resource  normalization, representation (meta, $ref), projection
storage             src/store/repository.ts  the ScimRepository contract
                    src/store/memory.ts      MemoryScimStore
                    src/postgres             PostgresScimStore, SQL compiler, migrations, token store
tools               src/verify   conformance profiles     src/cli   the scimkit command
```

`ScimServer.handle` takes a framework-neutral request and never throws: every error becomes a SCIM error
response (`ScimError` keeps its status and `scimType`; anything else is logged and answered with a 500 and
a request id). This keeps the adapters thin and lets tests drive the protocol without HTTP.

## A request

1. The adapter reads the body (respecting its size limit), works out the base URL and calls `handle`.
2. The router splits and decodes the path. Discovery, `/Bulk`, `/.search` and `/Me` are handled
   separately; everything else is a resource type endpoint.
3. `authenticate` returns a principal; its `tenantId` scopes everything that follows.
4. For writes, the body is normalized against the resource type: names canonicalised, values coerced,
   read-only values dropped, required and immutable rules checked, the password split off. PATCH applies
   operations to a copy of the current resource and normalizes the result. A PATCH that changes nothing
   is answered without a write.
5. `hooks.beforeWrite` may reject or rewrite. The repository stores the result with the version it was
   based on; on a conflict the server re-reads and retries with backoff (unless the client sent
   `If-Match`, which turns a conflict into 412).
6. The stored resource becomes its SCIM representation (`meta`, `$ref`), is projected, and is returned with
   `ETag` and `Location`. Events go to `hooks.onEvent`.

## Filters

`parseFilter` builds a syntax tree, `resolveFilter` checks it against the resource type (unknown
attributes, operators the type does not support, coercion of literals) and produces a `ResolvedFilter`
whose paths carry their attribute definitions. Repositories receive only resolved filters. The in-memory
evaluator and the SQL compiler implement the same semantics, and the contract suite
(`test/support/contract.ts`) runs the same requests against both stores:

- comparisons on multi-valued attributes match when any value matches;
- `ne` matches an absent single value; `pr` means non-empty;
- strings compare case-insensitively unless the attribute is `caseExact`, and order by character code;
- `meta.created` and `meta.lastModified` compare as instants, numbers as numbers;
- sorting puts absent values last in both directions; a multi-valued attribute sorts by its primary (or
  first) value; ties keep creation order.

## PostgreSQL data model

```
scim_resources       (tenant_id, id) primary key, resource_type, seq, external_id, user_name,
                     display_name, data jsonb, version, created_at, updated_at
                     unique (tenant_id, resource_type, lower(user_name)); GIN (data jsonb_path_ops)
scim_group_members   (tenant_id, group_id, member_id) primary key, seq;
                     foreign keys to scim_resources with ON DELETE CASCADE
scim_tokens          id, tenant_id, label, secret_hash, created_at, expires_at, revoked_at, last_used_at
scim_migrations      version, name, applied_at
```

Group members are rows, not JSON: membership filters use indexes, deleting a user removes it from its
groups, and a user's `groups` attribute is one indexed query per page. Membership changes bump the version
of the affected users, whose representation includes `groups`. Other unique attributes are checked under a
transaction-scoped advisory lock, so concurrent creates cannot both succeed.

## Compatibility mode

Lenient behaviour is confined to a few places: normalization (coercions, unknown attributes, flattened
keys), filter resolution (unprefixed extension attributes, literal coercion), the PATCH engine (seeding
values from filters, ignoring read-only keys in path-less values) and the router (case-insensitive names,
content types, envelopes). Every one of them corresponds to something a real client sends; the README lists
them.

## Packaging

One esbuild build produces all library entries with code splitting, so `scimkit`, `scimkit/postgres`,
`scimkit/nestjs` and `scimkit/verify` share one copy of each class per module format (ESM and CommonJS).
The CLI is built separately and imports the entries by package name. `ScimError` and
`VersionConflictError` carry a `Symbol.for` brand, so they are recognised even across the ESM/CommonJS
boundary.
