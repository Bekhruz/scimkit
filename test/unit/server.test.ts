import { describe, expect, it, vi } from 'vitest';
import {
  type JsonObject,
  MemoryScimStore,
  SCIM_MESSAGES,
  ScimError,
  type ScimEvent,
  type ScimRepository,
  ScimServer,
  silentLogger,
  type StoredResource,
  UserResourceType,
  VersionConflictError,
} from 'scimkit';
import {
  BASE_URL,
  createHarness,
  ENTERPRISE,
  GROUP,
  patchBody,
  TOKEN_ACME,
  USER,
} from '../support/harness.js';

describe('discovery', () => {
  it('describes the service provider', async () => {
    const scim = createHarness({ documentationUri: 'https://docs.example.test/scim' });
    const config = await scim.call('GET', '/ServiceProviderConfig');
    expect(config.status).toBe(200);
    expect(config.headers['Content-Type']).toBe('application/scim+json; charset=utf-8');
    expect(config.body).toMatchObject({
      schemas: ['urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig'],
      documentationUri: 'https://docs.example.test/scim',
      patch: { supported: true },
      bulk: { supported: true, maxOperations: 1000, maxPayloadSize: 1_048_576 },
      filter: { supported: true, maxResults: 200 },
      changePassword: { supported: false },
      sort: { supported: true },
      etag: { supported: true },
      authenticationSchemes: [{ type: 'oauthbearertoken', primary: true }],
      meta: { resourceType: 'ServiceProviderConfig', location: `${BASE_URL}/ServiceProviderConfig` },
    });
  });

  it('lists resource types and schemas', async () => {
    const scim = createHarness();
    const types = await scim.call('GET', '/ResourceTypes');
    expect(types.body).toMatchObject({ schemas: [SCIM_MESSAGES.listResponse], totalResults: 2 });
    expect((types.body['Resources'] as JsonObject[])[0]).toEqual({
      schemas: ['urn:ietf:params:scim:schemas:core:2.0:ResourceType'],
      id: 'User',
      name: 'User',
      endpoint: '/Users',
      description: 'User Account',
      schema: USER,
      schemaExtensions: [{ schema: ENTERPRISE, required: false }],
      meta: { resourceType: 'ResourceType', location: `${BASE_URL}/ResourceTypes/User` },
    });
    expect((await scim.call('GET', '/ResourceTypes/group')).body['endpoint']).toBe('/Groups');
    expect((await scim.call('GET', '/ResourceTypes/Device')).status).toBe(404);

    const schemas = await scim.call('GET', '/Schemas');
    expect((schemas.body['Resources'] as JsonObject[]).map((schema) => schema['id'])).toEqual([
      USER,
      ENTERPRISE,
      GROUP,
    ]);
    const user = await scim.call('GET', `/Schemas/${USER}`);
    const userName = (user.body['attributes'] as JsonObject[]).find(
      (attribute) => attribute['name'] === 'userName',
    );
    expect(userName).toEqual({
      name: 'userName',
      type: 'string',
      multiValued: false,
      description: expect.any(String),
      required: true,
      caseExact: false,
      mutability: 'readWrite',
      returned: 'default',
      uniqueness: 'server',
    });
    expect((await scim.call('GET', '/Schemas/urn:example:none')).status).toBe(404);
    expect((await scim.call('GET', '/ServiceProviderConfig/x')).status).toBe(404);
    expect((await scim.call('GET', '/Schemas/a/b')).status).toBe(404);
  });

  it('requires authentication for discovery unless configured otherwise', async () => {
    const closed = createHarness();
    expect((await closed.as('wrong-token-000000000000')('GET', '/ServiceProviderConfig')).status).toBe(401);
    const open = createHarness({ discoveryRequiresAuthentication: false });
    expect((await open.as('wrong-token-000000000000')('GET', '/Schemas')).status).toBe(200);
    expect((await open.as('wrong-token-000000000000')('GET', '/Users')).status).toBe(401);
  });

  it('advertises changePassword when a password hook is set', async () => {
    const scim = createHarness({ hooks: { setPassword: () => undefined } });
    expect((await scim.call('GET', '/ServiceProviderConfig')).body['changePassword']).toEqual({
      supported: true,
    });
  });
});

