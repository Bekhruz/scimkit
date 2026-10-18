#!/usr/bin/env node
// Local release: verify, tag, publish to npm, create the GitHub release.
// No hosted CI is involved; everything runs on the maintainer's machine.
//
//   pnpm run release                   dry run: every check, then `npm publish --dry-run`
//   pnpm run release --publish         tag, push the tag, publish and create the GitHub release
//   pnpm run release --publish --otp 123456
//   pnpm run release --skip-matrix     leave out the Docker compatibility matrix
//
// Preconditions for --publish: a clean working tree whose HEAD is the commit at
// origin/main, an unpublished version with a CHANGELOG.md section, and working
// `npm whoami`. With `gh auth status` working, a GitHub release is created too.
// A release that stopped half way can be re-run: finished steps are skipped.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { bold, green, log, root, run, yellow } from './lib.mjs';

const args = process.argv.slice(2);
const publish = args.includes('--publish');
const skipMatrix = args.includes('--skip-matrix');
const otpIndex = args.indexOf('--otp');
const otp = otpIndex === -1 ? undefined : args[otpIndex + 1];

const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const version = pkg.version;
const tag = `v${version}`;
const git = (...gitArgs) => run('git', gitArgs, { capture: true }).stdout.trim();
const tryRun = (command, commandArgs) => run(command, commandArgs, { capture: true, allowFailure: true });

function step(title) {
  log(bold(`\n▶ ${title}`));
}

function fail(message) {
  log(`\n${message}`);
  process.exit(1);
}

function readJson(file) {
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : undefined;
}

function changelogSection(target) {
  const changelog = readFileSync(join(root, 'CHANGELOG.md'), 'utf8');
  const start = changelog.indexOf(`## [${target}]`);
  if (start === -1) return undefined;
  const rest = changelog.slice(start);
  const firstLineEnd = rest.indexOf('\n');
  const next = rest.indexOf('\n## [', firstLineEnd);
  return rest.slice(firstLineEnd + 1, next === -1 ? undefined : next).replace(/\n\[[^\]]+\]: .*$/gm, '');
}

step(`preconditions (${publish ? 'publish' : 'dry run'})`);
const notes = changelogSection(version);
if (notes === undefined || notes.trim() === '')
  fail(`CHANGELOG.md has no "## [${version}]" section. Run \`pnpm version:bump\`.`);
const dirty = git('status', '--porcelain') !== '';
const hasOrigin = tryRun('git', ['remote', 'get-url', 'origin']).status === 0;
if (publish) {
  if (dirty) fail('The working tree is not clean.');
  if (!hasOrigin) fail('There is no "origin" remote to push the tag to.');
  run('git', ['fetch', '--quiet', 'origin', 'main']);
  if (git('rev-parse', 'HEAD') !== git('rev-parse', 'origin/main')) {
    fail('HEAD is not the commit at origin/main. Push main first; releases tag exactly what main contains.');
  }
} else if (dirty) {
  log(yellow('  the working tree has uncommitted changes (allowed in a dry run)'));
}
const tagged = tryRun('git', ['rev-parse', '--verify', '--quiet', `refs/tags/${tag}^{commit}`]).stdout.trim();
if (tagged !== '' && tagged !== git('rev-parse', 'HEAD'))
  fail(`Tag ${tag} exists on ${tagged.slice(0, 7)}, not on HEAD.`);
const published = tryRun('npm', ['view', `${pkg.name}@${version}`, 'version']).stdout.trim() === version;
const ghReady = tryRun('gh', ['auth', 'status']).status === 0;
const released = ghReady && tryRun('gh', ['release', 'view', tag]).status === 0;
if (publish) {
  if (tagged !== '' && published && (released || !ghReady))
    fail(`${pkg.name}@${version} is already released.`);
  const npmUser = tryRun('npm', ['whoami']);
  if (npmUser.status !== 0) fail('Not logged in to npm. Run `npm login` first.');
  log(`  ${pkg.name}@${version} as npm user ${npmUser.stdout.trim()}`);
  if (!ghReady) log(yellow('  gh is not authenticated: the GitHub release will be skipped'));
  if (tagged !== '' || published || released) {
    log(yellow(`  resuming: tagged ${tagged !== ''}, published ${published}, GitHub release ${released}`));
  }
} else {
  log(`  ${pkg.name}@${version}${published ? yellow(' (already on npm)') : ''}`);
}

