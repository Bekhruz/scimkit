import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { ScimTokens } from 'scimkit';
import { AppModule } from './app.module.js';

/**
 * Starts the example on http://localhost:3000/scim/v2 and prints a token for
 * the "acme" organization. Point Okta or Microsoft Entra ID at it, or run:
 *
 *   npx scimkit verify http://localhost:3000/scim/v2 --token <token>
 */
export async function bootstrap(port = Number(process.env['PORT'] ?? 3000)): Promise<void> {
  const app = await NestFactory.create(AppModule);
  app.enableShutdownHooks();
  await app.listen(port);
  const { token } = await app.get(ScimTokens).issue('acme', { label: 'example' });
  console.log(`SCIM endpoint: ${await app.getUrl()}/scim/v2`);
  console.log(`Bearer token for tenant "acme": ${token}`);
}

if (process.argv[1]?.endsWith('main.ts') === true || process.argv[1]?.endsWith('main.js') === true) {
  void bootstrap();
}
