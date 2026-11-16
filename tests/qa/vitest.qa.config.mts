// Standalone config for the QA tests: own DB (sa_qa) and bucket (recordings-qa), so it can run
// while other suites use sa_tests. Run: npx vitest run tests/qa --config tests/qa/vitest.qa.config.mts
// (The shared vitest.config.ts also picks these files up and runs them against sa_tests.)
import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../..', import.meta.url));

export default defineConfig({
  root,
  resolve: { alias: { '@': root } },
  test: {
    environment: 'node',
    include: ['tests/qa/**/*.test.ts'],
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 60_000,
    globalSetup: ['tests/qa/global-setup.ts'],
    env: {
      DATABASE_URL: 'postgres://postgres:postgres@localhost:5433/sa_qa',
      S3_ENDPOINT: 'http://localhost:9000',
      S3_BUCKET: 'recordings-qa',
      S3_KEY: 'minioadmin',
      S3_SECRET: 'minioadmin',
      S3_REGION: 'us-east-1',
      LEASE_SECONDS: '600',
      HEARTBEAT_SECONDS: '30',
    },
  },
});
