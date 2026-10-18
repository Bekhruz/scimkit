#!/usr/bin/env node
// Dependency review:
// - scimkit ships without runtime dependencies; keep it that way.
// - Known vulnerabilities: any advisory in what users install fails the check;
//   advisories in development tooling are reported, and high or critical ones fail it.
// - Licenses of development dependencies must be on the allowlist below
//   (they are never redistributed, but the project should be buildable by anyone).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { bold, green, log, pnpm, red, root, yellow } from './lib.mjs';

const ALLOWED_LICENSES = new Set([
  'MIT',
  'ISC',
  'Apache-2.0',
  'BSD-2-Clause',
  'BSD-3-Clause',
  '0BSD',
  'BlueOak-1.0.0',
  'CC0-1.0',
  'CC-BY-4.0',
  'Unlicense',
  'Python-2.0',
  'MPL-2.0',
]);

const failures = [];
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

log(bold('• runtime dependencies'));
const runtime = Object.keys(pkg.dependencies ?? {});
if (runtime.length > 0) failures.push(`runtime dependencies are not allowed: ${runtime.join(', ')}`);
log(`  ${runtime.length === 0 ? 'none' : runtime.join(', ')}`);

log(bold('• known vulnerabilities'));
const audit = (args) =>
  JSON.parse(pnpm(['audit', '--json', ...args], { capture: true, allowFailure: true }).stdout);
const production = audit(['--prod']).metadata.vulnerabilities;
const all = audit([]).metadata.vulnerabilities;
const count = (counts) => Object.values(counts).reduce((sum, value) => sum + value, 0);
log(`  shipped: ${JSON.stringify(production)}`);
log(`  tooling: ${JSON.stringify(all)}`);
if (count(production) > 0) failures.push('vulnerabilities in shipped dependencies');
if (all.high + all.critical > 0)
  failures.push('high or critical vulnerabilities in development dependencies');
else if (count(all) > 0)
  log(yellow('  low or moderate advisories in development tooling; review with `pnpm audit`'));

log(bold('• licenses'));
const licenses = JSON.parse(pnpm(['licenses', 'list', '--json'], { capture: true }).stdout);
for (const [license, packages] of Object.entries(licenses)) {
  const parts = license.replace(/[()]/g, '').split(/\s+(?:AND|OR)\s+/);
  const allowed = parts.every((part) => ALLOWED_LICENSES.has(part));
  log(`  ${allowed ? '' : red('✖ ')}${license}: ${packages.length}`);
  if (!allowed) failures.push(`license ${license}: ${packages.map((item) => item.name).join(', ')}`);
}

if (failures.length > 0) {
  log(red(`\nDependency review failed:\n  ${failures.join('\n  ')}`));
  process.exit(1);
}
log(green('\nDependency review passed.'));
