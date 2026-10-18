#!/usr/bin/env node
// Disposable PostgreSQL for tests, in Docker.
//
//   node scripts/postgres.mjs start [--image postgres:17-alpine]   prints SCIMKIT_TEST_DATABASE_URL=...
//   node scripts/postgres.mjs stop                                  removes the containers this script started
//
// The container listens on a random port of 127.0.0.1, keeps its data in
// memory (tmpfs) and runs without fsync: fast, and gone when it stops.
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { dockerArgs, log, root, run } from './lib.mjs';

export const DEFAULT_IMAGE = process.env.SCIMKIT_PG_IMAGE ?? 'postgres:17-alpine';
const STATE = join(root, '.compat', 'postgres.json');
const LABEL = 'dev.scimkit.ci=postgres';

function docker(args, options = {}) {
  const prefix = dockerArgs();
  if (prefix === undefined) {
    throw new Error(
      'Docker is not reachable. Start Docker, or set SCIMKIT_TEST_DATABASE_URL to an existing database.',
    );
  }
  return run('docker', [...prefix, ...args], { capture: true, ...options });
}

/** Starts a PostgreSQL container and resolves when it accepts TCP connections. */
export async function startPostgres({ image = DEFAULT_IMAGE, timeoutMs = 90_000 } = {}) {
  const name = `scimkit-pg-${randomBytes(4).toString('hex')}`;
  const password = randomBytes(12).toString('hex');
  docker([
    'run',
    '--detach',
    '--rm',
    '--name',
    name,
    '--label',
    LABEL,
    '--publish',
    '127.0.0.1::5432',
    '--tmpfs',
    '/var/lib/postgresql:rw',
    '--env',
    'POSTGRES_USER=scimkit',
    '--env',
    `POSTGRES_PASSWORD=${password}`,
    '--env',
    'POSTGRES_DB=scimkit',
    image,
    '-c',
    'fsync=off',
    '-c',
    'synchronous_commit=off',
    '-c',
    'full_page_writes=off',
  ]);
  const stop = () => docker(['rm', '--force', name], { allowFailure: true });
  try {
    const port = docker(['port', name, '5432/tcp']).stdout.trim().split('\n')[0].split(':').pop();
    const deadline = Date.now() + timeoutMs;
    // Probe over TCP inside the container: during initialisation the server only listens on a socket.
    for (;;) {
      const probe = docker(
        [
          'exec',
          name,
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
        { allowFailure: true, env: { PGPASSWORD: password } },
      );
      if (probe.status === 0) break;
      if (Date.now() > deadline)
        throw new Error(`PostgreSQL in ${name} did not start within ${timeoutMs / 1000}s.`);
      await sleep(300);
    }
    const version = docker(['exec', name, 'postgres', '--version']).stdout.trim();
    const url = `postgres://scimkit:${password}@127.0.0.1:${port}/scimkit`;
    return { name, url, image, version, stop };
  } catch (error) {
    stop();
    throw error;
  }
}

function remember(entry) {
  mkdirSync(join(root, '.compat'), { recursive: true });
  const entries = existsSync(STATE) ? JSON.parse(readFileSync(STATE, 'utf8')) : [];
  entries.push(entry);
  writeFileSync(STATE, `${JSON.stringify(entries, null, 2)}\n`);
}

function stopAll() {
  if (!existsSync(STATE)) return 0;
  const entries = JSON.parse(readFileSync(STATE, 'utf8'));
  for (const entry of entries) docker(['rm', '--force', entry.name], { allowFailure: true });
  rmSync(STATE, { force: true });
  return entries.length;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const [command, ...rest] = process.argv.slice(2);
  const imageIndex = rest.indexOf('--image');
  const image = imageIndex === -1 ? DEFAULT_IMAGE : rest[imageIndex + 1];
  if (command === 'start') {
    const database = await startPostgres({ image });
    remember({ name: database.name, url: database.url, image: database.image });
    log(`# ${database.version} in container ${database.name}`);
    log(`SCIMKIT_TEST_DATABASE_URL=${database.url}`);
  } else if (command === 'stop') {
    log(`Stopped ${stopAll()} container(s).`);
  } else {
    log('Usage: node scripts/postgres.mjs start [--image postgres:17-alpine] | stop');
    process.exit(2);
  }
}
