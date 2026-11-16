// QA worker core: claim pending_checks recordings, analyze them, approve / reject / send to review.
//
// How two workers avoid processing the same recording (no lease column in the schema):
//   1. One dedicated connection per batch. In a short transaction it picks candidates with
//      FOR UPDATE SKIP LOCKED (so concurrent claimers never even look at the same rows) and, while
//      it still holds those row locks, takes a *session-level* advisory lock per recording with
//      pg_try_advisory_lock(QA_LOCK_NS, id). Then it commits: row locks are released, the advisory
//      locks stay held by the session.
//   2. Download + decode + analyze run outside any transaction. Other workers skip rows whose
//      advisory lock is held (filtered via pg_locks, and pg_try_advisory_lock would fail anyway).
//   3. The advisory lock is released after the status change commits. If the worker crashes, its
//      connection drops and Postgres frees the locks: a free, crash-safe lease.
// Why not hold FOR UPDATE for the whole job: lib/review.ts runs its updates on other pool
// connections, so they would block on our own row lock (self-deadlock), and we'd hold a row lock
// across a 17 MB download. The final guard is still review.ts's `WHERE status IN (...)`: a
// decision on a row that was already decided (e.g. a reviewer acted first) is a 409 we count as
// "skipped", never a double transition.
import type { PoolClient } from 'pg';
import { pool } from './db';
import { getObjectBytes } from './storage';
import { decodeWav } from './wav';
import { analyze, expectedDurationS, type Check } from './checks';
import { saveMetrics, approve, reject, sendToReview } from './review';
import { AppError } from './errors';

/** Advisory-lock namespace (first key of the two-int form) so we never collide with other users. */
export const QA_LOCK_NS = 0x51a; // "QA"

export type QaResult = {
  processed: number;
  approved: number;
  rejected: number;
  review: number;
  skipped: number;
  errors: number;
};

type Row = { id: number; s3_key: string; body: string | null };
type Logger = Pick<Console, 'error' | 'warn'>;

export async function runQaOnce(opts: { limit?: number; logger?: Logger } = {}): Promise<QaResult> {
  const limit = opts.limit ?? 10;
  const log = opts.logger ?? console;
  const out: QaResult = { processed: 0, approved: 0, rejected: 0, review: 0, skipped: 0, errors: 0 };

  const c = await pool().connect();
  let broken: Error | undefined;
  try {
    const rows = await claimBatch(c, limit);
    for (const row of rows) {
      try {
        const decision = await processOne(row);
        out.processed++;
        out[decision]++;
      } catch (e) {
        if (e instanceof AppError && e.status === 409) {
          out.skipped++; // decided by someone else meanwhile
        } else {
          out.errors++; // stays pending_checks; retried next batch
          log.error(`qa: recording ${row.id} failed:`, e);
        }
      } finally {
        await c.query('SELECT pg_advisory_unlock($1, $2::int)', [QA_LOCK_NS, row.id]).catch((e) => { broken = e; });
      }
    }
  } catch (e) {
    broken = e as Error;
    throw e;
  } finally {
    // Session locks would otherwise leak to the next pool user of this connection.
    if (!broken) await c.query('SELECT pg_advisory_unlock_all()').catch((e) => { broken = e; });
    c.release(broken); // a broken connection is destroyed, which also frees its locks
  }
  return out;
}

async function claimBatch(c: PoolClient, limit: number): Promise<Row[]> {
  await c.query('BEGIN');
  try {
    const cand = await c.query<Row>(
      `SELECT r.id, r.s3_key, s.body
       FROM recordings r JOIN scripts s ON s.id = r.script_id
       WHERE r.status = 'pending_checks'
         AND NOT EXISTS (SELECT 1 FROM pg_locks l
                         WHERE l.locktype = 'advisory' AND l.classid = $1::int::oid
                           AND l.objid = r.id::int::oid AND l.objsubid = 2)
       ORDER BY r.created_at, r.id
       FOR UPDATE OF r SKIP LOCKED
       LIMIT $2`,
      [QA_LOCK_NS, limit],
    );
    const got: Row[] = [];
    for (const r of cand.rows) {
      const l = await c.query('SELECT pg_try_advisory_lock($1, $2::int) AS ok', [QA_LOCK_NS, r.id]);
      if (l.rows[0].ok) got.push({ ...r, id: Number(r.id) });
    }
    await c.query('COMMIT');
    return got;
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {});
    throw e;
  }
}

