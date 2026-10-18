import { once } from 'node:events';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { verifyScimEndpoint } from 'scimkit/verify';
import { createApp } from './server.js';

describe('example: Express', () => {
  const token = 'express-example-token-0123';
  let server: Server;
  let url: string;

  beforeAll(async () => {
    server = createApp({ token }).listen(0, '127.0.0.1');
    await once(server, 'listening');
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => {
    server.close();
  });

  it('passes every check and keeps the other routes working', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const report = await verifyScimEndpoint({ baseUrl: `${url}/scim/v2`, token });
    expect(report.checks.filter((check) => check.status !== 'passed')).toEqual([]);
    expect(info).toHaveBeenCalledWith(expect.stringMatching(/^Deactivated user /));
    expect(await (await fetch(`${url}/health`)).json()).toEqual({ ok: true });
    vi.restoreAllMocks();
  });
});
