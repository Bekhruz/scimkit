import { readFileSync } from 'node:fs';
import type PG from 'pg';
import { runCli } from './commands.js';

const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
  version: string;
};

const exitCode = await runCli(
  process.argv.slice(2),
  {
    env: process.env,
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
    color: process.stdout.isTTY && process.env['NO_COLOR'] === undefined,
    openPool: async (connectionString) => {
      let pg: { default: typeof PG };
      try {
        pg = await import('pg');
      } catch {
        throw new Error('Database commands need the "pg" package: npm install pg');
      }
      // pg.Pool satisfies scimkit's PgPool interface; this assignment checks it.
      return new pg.default.Pool({ connectionString });
    },
  },
  version,
);
process.exitCode = exitCode;
