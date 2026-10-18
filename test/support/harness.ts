import {
  type JsonObject,
  MemoryScimStore,
  SCIM_MESSAGES,
  ScimServer,
  type ScimServerOptions,
  type ScimStore,
  silentLogger,
  staticTokenAuth,
} from 'scimkit';

export const TOKEN_ACME = 'acme-token-0123456789abcdef';
export const TOKEN_GLOBEX = 'globex-token-0123456789abcdef';
export const BASE_URL = 'https://scim.example.test/scim/v2';
export const USER = 'urn:ietf:params:scim:schemas:core:2.0:User';
export const GROUP = 'urn:ietf:params:scim:schemas:core:2.0:Group';
export const ENTERPRISE = 'urn:ietf:params:scim:schemas:extension:enterprise:2.0:User';

export interface Reply {
  status: number;
  headers: Record<string, string>;
  body: JsonObject;
}

export interface Harness {
  server: ScimServer;
  store: ScimStore;
  call(method: string, path: string, body?: unknown, headers?: Record<string, string>): Promise<Reply>;
  as(token: string): Harness['call'];
  createUser(userName: string, extra?: JsonObject): Promise<JsonObject>;
  createGroup(displayName: string, memberIds?: string[]): Promise<JsonObject>;
}

export function createHarness(options: Partial<ScimServerOptions> & { store?: ScimStore } = {}): Harness {
  const store = options.store ?? new MemoryScimStore();
  const server = new ScimServer({
    store,
    authenticate: staticTokenAuth([
      { token: TOKEN_ACME, tenantId: 'acme' },
      { token: TOKEN_GLOBEX, tenantId: 'globex' },
    ]),
    baseUrl: BASE_URL,
    logger: silentLogger,
    ...options,
  });
  const as =
    (token: string) =>
    async (
      method: string,
      path: string,
      body?: unknown,
      headers: Record<string, string> = {},
    ): Promise<Reply> => {
      const [pathname = '', query] = path.split('?');
      const response = await server.handle({
        method,
        path: pathname,
        ...(query === undefined ? {} : { query }),
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/scim+json', ...headers },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return {
        status: response.status,
        headers: response.headers,
        body: (response.body ?? {}) as JsonObject,
      };
    };
  const call = as(TOKEN_ACME);
  return {
    server,
    store,
    call,
    as,
    async createUser(userName, extra = {}) {
      const reply = await call('POST', '/Users', { schemas: [USER], userName, ...extra });
      if (reply.status !== 201) throw new Error(`createUser failed: ${JSON.stringify(reply.body)}`);
      return reply.body;
    },
    async createGroup(displayName, memberIds = []) {
      const reply = await call('POST', '/Groups', {
        schemas: [GROUP],
        displayName,
        members: memberIds.map((value) => ({ value })),
      });
      if (reply.status !== 201) throw new Error(`createGroup failed: ${JSON.stringify(reply.body)}`);
      return reply.body;
    },
  };
}

export const patchBody = (...operations: unknown[]) => ({
  schemas: [SCIM_MESSAGES.patchOp],
  Operations: operations,
});
