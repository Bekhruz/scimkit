#!/usr/bin/env node
// Points Git at the repository's hooks (.githooks). Runs on `pnpm install`.
// It is a no-op outside a Git checkout, in CI, or when SCIMKIT_SKIP_HOOKS is set.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { root } from './lib.mjs';

if (process.env.CI || process.env.SCIMKIT_SKIP_HOOKS || !existsSync(join(root, '.githooks'))) process.exit(0);

const git = (...args) => spawnSync('git', args, { cwd: root, encoding: 'utf8' });
if (git('rev-parse', '--is-inside-work-tree').stdout?.trim() !== 'true') process.exit(0);
if (git('config', '--get', 'core.hooksPath').stdout?.trim() === '.githooks') process.exit(0);
git('config', 'core.hooksPath', '.githooks');
