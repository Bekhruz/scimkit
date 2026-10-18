import express from 'express';
import { createNodeHandler, MemoryScimStore, ScimServer, staticTokenAuth } from 'scimkit';

/**
 * The smallest useful setup: one tenant, a token from the environment and the
 * memory store. Swap in PostgresScimStore and ScimTokens for production.
 */
export function createApp(options: { token: string }): express.Express {
  const scim = new ScimServer({
    store: new MemoryScimStore(),
    authenticate: staticTokenAuth({ token: options.token, tenantId: 'default' }),
    hooks: {
      onEvent: (event) => {
        if (event.type === 'user.deactivated') console.info(`Deactivated user ${event.id}`);
      },
    },
  });
  const app = express();
  app.use(express.json());
  app.use('/scim/v2', createNodeHandler(scim));
  app.get('/health', (_request, response) => {
    response.json({ ok: true });
  });
  return app;
}

if (process.argv[1]?.endsWith('server.ts') === true || process.argv[1]?.endsWith('server.js') === true) {
  const token = process.env['SCIM_TOKEN'];
  if (token === undefined) throw new Error('Set SCIM_TOKEN (at least 16 characters).');
  createApp({ token }).listen(3000, () => {
    console.log('SCIM endpoint: http://localhost:3000/scim/v2');
  });
}
