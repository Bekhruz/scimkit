#!/usr/bin/env node
// The complete local quality gate: every check a release requires. It needs no
// hosted CI. It writes a machine-readable summary to reports/ci-summary.json.
//
//   pnpm ci          full gate (starts a disposable PostgreSQL in Docker)
//   pnpm ci:fast     format, lint, typecheck and unit tests (the pre-push hook)
//
// Flags: --fast, --skip-install, --skip-audit, --skip-postgres
// With SCIMKIT_TEST_DATABASE_URL set, that database is used instead of Docker.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { startPostgres } from './postgres.mjs';
import { bold, dim, formatDuration, green, log, pnpm, red, root, run, yellow } from './lib.mjs';

const flags = new Set(process.argv.slice(2));
const fast = flags.has('--fast');
const skipPostgres = flags.has('--skip-postgres');
const env = {};
let database;

const steps = [
  {
    name: 'install',
    skip: fast || flags.has('--skip-install'),
    run: () => pnpm(['install', '--frozen-lockfile']),
  },
  { name: 'format', run: () => pnpm(['run', 'format:check']) },
  { name: 'lint', run: () => pnpm(['run', 'lint']) },
  { name: 'typecheck', run: () => pnpm(['run', 'typecheck']) },
  {
    name: 'postgres',
    skip: fast || skipPostgres,
    run: async () => {
      if (process.env.SCIMKIT_TEST_DATABASE_URL) {
        log(dim('  using SCIMKIT_TEST_DATABASE_URL'));
      } else {
        database = await startPostgres();
        env.SCIMKIT_TEST_DATABASE_URL = database.url;
        log(dim(`  ${database.version} in ${database.name}`));
      }
      // The PostgreSQL tests must run, not skip, in the full gate.
      env.SCIMKIT_REQUIRE_POSTGRES = '1';
    },
  },
  fast
    ? { name: 'unit tests', run: () => pnpm(['run', 'test']) }
    : {
        name: 'tests + coverage',
        run: () =>
          pnpm(
            [
              'exec',
              'vitest',
              'run',
              '--coverage',
              '--reporter=default',
              '--reporter=junit',
              '--outputFile.junit=reports/junit.xml',
              '--reporter=json',
              '--outputFile.json=reports/tests.json',
            ],
            { env },
          ),
      },
  { name: 'build', skip: fast, run: () => pnpm(['run', 'build']) },
  { name: 'package checks', skip: fast, run: () => run(process.execPath, ['scripts/pack-check.mjs']) },
  {
    name: 'dependency audit',
    skip: fast || flags.has('--skip-audit'),
    run: () => run(process.execPath, ['scripts/audit-deps.mjs']),
  },
];

const results = [];
const started = Date.now();
let failed;

try {
  for (const step of steps) {
    if (step.skip) {
      results.push({ name: step.name, status: 'skipped', durationMs: 0 });
      continue;
    }
    log(bold(`\n▶ ${step.name}`));
    const stepStarted = Date.now();
    try {
      await step.run();
      results.push({ name: step.name, status: 'passed', durationMs: Date.now() - stepStarted });
    } catch (error) {
      results.push({
        name: step.name,
        status: 'failed',
        durationMs: Date.now() - stepStarted,
        error: String(error.message),
      });
      failed = step.name;
      break;
    }
  }
} finally {
  database?.stop();
}

for (const step of steps.slice(results.length)) {
  results.push({ name: step.name, status: 'not run', durationMs: 0 });
}

const summary = {
  passed: failed === undefined,
  mode: fast ? 'fast' : 'full',
  node: process.version,
  platform: `${process.platform}-${process.arch}`,
  postgres: database?.version ?? (process.env.SCIMKIT_TEST_DATABASE_URL ? 'external' : 'none'),
  finishedAt: new Date().toISOString(),
  durationMs: Date.now() - started,
  steps: results,
};
mkdirSync(join(root, 'reports'), { recursive: true });
writeFileSync(join(root, 'reports', 'ci-summary.json'), `${JSON.stringify(summary, null, 2)}\n`);

log(bold('\nSummary'));
for (const result of results) {
  const mark = result.status === 'passed' ? green('✔') : result.status === 'failed' ? red('✖') : dim('–');
  const time = result.durationMs > 0 ? dim(` ${formatDuration(result.durationMs)}`) : '';
  const note = result.status === 'passed' || result.status === 'failed' ? '' : dim(` (${result.status})`);
  log(`  ${mark} ${result.name}${note}${time}`);
}
if (skipPostgres && !fast) log(yellow('\nPostgreSQL was skipped: this run does not qualify for a release.'));
log(
  failed === undefined
    ? green(`\nAll checks passed in ${formatDuration(summary.durationMs)}.`)
    : red(`\nFailed at "${failed}". See the output above.`),
);
process.exit(failed === undefined ? 0 : 1);