describe('authentication and routing', () => {
  it('answers 401 with a WWW-Authenticate challenge', async () => {
    const scim = createHarness();
    const reply = await scim.as('not-a-valid-token-000')('GET', '/Users');
    expect(reply.status).toBe(401);
    expect(reply.headers['WWW-Authenticate']).toBe('Bearer realm="SCIM"');
    expect(reply.body).toEqual({
      schemas: [SCIM_MESSAGES.error],
      status: '401',
      detail: 'Authentication is required.',
    });
    const none = await scim.server.handle({ method: 'GET', path: '/Users', baseUrl: BASE_URL });
    expect(none.status).toBe(401);
  });

  it('answers 404 and 405 with SCIM errors', async () => {
    const scim = createHarness();
    expect((await scim.call('GET', '/')).status).toBe(404);
    expect((await scim.call('GET', '/Devices')).status).toBe(404);
    expect((await scim.call('GET', '/Users/1/extra')).status).toBe(404);
    expect((await scim.call('GET', '/Users/%E0%A4%A')).status).toBe(404);
    const wrong = await scim.call('DELETE', '/Users');
    expect(wrong.status).toBe(405);
    expect(wrong.headers['Allow']).toBe('GET, POST');
    expect((await scim.call('GET', '/Users/.search')).status).toBe(405);
    expect((await scim.call('POST', '/Users/123')).status).toBe(405);
    expect((await scim.call('POST', '/ServiceProviderConfig')).status).toBe(405);
    expect((await scim.call('GET', '/Bulk')).status).toBe(405);
    expect((await scim.call('GET', '/.search')).status).toBe(405);
  });

  it('matches endpoints case-insensitively when lenient and exactly when strict', async () => {
    expect((await createHarness().call('GET', '/users')).status).toBe(200);
    expect((await createHarness().call('GET', '/serviceproviderconfig')).status).toBe(200);
    expect((await createHarness({ compatibility: 'strict' }).call('GET', '/users')).status).toBe(404);
  });

  it('answers HEAD like GET without a body', async () => {
    const scim = createHarness();
    const reply = await scim.server.handle({
      method: 'HEAD',
      path: '/Users',
      headers: { authorization: `Bearer ${TOKEN_ACME}` },
      baseUrl: BASE_URL,
    });
    expect(reply.status).toBe(200);
    expect(reply.body).toBeUndefined();
  });

  it('echoes or creates a request id', async () => {
    const scim = createHarness();
    expect(
      (await scim.call('GET', '/Users', undefined, { 'x-request-id': 'req-123' })).headers['X-Request-Id'],
    ).toBe('req-123');
    expect(
      (await scim.call('GET', '/Users', undefined, { 'x-request-id': 'bad id!' })).headers['X-Request-Id'],
    ).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('derives the base URL from the request when none is configured', async () => {
    const server = new ScimServer({
      store: new MemoryScimStore(),
      authenticate: () => ({ tenantId: 't' }),
      logger: silentLogger,
    });
    const reply = await server.handle({
      method: 'GET',
      path: '/ServiceProviderConfig',
      baseUrl: 'https://h.test/scim/',
    });
    expect((reply.body as JsonObject)['meta']).toMatchObject({
      location: 'https://h.test/scim/ServiceProviderConfig',
    });
    const missing = await server.handle({ method: 'GET', path: '/ServiceProviderConfig' });
    expect(missing.status).toBe(500);
  });

  it('rejects principals without a tenant', async () => {
    const logger = { ...silentLogger, error: vi.fn() };
    const server = new ScimServer({
      store: new MemoryScimStore(),
      authenticate: () => ({ tenantId: '' }),
      logger,
      baseUrl: BASE_URL,
    });
    expect((await server.handle({ method: 'GET', path: '/Users' })).status).toBe(500);
    expect(logger.error).toHaveBeenCalled();
  });

  it('turns authenticator errors into responses', async () => {
    const server = new ScimServer({
      store: new MemoryScimStore(),
      authenticate: () => {
        throw ScimError.forbidden('This token is read-only.');
      },
      logger: silentLogger,
      baseUrl: BASE_URL,
    });
    const reply = await server.handle({ method: 'GET', path: '/Users' });
    expect(reply.status).toBe(403);
    expect((reply.body as JsonObject)['detail']).toBe('This token is read-only.');
  });
});

describe('request validation', () => {
  it('rejects bodies that are not JSON objects', async () => {
    const scim = createHarness();
    const noBody = await scim.server.handle({
      method: 'POST',
      path: '/Users',
      headers: { authorization: `Bearer ${TOKEN_ACME}` },
    });
    expect(noBody.status).toBe(400);
    expect((noBody.body as JsonObject)['scimType']).toBe('invalidSyntax');
    const broken = await scim.server.handle({
      method: 'POST',
      path: '/Users',
      headers: { authorization: `Bearer ${TOKEN_ACME}` },
      body: '{"userName":',
    });
    expect((broken.body as JsonObject)['detail']).toBe('The request body is not valid JSON.');
    const bytes = await scim.server.handle({
      method: 'POST',
      path: '/Users',
      headers: { authorization: `Bearer ${TOKEN_ACME}` },
      body: new TextEncoder().encode(JSON.stringify({ schemas: [USER], userName: 'bytes' })),
    });
    expect(bytes.status).toBe(201);
    const parsed = await scim.server.handle({
      method: 'POST',
      path: '/Users',
      headers: { authorization: `Bearer ${TOKEN_ACME}` },
      body: { schemas: [USER], userName: 'parsed' },
    });
    expect(parsed.status).toBe(201);
  });

  it('checks content types and envelopes in strict mode', async () => {
    const scim = createHarness({ compatibility: 'strict' });
    const text = await scim.call(
      'POST',
      '/Users',
      { schemas: [USER], userName: 'a' },
      { 'content-type': 'text/plain' },
    );
    expect(text.status).toBe(415);
    const search = await scim.call('POST', '/Users/.search', { filter: 'userName pr' });
    expect(search.status).toBe(400);
    const json = await scim.call(
      'POST',
      '/Users',
      { schemas: [USER], userName: 'a' },
      { 'content-type': 'application/json' },
    );
    expect(json.status).toBe(201);
    const lenientText = await createHarness().call(
      'POST',
      '/Users',
      { schemas: [USER], userName: 'a' },
      { 'content-type': 'text/plain' },
    );
    expect(lenientText.status).toBe(201);
  });

  it('validates list parameters', async () => {
    const scim = createHarness();
    await scim.createUser('a@x.io');
    await scim.createUser('b@x.io');
    expect((await scim.call('GET', '/Users?startIndex=abc')).body['detail']).toBe(
      '"startIndex" must be an integer.',
    );
    expect((await scim.call('GET', '/Users?count=1.5')).status).toBe(400);
    expect((await scim.call('GET', '/Users?sortOrder=sideways')).status).toBe(400);
    expect((await scim.call('GET', '/Users?sortBy=name')).body['detail']).toMatch(
      /Cannot sort by the complex attribute/,
    );
    expect((await scim.call('GET', '/Users?sortBy=password')).status).toBe(400);
    expect((await scim.call('GET', '/Users?sortBy=nope')).status).toBe(400);
    expect((await scim.call('GET', '/Users?startIndex=-5&count=-1')).body).toMatchObject({
      startIndex: 1,
      itemsPerPage: 0,
    });
    expect((await scim.call('GET', '/Users?count=5000')).body['itemsPerPage']).toBe(2);
    expect((await scim.call('GET', '/Users?attributes=nope')).status).toBe(200);
    expect(
      (await createHarness({ compatibility: 'strict' }).call('GET', '/Users?attributes=nope')).status,
    ).toBe(400);
    expect((await scim.call('GET', '/Users?COUNT=1')).body['itemsPerPage']).toBe(1);
    const search = await scim.call('POST', '/Users/.search', { attributes: 5 });
    expect(search.status).toBe(400);
    expect((await scim.call('POST', '/Users/.search', { filter: 7 })).body['scimType']).toBe('invalidFilter');
    expect((await scim.call('POST', '/Users/.search', ['x'])).status).toBe(400);
  });

  it('applies configured limits', async () => {
    const scim = createHarness({
      limits: { maxResults: 2, defaultCount: 5, maxPatchOperations: 1, maxFilterLength: 10 },
    });
    for (const name of ['a', 'b', 'c']) await scim.createUser(`${name}@x.io`);
    const list = await scim.call('GET', '/Users');
    expect(list.body).toMatchObject({ totalResults: 3, itemsPerPage: 2 });
    expect(
      (await scim.call('GET', `/Users?filter=${encodeURIComponent('userName eq "abcdefgh"')}`)).status,
    ).toBe(400);
    const id = ((list.body['Resources'] as JsonObject[])[0] as JsonObject)['id'] as string;
    const tooMany = await scim.call(
      'PATCH',
      `/Users/${id}`,
      patchBody({ op: 'add', path: 'title', value: 'a' }, { op: 'add', path: 'nickName', value: 'b' }),
    );
    expect(tooMany.status).toBe(413);
  });

  it('returns the projection asked for on writes', async () => {
    const scim = createHarness();
    const created = await scim.call('POST', '/Users?attributes=userName', {
      schemas: [USER],
      userName: 'a',
      title: 'T',
    });
    expect(created.body).toEqual({ schemas: [USER], id: expect.any(String), userName: 'a' });
    const deleted = await scim.call('DELETE', `/Users/${created.body['id'] as string}?attributes=userName`);
    expect(deleted.status).toBe(204);
  });
});

describe('root search', () => {
  it('searches across resource types with one pagination', async () => {
    const scim = createHarness();
    const ann = await scim.createUser('ann@x.io', { displayName: 'Shared' });
    await scim.createUser('bo@x.io');
    await scim.createGroup('Shared', [ann['id'] as string]);
    const all = await scim.call('POST', '/.search', { count: 10 });
    expect(all.body).toMatchObject({ totalResults: 3, itemsPerPage: 3 });
    const shared = await scim.call('POST', '/.search', {
      filter: 'displayName eq "shared"',
      attributes: ['displayName'],
    });
    expect(shared.body['totalResults']).toBe(2);
    expect((shared.body['Resources'] as JsonObject[]).map((resource) => resource['schemas'])).toEqual([
      [USER],
      [GROUP],
    ]);
    const users = await scim.call('POST', '/.search', { filter: 'userName sw "a"' });
    expect(users.body['totalResults']).toBe(1);
    const page = await scim.call('POST', '/.search', { startIndex: 2, count: 2 });
    expect(page.body).toMatchObject({ totalResults: 3, startIndex: 2, itemsPerPage: 2 });
    expect(((page.body['Resources'] as JsonObject[])[1] as JsonObject)['displayName']).toBe('Shared');
    const zero = await scim.call('POST', '/.search', { count: 0 });
    expect(zero.body).toMatchObject({ totalResults: 3, itemsPerPage: 0 });
    expect((await scim.call('POST', '/.search', { filter: 'shoeSize eq 1' })).body['scimType']).toBe(
      'invalidFilter',
    );
    expect((await scim.call('POST', '/.search', { sortBy: 'userName' })).status).toBe(400);
    expect((await scim.call('POST', '/.search', { filter: 3 })).status).toBe(400);
  });
});

describe('/Me', () => {
  it('maps to the resource me() names', async () => {
    const store = new MemoryScimStore();
    const target: { id?: string } = {};
    const scim = createHarness({
      store,
      me: () => (target.id === undefined ? undefined : { resourceType: 'User', id: target.id }),
    });
    expect((await scim.call('GET', '/Me')).status).toBe(404);
    const ann = await scim.createUser('ann@x.io');
    target.id = ann['id'] as string;
    expect((await scim.call('GET', '/Me')).body['userName']).toBe('ann@x.io');
    expect(
      (await scim.call('PATCH', '/Me', patchBody({ op: 'replace', path: 'nickName', value: 'A' }))).body[
        'nickName'
      ],
    ).toBe('A');
    expect((await scim.call('POST', '/Me', {})).status).toBe(501);
    expect((await scim.call('GET', '/Me/x')).status).toBe(404);
    expect((await createHarness().call('GET', '/Me')).status).toBe(501);
  });
});

describe('bulk', () => {
  const bulk = (operations: unknown[], extra: JsonObject = {}) => ({
    schemas: [SCIM_MESSAGES.bulkRequest],
    Operations: operations,
    ...extra,
  });

  it('runs operations and resolves bulkId references, including forward ones', async () => {
    const scim = createHarness();
    const reply = await scim.call(
      'POST',
      '/Bulk',
      bulk([
        {
          method: 'POST',
          path: '/Groups',
          bulkId: 'g',
          data: {
            schemas: [GROUP],
            displayName: 'Tour Guides',
            members: [{ type: 'User', value: 'bulkId:u' }],
          },
        },
        { method: 'POST', path: '/Users', bulkId: 'u', data: { schemas: [USER], userName: 'alice' } },
        {
          method: 'PATCH',
          path: '/Users/bulkId:u',
          data: patchBody({ op: 'replace', path: 'title', value: 'Guide' }),
        },
      ]),
    );
    expect(reply.status).toBe(200);
    const operations = reply.body['Operations'] as JsonObject[];
    expect(operations.map((operation) => [operation['bulkId'], operation['status']])).toEqual([
      ['g', '201'],
      ['u', '201'],
      [undefined, '200'],
    ]);
    expect(operations[0]?.['location']).toMatch(/\/Groups\//);
    expect(operations[0]?.['version']).toMatch(/^W\//);
    const userId = String(operations[1]?.['location']).split('/').pop() as string;
    const user = await scim.call('GET', `/Users/${userId}`);
    expect(user.body['title']).toBe('Guide');
    expect((user.body['groups'] as JsonObject[])[0]?.['display']).toBe('Tour Guides');
  });

  it('reports failures per operation and stops after failOnErrors', async () => {
    const scim = createHarness();
    const reply = await scim.call(
      'POST',
      '/Bulk',
      bulk(
        [
          { method: 'POST', path: '/Users', bulkId: 'a', data: { schemas: [USER] } },
          { method: 'DELETE', path: '/Users/nope' },
          {
            method: 'POST',
            path: '/Users',
            bulkId: 'c',
            data: { schemas: [USER], userName: 'never-created' },
          },
        ],
        { failOnErrors: 2 },
      ),
    );
    const operations = reply.body['Operations'] as JsonObject[];
    expect(operations).toHaveLength(2);
    expect(operations[0]).toMatchObject({ status: '400', response: { scimType: 'invalidValue' } });
    expect(operations[1]).toMatchObject({ method: 'DELETE', status: '404' });
    expect((await scim.call('GET', '/Users')).body['totalResults']).toBe(0);
  });

  it('fails operations that depend on failed, unknown or circular references', async () => {
    const scim = createHarness();
    const reply = await scim.call(
      'POST',
      '/Bulk',
      bulk([
        { method: 'POST', path: '/Users', bulkId: 'bad', data: { schemas: [USER] } },
        {
          method: 'PATCH',
          path: '/Users/bulkId:bad',
          data: patchBody({ op: 'replace', path: 'title', value: 'x' }),
        },
        {
          method: 'PATCH',
          path: '/Users/bulkId:ghost',
          data: patchBody({ op: 'replace', path: 'title', value: 'x' }),
        },
        {
          method: 'POST',
          path: '/Groups',
          bulkId: 'x',
          data: { schemas: [GROUP], displayName: 'X', members: [{ value: 'bulkId:y' }] },
        },
        {
          method: 'POST',
          path: '/Groups',
          bulkId: 'y',
          data: { schemas: [GROUP], displayName: 'Y', members: [{ value: 'bulkId:x' }] },
        },
        { method: 'PUT', path: '/Users', data: { schemas: [USER], userName: 'x' } },
        { method: 'POST', path: '/Users/1', bulkId: 'p', data: { schemas: [USER], userName: 'x' } },
        { method: 'POST', path: '/Nope', bulkId: 'q', data: {} },
      ]),
    );
    const statuses = (reply.body['Operations'] as JsonObject[]).map((operation) => operation['status']);
    expect(statuses).toEqual(['400', '409', '409', '409', '409', '400', '400', '400']);
  });

  it('validates bulk requests', async () => {
    const scim = createHarness({ limits: { maxBulkOperations: 1, maxBulkPayloadBytes: 400 } });
    expect((await scim.call('POST', '/Bulk', bulk([]))).status).toBe(400);
    expect((await scim.call('POST', '/Bulk', 'x')).status).toBe(400);
    expect(
      (
        await scim.call(
          'POST',
          '/Bulk',
          bulk([
            { method: 'DELETE', path: '/Users/1' },
            { method: 'DELETE', path: '/Users/2' },
          ]),
        )
      ).status,
    ).toBe(413);
    expect(
      (
        await scim.call(
          'POST',
          '/Bulk',
          bulk([{ method: 'DELETE', path: '/Users/1', data: 'x'.repeat(500) }]),
        )
      ).status,
    ).toBe(413);
    const invalid: [unknown, RegExp][] = [
      [{ method: 'GET', path: '/Users' }, /unknown "method"/],
      [{ method: 'POST', path: 'Users', bulkId: 'a', data: {} }, /needs a "path"/],
      [{ method: 'POST', path: '/Users', bulkId: '', data: {} }, /invalid "bulkId"/],
      [{ method: 'POST', path: '/Users', bulkId: 'a' }, /needs "data"/],
      [{ method: 'DELETE', path: '/Users/1', version: 1 }, /"version" that is not a string/],
      ['op', /must be an object/],
    ];
    const roomy = createHarness();
    for (const [operation, message] of invalid) {
      const reply = await roomy.call('POST', '/Bulk', bulk([operation]));
      expect(reply.status).toBe(400);
      expect(reply.body['detail']).toMatch(message);
    }
    expect(
      (await roomy.call('POST', '/Bulk', bulk([{ method: 'DELETE', path: '/Users/1' }], { failOnErrors: 0 })))
        .status,
    ).toBe(400);
    const duplicate = await roomy.call(
      'POST',
      '/Bulk',
      bulk([
        { method: 'POST', path: '/Users', bulkId: 'a', data: {} },
        { method: 'POST', path: '/Users', bulkId: 'a', data: {} },
      ]),
    );
    expect(duplicate.body['detail']).toMatch(/used twice/);
    const strict = createHarness({ compatibility: 'strict' });
    expect(
      (await strict.call('POST', '/Bulk', { Operations: [{ method: 'DELETE', path: '/Users/1' }] })).status,
    ).toBe(400);
    expect(
      (
        await strict.call(
          'POST',
          '/Bulk',
          bulk([{ method: 'POST', path: '/Users', data: { schemas: [USER], userName: 'a' } }]),
        )
      ).body['detail'],
    ).toMatch(/needs a "bulkId"/);
    expect(
      (
        await createHarness({ bulk: false }).call(
          'POST',
          '/Bulk',
          bulk([{ method: 'DELETE', path: '/Users/1' }]),
        )
      ).status,
    ).toBe(501);
  });

  it('applies bulk versions as If-Match', async () => {
    const scim = createHarness();
    const ann = await scim.createUser('ann@x.io');
    const reply = await scim.call(
      'POST',
      '/Bulk',
      bulk([{ method: 'DELETE', path: `/Users/${ann['id'] as string}`, version: 'W/"999"' }]),
    );
    expect((reply.body['Operations'] as JsonObject[])[0]?.['status']).toBe('412');
  });
});

describe('hooks and events', () => {
  it('emits lifecycle, activation and membership events', async () => {
    const events: ScimEvent[] = [];
    const scim = createHarness({ hooks: { onEvent: (event) => void events.push(event) } });
    const ann = await scim.createUser('ann@x.io');
    const id = ann['id'] as string;
    await scim.call('PATCH', `/Users/${id}`, patchBody({ op: 'replace', path: 'active', value: false }));
    await scim.call('PUT', `/Users/${id}`, { schemas: [USER], userName: 'ann@x.io', active: true });
    const group = await scim.createGroup('G', [id]);
    await scim.call(
      'PATCH',
      `/Groups/${group['id'] as string}`,
      patchBody({ op: 'remove', path: `members[value eq "${id}"]` }),
    );
    await scim.call('DELETE', `/Users/${id}`);
    expect(events.map((event) => event.type)).toEqual([
      'resource.created',
      'resource.updated',
      'user.deactivated',
      'resource.updated',
      'user.reactivated',
      'resource.created',
      'group.members.added',
      'resource.updated',
      'group.members.removed',
      'resource.deleted',
    ]);
    const added = events[6] as Extract<ScimEvent, { members: unknown }>;
    expect(added.members).toEqual([{ value: id, type: 'User' }]);
    expect(added.context.tenantId).toBe('acme');
    const updated = events[1] as Extract<ScimEvent, { type: 'resource.updated' }>;
    expect(updated.operation).toBe('patch');
    expect(updated.previous['active']).toBeUndefined();
  });

  it('logs failing event handlers without failing the request', async () => {
    const logger = { ...silentLogger, error: vi.fn() };
    const scim = createHarness({
      logger,
      hooks: {
        onEvent: () => {
          throw new Error('handler broke');
        },
      },
    });
    const reply = await scim.call('POST', '/Users', { schemas: [USER], userName: 'a' });
    expect(reply.status).toBe(201);
    expect(logger.error).toHaveBeenCalledWith(
      'An onEvent hook failed',
      expect.objectContaining({ event: 'resource.created' }),
    );
  });

  it('lets beforeWrite reject or rewrite a write', async () => {
    const scim = createHarness({
      hooks: {
        beforeWrite: (event) => {
          if (event.action === 'delete')
            throw ScimError.forbidden('Users cannot be deleted; deactivate them.');
          const userName = event.attributes?.['userName'];
          if (typeof userName === 'string' && !userName.endsWith('@acme.test')) {
            throw ScimError.invalidValue('Only @acme.test accounts can be provisioned.');
          }
          if (event.action === 'create') return { ...event.attributes, title: 'Provisioned' };
          return undefined;
        },
      },
    });
    expect((await scim.call('POST', '/Users', { schemas: [USER], userName: 'a@else.test' })).status).toBe(
      400,
    );
    const created = await scim.call('POST', '/Users', { schemas: [USER], userName: 'a@acme.test' });
    expect(created.body['title']).toBe('Provisioned');
    expect((await scim.call('DELETE', `/Users/${created.body['id'] as string}`)).status).toBe(403);
    const patched = await scim.call(
      'PATCH',
      `/Users/${created.body['id'] as string}`,
      patchBody({ op: 'replace', path: 'nickName', value: 'A' }),
    );
    expect(patched.status).toBe(200);
  });

  it('passes passwords to setPassword and never stores them', async () => {
    const setPassword = vi.fn();
    const scim = createHarness({ hooks: { setPassword } });
    const created = await scim.call('POST', '/Users', {
      schemas: [USER],
      userName: 'a',
      password: 'P@ssw0rd!',
    });
    const id = created.body['id'] as string;
    expect(setPassword).toHaveBeenCalledWith(expect.objectContaining({ tenantId: 'acme' }), {
      resourceType: 'User',
      id,
      password: 'P@ssw0rd!',
    });
    await scim.call(
      'PATCH',
      `/Users/${id}`,
      patchBody({ op: 'replace', path: 'password', value: 'N3w-pass' }),
    );
    expect(setPassword).toHaveBeenLastCalledWith(expect.anything(), {
      resourceType: 'User',
      id,
      password: 'N3w-pass',
    });
    await scim.call('PUT', `/Users/${id}`, { schemas: [USER], userName: 'a', password: 'Third-1' });
    expect(setPassword).toHaveBeenCalledTimes(3);
    const read = await scim.call('GET', `/Users/${id}?attributes=password`);
    expect(read.body).not.toHaveProperty('password');
    const unhooked = createHarness();
    expect(
      (await unhooked.call('POST', '/Users', { schemas: [USER], userName: 'a', password: 'x' })).status,
    ).toBe(201);
  });
});

describe('repositories', () => {
  const stored = (id: string, version: string): StoredResource => ({
    id,
    version,
    created: new Date('2024-01-01T00:00:00Z'),
    lastModified: new Date('2024-01-01T00:00:00Z'),
    attributes: { userName: 'u' },
  });

  it('retries a write after a version conflict and gives up after eight attempts', async () => {
    let conflicts = 1;
    const replace = vi.fn(() => {
      if (conflicts > 0) {
        conflicts--;
        return Promise.reject(new VersionConflictError());
      }
      return Promise.resolve(stored('1', '3'));
    });
    const repository: ScimRepository = {
      create: () => Promise.reject(new Error('unused')),
      get: () => Promise.resolve(stored('1', '2')),
      list: () => Promise.resolve({ totalResults: 0, resources: [] }),
      replace,
      delete: () => Promise.reject(new VersionConflictError()),
    };
    const server = new ScimServer({
      resourceTypes: [UserResourceType],
      repositories: { User: repository },
      authenticate: () => ({ tenantId: 't' }),
      baseUrl: BASE_URL,
      logger: silentLogger,
    });
    const request = (method: string, body?: unknown, headers: Record<string, string> = {}) =>
      server.handle({ method, path: '/Users/1', body, headers });
    expect((await request('PUT', { schemas: [USER], userName: 'v' })).status).toBe(200);
    expect(replace).toHaveBeenCalledTimes(2);
    conflicts = 10;
    expect((await request('PUT', { schemas: [USER], userName: 'v' })).status).toBe(409);
    conflicts = 1;
    expect((await request('PUT', { schemas: [USER], userName: 'v' }, { 'if-match': 'W/"2"' })).status).toBe(
      412,
    );
    expect((await request('DELETE')).status).toBe(409);
  });

  it('lets a PATCH repair stored data that does not validate', async () => {
    const incomplete: StoredResource = { ...stored('1', '1'), attributes: { nickName: 'no userName' } };
    const replace = vi.fn((_context: unknown, _id: string, attributes: JsonObject) =>
      Promise.resolve({ ...stored('1', '2'), attributes }),
    );
    const server = new ScimServer({
      resourceTypes: [UserResourceType],
      repositories: {
        User: {
          create: () => Promise.reject(new Error('unused')),
          get: () => Promise.resolve(incomplete),
          list: () => Promise.resolve({ totalResults: 0, resources: [] }),
          replace,
          delete: () => Promise.resolve(false),
        },
      },
      authenticate: () => ({ tenantId: 't' }),
      baseUrl: BASE_URL,
      logger: silentLogger,
    });
    const reply = await server.handle({
      method: 'PATCH',
      path: '/Users/1',
      body: patchBody({ op: 'add', path: 'userName', value: 'fixed' }),
    });
    expect(reply.status).toBe(200);
    expect(replace).toHaveBeenCalledWith(
      expect.anything(),
      '1',
      { nickName: 'no userName', userName: 'fixed' },
      {
        expectedVersion: '1',
      },
    );
  });

  it('hides unexpected repository errors behind a 500 and logs them', async () => {
    const logger = { ...silentLogger, error: vi.fn() };
    const server = new ScimServer({
      resourceTypes: [UserResourceType],
      repositories: {
        User: {
          create: () => Promise.reject(new Error('connection refused')),
          get: () => Promise.reject(ScimError.internal('Database unavailable.')),
          list: () => Promise.resolve({ totalResults: 0, resources: [] }),
          replace: () => Promise.reject(new Error('x')),
          delete: () => Promise.resolve(false),
        },
      },
      authenticate: () => ({ tenantId: 't' }),
      baseUrl: BASE_URL,
      logger,
    });
    const created = await server.handle({
      method: 'POST',
      path: '/Users',
      body: { schemas: [USER], userName: 'a' },
    });
    expect(created.status).toBe(500);
    expect(JSON.stringify(created.body)).not.toContain('connection refused');
    expect(logger.error).toHaveBeenCalledWith(
      'Unexpected error while handling a SCIM request',
      expect.objectContaining({ method: 'POST' }),
    );
    expect((await server.handle({ method: 'GET', path: '/Users/1' })).status).toBe(500);
    expect(logger.error).toHaveBeenCalledWith('Database unavailable.', expect.anything());
  });

  it('validates its configuration', () => {
    const authenticate = () => ({ tenantId: 't' });
    expect(() => new ScimServer({ authenticate })).toThrow(/No repository for resource type User/);
    expect(() => new ScimServer({ store: new MemoryScimStore() } as never)).toThrow(
      /needs an `authenticate` function/,
    );
    expect(() => new ScimServer({ store: new MemoryScimStore(), authenticate, resourceTypes: [] })).toThrow(
      /at least one/,
    );
    expect(
      () =>
        new ScimServer({
          store: new MemoryScimStore(),
          authenticate,
          resourceTypes: [UserResourceType, UserResourceType],
        }),
    ).toThrow(/defined twice/);
    expect(
      () =>
        new ScimServer({
          store: new MemoryScimStore(),
          authenticate,
          repositories: { Device: {} as ScimRepository },
        }),
    ).toThrow(/Unknown resource type "Device"/);
  });
});
