import 'reflect-metadata';
import {
  type CanActivate,
  type ExecutionContext,
  Inject,
  Injectable,
  type INestApplication,
  Module,
  SetMetadata,
} from '@nestjs/common';
import { NestFactory, Reflector } from '@nestjs/core';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { MemoryScimStore, ScimServer, type ScimServerOptions, silentLogger, staticTokenAuth } from 'scimkit';
import { ScimModule, type ScimOptionsFactory } from 'scimkit/nestjs';

const TOKEN = 'nest-test-token-0123456789';
const USER = 'urn:ietf:params:scim:schemas:core:2.0:User';
const IS_PUBLIC = 'isPublic';
const Public = () => SetMetadata(IS_PUBLIC, true);

/** A typical application guard: everything needs a session unless marked public. */
@Injectable()
class SessionGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    return (
      this.reflector.getAllAndOverride<boolean | undefined>(IS_PUBLIC, [
        context.getHandler(),
        context.getClass(),
      ]) === true
    );
  }
}

async function start(
  platform: 'express' | 'fastify',
  module: unknown,
): Promise<{ app: INestApplication; url: string }> {
  const app =
    platform === 'express'
      ? await NestFactory.create(module as never, { logger: false })
      : await NestFactory.create(module as never, new FastifyAdapter(), { logger: false });
  app.setGlobalPrefix('api');
  app.useGlobalGuards(new SessionGuard(app.get(Reflector)));
  await app.listen(0, '127.0.0.1');
  return { app, url: (await app.getUrl()).replace('[::1]', '127.0.0.1') };
}

