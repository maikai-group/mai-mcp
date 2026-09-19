import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/__tests__/**/*.test.ts'],
    fileParallelism: false,
    setupFiles: ['src/__tests__/support/canonical-tmpdir.ts'],
    testTimeout: 30000,
    env: {
      MAI_EMBEDDINGS: '0',
      OPENAI_API_KEY: '',
      VOYAGE_API_KEY: '',
    },
  },
});
