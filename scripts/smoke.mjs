#!/usr/bin/env node
// Runs the published build, not the sources: boots SCIM servers from an
// extracted package (ESM and CommonJS, plain Node and NestJS on Express and
// Fastify) and runs the package's own CLI `verify` against each of them.
//
//   node scripts/smoke.mjs <extracted package directory>
import { execFile } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const directory = resolve(process.argv[2] ?? '');
const require = createRequire(join(directory, 'package.json'));
const exec = promisify(execFile);
const TOKEN = 'smoke-test-token-0123456789';
const USER = 'urn:ietf:params:scim:schemas:core:2.0:User';

async function verify(label, baseUrl) {
  const { stdout } = await exec(
    process.execPath,
    [join(directory, 'dist', 'cli.js'), 'verify', baseUrl, '--token', TOKEN, '--json'],
    {
      maxBuffer: 16 * 1024 * 1024,
    },
  ).catch((error) => error);
  const report = JSON.parse(stdout);
  if (report.failed > 0 || report.passed === 0) {
    const failures = report.checks.filter((check) => check.status !== 'passed');
    throw new Error(`${label}: ${report.failed} checks failed\n${JSON.stringify(failures, null, 2)}`);
  }
  console.log(`  ${label}: ${report.passed} checks passed`);
}

async function plainServer(scimkit, label) {
  const server = new scimkit.ScimServer({
    store: new scimkit.MemoryScimStore(),
    authenticate: scimkit.staticTokenAuth({ token: TOKEN, tenantId: 'smoke' }),
    logger: scimkit.silentLogger,
  });
  const http = createServer(scimkit.createNodeHandler(server, { basePath: '/scim/v2' })).listen(
    0,
    '127.0.0.1',
  );
  await once(http, 'listening');
  try {
    await verify(label, `http://127.0.0.1:${http.address().port}/scim/v2`);
  } finally {
    http.close();
  }
}

async function nestServer(platform) {
  require('reflect-metadata');
  const core = require(join(directory, 'dist', 'index.cjs'));
  const { ScimModule } = require(join(directory, 'dist', 'nestjs.cjs'));
  const { Module } = require('@nestjs/common');
  const { NestFactory } = require('@nestjs/core');
  // eslint-disable-next-line @typescript-eslint/no-extraneous-class -- a Nest module only carries metadata
  class AppModule {}
  Module({
    imports: [
      ScimModule.forRoot({
        store: new core.MemoryScimStore(),
        authenticate: core.staticTokenAuth({ token: TOKEN, tenantId: 'smoke' }),
        logger: core.silentLogger,
      }),
    ],
  })(AppModule);
  const app =
    platform === 'fastify'
      ? await NestFactory.create(AppModule, new (require('@nestjs/platform-fastify').FastifyAdapter)(), {
          logger: false,
        })
      : await NestFactory.create(AppModule, { logger: false });
  await app.listen(0, '127.0.0.1');
  try {
    // The module must provide the very ScimServer class the main entry exports.
    if (!(app.get(core.ScimServer) instanceof core.ScimServer))
      throw new Error('ScimServer identity differs between entries');
    const url = (await app.getUrl()).replace('[::1]', '127.0.0.1');
    const created = await fetch(`${url}/scim/v2/Users`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/scim+json' },
      body: JSON.stringify({ schemas: [USER], userName: 'smoke@example.com' }),
    });
    if (created.status !== 201)
      throw new Error(`NestJS on ${platform}: POST /Users answered ${created.status}`);
    await verify(`NestJS on ${platform} (CommonJS)`, `${url}/scim/v2`);
  } finally {
    await app.close();
  }
}

await plainServer(await import(pathToFileURL(join(directory, 'dist', 'index.js')).href), 'Node http (ESM)');
await plainServer(require(join(directory, 'dist', 'index.cjs')), 'Node http (CommonJS)');
await nestServer('express');
await nestServer('fastify');
