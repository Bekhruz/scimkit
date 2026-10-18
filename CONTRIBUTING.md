# Contributing to scimkit

Thank you for helping. Issues and pull requests are welcome: bug reports with a failing test, compatibility
reports from identity providers (request and response bodies, with secrets removed), documentation fixes
and features that stay within the SCIM standard.

## Setup

You need Node.js 22.12 or later (the repository's `.nvmrc` says 24), Corepack (or pnpm 10) and Docker for
the PostgreSQL tests.

```sh
git clone https://github.com/Bekhruz/scimkit.git
cd scimkit
corepack enable
pnpm install        # also points Git at .githooks (a pre-push hook)
```

## The local gate

Everything a pull request needs is checked on your machine; nothing depends on hosted CI.

| Command                 | What it does                                                                                                                                                                                                                      |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm test`             | Unit tests.                                                                                                                                                                                                                       |
| `pnpm test:integration` | Integration tests and examples. PostgreSQL tests run when `SCIMKIT_TEST_DATABASE_URL` is set.                                                                                                                                     |
| `pnpm db:start`         | Starts a disposable PostgreSQL in Docker and prints its `SCIMKIT_TEST_DATABASE_URL`. `pnpm db:stop` removes it.                                                                                                                   |
| `pnpm ci:fast`          | Format, lint, typecheck and unit tests. The pre-push hook runs this.                                                                                                                                                              |
| `pnpm ci`               | The full gate: install, format, lint, typecheck, all tests with coverage against a disposable PostgreSQL, build, package checks (tarball contents, publint, are-the-types-wrong, a run of the published build), dependency audit. |
| `pnpm ci:matrix`        | Node.js 22, 24 and 26 in clean containers, and PostgreSQL 13, 16, 17 and 18.                                                                                                                                                      |

Please run `pnpm ci` before opening a pull request, and `pnpm ci:matrix` when you touch SQL, the build or
Node.js-specific code. [docs/local-ci.md](docs/local-ci.md) describes every step.

## Guidelines

- **Tests first for behaviour.** Store behaviour belongs in `test/support/contract.ts`, which runs against
  the memory store and PostgreSQL: the two must give the same answers. Client quirks belong in the PATCH
  and normalization tests and, when they are part of a provider's sequence, in the `verify` profiles.
- **Stay close to the RFCs.** Lenient behaviour is added only for something a real client sends, and is
  listed in the README's compatibility table.
- **No runtime dependencies.** `pg` and NestJS stay optional peer dependencies.
- **Types are strict.** `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess` and typescript-eslint's
  strict type-checked rules are on; please don't silence them without a comment explaining why.
- **Changelog.** Add a line under `## [Unreleased]` in CHANGELOG.md for user-visible changes.

## Releases

Maintainers release from their machine:

```sh
pnpm version:bump minor          # sets the version, dates the changelog section
git commit -am "Release v0.2.0" && git push origin main
pnpm release                     # dry run: gate, matrix, release notes, npm publish --dry-run
pnpm release --publish           # tag, push the tag, publish the verified tarball, GitHub release
```

## Code of conduct

Be kind and assume good intent. Harassment or personal attacks are not tolerated in issues, pull requests
or any other project space.
