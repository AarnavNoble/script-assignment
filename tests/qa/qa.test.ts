// Integration: runQaOnce against real Postgres + MinIO.
// Works under tests/qa/vitest.qa.config.mts (sa_qa / recordings-qa) or the shared config (sa_tests).
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { DeleteObjectCommand } from '@aws-sdk/client-s3';
import { seed } from '@/db/seed';
import { pool, closePool } from '@/lib/db';
import { claim, submit } from '@/lib/assign';
import { putObject, recordingKey, finalKey, s3, bucket } from '@/lib/storage';
import { encodeWav } from '@/lib/wav';
import { runQaOnce, QA_LOCK_NS } from '@/lib/qa';
import { speech, noiseOnly } from './synth';

// Pass-through mock so one test can make a download fail transiently.
const failKeys = new Set<string>();
vi.mock('@/lib/storage', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/storage')>();
  return {
    ...real,
    getObjectBytes: async (key: string) => {
      if (failKeys.has(key)) throw Object.assign(new Error('simulated network error'), { name: 'TimeoutError' });
      return real.getObjectBytes(key);
    },
  };
});

type Rec = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const q = async <T = Rec>(sql: string, p: unknown[] = []) => (await pool().query(sql, p)).rows as T[];
const quiet = { error: () => {}, warn: () => {} };

let nextContributor = 1;
/** claim -> upload -> submit, returns the recording id and its stored (final) key */
async function record(body: Buffer): Promise<{ id: number; key: string; scriptId: number }> {
  const c = await claim(nextContributor++, 'en');
  if (c.status === 'empty') throw new Error('pool empty');
  await putObject(recordingKey(c.scriptId, c.token), body);
  const s = await submit(nextContributor - 1, c.token);
  // submit copies the upload to an immutable final key; QA reads that one
  return { id: s.recordingId, key: finalKey(c.scriptId, c.token), scriptId: c.scriptId };
}

const rec = async (id: number) => (await q('SELECT * FROM recordings WHERE id = $1', [id]))[0];

beforeEach(async () => {
  failKeys.clear();
  delete process.env.QA_CHECK_SCRIPT_LENGTH;
  nextContributor = 1;
  await seed({ databaseUrl: process.env.DATABASE_URL!, contributors: 40, scriptsPerLanguage: 0, scriptsByLanguage: { en: 30 } });
});

afterAll(async () => {
  await closePool();
});

