// Shared helpers for the local CI scripts. Plain Node.js, no dependencies.
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const color = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code) => (text) => (color ? `\u001b[${code}m${text}\u001b[0m` : text);
export const bold = paint('1');
export const green = paint('32');
export const red = paint('31');
export const yellow = paint('33');
export const dim = paint('2');

export function log(message = '') {
  process.stdout.write(`${message}\n`);
}

/**
 * Runs a command with inherited output. Throws with the exit code on failure.
 * `capture: true` returns stdout instead of printing it; `input` is written to
 * stdin; `encoding: 'buffer'` returns raw bytes.
 */
export function run(command, args, options = {}) {
  const { cwd = root, env = {}, capture = false, allowFailure = false, input, encoding = 'utf8' } = options;
  const stdin = input === undefined ? 'ignore' : 'pipe';
  const result = spawnSync(command, args, {
    cwd,
    env: { ...process.env, ...env },
    stdio: capture
      ? [stdin, 'pipe', 'pipe']
      : input === undefined
        ? 'inherit'
        : ['pipe', 'inherit', 'inherit'],
    ...(input === undefined ? {} : { input }),
    encoding,
    shell: false,
    maxBuffer: 256 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0 && !allowFailure) {
    const detail = capture ? `\n${result.stdout ?? ''}${result.stderr ?? ''}` : '';
    throw new Error(`${command} ${args.join(' ')} exited with ${result.status}${detail}`);
  }
  return capture
    ? { status: result.status, stdout: result.stdout, stderr: result.stderr }
    : { status: result.status };
}

let corepack;

/**
 * pnpm, through Corepack so the version pinned in package.json is used.
 * Node.js 25 and later no longer bundle Corepack; there a pnpm on PATH is used.
 */
export function pnpm(args, options = {}) {
  corepack ??= spawnSync('corepack', ['--version'], { encoding: 'utf8' }).status === 0;
  if (!corepack) return run('pnpm', args, options);
  return run('corepack', ['pnpm', ...args], {
    ...options,
    env: { COREPACK_ENABLE_DOWNLOAD_PROMPT: '0', ...options.env },
  });
}

/**
 * Docker CLI arguments that reach a running engine. The active context is tried
 * first; when it is unreachable (for example Docker Desktop is stopped while the
 * system engine runs), the `default` context is used. Returns undefined when no
 * engine answers.
 */
export function dockerArgs() {
  if (process.env.SCIMKIT_DOCKER_CONTEXT) return ['--context', process.env.SCIMKIT_DOCKER_CONTEXT];
  const probe = (args) =>
    spawnSync('docker', [...args, 'info', '--format', '{{.ServerVersion}}'], { encoding: 'utf8' }).status ===
    0;
  if (probe([])) return [];
  if (probe(['--context', 'default'])) return ['--context', 'default'];
  return undefined;
}

/**
 * Finds a Node.js binary directory for a major version: the running Node if it
 * matches, otherwise the newest matching install managed by nvm, fnm or volta,
 * or SCIMKIT_NODE_<major> (a directory containing `node`).
 */
export function nodeBinDir(major) {
  const override = process.env[`SCIMKIT_NODE_${major}`];
  if (override) return override;
  if (Number(process.versions.node.split('.')[0]) === major) return dirname(process.execPath);
  const candidates = [
    join(process.env.NVM_DIR ?? join(homedir(), '.nvm'), 'versions', 'node'),
    join(homedir(), '.local', 'share', 'fnm', 'node-versions'),
    join(homedir(), '.volta', 'tools', 'image', 'node'),
  ];
  for (const base of candidates) {
    if (!existsSync(base)) continue;
    const versions = readdirSync(base)
      .filter((name) => name.replace(/^v/, '').split('.')[0] === String(major))
      .sort((a, b) => compareVersions(b.replace(/^v/, ''), a.replace(/^v/, '')));
    for (const version of versions) {
      for (const bin of [
        join(base, version, 'bin'),
        join(base, version, 'installation', 'bin'),
        join(base, version),
      ]) {
        if (existsSync(join(bin, 'node'))) return bin;
      }
    }
  }
  return undefined;
}

function compareVersions(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let index = 0; index < 3; index++) {
    const difference = (pa[index] ?? 0) - (pb[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

export function formatDuration(milliseconds) {
  return milliseconds < 1000 ? `${milliseconds}ms` : `${(milliseconds / 1000).toFixed(1)}s`;
}