step('quality gate');
run(process.execPath, ['scripts/ci.mjs']);
if (!skipMatrix) {
  step('compatibility matrix');
  run(process.execPath, ['scripts/matrix.mjs']);
}

const packDir = join(root, '.compat', 'pack');
const tarballName = readdirSync(packDir).find((file) => file === `${pkg.name}-${version}.tgz`);
if (!tarballName) fail('The verified tarball is missing.');
const tarball = join(packDir, tarballName);
const sha256 = createHash('sha256').update(readFileSync(tarball)).digest('hex');
const integrity = `sha512-${createHash('sha512').update(readFileSync(tarball)).digest('base64')}`;

step('release notes');
const summary = readJson(join(root, 'reports', 'ci-summary.json'));
const tests = readJson(join(root, 'reports', 'tests.json'));
const coverage = readJson(join(root, 'coverage', 'coverage-summary.json'))?.total;
const matrix = skipMatrix ? undefined : readJson(join(root, 'reports', 'matrix.json'));
const body = [
  notes.trim(),
  '',
  '### Verification',
  '',
  `Local quality gate on ${summary.platform}, Node.js ${summary.node}, ${summary.postgres}: ${summary.steps.filter((s) => s.status === 'passed').length} of ${summary.steps.length} steps passed.`,
  tests
    ? `- Tests: ${tests.numPassedTests} passed, ${tests.numFailedTests} failed, ${tests.numPendingTests} skipped`
    : undefined,
  coverage
    ? `- Coverage: ${coverage.lines.pct}% lines, ${coverage.branches.pct}% branches, ${coverage.functions.pct}% functions`
    : undefined,
  ...(matrix?.results ?? []).map(
    (result) =>
      `- ${result.status === 'passed' ? '✅' : '❌'} ${result.id}${result.versions?.node ? `, Node.js ${result.versions.node}` : ''}${result.versions?.postgres ? `, PostgreSQL ${result.versions.postgres}` : ''}`,
  ),
  '',
  `Package: \`${tarballName}\`, SHA-256 \`${sha256}\`.`,
  `Compare with \`npm pack ${pkg.name}@${version}\` and \`shasum -a 256\`.`,
]
  .filter((line) => line !== undefined)
  .join('\n');
mkdirSync(join(root, 'reports'), { recursive: true });
const notesFile = join(root, 'reports', 'release-notes.md');
writeFileSync(notesFile, `${body}\n`);
log(body);

if (!publish) {
  step('npm publish --dry-run');
  run(
    'npm',
    ['publish', tarball, '--dry-run', '--access', 'public', ...(published ? ['--tag', 'dry-run'] : [])],
    {
      env: { SCIMKIT_RELEASE: '1' },
    },
  );
  log(yellow('\nDry run complete. Nothing was tagged, pushed, published or released.'));
  log(`Verified tarball: ${tarball}\nRelease notes: ${notesFile}\nPublish with: pnpm run release --publish`);
  process.exit(0);
}

step('tag and push');
if (tagged === '') run('git', ['tag', '--annotate', tag, '--message', tag]);
run('git', ['push', 'origin', tag]);

step('publish to npm');
if (published) {
  log('  already published');
} else {
  run('npm', ['publish', tarball, '--access', 'public', ...(otp ? ['--otp', otp] : [])], {
    env: { SCIMKIT_RELEASE: '1' },
  });
}

step('GitHub release');
if (!ghReady) log(yellow('  skipped: run `gh auth login`, then re-run this command to create it'));
else if (released) log('  already created');
else
  run('gh', ['release', 'create', tag, tarball, '--title', tag, '--notes-file', notesFile, '--verify-tag']);

step('verify');
// The registry must serve exactly the tarball the quality gate verified.
const served = run('npm', ['view', `${pkg.name}@${version}`, 'dist.integrity'], {
  capture: true,
}).stdout.trim();
if (served !== integrity)
  fail(`npm serves a different tarball for ${pkg.name}@${version} than the one that was verified.`);
log(`  npm integrity ${integrity}`);
log(green(`\nReleased ${pkg.name}@${version}.`));
