import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  customizeSchema,
  defineResourceType,
  GROUP_SCHEMA,
  type JsonObject,
  ScimTokens,
  UserResourceType,
} from 'scimkit';
import { migrate, migrationSql, PostgresScimStore, PostgresTokenStore } from 'scimkit/postgres';
import { describeStoreContract } from '../support/contract.js';
import { createHarness, GROUP, patchBody, TOKEN_GLOBEX, USER } from '../support/harness.js';
import { hasPostgres, isolatedSchema } from '../support/postgres.js';

const suite = hasPostgres ? describe : describe.skip;
if (!hasPostgres)
  console.warn('[scimkit] PostgreSQL tests skipped: set SCIMKIT_TEST_DATABASE_URL or run `pnpm ci`.');

if (hasPostgres) {
  describeStoreContract('postgres', async () => {
    const database = await isolatedSchema();
    const store = new PostgresScimStore({ pool: database.pool, schema: database.schema });
    await store.migrate();
    return {
      store,
      reset: async () => {
        await database.pool.query(`TRUNCATE "${database.schema}".scim_resources CASCADE`);
      },
      close: () => database.drop(),
    };
  });
}

suite('PostgresScimStore', () => {
  let database: Awaited<ReturnType<typeof isolatedSchema>>;
  let store: PostgresScimStore;

  beforeAll(async () => {
    database = await isolatedSchema();
    store = new PostgresScimStore({ pool: database.pool, schema: database.schema, tablePrefix: 'idp_' });
    expect(await store.migrate()).toEqual([1]);
  });
  beforeEach(async () => {
    await database.pool.query(`TRUNCATE "${database.schema}".idp_resources CASCADE`);
  });
  afterAll(async () => {
    await database.drop();
  });

  it('migrates idempotently, also concurrently', async () => {
    expect(await store.migrate()).toEqual([]);
    const other = { schema: database.schema, tablePrefix: 'race_' };
    const results = await Promise.all([
      migrate(database.pool, other),
      migrate(database.pool, other),
      migrate(database.pool, other),
    ]);
    expect(results.flat()).toEqual([1]);
    const { rows } = await database.pool.query(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = $1 AND table_name LIKE 'race_%' ORDER BY 1`,
      [database.schema],
    );
    expect(rows.map((row: { table_name: string }) => row.table_name)).toEqual([
      'race_group_members',
      'race_migrations',
      'race_resources',
      'race_tokens',
    ]);
  });

  it('creates a schema of its own when asked', async () => {
    const schema = `${database.schema}_own`;
    await migrate(database.pool, { schema });
    const { rows } = await database.pool.query(
      'SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema = $1',
      [schema],
    );
    expect((rows[0] as { n: number }).n).toBe(4);
    await database.pool.query(`DROP SCHEMA "${schema}" CASCADE`);
  });

  it('exposes the migration SQL for other migration tools', () => {
    const sql = migrationSql({ schema: 'identity', tablePrefix: 'x_' });
    expect(sql).toContain('CREATE SCHEMA IF NOT EXISTS "identity"');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS "identity"."x_resources"');
    expect(migrationSql()).not.toContain('CREATE SCHEMA');
    expect(() => migrationSql({ schema: 'bad; DROP' })).toThrow(/Invalid schema name/);
    expect(() => migrationSql({ tablePrefix: 'X-' })).toThrow(/Invalid table prefix/);
  });

  it('keeps hostile filter values out of the SQL', async () => {
    const scim = createHarness({ store });
    await scim.createUser("o'brien@example.com", { title: "100% _real_ \\ o'brien" });
    const hostile = [`userName eq "x' OR '1'='1"`, `title co "%"`, `title co "_"`, `title sw "100\\\\"`];
    const totals = [];
    for (const filter of hostile) {
      const reply = await scim.call('GET', `/Users?filter=${encodeURIComponent(filter)}`);
      expect(reply.status).toBe(200);
      totals.push(reply.body['totalResults']);
    }
    expect(totals).toEqual([0, 1, 1, 0]);
    const nul = await scim.call('GET', `/Users?filter=${encodeURIComponent('userName eq "\\u0000"')}`);
    expect(nul.status).toBe(400);
    const stored = await scim.call('POST', '/Users', { schemas: [USER], userName: 'nul\u0000@example.com' });
    expect(stored.status).toBe(400);
    const quoted = await scim.call(
      'GET',
      `/Users?filter=${encodeURIComponent(`userName eq "O'BRIEN@example.com"`)}`,
    );
    expect(quoted.body['totalResults']).toBe(1);
    const literal = await scim.call(
      'GET',
      `/Users?filter=${encodeURIComponent('title co "100% _real_ \\\\"')}`,
    );
    expect(literal.body['totalResults']).toBe(1);
  });

  it('serialises concurrent PATCHes without losing updates', async () => {
    const scim = createHarness({ store });
    const users = await Promise.all(
      Array.from({ length: 12 }, (_, index) => scim.createUser(`member${index}@example.com`)),
    );
    const group = await scim.createGroup('Everyone');
    const results = await Promise.all(
      users.map((user) =>
        scim.call(
          'PATCH',
          `/Groups/${group['id'] as string}`,
          patchBody({ op: 'add', path: 'members', value: [{ value: user['id'] }] }),
        ),
      ),
    );
    // Without If-Match the server re-reads and retries with backoff, so no update is lost.
    expect(results.map((reply) => reply.status)).toEqual(users.map(() => 200));
    const read = await scim.call('GET', `/Groups/${group['id'] as string}`);
    expect((read.body['members'] as JsonObject[]).map((member) => member['value']).sort()).toEqual(
      users.map((user) => user['id']).sort(),
    );
  });

  it('allows only one of two concurrent creates with the same userName', async () => {
    const scim = createHarness({ store });
    const replies = await Promise.all([
      scim.call('POST', '/Users', { schemas: [USER], userName: 'race@example.com' }),
      scim.call('POST', '/Users', { schemas: [USER], userName: 'RACE@example.com' }),
    ]);
    expect(replies.map((reply) => reply.status).sort()).toEqual([201, 409]);
  });

  it('enforces custom unique attributes, per tenant and globally', async () => {
    const custom = new PostgresScimStore({
      pool: database.pool,
      schema: database.schema,
      tablePrefix: 'idp_',
    });
    const scim = createHarness({
      store: custom,
      resourceTypes: [
        UserResourceType,
        defineResourceType({
          name: 'Group',
          endpoint: '/Groups',
          schema: customizeSchema(GROUP_SCHEMA, { overrides: { displayName: { uniqueness: 'global' } } }),
        }),
      ],
    });
    expect((await scim.call('POST', '/Groups', { schemas: [GROUP], displayName: 'Admins' })).status).toBe(
      201,
    );
    const duplicates = await Promise.all([
      scim.call('POST', '/Groups', { schemas: [GROUP], displayName: 'admins' }),
      scim.as(TOKEN_GLOBEX)('POST', '/Groups', { schemas: [GROUP], displayName: 'ADMINS' }),
    ]);
    expect(duplicates.map((reply) => reply.status)).toEqual([409, 409]);
    const other = await scim.call('POST', '/Groups', { schemas: [GROUP], displayName: 'Ops' });
    expect(
      (
        await scim.call('PUT', `/Groups/${other.body['id'] as string}`, {
          schemas: [GROUP],
          displayName: 'Ops',
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await scim.call('PUT', `/Groups/${other.body['id'] as string}`, {
          schemas: [GROUP],
          displayName: 'Admins',
        })
      ).status,
    ).toBe(409);
  });

  it('ignores missing members when configured to', async () => {
    const lenient = new PostgresScimStore({
      pool: database.pool,
      schema: database.schema,
      tablePrefix: 'idp_',
      memberReferences: 'ignore',
    });
    const scim = createHarness({ store: lenient });
    const ann = await scim.createUser('ann@example.com');
    const group = await scim.call('POST', '/Groups', {
      schemas: [GROUP],
      displayName: 'Mixed',
      members: [{ value: 'missing' }, { value: ann['id'] }],
    });
    expect(group.status).toBe(201);
    expect((group.body['members'] as JsonObject[]).map((member) => member['value'])).toEqual([ann['id']]);
  });

  it('keeps tenants apart in SQL', async () => {
    const scim = createHarness({ store });
    await scim.createUser('shared@example.com');
    await scim.as(TOKEN_GLOBEX)('POST', '/Users', { schemas: [USER], userName: 'shared@example.com' });
    const { rows } = await database.pool.query(
      `SELECT tenant_id, count(*)::int AS n FROM "${database.schema}".idp_resources GROUP BY tenant_id ORDER BY tenant_id`,
    );
    expect(rows).toEqual([
      { tenant_id: 'acme', n: 1 },
      { tenant_id: 'globex', n: 1 },
    ]);
  });
});

suite('PostgresTokenStore', () => {
  let database: Awaited<ReturnType<typeof isolatedSchema>>;

  beforeAll(async () => {
    database = await isolatedSchema();
  });
  afterAll(async () => {
    await database.drop();
  });

  it('issues, verifies, lists and revokes tokens', async () => {
    const storeOfTokens = new PostgresTokenStore({ pool: database.pool, schema: database.schema });
    await storeOfTokens.migrate();
    const tokens = new ScimTokens(storeOfTokens, { touchIntervalMs: 0 });
    const issued = await tokens.issue('acme', {
      label: 'Okta production',
      expiresAt: new Date(Date.now() + 86_400_000),
    });
    const verified = await tokens.verify(issued.token);
    expect(verified).toMatchObject({ tenantId: 'acme', label: 'Okta production' });
    const listed = await tokens.list('acme');
    expect(listed).toHaveLength(1);
    expect(listed[0]?.lastUsedAt).toBeInstanceOf(Date);
    expect(JSON.stringify(listed)).not.toContain(issued.token.split('_')[2]);
    expect(await tokens.revoke(issued.record.id)).toBe(true);
    expect(await tokens.revoke(issued.record.id)).toBe(false);
    expect(await tokens.verify(issued.token)).toBeUndefined();
    expect(await storeOfTokens.find('nope')).toBeUndefined();
    const plain = await tokens.issue('acme');
    expect((await storeOfTokens.find(plain.record.id))?.label).toBeUndefined();
  });
});