type Decision = 'approved' | 'rejected' | 'review';

async function processOne(row: Row): Promise<Decision> {
  let bytes: Buffer;
  try {
    bytes = await getObjectBytes(row.s3_key);
  } catch (e) {
    const err = e as { name?: string; $metadata?: { httpStatusCode?: number } };
    // submit() checked the object exists, so a 404 now means it was deleted: a human should look.
    // Any other storage error is transient: rethrow, the row stays pending_checks for the next batch.
    if (err.name === 'NoSuchKey' || err.$metadata?.httpStatusCode === 404) {
      await sendToReview(row.id, 'missing_audio');
      return 'review';
    }
    throw e;
  }

  let pcm;
  try {
    pcm = decodeWav(bytes);
    if (!(pcm.sampleRate > 0)) throw new Error(`bad sample rate ${pcm.sampleRate}`);
  } catch (e) {
    await reject(row.id, 'qa', `unreadable_audio: ${(e as Error).message}`);
    return 'rejected';
  }

  // Script-length check is opt-in: the seed scripts are one-sentence placeholders (~5 s to read)
  // while takes are modeled on the exercise's ~3 min, so it would flag every take as lengthened.
  // Turn it on (QA_CHECK_SCRIPT_LENGTH=1) once script bodies match the expected recording length.
  const useScriptLength = process.env.QA_CHECK_SCRIPT_LENGTH === '1' && row.body;
  const a = analyze(pcm, { expectedS: useScriptLength ? expectedDurationS(row.body!) : undefined });
  // Save first: the duplicate lookup below relies on our own hash being visible to other workers.
  await saveMetrics(row.id, a.metrics);

  const reasons = [...a.reasons];
  let verdict = a.verdict;
  const extra: Check[] = [];

  // Exact duplicate. "Earliest wins": the other copy counts if it's older or already past QA, so
  // two workers checking two identical uploads at once reject exactly one of them.
  const dup = await pool().query(
    `SELECT id FROM recordings
     WHERE audio_sha256 = $1 AND id <> $2 AND status <> 'rejected'
       AND (id < $2 OR status <> 'pending_checks')
     ORDER BY id LIMIT 1`,
    [a.metrics.sha256, row.id],
  );
  if (dup.rowCount) {
    const of = Number(dup.rows[0].id);
    extra.push({ name: 'duplicate_audio', value: of, status: 'fail', threshold: 'same PCM sha256 as a live recording', reason: 'duplicate_audio' });
    if (verdict !== 'fail') reasons.length = 0;
    reasons.push('duplicate_audio');
    verdict = 'fail';
  } else if (verdict !== 'fail' && a.detail.fingerprint) {
    // Near duplicate (same coarse envelope, e.g. re-encoded or volume-changed copy): review only.
    // Seq scan over checks; fine at this size, would want a GIN index on checks at scale.
    const near = await pool().query(
      `SELECT id FROM recordings
       WHERE id <> $2 AND status <> 'rejected' AND checks @> $1::jsonb
         AND (id < $2 OR status <> 'pending_checks')
       ORDER BY id LIMIT 1`,
      [JSON.stringify([{ name: 'fingerprint', value: a.detail.fingerprint }]), row.id],
    );
    if (near.rowCount) {
      const of = Number(near.rows[0].id);
      extra.push({ name: 'near_duplicate', value: of, status: 'warn', threshold: 'same envelope fingerprint as a live recording', reason: 'near_duplicate' });
      if (verdict === 'pass') reasons.length = 0;
      reasons.push('near_duplicate');
      verdict = 'review';
    }
  }
  if (extra.length) await saveMetrics(row.id, { ...a.metrics, checks: [...a.metrics.checks, ...extra] });

  const note = reasons.join(',');
  if (verdict === 'fail') { await reject(row.id, 'qa', note); return 'rejected'; }
  if (verdict === 'review') { await sendToReview(row.id, note); return 'review'; }
  await approve(row.id, 'qa');
  return 'approved';
}
