import { defineConfig } from 'tsup';

export default defineConfig([
  {
    // One build for all library entries: shared code goes into chunks, so every
    // entry uses the same ScimServer and ScimError classes (per module format).
    entry: {
      index: 'src/index.ts',
      postgres: 'src/postgres/index.ts',
      nestjs: 'src/nestjs/index.ts',
      verify: 'src/verify/index.ts',
    },
    format: ['esm', 'cjs'],
    platform: 'node',
    target: 'node22',
    external: ['@nestjs/common', '@nestjs/core', 'pg'],
    dts: {
      compilerOptions: {
        stripInternal: true,
        experimentalDecorators: false,
        emitDecoratorMetadata: false,
      },
    },
    clean: false,
    splitting: true,
    sourcemap: false,
    treeshake: true,
    removeNodeProtocol: false,
  },
  {
    // The CLI loads the published entries by package name.
    entry: { cli: 'src/cli/main.ts' },
    format: ['esm'],
    platform: 'node',
    target: 'node22',
    external: ['scimkit', 'scimkit/postgres', 'scimkit/verify', 'pg'],
    banner: { js: '#!/usr/bin/env node' },
    clean: false,
    splitting: false,
    sourcemap: false,
    treeshake: true,
    removeNodeProtocol: false,
  },
]);
