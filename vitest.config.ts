import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/__tests__/**/*.test.ts'],
    fileParallelism: false,
    setupFiles: ['src/__tests__/support/canonical-tmpdir.ts', 'src/__tests__/support/provider-state.ts'],
    testTimeout: 30000,
    env: {
      MAI_EMBEDDINGS: '0',
      TYPESAFE_API_KEY: '',
      ANTHROPIC_API_KEY: '',
      OPENAI_API_KEY: '',
      VOYAGE_API_KEY: '',
    },
  },
});
