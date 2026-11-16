import { S3Client, CreateBucketCommand } from '@aws-sdk/client-s3';
import { ensureDatabase } from '../db/seed';

// Runs once before all test files. vitest's test.env is not applied here, so use literals.
export default async function setup() {
  try { process.loadEnvFile('.env'); } catch { /* compose default */ }
  await ensureDatabase(`${(process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/scripts').replace(/\/[^/]*$/, '')}/sa_tests`);
  const s3 = new S3Client({
    endpoint: 'http://localhost:9000',
    region: 'us-east-1',
    forcePathStyle: true,
    credentials: { accessKeyId: 'minioadmin', secretAccessKey: 'minioadmin' },
  });
  try {
    await s3.send(new CreateBucketCommand({ Bucket: 'recordings-tests' }));
  } catch (e) {
    const name = (e as { name?: string }).name;
    if (name !== 'BucketAlreadyOwnedByYou' && name !== 'BucketAlreadyExists') throw e;
  } finally {
    s3.destroy();
  }
}
