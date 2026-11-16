// Standalone config for the QA tests: own DB (sa_qa) and bucket (recordings-qa), so it can run
// while other suites use sa_tests. Run: npx vitest run tests/qa --config tests/qa/vitest.qa.config.mts
// (The shared vitest.config.ts also picks these files up and runs them against sa_tests.)
import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../..', import.meta.url));

// Same Postgres server as .env's DATABASE_URL (host/port), but the tests' own database.
try { process.loadEnvFile('.env'); } catch { /* no .env: use the compose default */ }
const PG_BASE = (process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/scripts').replace(/\/[^/]*$/, '');

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
      DATABASE_URL: `${PG_BASE}/sa_qa`,
      S3_ENDPOINT: 'http://localhost:9000',
      S3_BUCKET: 'recordings-qa',
      S3_KEY: 'minioadmin',
      S3_SECRET: 'minioadmin',
      S3_REGION: 'us-east-1',
      LEASE_SECONDS: '600',
      CLAIM_ORDER: 'lowest_id', // tests pin the simpler order; fresh_first is tested explicitly
      RELEASE_GRACE_SECONDS: '0', // tests expect release to free at once; soft release is tested explicitly
      ACCEPTED_SAMPLE_RATES: '1000,8000,16000,44100,48000', // synthetic test audio uses low rates
      HEARTBEAT_SECONDS: '30',
    },
  },
});
