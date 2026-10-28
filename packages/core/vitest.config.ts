import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    pool: 'forks',
    // node:sqlite (used by later tasks) prints an ExperimentalWarning; keep test output clean.
    execArgv: ['--no-warnings=ExperimentalWarning'],
  },
});
