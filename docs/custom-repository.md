# Provisioning into your own tables

The built-in stores keep SCIM resources in their own tables. Many applications would rather have the
identity provider write straight into the `users` table they already have. A repository does that: five
methods that store and find data for one resource type. The complete, tested example is in
[`examples/custom-repository`](../examples/custom-repository/repositories.ts); it passes every
`scimkit verify` check.

## What you implement, and what you get for free

```ts
interface ScimRepository {
  create(context: ScimContext, attributes: JsonObject): Promise<StoredResource>;
  get(context: ScimContext, id: string, options?: ReadOptions): Promise<StoredResource | undefined>;
  list(context: ScimContext, query: ListQuery): Promise<ListResult>;
  replace(
    context: ScimContext,
    id: string,
    attributes: JsonObject,
    options?: WriteOptions,
  ): Promise<StoredResource>;
  delete(context: ScimContext, id: string, options?: WriteOptions): Promise<boolean>;
}
```

Before a repository is called, scimkit has authenticated the request, parsed and validated the body
against the schema, coerced values to their types, dropped read-only attributes, applied PATCH operations
to the current resource, enforced required and immutable attributes, and checked `If-Match`. After it
returns, scimkit builds `meta`, `$ref` values, `Location` and `ETag`, applies `attributes` and
`excludedAttributes`, and emits events. So the repository only maps attributes to rows and back.

`attributes` use the canonical schema names: `userName`, `name.givenName`, `emails[]`, and extension
attributes inside an object keyed by the extension URN. They never contain `id`, `meta`, `schemas` or the
password (that goes to `hooks.setPassword`).

A `StoredResource` is what you return:

```ts
{
  id: row.id,
  version: String(row.version), // the ETag; change it on every write
  created: row.createdAt,
  lastModified: row.updatedAt,
  attributes: { userName: row.username, active: row.isActive, /* ... */ },
}
```

## Mapping attributes

Your columns are the source of truth for what your application owns. Everything else can round-trip
through a JSON column, so nothing the identity provider sends is lost:

```ts
private columns(attributes: JsonObject) {
  const { userName, externalId, name, displayName, active, groups: _groups, ...rest } = attributes;
  return {
    username: String(userName),
    firstName: name?.givenName ?? null,
    lastName: name?.familyName ?? null,
    displayName: displayName ?? null,
    isActive: active !== false,
    scimExternalId: externalId ?? null,
    scimAttributes: rest, // emails, phoneNumbers, addresses, the enterprise extension, ...
  };
}
```

When reading, put your columns over the JSON, so that changes made in your own UI win.

Computed read-only attributes are yours to fill in: a User's `groups` (`{ value, display, type: 'direct' }`)
and a Group member's `display`.

## Filters

Identity providers send few filters, nearly all equality checks: `userName eq "…"`, `externalId eq "…"`,
`displayName eq "…"` and, from Entra, `id eq "…" and members[value eq "…"]`. `simpleEquality` turns these
into plain conditions:

```ts
import { ScimError, simpleEquality } from 'scimkit';

const conditions = simpleEquality(query.filter);
if (conditions === undefined) throw ScimError.invalidFilter('Only eq filters joined with and are supported.');
// [{ attribute: 'userName', value: 'ann@example.com', caseExact: false }, ...]
```

Map each condition to a WHERE clause (case-insensitively unless `caseExact`), and answer attributes you
do not support with `ScimError.invalidFilter`, before you query. To support any filter, walk
`query.filter` yourself: it is a resolved tree (`ResolvedFilter`) with attribute definitions attached.

Apply `query.startIndex` (1-based) and `query.count`, and return the total number of matches. `count: 0`
asks for the total only.

## Uniqueness, versions and errors

- Enforce unique attributes yourself, usually with a unique index, and throw `ScimError.uniqueness(...)`
  (409). `userName` is unique per tenant and case-insensitive.
- Keep a version per row. When `options.expectedVersion` is given and is no longer current, throw
  `VersionConflictError`; scimkit then re-reads and retries the write, or answers 412 when the client sent
  `If-Match`.
- Throw `ScimError.notFound` from `replace` for a missing resource, and return `false` from `delete`.
- Validate group members (they should exist in the same tenant) and throw `ScimError.invalidValue`.
- Any other error becomes a 500 with a request id, and is logged with its stack.

## Wiring it up

```ts
new ScimServer({
  repositories: { User: new UsersRepository(db), Group: new TeamsRepository(db) },
  authenticate: bearerTokenAuth(tokens),
});
```

Mix and match: `store` serves the types without an entry in `repositories`. Test with `verifyScimEndpoint`
in your own test suite, as the example's spec does.
