import { S3Client, CreateBucketCommand } from '@aws-sdk/client-s3';
import { ensureDatabase } from '../../db/seed';

// Only used by tests/qa/vitest.qa.config.mts. test.env isn't applied in globalSetup, so literals.
export default async function setup() {
  await ensureDatabase('postgres://postgres:postgres@localhost:5433/sa_qa');
  const s3 = new S3Client({
    endpoint: 'http://localhost:9000', region: 'us-east-1', forcePathStyle: true,
    credentials: { accessKeyId: 'minioadmin', secretAccessKey: 'minioadmin' },
  });
  try {
    await s3.send(new CreateBucketCommand({ Bucket: 'recordings-qa' }));
  } catch (e) {
    const name = (e as { name?: string }).name;
    if (name !== 'BucketAlreadyOwnedByYou' && name !== 'BucketAlreadyExists') throw e;
  } finally {
    s3.destroy();
  }
}
