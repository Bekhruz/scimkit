import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { createFetchHandler, MemoryScimStore, ScimServer, silentLogger, staticTokenAuth } from 'scimkit';
import { HELP, type Io, runCli } from '../../src/cli/commands.js';
import { DATABASE_URL, hasPostgres, isolatedSchema } from '../support/postgres.js';

const TOKEN = 'cli-test-token-0123456789';

function io(overrides: Partial<Io> = {}): Io & { out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return {
    env: {},
    stdout: (text) => out.push(text),
    stderr: (text) => err.push(text),
    color: false,
    openPool: () => Promise.reject(new Error('no database in this test')),
    out,
    err,
    ...overrides,
  };
}

const server = () => {
  const handler = createFetchHandler(
    new ScimServer({
      store: new MemoryScimStore(),
      authenticate: staticTokenAuth({ token: TOKEN, tenantId: 'acme' }),
      logger: silentLogger,
    }),
    { basePath: '/scim/v2' },
  );
  const fetcher: typeof fetch = (input, init) => handler(new Request(input, init));
  return fetcher;
};

describe('scimkit CLI', () => {
  it('prints help and its version', async () => {
    const help = io();
    expect(await runCli(['help'], help, '1.2.3')).toBe(0);
    expect(help.out.join('')).toBe(HELP);
    const none = io();
    expect(await runCli([], none, '1.2.3')).toBe(2);
    const version = io();
    expect(await runCli(['--version'], version, '1.2.3')).toBe(0);
    expect(version.out).toEqual(['1.2.3\n']);
    const verifyHelp = io();
    expect(await runCli(['verify', '--help'], verifyHelp, '1')).toBe(0);
  });

  it('rejects bad usage with exit code 2', async () => {
    const cases: [string[], RegExp][] = [
      [['frobnicate'], /Unknown command "frobnicate"/],
      [['verify'], /one base URL/],
      [['verify', 'ftp://x'], /not an http\(s\) URL/],
      [['verify', 'https://x', '--profile', 'ping'], /Unknown profile "ping"/],
      [['verify', 'https://x', '--timeout', 'soon'], /--timeout/],
      [['verify', 'https://x', '--header', 'novalue'], /must look like "Name: value"/],
      [['verify', 'https://x', '--bogus'], /Unknown option '--bogus'/],
      [['migrate'], /Pass --database-url or set DATABASE_URL/],
      [['token', 'create'], /Pass --database-url/],
    ];
    for (const [args, message] of cases) {
      const output = io();
      expect(await runCli(args, output, '1')).toBe(2);
      expect(output.err.join('')).toMatch(message);
    }
    expect(await runCli(['token'], io(), '1')).toBe(2);
  });

  it('verifies an endpoint and sets the exit code from the result', async () => {
    const output = io({ fetch: server(), env: { SCIM_TOKEN: TOKEN } });
    expect(
      await runCli(
        [
          'verify',
          'https://scim.example.test/scim/v2',
          '--profile',
          'okta,entra',
          '--header',
          'X-Trace: cli',
        ],
        output,
        '1',
      ),
    ).toBe(0);
    expect(output.out.join('')).toMatch(
      /Okta provisioning[\s\S]*Microsoft Entra ID provisioning[\s\S]*\d+ passed, 0 failed/,
    );
    const json = io({ fetch: server() });
    expect(
      await runCli(
        [
          'verify',
          'https://scim.example.test/scim/v2',
          '--token',
          TOKEN,
          '--json',
          '--profile',
          'rfc',
          '--timeout',
          '5000',
        ],
        json,
        '1',
      ),
    ).toBe(0);
    expect(JSON.parse(json.out.join(''))).toMatchObject({ failed: 0, cleanup: { failed: [] } });
    const denied = io({ fetch: server() });
    expect(
      await runCli(
        [
          'verify',
          'https://scim.example.test/scim/v2',
          '--token',
          'wrong-token-00000000',
          '--profile',
          'rfc',
        ],
        denied,
        '1',
      ),
    ).toBe(1);
    expect(denied.out.join('')).toContain('HTTP 401');
  });

  it('reports unexpected errors with exit code 1', async () => {
    const output = io();
    expect(await runCli(['migrate', '--database-url', 'postgres://nowhere'], output, '1')).toBe(1);
    expect(output.err.join('')).toContain('no database in this test');
  });

  it('prints the migration SQL', async () => {
    const output = io();
    expect(
      await runCli(['migrate', '--print', '--schema', 'idp', '--table-prefix', 'sso_'], output, '1'),
    ).toBe(0);
    expect(output.out.join('')).toContain('CREATE TABLE IF NOT EXISTS "idp"."sso_resources"');
  });
});

