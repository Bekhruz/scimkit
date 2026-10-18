#!/usr/bin/env node
// Compatibility matrix in Docker, the part of CI that needs other runtimes:
//
//   Node.js     typecheck, all tests (against PostgreSQL) and the build in a
//               clean node:<major>-alpine container per version, installed
//               from the lockfile;
//   PostgreSQL  the integration tests on this machine against each server version.
//
//   pnpm ci:matrix                          everything
//   pnpm ci:matrix --node 24 --postgres 17  a subset
//   pnpm ci:matrix --only node              one dimension
//
// Writes reports/matrix.json. A named volume caches the pnpm store between runs.
import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { startPostgres } from './postgres.mjs';
import { bold, dim, dockerArgs, formatDuration, green, log, pnpm, red, root, run } from './lib.mjs';

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? fallback : args[index + 1];
};
const only = option('only', undefined);
const nodeVersions = (option('node', '22,24,26') ?? '').split(',').filter(Boolean);
const postgresVersions = (option('postgres', '13,16,17,18') ?? '').split(',').filter(Boolean);
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const pnpmVersion = pkg.packageManager.split('@')[1];

const docker = dockerArgs();
if (docker === undefined) {
  log(red('Docker is not reachable; the matrix needs it.'));
  process.exit(1);
}
const dockerRun = (dockerCommand, options = {}) => run('docker', [...docker, ...dockerCommand], options);

const results = [];
const record = (id, started, error, versions) => {
  results.push({
    id,
    status: error === undefined ? 'passed' : 'failed',
    durationMs: Date.now() - started,
    versions,
    ...(error ? { error: String(error.message).slice(-4000) } : {}),
  });
  log(error === undefined ? green(`  ✔ ${id}`) : red(`  ✖ ${id}\n${String(error.message).slice(-4000)}`));
};

/** The repository as a tar stream, without installed or generated files. */
function sourceArchive() {
  const tar = run(
    'tar',
    [
      '--create',
      '--file=-',
      '--exclude=./node_modules',
      '--exclude=./.git',
      '--exclude=./dist',
      '--exclude=./coverage',
      '--exclude=./reports',
      '--exclude=./.compat',
      '--directory',
      root,
      '.',
    ],
    { capture: true, encoding: 'buffer' },
  );
  return tar.stdout;
}

async function nodeMatrix() {
  const id = randomBytes(3).toString('hex');
  const network = `scimkit-matrix-${id}`;
  const database = `scimkit-matrix-pg-${id}`;
  const password = randomBytes(12).toString('hex');
  dockerRun(['network', 'create', network], { capture: true });
  try {
    dockerRun(
      [
        'run',
        '--detach',
        '--rm',
        '--name',
        database,
        '--network',
        network,
        '--tmpfs',
        '/var/lib/postgresql:rw',
        '--env',
        'POSTGRES_USER=scimkit',
        '--env',
        `POSTGRES_PASSWORD=${password}`,
        '--env',
        'POSTGRES_DB=scimkit',
        'postgres:17-alpine',
        '-c',
        'fsync=off',
        '-c',
        'synchronous_commit=off',
      ],
      { capture: true },
    );
    for (let attempt = 0; ; attempt++) {
      const probe = dockerRun(
        [
          'exec',
          database,
          'psql',
          '--host',
          '127.0.0.1',
          '--username',
          'scimkit',
          '--dbname',
          'scimkit',
          '--command',
          'SELECT 1',
        ],
        { capture: true, allowFailure: true, env: { PGPASSWORD: password } },
      );
      if (probe.status === 0) break;
      if (attempt > 300) throw new Error('PostgreSQL for the Node.js matrix did not start.');
      await sleep(300);
    }
    const archive = sourceArchive();
    for (const major of nodeVersions) {
      const started = Date.now();
      log(bold(`\n▶ Node.js ${major}`));
      const script = [
        'set -eu',
        'mkdir /work && tar -xf - -C /work && cd /work',
        `npm install --global --silent pnpm@${pnpmVersion}`,
        'pnpm config set store-dir /pnpm-store',
        'pnpm install --frozen-lockfile --reporter=silent',
        'echo "node $(node --version), pnpm $(pnpm --version)"',
        'pnpm run typecheck',
        'pnpm exec vitest run --reporter=dot',
        'pnpm run build',
        'node dist/cli.js --version',
      ].join('\n');
      try {
        const output = dockerRun(
          [
            'run',
            '--rm',
            '--interactive',
            '--network',
            network,
            '--volume',
            'scimkit-pnpm-store:/pnpm-store',
            '--env',
            'CI=1',
            '--env',
            `SCIMKIT_TEST_DATABASE_URL=postgres://scimkit:${password}@${database}:5432/scimkit`,
            '--env',
            'SCIMKIT_REQUIRE_POSTGRES=1',
            `node:${major}-alpine`,
            'sh',
            '-c',
            script,
          ],
          { capture: true, input: archive },
        );
        const version = /node (v[\d.]+)/.exec(output.stdout)?.[1];
        log(dim(output.stdout.trim().split('\n').slice(-6).join('\n')));
        record(`node ${major}`, started, undefined, { node: version, postgres: '17' });
      } catch (error) {
        record(`node ${major}`, started, error, { node: major });
      }
    }
  } finally {
    dockerRun(['rm', '--force', database], { capture: true, allowFailure: true });
    dockerRun(['network', 'rm', network], { capture: true, allowFailure: true });
  }
}

async function postgresMatrix() {
  for (const version of postgresVersions) {
    const started = Date.now();
    log(bold(`\n▶ PostgreSQL ${version}`));
    let database;
    try {
      database = await startPostgres({ image: `postgres:${version}-alpine` });
      log(dim(`  ${database.version}`));
      pnpm(['exec', 'vitest', 'run', 'test/integration', '--reporter=dot'], {
        env: { SCIMKIT_TEST_DATABASE_URL: database.url, SCIMKIT_REQUIRE_POSTGRES: '1' },
        capture: true,
      });
      record(`postgres ${version}`, started, undefined, {
        node: process.version,
        postgres: database.version,
      });
    } catch (error) {
      record(`postgres ${version}`, started, error, { postgres: version });
    } finally {
      database?.stop();
    }
  }
}

const started = Date.now();
if (only === undefined || only === 'node') await nodeMatrix();
if (only === undefined || only === 'postgres') await postgresMatrix();

mkdirSync(join(root, 'reports'), { recursive: true });
const report = { finishedAt: new Date().toISOString(), durationMs: Date.now() - started, results };
writeFileSync(join(root, 'reports', 'matrix.json'), `${JSON.stringify(report, null, 2)}\n`);

const failedCount = results.filter((result) => result.status === 'failed').length;
log(bold('\nMatrix'));
for (const result of results) {
  log(
    `  ${result.status === 'passed' ? green('✔') : red('✖')} ${result.id} ${dim(formatDuration(result.durationMs))}`,
  );
}
log(
  failedCount === 0
    ? green(`\nAll ${results.length} combinations passed.`)
    : red(`\n${failedCount} of ${results.length} failed.`),
);
process.exit(failedCount === 0 ? 0 : 1);
