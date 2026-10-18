import 'reflect-metadata';
import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ScimTokens } from 'scimkit';
import { verifyScimEndpoint } from 'scimkit/verify';
import { AppModule } from './app.module.js';
import { SessionsService } from './sessions.service.js';

describe('example: NestJS application', () => {
  let app: INestApplication;
  let url: string;

  beforeAll(async () => {
    app = await NestFactory.create(AppModule, { logger: false });
    await app.listen(0, '127.0.0.1');
    url = (await app.getUrl()).replace('[::1]', '127.0.0.1');
  });
  afterAll(async () => {
    await app.close();
  });

  it('serves SCIM beside routes protected by the application guard', async () => {
    const { token } = await app.get(ScimTokens).issue('acme');
    const report = await verifyScimEndpoint({ baseUrl: `${url}/scim/v2`, token });
    expect(report.checks.filter((check) => check.status !== 'passed')).toEqual([]);
    // Deactivating and deleting users ended their sessions.
    expect(app.get(SessionsService).revoked.length).toBeGreaterThanOrEqual(3);
  });

  it('rejects tokens of no tenant', async () => {
    const reply = await fetch(`${url}/scim/v2/Users`, { headers: { authorization: 'Bearer scim_nope' } });
    expect(reply.status).toBe(401);
  });
});
