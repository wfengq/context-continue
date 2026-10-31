import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: { '@context-continue/core': fileURLToPath(new URL('../core/src/index.ts', import.meta.url)) },
  },
  test: {
    include: ['test/**/*.test.ts'],
    pool: 'forks',
    // node:sqlite (used by the core library) prints an ExperimentalWarning; keep test output clean.
    execArgv: ['--no-warnings=ExperimentalWarning'],
  },
});
