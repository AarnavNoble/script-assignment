import {
  S3Client, PutObjectCommand, HeadObjectCommand, GetObjectCommand, ListObjectsV2Command,
  CopyObjectCommand, DeleteObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

const g = globalThis as unknown as { __s3?: S3Client };

export function s3(): S3Client {
  if (!g.__s3) {
    g.__s3 = new S3Client({
      endpoint: process.env.S3_ENDPOINT,
      region: process.env.S3_REGION ?? 'us-east-1',
      forcePathStyle: true, // MinIO
      credentials: {
        accessKeyId: process.env.S3_KEY ?? 'minioadmin',
        secretAccessKey: process.env.S3_SECRET ?? 'minioadmin',
      },
    });
  }
  return g.__s3;
}

export const bucket = () => process.env.S3_BUCKET ?? 'recordings';

/** Where the browser uploads (writable through a presigned URL until it expires). */
export function recordingKey(scriptId: number | string, token: string): string {
  return `recordings/${scriptId}/${token}.wav`;
}

/** Where a submitted recording lives. No URL can write here, so the approved audio can't be swapped later. */
export function finalKey(scriptId: number | string, token: string): string {
  return `final/${scriptId}/${token}.wav`;
}

/** Server-side copy. Returns false if the source doesn't exist. */
export async function copyObject(from: string, to: string): Promise<boolean> {
  try {
    await s3().send(new CopyObjectCommand({ Bucket: bucket(), Key: to, CopySource: `${bucket()}/${from}` }));
    return true;
  } catch (e) {
    const err = e as { name?: string; Code?: string; $metadata?: { httpStatusCode?: number } };
    if (err.name === 'NoSuchKey' || err.Code === 'NoSuchKey' || err.$metadata?.httpStatusCode === 404) return false;
    throw e;
  }
}

export async function deleteObject(key: string): Promise<void> {
  await s3().send(new DeleteObjectCommand({ Bucket: bucket(), Key: key }));
}

/** Presigned PUT: the browser uploads straight to storage; the audio never passes through our server. */
export async function presignPut(key: string, contentType: string, expiresIn: number): Promise<string> {
  return getSignedUrl(
    s3(),
    new PutObjectCommand({ Bucket: bucket(), Key: key, ContentType: contentType }),
    // sign content-type too, so the URL only accepts the type we said we'd store
    { expiresIn, signableHeaders: new Set(['content-type']) },
  );
}

/** Returns the object size, or null if it doesn't exist. */
export async function headObject(key: string): Promise<{ size: number } | null> {
  try {
    const r = await s3().send(new HeadObjectCommand({ Bucket: bucket(), Key: key }));
    return { size: Number(r.ContentLength ?? 0) };
  } catch (e) {
    const err = e as { name?: string; $metadata?: { httpStatusCode?: number } };
    if (err.name === 'NotFound' || err.$metadata?.httpStatusCode === 404) return null;
    throw e;
  }
}

export async function getObjectBytes(key: string): Promise<Buffer> {
  const r = await s3().send(new GetObjectCommand({ Bucket: bucket(), Key: key }));
  return Buffer.from(await r.Body!.transformToByteArray());
}

/** Direct server-side put (used by tests and the simulation, not the browser flow). */
export async function putObject(key: string, body: Buffer, contentType = 'audio/wav'): Promise<void> {
  await s3().send(new PutObjectCommand({ Bucket: bucket(), Key: key, Body: body, ContentType: contentType }));
}

export async function listObjects(prefix: string): Promise<{ key: string; lastModified: Date; size: number }[]> {
  const out: { key: string; lastModified: Date; size: number }[] = [];
  let token: string | undefined;
  do {
    const r = await s3().send(new ListObjectsV2Command({ Bucket: bucket(), Prefix: prefix, ContinuationToken: token }));
    for (const o of r.Contents ?? []) out.push({ key: o.Key!, lastModified: o.LastModified!, size: Number(o.Size ?? 0) });
    token = r.IsTruncated ? r.NextContinuationToken : undefined;
  } while (token);
  return out;
}
