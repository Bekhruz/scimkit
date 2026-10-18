#!/usr/bin/env node
// Starts a release: sets the version and turns the "Unreleased" changelog
// section into a dated section for it.
//
//   pnpm version:bump patch | minor | major | 1.2.3
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { bold, green, log, root } from './lib.mjs';

const REPOSITORY = 'https://github.com/Bekhruz/scimkit';
const level = process.argv[2];
const packagePath = join(root, 'package.json');
const changelogPath = join(root, 'CHANGELOG.md');
const pkg = JSON.parse(readFileSync(packagePath, 'utf8'));
const current = pkg.version;

function next(version, kind) {
  if (/^\d+\.\d+\.\d+$/.test(kind ?? '')) return kind;
  const [major, minor, patch] = version.split('.').map(Number);
  if (kind === 'major') return `${major + 1}.0.0`;
  if (kind === 'minor') return `${major}.${minor + 1}.0`;
  if (kind === 'patch') return `${major}.${minor}.${patch + 1}`;
  log('Usage: pnpm version:bump patch | minor | major | <x.y.z>');
  process.exit(2);
}

const version = next(current, level);
if (version === current) {
  log(`The version is already ${version}.`);
  process.exit(1);
}
const changelog = readFileSync(changelogPath, 'utf8');
const unreleased = /## \[Unreleased\]\n([\s\S]*?)(?=\n## \[|\n\[Unreleased\]:)/.exec(changelog);
if (unreleased === null || unreleased[1].trim() === '') {
  log('CHANGELOG.md has nothing under "## [Unreleased]". Describe the changes first.');
  process.exit(1);
}
const date = new Date().toISOString().slice(0, 10);
const updated = changelog
  .replace('## [Unreleased]\n', `## [Unreleased]\n\n## [${version}] - ${date}\n`)
  .replace(
    /^\[Unreleased\]: .*$/m,
    `[Unreleased]: ${REPOSITORY}/compare/v${version}...HEAD\n[${version}]: ${REPOSITORY}/compare/v${current}...v${version}`,
  );
pkg.version = version;
writeFileSync(packagePath, `${JSON.stringify(pkg, null, 2)}\n`);
writeFileSync(changelogPath, updated);
log(green(`${current} → ${version}`));
log(bold('\nNext:'));
log(`  git commit -am "Release v${version}" && git push origin main`);
log('  pnpm run release            (dry run)');
log('  pnpm run release --publish');
