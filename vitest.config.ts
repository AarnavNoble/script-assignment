import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('.', import.meta.url));

// Tests run against the real docker Postgres and MinIO, in their own DB + bucket.
// Every test drops and re-seeds the schema, so files and tests run strictly one at a time.
// Same Postgres server as .env's DATABASE_URL (host/port), but the tests' own database.
try { process.loadEnvFile('.env'); } catch { /* no .env: use the compose default */ }
const PG_BASE = (process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/scripts').replace(/\/[^/]*$/, '');

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
      DATABASE_URL: `${PG_BASE}/sa_tests`,
      S3_ENDPOINT: 'http://localhost:9000',
      S3_BUCKET: 'recordings-tests',
      S3_KEY: 'minioadmin',
      S3_SECRET: 'minioadmin',
      S3_REGION: 'us-east-1',
      LEASE_SECONDS: '600',
      CLAIM_ORDER: 'lowest_id', // tests pin the simpler order; fresh_first is tested explicitly
      RELEASE_GRACE_SECONDS: '0', // tests expect release to free at once; soft release is tested explicitly
      ACCEPTED_SAMPLE_RATES: '1000,8000,16000,44100,48000', // synthetic test audio uses low rates
      HEARTBEAT_SECONDS: '30',
      FORECAST_WINDOW_SECONDS: '3600',
      LOW_POOL_ALERT_HOURS: '2',
      ORPHAN_AGE_SECONDS: '3600',
      PG_POOL_MAX: '20',
    },
  },
});
