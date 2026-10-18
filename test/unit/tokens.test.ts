import { describe, expect, it, vi } from 'vitest';
import {
  bearerTokenAuth,
  MemoryTokenStore,
  readBearerToken,
  type ScimHttpRequest,
  ScimTokens,
  type ScimTokenStore,
  staticTokenAuth,
} from 'scimkit';

const request = (authorization?: string): ScimHttpRequest => ({
  method: 'GET',
  path: '/Users',
  headers: authorization === undefined ? {} : { Authorization: authorization },
});

describe('ScimTokens', () => {
  it('issues tokens it can verify and stores only a hash', async () => {
    const store = new MemoryTokenStore();
    const tokens = new ScimTokens(store);
    const issued = await tokens.issue('acme', { label: 'Okta' });
    expect(issued.token).toMatch(/^scim_[0-9a-f]{24}_[A-Za-z0-9_-]{43}$/);
    expect(issued.record).toMatchObject({ tenantId: 'acme', label: 'Okta', id: issued.token.split('_')[1] });
    const secret = issued.token.slice(30);
    expect(JSON.stringify(await store.find(issued.record.id))).not.toContain(secret);
    expect(await tokens.verify(issued.token)).toMatchObject({ tenantId: 'acme' });
  });

  it('rejects malformed, unknown, tampered, expired and revoked tokens', async () => {
    let now = new Date('2026-01-01T00:00:00Z');
    const tokens = new ScimTokens(new MemoryTokenStore(), { now: () => now });
    const issued = await tokens.issue('acme', { expiresAt: new Date('2026-02-01T00:00:00Z') });
    const tampered = `${issued.token.slice(0, -1)}${issued.token.endsWith('A') ? 'B' : 'A'}`;
    expect(await tokens.verify('garbage')).toBeUndefined();
    expect(await tokens.verify(`scim_${'0'.repeat(24)}_${'A'.repeat(43)}`)).toBeUndefined();
    expect(await tokens.verify(tampered)).toBeUndefined();
    expect(await tokens.verify(issued.token)).toBeDefined();
    now = new Date('2026-02-01T00:00:00Z');
    expect(await tokens.verify(issued.token)).toBeUndefined();
    now = new Date('2026-01-15T00:00:00Z');
    expect(await tokens.revoke(issued.record.id)).toBe(true);
    expect(await tokens.revoke(issued.record.id)).toBe(false);
    expect(await tokens.revoke('unknown')).toBe(false);
    expect(await tokens.verify(issued.token)).toBeUndefined();
  });

  it('records usage at most once per interval and tolerates failures to do so', async () => {
    let now = new Date('2026-01-01T00:00:00Z');
    const store = new MemoryTokenStore();
    const touch = vi.spyOn(store, 'touch');
    const tokens = new ScimTokens(store, { now: () => now, touchIntervalMs: 60_000 });
    const issued = await tokens.issue('acme');
    await tokens.verify(issued.token);
    await tokens.verify(issued.token);
    expect(touch).toHaveBeenCalledTimes(1);
    now = new Date('2026-01-01T00:02:00Z');
    await tokens.verify(issued.token);
    expect(touch).toHaveBeenCalledTimes(2);
    expect((await tokens.list('acme'))[0]?.lastUsedAt).toEqual(now);

    const broken: ScimTokenStore = {
      insert: (record) => store.insert(record),
      find: (id) => store.find(id),
      list: (tenant) => store.list(tenant),
      revoke: (id, at) => store.revoke(id, at),
      touch: () => Promise.reject(new Error('read-only replica')),
    };
    const fragile = new ScimTokens(broken, { touchIntervalMs: 0 });
    const other = await fragile.issue('acme');
    expect(await fragile.verify(other.token)).toBeDefined();
  });

  it('lists tokens per tenant in creation order', async () => {
    let tick = 0;
    const tokens = new ScimTokens(new MemoryTokenStore(), {
      now: () => new Date(1_700_000_000_000 + tick++ * 1000),
    });
    const first = await tokens.issue('acme', { label: 'first' });
    await tokens.issue('globex');
    const second = await tokens.issue('acme', { label: 'second' });
    expect((await tokens.list('acme')).map((record) => record.id)).toEqual([
      first.record.id,
      second.record.id,
    ]);
  });

  it('validates its inputs', async () => {
    expect(() => new ScimTokens(new MemoryTokenStore(), { prefix: 'Bad_Prefix' })).toThrow(/token prefix/);
    const tokens = new ScimTokens(new MemoryTokenStore(), { prefix: 'acmeidp' });
    expect((await tokens.issue('t')).token).toMatch(/^acmeidp_/);
    await expect(tokens.issue('')).rejects.toThrow(/needs a tenant id/);
    const store = new MemoryTokenStore();
    const record = (await new ScimTokens(store).issue('t')).record;
    await expect(store.insert(record)).rejects.toThrow(/already exists/);
    await store.touch('unknown', new Date());
  });
});

describe('authenticators', () => {
  it('reads bearer tokens', () => {
    expect(readBearerToken(request('Bearer abc'))).toBe('abc');
    expect(readBearerToken(request('bearer   abc  '))).toBe('abc');
    expect(readBearerToken(request('Basic abc'))).toBeUndefined();
    expect(readBearerToken(request('Bearer a b'))).toBeUndefined();
    expect(readBearerToken(request())).toBeUndefined();
    expect(readBearerToken({ headers: new Headers({ authorization: 'Bearer h' }) })).toBe('h');
    expect(readBearerToken({ headers: { authorization: ['Bearer x'] } })).toBe('x');
  });

  it('authenticates issued tokens', async () => {
    const tokens = new ScimTokens(new MemoryTokenStore());
    const issued = await tokens.issue('acme', { label: 'Entra' });
    const plain = await tokens.issue('globex');
    const authenticate = bearerTokenAuth(tokens);
    expect(await authenticate(request(`Bearer ${issued.token}`))).toEqual({
      tenantId: 'acme',
      subject: issued.record.id,
      tokenLabel: 'Entra',
    });
    expect(await authenticate(request(`Bearer ${plain.token}`))).toEqual({
      tenantId: 'globex',
      subject: plain.record.id,
    });
    expect(await authenticate(request('Bearer nope'))).toBeUndefined();
    expect(await authenticate(request())).toBeUndefined();
  });

  it('authenticates with a custom verifier', async () => {
    const authenticate = bearerTokenAuth((token) =>
      token === 'jwt' ? { tenantId: 'acme', subject: 'idp' } : undefined,
    );
    expect(await authenticate(request('Bearer jwt'))).toEqual({ tenantId: 'acme', subject: 'idp' });
    expect(await authenticate(request())).toBeUndefined();
  });

  it('authenticates static tokens', async () => {
    const single = staticTokenAuth({ token: 'a-long-static-token-1', tenantId: 'acme' });
    expect(await single(request('Bearer a-long-static-token-1'))).toEqual({
      tenantId: 'acme',
      subject: 'static-token',
    });
    expect(await single(request('Bearer a-long-static-token-2'))).toBeUndefined();
    expect(await single(request())).toBeUndefined();
    const several = staticTokenAuth([
      { token: 'a-long-static-token-1', tenantId: 'acme' },
      { token: 'b-long-static-token-2', tenantId: 'globex' },
    ]);
    expect(await several(request('Bearer b-long-static-token-2'))).toMatchObject({ tenantId: 'globex' });
    expect(() => staticTokenAuth([])).toThrow(/at least one token/);
    expect(() => staticTokenAuth({ token: 'short', tenantId: 'x' })).toThrow(/at least 16 characters/);
  });
});
