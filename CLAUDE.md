# scimkit

SCIM 2.0 (RFC 7643/7644) service provider for Node.js: core in `src/`, entries `scimkit`,
`scimkit/postgres`, `scimkit/nestjs`, `scimkit/verify`, and the `scimkit` CLI. See docs/architecture.md.

## Commands

- `pnpm test` unit tests · `pnpm test:integration` integration tests and examples
- `pnpm db:start` / `pnpm db:stop` disposable PostgreSQL; export the printed `SCIMKIT_TEST_DATABASE_URL`
- `pnpm ci` the full local gate (the source of truth; hosted CI only runs it) · `pnpm ci:fast`
- `pnpm ci:matrix` Node 22/24/26 containers and PostgreSQL 13/16/17/18
- `pnpm release` is a dry run; `pnpm release --publish` publishes. Never publish without being asked.

Use Node 24 (`.nvmrc`); the system Node may be older. Docker may need `--context default` when Docker
Desktop is stopped; the scripts fall back to it automatically.

## Rules

- No runtime dependencies. `pg` and NestJS are optional peers.
- Store behaviour goes in `test/support/contract.ts`; the memory store and PostgreSQL must agree.
- The in-memory evaluator (`src/filter/evaluate.ts`) and the SQL compiler (`src/postgres/sql.ts`) implement
  the same semantics; change both together.
- Inside `src/`, import with relative paths (not `scimkit`), so the build shares chunks between entries.
  Only `src/cli` imports the package by name.
- Lenient behaviour only for what real clients send; list it in the README's compatibility table.
- Throw `ScimError` for client-facing errors; static factories declare `this: void` for use as callbacks.
