import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts', 'tests/**/*.test.ts', 'scripts/**/*.test.ts'],
    setupFiles: ['./test/ignore-mastra-storage-init-rejection.ts'],
    onConsoleLog(log) {
      if (log.includes('Storage init failed; will retry on next storage call')) return false;
      if (log.includes('MASTRA_STORAGE_MONGODB_CREATE_DEFAULT_INDEXES_FAILED')) return false;
      return undefined;
    },
  },
  resolve: {
    alias: {
      'voyageai/dist/esm/api': 'voyageai/dist/esm/api/index.mjs',
    },
  },
});