describe.skipIf(!hasPostgres)('scimkit CLI with PostgreSQL', () => {
  let database: Awaited<ReturnType<typeof isolatedSchema>>;
  const pools: pg.Pool[] = [];
  const withDatabase = () =>
    io({
      env: { DATABASE_URL },
      openPool: (url) => {
        const pool = new pg.Pool({ connectionString: url });
        pools.push(pool);
        return Promise.resolve(pool);
      },
    });

  beforeAll(async () => {
    database = await isolatedSchema();
  });
  afterAll(async () => {
    await database.drop();
  });

  it('migrates, then issues, lists and revokes tokens', async () => {
    const schema = ['--schema', database.schema];
    const migrated = withDatabase();
    expect(await runCli(['migrate', ...schema], migrated, '1')).toBe(0);
    expect(migrated.out).toEqual(['Applied migration 1.\n']);
    const again = withDatabase();
    expect(await runCli(['migrate', ...schema], again, '1')).toBe(0);
    expect(again.out).toEqual(['The database is up to date.\n']);

    const created = withDatabase();
    expect(
      await runCli(
        ['token', 'create', '--tenant', 'acme', '--label', 'Okta', '--expires-in-days', '30', ...schema],
        created,
        '1',
      ),
    ).toBe(0);
    const text = created.out.join('');
    expect(text).toMatch(/Token [0-9a-f]{24} for tenant acme, expires /);
    expect(text).toMatch(/scim_[0-9a-f]{24}_\S{43}/);
    const asJson = withDatabase();
    expect(await runCli(['token', 'create', '--tenant', 'acme', '--json', ...schema], asJson, '1')).toBe(0);
    const issued = JSON.parse(asJson.out.join('')) as { token: string; id: string };

    const listed = withDatabase();
    expect(await runCli(['token', 'list', '--tenant', 'acme', ...schema], listed, '1')).toBe(0);
    expect(listed.out).toHaveLength(2);
    expect(listed.out[0]).toMatch(/active .* last used never {2}Okta/);
    const listedJson = withDatabase();
    expect(await runCli(['token', 'list', '--tenant', 'acme', '--json', ...schema], listedJson, '1')).toBe(0);
    expect(listedJson.out.join('')).not.toContain('secretHash');

    const revoked = withDatabase();
    expect(await runCli(['token', 'revoke', issued.id, ...schema], revoked, '1')).toBe(0);
    expect(revoked.out).toEqual([`Revoked token ${issued.id}.\n`]);
    const twice = withDatabase();
    expect(await runCli(['token', 'revoke', issued.id, ...schema], twice, '1')).toBe(1);
    const after = withDatabase();
    await runCli(['token', 'list', '--tenant', 'acme', ...schema], after, '1');
    expect(after.out.join('')).toContain('revoked');
    const empty = withDatabase();
    await runCli(['token', 'list', '--tenant', 'nobody', ...schema], empty, '1');
    expect(empty.out).toEqual(['No tokens for tenant nobody.\n']);

    const usage: [string[], RegExp][] = [
      [['token', 'create', ...schema], /needs --tenant/],
      [['token', 'list', ...schema], /needs --tenant/],
      [['token', 'revoke', ...schema], /needs a token id/],
      [['token', 'rotate', ...schema], /Unknown token command "rotate"/],
      [['token', 'create', '--tenant', 'a', '--expires-in-days', '0', ...schema], /positive number/],
    ];
    for (const [args, message] of usage) {
      const output = withDatabase();
      expect(await runCli(args, output, '1')).toBe(2);
      expect(output.err.join('')).toMatch(message);
    }
    await Promise.all(pools.map((pool) => pool.end().catch(() => undefined)));
  });
});
