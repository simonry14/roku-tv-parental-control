import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    testTimeout: 15_000,
    // Integration tests bind real sockets; keep files isolated.
    pool: 'forks',
  },
});
