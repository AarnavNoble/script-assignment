import { afterAll } from 'vitest';
import { closePool } from '@/lib/db';

// Guard: never let a test run against the shared dev DB or bucket.
if (!process.env.DATABASE_URL?.endsWith('/sa_tests') || process.env.S3_BUCKET !== 'recordings-tests') {
  throw new Error('tests must use DATABASE_URL=.../sa_tests and S3_BUCKET=recordings-tests');
}

afterAll(async () => {
  await closePool();
});