describe('runQaOnce', () => {
  it('approves, rejects and reviews according to analyze(), and stores metrics', async () => {
    process.env.QA_CHECK_SCRIPT_LENGTH = '1';
    const good = await record(encodeWav(speech({ seed: 11 })));
    const silent = await record(encodeWav(noiseOnly({ seed: 12 })));
    const quietTake = await record(encodeWav(speech({ seed: 13, levelDb: -40 })));
    const garbage = await record(Buffer.from('definitely not a wav file'));
    const lowRate = await record(encodeWav(speech({ seed: 14, sr: 1000 })));

    const r = await runQaOnce({ limit: 10, logger: quiet });
    expect(r).toEqual({ processed: 5, approved: 2, rejected: 2, review: 1, skipped: 0, errors: 0 });

    const g = await rec(good.id);
    expect(g.status).toBe('approved');
    expect(g.duration_s).toBeCloseTo(11.1, 1);
    expect(g.rms_db).toBeLessThan(-15);
    expect(g.audio_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(g.est_pay_cents).toBe(Math.round((g.duration_s / 3600) * 500));
    expect(Array.isArray(g.checks)).toBe(true);
    expect(g.checks.find((c: { name: string }) => c.name === 'expected_length')).toBeTruthy(); // script body was used
    expect((await q('SELECT status FROM scripts WHERE id = $1', [good.scriptId]))[0].status).toBe('approved');

    const s = await rec(silent.id);
    expect(s).toMatchObject({ status: 'rejected', review_note: 'silent', est_pay_cents: 0 });
    // rejected -> the script goes back to the pool
    expect((await q('SELECT status FROM scripts WHERE id = $1', [silent.scriptId]))[0].status).toBe('available');

    expect(await rec(quietTake.id)).toMatchObject({ status: 'needs_review', review_note: 'quiet' });

    const bad = await rec(garbage.id);
    expect(bad.status).toBe('rejected');
    expect(bad.review_note).toMatch(/^unreadable_audio/);

    expect((await rec(lowRate.id)).status).toBe('approved');

    const ev = await q(`SELECT event, count(*)::int n FROM claim_events WHERE event LIKE 'qa_%' GROUP BY event ORDER BY event`);
    expect(ev).toEqual([{ event: 'qa_approved', n: 2 }, { event: 'qa_rejected', n: 2 }, { event: 'qa_review', n: 1 }]);

    // nothing left to do, and no advisory locks leaked back into the pool
    expect(await runQaOnce({ limit: 10 })).toMatchObject({ processed: 0 });
    expect(await q(`SELECT 1 FROM pg_locks WHERE locktype = 'advisory' AND classid = $1::int::oid`, [QA_LOCK_NS])).toEqual([]);
  });

  it('rejects an exact duplicate of a live recording; a volume-changed copy goes to review', async () => {
    const wav = encodeWav(speech({ seed: 21 }));
    const first = await record(wav);
    expect(await runQaOnce({ limit: 10, logger: quiet })).toMatchObject({ approved: 1 });

    const copy = await record(wav); // same bytes, different script
    const louder = await record(encodeWav(speech({ seed: 21, levelDb: -17 })));
    const other = await record(encodeWav(speech({ seed: 22 })));
    expect(await runQaOnce({ limit: 10, logger: quiet })).toMatchObject({ processed: 3, approved: 1, rejected: 1, review: 1 });

    const c = await rec(copy.id);
    expect(c).toMatchObject({ status: 'rejected', review_note: 'duplicate_audio' });
    expect(c.checks.find((x: { name: string }) => x.name === 'duplicate_audio').value).toBe(first.id);
    const l = await rec(louder.id);
    expect(l).toMatchObject({ status: 'needs_review', review_note: 'near_duplicate' });
    expect((await rec(other.id)).status).toBe('approved');
  });

  it('two identical uploads processed in the same batch: exactly one survives (earliest wins)', async () => {
    const wav = encodeWav(speech({ seed: 31 }));
    const a = await record(wav);
    const b = await record(wav);
    await runQaOnce({ limit: 10, logger: quiet });
    expect((await rec(a.id)).status).toBe('approved');
    expect(await rec(b.id)).toMatchObject({ status: 'rejected', review_note: 'duplicate_audio' });
  });

  it('identical uploads on different concurrent workers: exactly one per audio survives', async () => {
    // pairs of identical takes, picked up by different workers at the same time (limit 1 each)
    for (let i = 0; i < 12; i++) {
      const wav = encodeWav(speech({ seed: 500 + i, sr: 8000 }));
      await record(wav);
      await record(wav);
    }
    await Promise.all(Array.from({ length: 6 }, async () => {
      for (;;) {
        await runQaOnce({ limit: 1, logger: quiet });
        const [{ n }] = await q<{ n: number }>(`SELECT count(*)::int n FROM recordings WHERE status = 'pending_checks'`);
        if (n === 0) break;
      }
    }));
    const live = await q<{ sha: string; n: number }>(
      `SELECT audio_sha256 sha, count(*) FILTER (WHERE status <> 'rejected')::int n FROM recordings GROUP BY 1`);
    expect(live).toHaveLength(12);
    expect(live.every((r) => r.n === 1)).toBe(true);
  });

  it('a rejected recording does not count as the original for duplicates', async () => {
    const wav = encodeWav(speech({ seed: 41 }));
    const a = await record(wav);
    await runQaOnce({ limit: 10, logger: quiet });
    // a reviewer later rejects it (its sha256 stays stored)
    await pool().query(`UPDATE recordings SET status = 'rejected' WHERE id = $1`, [a.id]);
    expect((await rec(a.id)).audio_sha256).toMatch(/^[0-9a-f]{64}$/);
    const b = await record(wav);
    await runQaOnce({ limit: 10, logger: quiet });
    expect((await rec(b.id)).status).toBe('approved');
  });

  it('rejects a sample rate the recorder does not produce, and a header whose rate was edited', async () => {
    const odd = await record(encodeWav(speech({ seed: 71, sr: 22050 })));
    const edited = encodeWav(speech({ seed: 72, sr: 48000 }));
    edited.writeUInt32LE(8000, 24); // claim 8 kHz (6x the duration, 6x the pay) without fixing byte rate
    const fake = await record(edited);
    await runQaOnce({ limit: 10, logger: quiet });
    expect((await rec(odd.id)).status).toBe('rejected');
    expect((await rec(odd.id)).review_note).toMatch(/^wrong_format/);
    expect((await rec(fake.id)).status).toBe('rejected');
    expect((await rec(fake.id)).review_note).toMatch(/inconsistent WAV header/);
  });

  it('a transient storage error leaves the row pending and does not stop the batch', async () => {
    const r1 = await record(encodeWav(speech({ seed: 51 })));
    const r2 = await record(encodeWav(speech({ seed: 52 })));
    failKeys.add(r1.key);
    const errors: unknown[] = [];
    const r = await runQaOnce({ limit: 10, logger: { error: (...a: unknown[]) => errors.push(a), warn: () => {} } });
    expect(r).toMatchObject({ processed: 1, approved: 1, errors: 1 });
    expect(errors).toHaveLength(1);
    expect((await rec(r1.id)).status).toBe('pending_checks');
    expect((await rec(r2.id)).status).toBe('approved');

    failKeys.clear(); // store recovers -> next batch picks it up
    expect(await runQaOnce({ limit: 10, logger: quiet })).toMatchObject({ processed: 1, approved: 1 });
  });

  it('audio deleted from storage after submit goes to review as missing_audio', async () => {
    const r1 = await record(encodeWav(speech({ seed: 61 })));
    await s3().send(new DeleteObjectCommand({ Bucket: bucket(), Key: r1.key }));
    expect(await runQaOnce({ limit: 10, logger: quiet })).toMatchObject({ review: 1 });
    expect(await rec(r1.id)).toMatchObject({ status: 'needs_review', review_note: 'missing_audio' });
  });

  it('concurrent workers never process the same recording twice', async () => {
    const ids: number[] = [];
    for (let i = 0; i < 24; i++) ids.push((await record(encodeWav(speech({ seed: 100 + i, sr: 8000 })))).id);

    // 4 workers, small batches, running until the queue is empty
    const totals = { processed: 0, skipped: 0, errors: 0 };
    await Promise.all(Array.from({ length: 4 }, async () => {
      for (;;) {
        const r = await runQaOnce({ limit: 3, logger: quiet });
        totals.processed += r.processed; totals.skipped += r.skipped; totals.errors += r.errors;
        const [{ n }] = await q<{ n: number }>(`SELECT count(*)::int n FROM recordings WHERE status = 'pending_checks'`);
        if (n === 0) break;
      }
    }));
    expect(totals).toEqual({ processed: 24, skipped: 0, errors: 0 });
    const perRec = await q<{ id: number; n: number }>(
      `SELECT (detail->>'recordingId')::int id, count(*)::int n FROM claim_events
       WHERE event LIKE 'qa_%' GROUP BY 1 HAVING count(*) <> 1`);
    expect(perRec).toEqual([]);
    expect((await q(`SELECT 1 FROM recordings WHERE status <> 'approved'`)).length).toBe(0);
  });
});
