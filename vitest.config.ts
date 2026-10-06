import { defineConfig } from 'vitest/config';

export default defineConfig({
  define: {
    __NL_DEV__: 'true',
  },
  test: {
    include: ['tests/unit/**/*.test.ts', 'tests/unit/**/*.test.tsx'],
    environment: 'node',
  },
});
