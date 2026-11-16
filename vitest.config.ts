import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('.', import.meta.url));

// Tests run against the real docker Postgres (port 5433) and MinIO, in their own DB + bucket.
// Every test drops and re-seeds the schema, so files and tests run strictly one at a time.
export default defineConfig({
  resolve: { alias: { '@': root } },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    fileParallelism: false,
    sequence: { concurrent: false },
    testTimeout: 30_000,
    hookTimeout: 60_000,
    globalSetup: ['tests/global-setup.ts'],
    setupFiles: ['tests/setup.ts'],
    env: {
      DATABASE_URL: 'postgres://postgres:postgres@localhost:5433/sa_tests',
      S3_ENDPOINT: 'http://localhost:9000',
      S3_BUCKET: 'recordings-tests',
      S3_KEY: 'minioadmin',
      S3_SECRET: 'minioadmin',
      S3_REGION: 'us-east-1',
      LEASE_SECONDS: '600',
      HEARTBEAT_SECONDS: '30',
      FORECAST_WINDOW_SECONDS: '3600',
      LOW_POOL_ALERT_HOURS: '2',
      ORPHAN_AGE_SECONDS: '3600',
      PG_POOL_MAX: '20',
    },
  },
});
