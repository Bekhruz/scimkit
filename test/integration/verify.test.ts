import { afterAll, describe, expect, it } from 'vitest';
import {
  createFetchHandler,
  MemoryScimStore,
  ScimServer,
  type ScimServerOptions,
  type ScimStore,
  silentLogger,
  staticTokenAuth,
} from 'scimkit';
import { PostgresScimStore } from 'scimkit/postgres';
import { type CheckResult, formatReport, verifyScimEndpoint } from 'scimkit/verify';
import { hasPostgres, isolatedSchema } from '../support/postgres.js';

const TOKEN = 'verify-test-token-0123456789';
const BASE = 'https://scim.example.test/scim/v2';

/** A fetch function that serves requests from an in-process ScimServer. */
function inProcess(options: Partial<ScimServerOptions> & { store: ScimStore }): typeof fetch {
  const handler = createFetchHandler(
    new ScimServer({
      authenticate: staticTokenAuth({ token: TOKEN, tenantId: 'acme' }),
      logger: silentLogger,
      ...options,
    }),
    { basePath: '/scim/v2' },
  );
  return (input, init) => handler(new Request(input, init));
}

const failed = (checks: readonly CheckResult[]) =>
  checks
    .filter((check) => check.status !== 'passed')
    .map((check) => `${check.profile}: ${check.name}: ${check.detail ?? ''}`);

describe('verifyScimEndpoint', () => {
  it('passes every check against scimkit with the memory store and cleans up', async () => {
    const store = new MemoryScimStore();
    const progress: string[] = [];
    const report = await verifyScimEndpoint({
      baseUrl: BASE,
      token: TOKEN,
      fetch: inProcess({ store }),
      onCheck: (check) => progress.push(check.name),
    });
    expect(failed(report.checks)).toEqual([]);
    expect(report.passed).toBe(report.checks.length);
    expect(report.checks.length).toBeGreaterThan(50);
    expect(progress).toHaveLength(report.checks.length);
    expect(report.cleanup.failed).toEqual([]);
    const leftovers = await inProcess({ store })(`${BASE}/Users`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(((await leftovers.json()) as { totalResults: number }).totalResults).toBe(0);
  });

  it('keeps resources when asked and runs only the chosen profiles', async () => {
    const store = new MemoryScimStore();
    const report = await verifyScimEndpoint({
      baseUrl: BASE,
      token: TOKEN,
      fetch: inProcess({ store }),
      profiles: ['okta'],
      keep: true,
    });
    expect(new Set(report.checks.map((check) => check.profile))).toEqual(new Set(['okta']));
    const users = await inProcess({ store })(`${BASE}/Users`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(((await users.json()) as { totalResults: number }).totalResults).toBe(1);
  });

  it('reports what a broken server gets wrong', async () => {
    // A server that ignores filters and accepts duplicate userNames, like many hand-written endpoints.
    const store = new MemoryScimStore();
    const real = inProcess({ store });
    const broken: typeof fetch = async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.searchParams.has('filter') && init?.method !== 'POST') url.searchParams.delete('filter');
      const response = await real(url.toString(), init);
      if (response.status === 409) {
        return new Response(JSON.stringify({ id: 'dup', userName: 'x' }), {
          status: 201,
          headers: { 'content-type': 'application/json' },
        });
      }
      const headers = new Headers(response.headers);
      headers.set('content-type', 'application/json');
      return new Response(response.status === 204 ? null : await response.text(), {
        status: response.status,
        headers,
      });
    };
    const report = await verifyScimEndpoint({
      baseUrl: BASE,
      token: TOKEN,
      fetch: broken,
      profiles: ['rfc'],
    });
    const names = report.checks.filter((check) => check.status === 'failed').map((check) => check.name);
    expect(names).toEqual(
      expect.arrayContaining([
        'Responds with the application/scim+json media type',
        'Rejects a duplicate userName with 409 uniqueness',
        'Finds nothing for an unknown userName',
        'Rejects an invalid filter with 400 invalidFilter',
      ]),
    );
    const text = formatReport(report);
    expect(text).toContain('✖ Rejects a duplicate userName with 409 uniqueness');
    expect(text).toContain('expected HTTP 409, got HTTP 201');
    expect(text).toMatch(/\d+ passed, \d+ failed, 0 skipped/);
    expect(formatReport(report, { color: true })).toContain('\u001b[31m');
  });

  it('skips checks that depend on a failed step, and the ETag check without ETag support', async () => {
    const unauthorized = await verifyScimEndpoint({
      baseUrl: BASE,
      token: 'wrong-token-0000000000000',
      fetch: inProcess({ store: new MemoryScimStore() }),
      profiles: ['rfc'],
    });
    const etag = unauthorized.checks.find((check) => check.name === 'Rejects a stale If-Match with 412');
    expect(etag).toMatchObject({ status: 'skipped' });
    expect(unauthorized.checks.find((check) => check.name === 'Reads the user')).toMatchObject({
      status: 'skipped',
      detail: 'needs user from an earlier check',
    });
    expect(unauthorized.checks[0]).toMatchObject({
      status: 'failed',
      detail: expect.stringContaining('HTTP 401'),
    });
  });

  it('survives network errors and rejects unknown profiles', async () => {
    const report = await verifyScimEndpoint({
      baseUrl: BASE,
      fetch: () => Promise.reject(new Error('ECONNREFUSED')),
      profiles: ['okta'],
    });
    expect(report.failed).toBeGreaterThan(0);
    expect(report.checks[0]?.detail).toBe('ECONNREFUSED');
    expect(() => verifyScimEndpoint({ baseUrl: BASE, profiles: ['ping' as 'okta'] })).toThrow(
      /Unknown profile "ping"/,
    );
  });
});

describe.skipIf(!hasPostgres)('verifyScimEndpoint against PostgreSQL', () => {
  let database: Awaited<ReturnType<typeof isolatedSchema>> | undefined;
  afterAll(async () => {
    await database?.drop();
  });

  it('passes every check', async () => {
    database = await isolatedSchema();
    const store = new PostgresScimStore({ pool: database.pool, schema: database.schema });
    await store.migrate();
    const report = await verifyScimEndpoint({ baseUrl: BASE, token: TOKEN, fetch: inProcess({ store }) });
    expect(failed(report.checks)).toEqual([]);
    expect(report.cleanup.failed).toEqual([]);
  });
});
