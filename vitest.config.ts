import { fileURLToPath } from 'node:url';
import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

/** NestJS fixtures rely on emitted decorator metadata, which the default transform does not produce. */
const decoratorMetadata = swc.vite({
  jsc: {
    target: 'es2022',
    parser: { syntax: 'typescript', decorators: true },
    transform: { legacyDecorator: true, decoratorMetadata: true },
  },
});

const source = (path: string) => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  plugins: [decoratorMetadata],
  resolve: {
    // Subpath entries and examples import the package by name, as users would.
    alias: [
      { find: /^scimkit\/postgres$/, replacement: source('./src/postgres/index.ts') },
      { find: /^scimkit\/nestjs$/, replacement: source('./src/nestjs/index.ts') },
      { find: /^scimkit\/verify$/, replacement: source('./src/verify/index.ts') },
      { find: /^scimkit$/, replacement: source('./src/index.ts') },
    ],
  },
  test: {
    include: ['test/**/*.test.ts', 'examples/**/*.spec.ts'],
    testTimeout: 20_000,
    hookTimeout: 60_000,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/cli/main.ts'],
      reporter: ['text', 'json-summary', 'lcov'],
      reportsDirectory: 'coverage',
      thresholds: {
        statements: 95,
        branches: 89,
        functions: 96,
        lines: 97,
      },
    },
  },
});
