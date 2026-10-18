#!/usr/bin/env node
// Validates the package exactly as it will be published:
// - the tarball contains only the intended files,
// - no secrets or local paths are shipped,
// - exports and type declarations resolve in every module mode (publint, attw),
// - every ESM and CommonJS entry point loads and exposes the same API,
// - the published build runs: servers built from it pass the CLI's checks,
// - the build is reproducible.
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { bold, green, log, pnpm, root, run } from './lib.mjs';

const packDir = join(root, '.compat', 'pack');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const ENTRIES = ['index', 'postgres', 'nestjs', 'verify'];

const ALLOWED = [
  /^package\/(package\.json|README\.md|LICENSE|CHANGELOG\.md)$/,
  /^package\/dist\/(index|postgres|nestjs|verify)\.(js|cjs|d\.ts|d\.cts)$/,
  /^package\/dist\/cli\.js$/,
  /^package\/dist\/chunk-[A-Z0-9]+\.(js|cjs)$/,
  /^package\/dist\/[a-z]+-[A-Za-z0-9_-]{8}\.d\.c?ts$/,
];
const REQUIRED = [
  'package/package.json',
  'package/README.md',
  'package/LICENSE',
  'package/CHANGELOG.md',
  'package/dist/cli.js',
  ...ENTRIES.flatMap((entry) =>
    ['js', 'cjs', 'd.ts', 'd.cts'].map((extension) => `package/dist/${entry}.${extension}`),
  ),
];

const FORBIDDEN_CONTENT = [
  { pattern: /\/home\/[a-z0-9._-]+\//i, reason: 'absolute home directory path' },
  { pattern: /\/Users\/[A-Za-z0-9._-]+\//, reason: 'absolute macOS user path' },
  { pattern: /[A-Za-z]:\\Users\\/, reason: 'absolute Windows user path' },
  { pattern: /npm_[A-Za-z0-9]{36}/, reason: 'npm token' },
  { pattern: /gh[pousr]_[A-Za-z0-9]{36}/, reason: 'GitHub token' },
  { pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/, reason: 'private key' },
  { pattern: /scim_[0-9a-f]{24}_[A-Za-z0-9_-]{43}/, reason: 'SCIM bearer token' },
  { pattern: /Co-Authored-By/i, reason: 'commit trailer' },
];

function fail(message) {
  throw new Error(message);
}

function step(title) {
  log(bold(`• ${title}`));
}

function hashDist() {
  const hash = createHash('sha256');
  for (const file of readdirSync(join(root, 'dist')).sort()) {
    hash.update(file);
    hash.update(readFileSync(join(root, 'dist', file)));
  }
  return hash.digest('hex');
}

if (pkg.dependencies && Object.keys(pkg.dependencies).length > 0) {
  fail(`scimkit must not have runtime dependencies, found: ${Object.keys(pkg.dependencies).join(', ')}`);
}

step('reproducible build');
pnpm(['run', 'build'], { capture: true });
const first = hashDist();
pnpm(['run', 'build'], { capture: true });
const second = hashDist();
if (first !== second) fail('Two consecutive builds produced different output.');
log(`  dist sha256 ${first}`);

step('pack');
rmSync(packDir, { recursive: true, force: true });
mkdirSync(packDir, { recursive: true });
pnpm(['pack', '--pack-destination', packDir], { capture: true });
const tarball = readdirSync(packDir).find((file) => file.endsWith('.tgz'));
if (!tarball) fail('pnpm pack produced no tarball.');
const tarballPath = join(packDir, tarball);
log(`  ${tarball}`);

step('tarball contents');
const files = run('tar', ['-tzf', tarballPath], { capture: true }).stdout.trim().split('\n');
const unexpected = files.filter((file) => !ALLOWED.some((pattern) => pattern.test(file)));
const missing = REQUIRED.filter((file) => !files.includes(file));
if (unexpected.length > 0) fail(`Unexpected files in the tarball:\n  ${unexpected.join('\n  ')}`);
if (missing.length > 0) fail(`Missing files in the tarball:\n  ${missing.join('\n  ')}`);
log(`  ${files.length} files`);

step('forbidden content');
// Extracted inside the repository, so that peer dependencies resolve from its node_modules.
const extractDir = join(packDir, 'extracted');
mkdirSync(extractDir, { recursive: true });
run('tar', ['-xzf', tarballPath, '-C', extractDir]);
const packageDir = join(extractDir, 'package');
for (const file of files) {
  const content = readFileSync(join(extractDir, file), 'utf8');
  for (const { pattern, reason } of FORBIDDEN_CONTENT) {
    if (pattern.test(content)) fail(`${file} contains a ${reason} (${pattern}).`);
  }
}
log('  none found');

step('publint');
pnpm(['exec', 'publint', '--strict', packageDir]);

step('are the types wrong');
pnpm(['exec', 'attw', tarballPath, '--format', 'table-flipped', '--profile', 'node16']);

step('ESM and CommonJS entry points');
const require = createRequire(join(packageDir, 'package.json'));
require('reflect-metadata');
for (const entry of ENTRIES) {
  const esm = await import(pathToFileURL(join(packageDir, 'dist', `${entry}.js`)).href);
  const cjs = require(join(packageDir, 'dist', `${entry}.cjs`));
  const esmKeys = Object.keys(esm)
    .filter((key) => key !== 'default')
    .sort();
  const cjsKeys = Object.keys(cjs).sort();
  if (JSON.stringify(esmKeys) !== JSON.stringify(cjsKeys)) {
    fail(
      `${entry}: ESM and CommonJS exports differ:\n  esm: ${esmKeys.join(', ')}\n  cjs: ${cjsKeys.join(', ')}`,
    );
  }
  log(`  ${entry}: ${esmKeys.length} exports`);
}
const core = await import(pathToFileURL(join(packageDir, 'dist', 'index.js')).href);
for (const name of [
  'ScimServer',
  'ScimError',
  'MemoryScimStore',
  'ScimTokens',
  'createNodeHandler',
  'createFetchHandler',
]) {
  if (typeof core[name] !== 'function') fail(`Missing export ${name}.`);
}

step('the published build runs');
run(process.execPath, ['scripts/smoke.mjs', packageDir]);
const cliVersion = run(process.execPath, [join(packageDir, 'dist', 'cli.js'), '--version'], {
  capture: true,
}).stdout.trim();
if (cliVersion !== pkg.version) fail(`The CLI reports version ${cliVersion}, the package is ${pkg.version}.`);
log(`  scimkit --version: ${cliVersion}`);

rmSync(extractDir, { recursive: true, force: true });
log(green(`\nPackage checks passed: ${tarballPath}`));