describe.each(['express', 'fastify'] as const)('ScimModule on %s', (platform) => {
  let app: INestApplication;
  let base: string;

  const call = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
    fetch(`${base}${path}`, {
      method,
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/scim+json', ...headers },
      ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
    });

  beforeAll(async () => {
    @Module({
      imports: [
        ScimModule.forRoot({
          store: new MemoryScimStore(),
          authenticate: staticTokenAuth({ token: TOKEN, tenantId: 'acme' }),
          logger: silentLogger,
          decorators: [Public()],
          bodyLimit: 4096,
        }),
      ],
    })
    class AppModule {}
    const started = await start(platform, AppModule);
    app = started.app;
    base = `${started.url}/api/scim/v2`;
  });
  afterAll(async () => {
    await app.close();
  });

  it('creates users from application/scim+json and application/json bodies', async () => {
    const scimJson = await call('POST', '/Users', { schemas: [USER], userName: 'ann@example.com' });
    expect(scimJson.status).toBe(201);
    expect(scimJson.headers.get('content-type')).toBe('application/scim+json; charset=utf-8');
    const created = (await scimJson.json()) as { id: string };
    expect(scimJson.headers.get('location')).toBe(`${base}/Users/${created.id}`);
    const plainJson = await call(
      'POST',
      '/Users',
      { schemas: [USER], userName: 'bo@example.com' },
      { 'content-type': 'application/json' },
    );
    expect(plainJson.status).toBe(201);
  });

  it('serves lists, filters, discovery and search', async () => {
    const list = await call('GET', `/Users?filter=${encodeURIComponent('userName sw "ann"')}&count=5`);
    expect(list.status).toBe(200);
    expect(await list.json()).toMatchObject({ totalResults: 1, itemsPerPage: 1 });
    const schema = await call('GET', `/Schemas/${USER}`);
    expect(schema.status).toBe(200);
    expect(await schema.json()).toMatchObject({ id: USER, meta: { location: `${base}/Schemas/${USER}` } });
    const search = await call('POST', '/Users/.search', { filter: 'userName pr', attributes: ['userName'] });
    expect(search.status).toBe(200);
    expect(await search.json()).toMatchObject({ totalResults: 2 });
  });

  it('patches and deletes', async () => {
    const created = (await (
      await call('POST', '/Users', { schemas: [USER], userName: 'cy@example.com' })
    ).json()) as { id: string };
    const patched = await call('PATCH', `/Users/${created.id}`, {
      schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'],
      Operations: [{ op: 'Replace', path: 'active', value: 'False' }],
    });
    expect(patched.status).toBe(200);
    expect(await patched.json()).toMatchObject({ active: false });
    const deleted = await call('DELETE', `/Users/${created.id}`);
    expect(deleted.status).toBe(204);
    expect(await deleted.text()).toBe('');
  });

  it('answers errors in SCIM format', async () => {
    const malformed = await call('POST', '/Users', '{"userName":');
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toMatchObject({ scimType: 'invalidSyntax', status: '400' });
    const unauthenticated = await fetch(`${base}/Users`);
    expect(unauthenticated.status).toBe(401);
    expect(unauthenticated.headers.get('www-authenticate')).toBe('Bearer realm="SCIM"');
    const root = await call('GET', '');
    expect(root.status).toBe(404);
    expect(await root.json()).toMatchObject({ status: '404' });
    const tooLarge = await call('POST', '/Users', { schemas: [USER], userName: 'x'.repeat(5000) });
    expect(tooLarge.status).toBe(413);
  });

  it('leaves the rest of the application to its guards', async () => {
    @Module({
      imports: [
        ScimModule.forRoot({
          store: new MemoryScimStore(),
          authenticate: staticTokenAuth({ token: TOKEN, tenantId: 'acme' }),
          logger: silentLogger,
        }),
      ],
    })
    class GuardedModule {}
    const guarded = await start(platform, GuardedModule);
    const reply = await fetch(`${guarded.url}/api/scim/v2/Users`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(reply.status).toBe(403);
    await guarded.app.close();
  });
});

describe('ScimModule.forRootAsync', () => {
  @Injectable()
  class TenantDirectory {
    readonly store = new MemoryScimStore();
  }

  @Module({ providers: [TenantDirectory], exports: [TenantDirectory] })
  class DirectoryModule {}

  @Injectable()
  class ScimConfig implements ScimOptionsFactory {
    createScimOptions(): ScimServerOptions {
      return {
        store: new MemoryScimStore(),
        authenticate: staticTokenAuth({ token: TOKEN, tenantId: 'from-class' }),
        logger: silentLogger,
      };
    }
  }

  @Injectable()
  class Provisioning {
    constructor(@Inject(ScimServer) readonly server: ScimServer) {}
  }

  it('builds options with a factory and exports the server', async () => {
    @Module({
      imports: [
        ScimModule.forRootAsync({
          imports: [DirectoryModule],
          inject: [TenantDirectory],
          useFactory: (directory: TenantDirectory) => ({
            store: directory.store,
            authenticate: staticTokenAuth({ token: TOKEN, tenantId: 'acme' }),
            logger: silentLogger,
          }),
          path: '/directory/scim/',
          decorators: [Public()],
          global: true,
        }),
      ],
      providers: [Provisioning],
    })
    class AsyncModule {}
    const { app, url } = await start('express', AsyncModule);
    expect(app.get(Provisioning).server).toBeInstanceOf(ScimServer);
    const reply = await fetch(`${url}/api/directory/scim/ServiceProviderConfig`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(reply.status).toBe(200);
    await app.close();
  });

  it('builds options with a class', async () => {
    @Module({ imports: [ScimModule.forRootAsync({ useClass: ScimConfig, decorators: [Public()] })] })
    class ClassModule {}
    const { app, url } = await start('fastify', ClassModule);
    const reply = await fetch(`${url}/api/scim/v2/Users`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/scim+json' },
      body: JSON.stringify({ schemas: [USER], userName: 'z@example.com' }),
    });
    expect(reply.status).toBe(201);
    await app.close();
  });

  it('logs through the Nest logger by default', async () => {
    const { Logger } = await import('@nestjs/common');
    const debug = vi.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
    const error = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    @Module({
      imports: [
        ScimModule.forRoot({
          store: new MemoryScimStore(),
          authenticate: () => {
            throw new Error('identity provider is down');
          },
          decorators: [Public()],
        }),
      ],
    })
    class LoggingModule {}
    const { app, url } = await start('express', LoggingModule);
    expect((await fetch(`${url}/api/scim/v2/Users`)).status).toBe(500);
    expect(debug).toHaveBeenCalledWith(expect.stringContaining('SCIM request'));
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining('Unexpected error while handling a SCIM request'),
      expect.stringContaining('identity provider is down'),
    );
    await app.close();
    vi.restoreAllMocks();
  });

  it('needs a way to build options', () => {
    expect(() => ScimModule.forRootAsync({})).toThrow(/needs useFactory, useClass or useExisting/);
  });
});
