import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include:        ['__tests__/integration/**/*.test.ts'],
    environment:    'node',
    globals:        true,
    testTimeout:    30_000, // Cognito + DB round-trips can be slow
    hookTimeout:    15_000,
    reporters:      ['verbose'],
    // Load .env from the repo root so COGNITO_* and PG* vars are available
    env:            { NODE_ENV: 'test' },
    setupFiles:     ['__tests__/integration/setup.ts'],
  },
});
