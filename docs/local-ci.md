# Local CI/CD

scimkit's continuous integration and delivery run on the maintainer's machine. Hosted CI is optional: the
GitHub Actions workflow only runs the same script, so a green local run means the same as a green hosted
one, and a release never waits for (or pays for) runner minutes.

## The gate: `pnpm ci`

`scripts/ci.mjs` runs these steps in order and stops at the first failure:

| Step             | What it checks                                                                                                                                                                                                                                                                                                                                                                           |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| install          | `pnpm install --frozen-lockfile`: the lockfile matches `package.json`.                                                                                                                                                                                                                                                                                                                   |
| format           | Prettier.                                                                                                                                                                                                                                                                                                                                                                                |
| lint             | ESLint with typescript-eslint's strict type-checked rules, zero warnings.                                                                                                                                                                                                                                                                                                                |
| typecheck        | `tsc` over sources, tests and examples.                                                                                                                                                                                                                                                                                                                                                  |
| postgres         | Starts a disposable PostgreSQL 17 in Docker (random port, tmpfs, removed afterwards), or uses `SCIMKIT_TEST_DATABASE_URL`. The PostgreSQL tests must then run rather than skip.                                                                                                                                                                                                          |
| tests + coverage | All unit, integration and example tests, with coverage thresholds; JUnit and JSON reports.                                                                                                                                                                                                                                                                                               |
| build            | tsup: ESM, CommonJS and declarations for every entry, and the CLI.                                                                                                                                                                                                                                                                                                                       |
| package checks   | `scripts/pack-check.mjs`: a reproducible build; the tarball holds only the intended files and no secrets or local paths; publint; are-the-types-wrong; ESM and CommonJS export the same API; and `scripts/smoke.mjs`, which boots servers from the extracted tarball (Node http in ESM and CommonJS, NestJS on Express and Fastify) and runs the packaged `scimkit verify` against each. |
| dependency audit | No runtime dependencies; no known vulnerabilities in what users install; licenses on an allowlist.                                                                                                                                                                                                                                                                                       |

`pnpm ci:fast` runs format, lint, typecheck and unit tests; the pre-push hook (`.githooks/pre-push`,
installed by `pnpm install`) runs it. Skip it once with `git push --no-verify`.

Flags: `--fast`, `--skip-install`, `--skip-postgres` (such a run does not qualify for a release) and
`--skip-audit`. The result is written to `reports/ci-summary.json`.

## The matrix: `pnpm ci:matrix`

`scripts/matrix.mjs` covers what one machine's Node.js cannot:

- **Node.js 22, 24 and 26.** For each version, a clean `node:<major>-alpine` container receives the
  sources (without `node_modules`), installs from the lockfile, and runs the typecheck, every test against a
  PostgreSQL container on a private Docker network, the build and the CLI. A named volume
  (`scimkit-pnpm-store`) caches downloads between runs.
- **PostgreSQL 13, 16, 17 and 18.** The integration tests run on the host against each server version.

Choose subsets with `--node 24`, `--postgres 13,18` or `--only node`. Results go to `reports/matrix.json`.

## Releasing: `pnpm release`

```sh
pnpm version:bump patch            # 0.1.0 → 0.1.1; dates the [Unreleased] changelog section
git commit -am "Release v0.1.1" && git push origin main
pnpm release                       # dry run
pnpm release --publish             # the real thing
```

The dry run checks the preconditions, runs the gate and the matrix, writes release notes with the
verification results and the tarball's SHA-256 to `reports/release-notes.md`, and ends with
`npm publish --dry-run`. Nothing is tagged, pushed or published.

`--publish` additionally requires a clean tree whose HEAD is `origin/main`, an unpublished version and a
logged-in npm user. It then tags and pushes the tag, publishes **the exact tarball the gate verified**,
creates the GitHub release with that tarball attached (when `gh` is authenticated), and checks that the
registry serves a tarball with the same integrity hash. A release that stopped half way can be re-run;
finished steps are skipped. Pass `--otp <code>` for npm two-factor codes and `--skip-matrix` to leave the
matrix out.

`npm publish` run directly triggers `prepublishOnly`, which runs the full gate first.

## Docker

The scripts use the active Docker context and fall back to the `default` context when it is unreachable
(for example when Docker Desktop is stopped but the system engine runs). Set `SCIMKIT_DOCKER_CONTEXT` to
choose one. Containers carry the label `dev.scimkit.ci=postgres` and are removed after each run;
`pnpm db:stop` removes any left by an interrupted `pnpm db:start`.
