import { defineConfig } from 'vitest/config';

// 실제 Chromium(Chrome for Testing)에 dev 빌드를 설치해 사이드 패널을 연다. npm run test:e2e
export default defineConfig({
  test: {
    include: ['tests/e2e/**/*.e2e.ts'],
    environment: 'node',
    testTimeout: 60_000,
    hookTimeout: 60_000,
    fileParallelism: false,
    sequence: { concurrent: false },
  },
});
