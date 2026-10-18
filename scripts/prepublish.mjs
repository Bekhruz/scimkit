#!/usr/bin/env node
// `npm publish` guard. Releases go through `pnpm run release --publish`, which
// runs the full gate and publishes the exact tarball it verified. Publishing
// any other way runs the full gate first.
import { run } from './lib.mjs';

if (process.env.SCIMKIT_RELEASE !== '1') {
  run(process.execPath, ['scripts/ci.mjs']);
}
