import { describe, expect, it } from 'vitest';
import {
  createFetchHandler,
  GroupResourceType,
  ScimServer,
  ScimTokens,
  MemoryTokenStore,
  bearerTokenAuth,
  silentLogger,
  UserResourceType,
} from 'scimkit';
import { verifyScimEndpoint } from 'scimkit/verify';
import { AppDatabase } from './app-database.js';
import { TeamsRepository, UsersRepository } from './repositories.js';

describe('example: provisioning into your own tables', () => {
  it('passes the Okta, Entra and RFC checks and fills the app tables', async () => {
    const db = new AppDatabase();
    const tokens = new ScimTokens(new MemoryTokenStore());
    const { token } = await tokens.issue('org_acme', { label: 'Okta' });
    const server = new ScimServer({
      resourceTypes: [UserResourceType, GroupResourceType],
      repositories: { User: new UsersRepository(db), Group: new TeamsRepository(db) },
      authenticate: bearerTokenAuth(tokens),
      logger: silentLogger,
    });
    const handler = createFetchHandler(server, { basePath: '/scim/v2' });
    const fetcher: typeof fetch = (input, init) => handler(new Request(input, init));

    const report = await verifyScimEndpoint({
      baseUrl: 'https://app.example.com/scim/v2',
      token,
      fetch: fetcher,
      keep: true,
    });
    expect(report.checks.filter((check) => check.status !== 'passed')).toEqual([]);

    // The Okta user is still there (Okta deactivates rather than deletes), stored in the app's columns.
    const okta = [...db.users.values()].find((user) => user.username.includes('-okta-dana'));
    expect(okta).toMatchObject({
      organizationId: 'org_acme',
      firstName: 'Dana',
      lastName: 'Mulder',
      displayName: 'Dana Mulder',
      isActive: true,
      email: okta?.username,
    });
    // Attributes without a column round-trip through the JSON column.
    expect(okta?.scimAttributes).toMatchObject({ locale: 'en-US' });

    const { token: otherTenant } = await tokens.issue('org_globex');
    const isolated = await fetcher(`https://app.example.com/scim/v2/Users/${okta?.id ?? ''}`, {
      headers: { authorization: `Bearer ${otherTenant}` },
    });
    expect(isolated.status).toBe(404);
  });

  it('rejects filters the app cannot answer', async () => {
    const server = new ScimServer({
      repositories: {
        User: new UsersRepository(new AppDatabase()),
        Group: new TeamsRepository(new AppDatabase()),
      },
      authenticate: () => ({ tenantId: 'org' }),
      logger: silentLogger,
      baseUrl: 'https://app.example.com/scim/v2',
    });
    const reply = await server.handle({ method: 'GET', path: '/Users', query: 'filter=userName co "a"' });
    expect(reply.status).toBe(400);
    expect(reply.body).toMatchObject({ scimType: 'invalidFilter' });
    const unsupported = await server.handle({ method: 'GET', path: '/Users', query: 'filter=title eq "x"' });
    expect(unsupported.body).toMatchObject({ detail: 'Filtering users by title is not supported.' });
  });
});
