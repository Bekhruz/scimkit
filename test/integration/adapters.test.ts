import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createFetchHandler,
  createNodeHandler,
  MemoryScimStore,
  ScimServer,
  silentLogger,
  staticTokenAuth,
} from 'scimkit';

const TOKEN = 'adapter-test-token-0123456789';
const USER = 'urn:ietf:params:scim:schemas:core:2.0:User';
const headers = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/scim+json' };

const scimServer = () =>
  new ScimServer({
    store: new MemoryScimStore(),
    authenticate: staticTokenAuth({ token: TOKEN, tenantId: 'acme' }),
    logger: silentLogger,
  });

const servers: Server[] = [];
async function listen(server: Server): Promise<string> {
  servers.push(server);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))));
});

describe('createNodeHandler', () => {
  it('serves SCIM below a base path on a plain http server', async () => {
    const url = await listen(createServer(createNodeHandler(scimServer(), { basePath: '/scim/v2/' })));
    const created = await fetch(`${url}/scim/v2/Users`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ schemas: [USER], userName: 'ann@example.com' }),
    });
    expect(created.status).toBe(201);
    const body = (await created.json()) as { id: string };
    expect(created.headers.get('location')).toBe(`${url}/scim/v2/Users/${body.id}`);
    const list = await fetch(
      `${url}/scim/v2/Users?filter=${encodeURIComponent('userName eq "ann@example.com"')}`,
      { headers },
    );
    expect(await list.json()).toMatchObject({ totalResults: 1 });
    const deleted = await fetch(`${url}/scim/v2/Users/${body.id}`, { method: 'DELETE', headers });
    expect(deleted.status).toBe(204);
    const outside = await fetch(`${url}/elsewhere`, { headers });
    expect(outside.status).toBe(404);
    expect(await outside.json()).toMatchObject({ status: '404' });
    expect((await fetch(`${url}/scim/v2`, { headers })).status).toBe(404);
  });

  it('enforces the body limit', async () => {
    const url = await listen(createServer(createNodeHandler(scimServer(), { bodyLimit: 100 })));
    const big = JSON.stringify({ schemas: [USER], userName: 'x'.repeat(200) });
    const declared = await fetch(`${url}/Users`, { method: 'POST', headers, body: big });
    expect(declared.status).toBe(413);
    const chunked = await fetch(`${url}/Users`, {
      method: 'POST',
      headers,
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(big));
          controller.close();
        },
      }),
      duplex: 'half',
    } as RequestInit);
    expect(chunked.status).toBe(413);
  });

  it('derives the base URL from forwarded headers only when trusted', async () => {
    const trusting = await listen(createServer(createNodeHandler(scimServer(), { trustProxy: true })));
    const forwarded = {
      ...headers,
      'x-forwarded-proto': 'https',
      'x-forwarded-host': 'id.example.com, proxy',
    };
    const trusted = await fetch(`${trusting}/ServiceProviderConfig`, { headers: forwarded });
    expect(await trusted.json()).toMatchObject({
      meta: { location: 'https://id.example.com/ServiceProviderConfig' },
    });
    const plain = await listen(createServer(createNodeHandler(scimServer())));
    const untrusted = await fetch(`${plain}/ServiceProviderConfig`, { headers: forwarded });
    expect(await untrusted.json()).toMatchObject({ meta: { location: `${plain}/ServiceProviderConfig` } });
  });

  it('mounts in Express, with or without a JSON body parser in front', async () => {
    const app = express();
    app.use(express.json());
    app.use('/scim/v2', createNodeHandler(scimServer()));
    app.get('/health', (_request, response) => {
      response.send('ok');
    });
    const url = await listen(createServer(app));
    for (const contentType of ['application/json', 'application/scim+json']) {
      const created = await fetch(`${url}/scim/v2/Users`, {
        method: 'POST',
        headers: { ...headers, 'content-type': contentType },
        body: JSON.stringify({ schemas: [USER], userName: `user-${contentType}@example.com` }),
      });
      expect(created.status).toBe(201);
      expect(created.headers.get('location')).toMatch(new RegExp(`^${url}/scim/v2/Users/`));
    }
    expect(await (await fetch(`${url}/health`)).text()).toBe('ok');
    const missing = createNodeHandler(scimServer(), { basePath: '/scim' });
    const passed = await new Promise<boolean>((resolve) => {
      missing({ url: '/other', method: 'GET', headers: {} } as never, {} as never, () => {
        resolve(true);
      });
    });
    expect(passed).toBe(true);
  });

  it('reports handler failures to next() when there is one', async () => {
    const failing = { handle: () => Promise.reject(new Error('boom')) } as unknown as ScimServer;
    const app = express();
    app.use('/scim', createNodeHandler(failing));
    app.use(
      (error: Error, _request: express.Request, response: express.Response, _next: express.NextFunction) => {
        response.status(599).send(error.message);
      },
    );
    const url = await listen(createServer(app));
    const reply = await fetch(`${url}/scim/Users`, { headers });
    expect(reply.status).toBe(599);
    expect(await reply.text()).toBe('boom');
    const bare = await listen(createServer(createNodeHandler(failing)));
    expect((await fetch(`${bare}/Users`, { headers })).status).toBe(500);
  });
});

describe('createFetchHandler', () => {
  const handler = createFetchHandler(scimServer(), { basePath: '/scim/v2', bodyLimit: 1000 });
  const request = (path: string, init: RequestInit = {}) =>
    handler(
      new Request(`https://id.example.com${path}`, {
        ...init,
        headers: { ...headers, ...(init.headers as object) },
      }),
    );

  it('serves SCIM with Request and Response', async () => {
    const created = await request('/scim/v2/Users', {
      method: 'POST',
      body: JSON.stringify({ schemas: [USER], userName: 'ann@example.com' }),
    });
    expect(created.status).toBe(201);
    expect(created.headers.get('content-type')).toBe('application/scim+json; charset=utf-8');
    const body = (await created.json()) as { id: string; meta: { location: string } };
    expect(body.meta.location).toBe(`https://id.example.com/scim/v2/Users/${body.id}`);
    const deleted = await request(`/scim/v2/Users/${body.id}`, { method: 'DELETE' });
    expect(deleted.status).toBe(204);
    expect(deleted.body).toBeNull();
    expect((await request('/other')).status).toBe(404);
  });

  it('enforces the body limit while streaming', async () => {
    const big = JSON.stringify({ schemas: [USER], userName: 'x'.repeat(2000) });
    expect((await request('/scim/v2/Users', { method: 'POST', body: big })).status).toBe(413);
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(big.slice(0, 600)));
        controller.enqueue(new TextEncoder().encode(big.slice(600)));
        controller.close();
      },
    });
    const streamed = await handler(
      new Request('https://id.example.com/scim/v2/Users', {
        method: 'POST',
        headers,
        body: stream,
        duplex: 'half',
      } as RequestInit),
    );
    expect(streamed.status).toBe(413);
    const empty = await handler(
      new Request('https://id.example.com/scim/v2/Users', { method: 'POST', headers }),
    );
    expect(empty.status).toBe(400);
  });
});
