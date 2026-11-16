import { expect } from 'vitest';
import { seed } from '@/db/seed';
import { pool } from '@/lib/db';
import { putObject, recordingKey } from '@/lib/storage';
import { AppError } from '@/lib/errors';

/**
 * Drop + recreate the schema with `contributors` contributors and only the given scripts.
 * Every language not listed gets 0 scripts. Contributor languages follow seed's languageFor,
 * so tests always pass an explicit language to claim().
 */
export async function reset(scripts: Record<string, number> = { en: 10 }, contributors = 20): Promise<void> {
  await seed({
    databaseUrl: process.env.DATABASE_URL!,
    contributors,
    scriptsPerLanguage: 0,
    scriptsByLanguage: scripts,
  });
}

/** Put a dummy object where submit() looks for this claim's audio. */
export async function upload(scriptId: number, token: string, bytes = 1024): Promise<void> {
  await putObject(recordingKey(scriptId, token), Buffer.alloc(bytes, 7));
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function q<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
  return (await pool().query(sql, params)).rows as T[];
}

export async function scriptRow(id: number) {
  const [r] = await q<Record<string, any>>('SELECT * FROM scripts WHERE id = $1', [id]);
  return r;
}

/** Assert a promise rejects with an AppError of this status + code. */
export async function expectAppError(p: Promise<unknown>, status: number, code: string): Promise<AppError> {
  let err: unknown;
  try {
    await p;
  } catch (e) {
    err = e;
  }
  expect(err, `expected AppError ${status} ${code}`).toBeInstanceOf(AppError);
  const a = err as AppError;
  expect({ status: a.status, code: a.code }).toEqual({ status, code });
  return a;
}

/** Narrow a ClaimResult to a successful claim. */
export function claimed<T extends { status: string }>(r: T): Extract<T, { token: string }> {
  expect(r.status === 'claimed' || r.status === 'resumed', `expected a claim, got ${JSON.stringify(r)}`).toBe(true);
  return r as Extract<T, { token: string }>;
}
