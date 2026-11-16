import type { PoolClient } from 'pg';
import { pool, tx, isUniqueViolation } from './db';
import { config } from './config';
import { AppError } from './errors';
import { headObject, presignPut, recordingKey } from './storage';

export type Claim = {
  status: 'claimed' | 'resumed';
  scriptId: number;
  language: string;
  body: string;
  token: string;
  leaseExpiresAt: string;
  /** Seconds left on the lease, computed by the database so the browser clock never matters. */
  leaseRemainingSeconds: number;
  heartbeatSeconds: number;
};
export type ClaimResult = Claim | { status: 'empty'; language: string; message: string };

export type SubmitResult = {
  status: 'submitted' | 'late_accepted';
  recordingId: number;
  scriptId: number;
  late: boolean;
  /** true when this was a retry of a submit that already succeeded */
  duplicate: boolean;
};

type Opts = { leaseSeconds?: number };

type EventRow = {
  scriptId?: number | null;
  contributorId?: number | null;
  token?: string | null;
  event: string;
  language?: string | null;
  leaseExpiresAt?: Date | string | null;
  detail?: unknown;
};

export async function logEvent(c: PoolClient | ReturnType<typeof pool>, e: EventRow): Promise<void> {
  await c.query(
    `INSERT INTO claim_events (script_id, contributor_id, claim_token, event, language, lease_expires_at, detail)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [e.scriptId ?? null, e.contributorId ?? null, e.token ?? null, e.event, e.language ?? null,
      e.leaseExpiresAt ?? null, e.detail === undefined ? null : JSON.stringify(e.detail)],
  );
}

const CLAIM_COLUMNS = `id, language, body, claim_token, lease_expires_at,
  EXTRACT(EPOCH FROM (lease_expires_at - now()))::float8 AS remaining`;

function toClaim(status: 'claimed' | 'resumed', r: Record<string, unknown>): Claim {
  return {
    status,
    scriptId: Number(r.id),
    language: String(r.language),
    body: String(r.body),
    token: String(r.claim_token),
    leaseExpiresAt: new Date(r.lease_expires_at as string).toISOString(),
    leaseRemainingSeconds: Math.max(0, Number(r.remaining)),
    heartbeatSeconds: config.heartbeatSeconds(),
  };
}

/**
 * Give the contributor a script: their existing live lease if they have one (refresh / second tab),
 * otherwise a fresh lease on a free script in their language.
 */
export async function claim(contributorId: number, language?: string, opts: Opts = {}): Promise<ClaimResult> {
  const lease = opts.leaseSeconds ?? config.leaseSeconds();
  // Two tabs of the same contributor can race past the resume check; the loser hits the
  // one_claim_per_contributor index, and its retry takes the resume path.
  for (let attempt = 0; ; attempt++) {
    try {
      return await tx((c) => claimOnce(c, contributorId, language, lease));
    } catch (e) {
      if (attempt < 3 && isUniqueViolation(e, 'one_claim_per_contributor')) continue;
      throw e;
    }
  }
}

async function claimOnce(c: PoolClient, contributorId: number, language: string | undefined, lease: number): Promise<ClaimResult> {
  const who = await c.query('SELECT language FROM contributors WHERE id = $1', [contributorId]);
  if (who.rowCount === 0) throw new AppError(404, 'unknown_contributor', `no contributor ${contributorId}`);
  const lang = language ?? (who.rows[0].language as string);

  // 1. Resume a live lease (same script, same token).
  const live = await c.query(
    `SELECT ${CLAIM_COLUMNS} FROM scripts
     WHERE claimed_by = $1 AND status = 'claimed' AND lease_expires_at > now()
     FOR UPDATE`,
    [contributorId],
  );
  if (live.rowCount) {
    const r = live.rows[0];
    await logEvent(c, { scriptId: r.id, contributorId, token: r.claim_token, event: 'resumed', language: r.language, leaseExpiresAt: r.lease_expires_at });
    return toClaim('resumed', r);
  }

  // 2. Revive this contributor's own expired lease if nobody re-claimed the script, keeping the same token.
  //    Safe because the token is still on the row only if no one else claimed it in between. Without this,
  //    a contributor who stalled and comes back would get the script under a new token and their finished
  //    recording (uploaded under the old token) would be rejected for nothing.
  //    SKIP LOCKED: if another claimer is taking the row right now, it's theirs; fall through to step 3.
  const revived = await c.query(
    `WITH mine AS (
       SELECT id FROM scripts
       WHERE (claimed_by = $1 AND status = 'claimed' AND lease_expires_at <= now())
          OR (prev_claimed_by = $1 AND status = 'available' AND prev_token IS NOT NULL)
       ORDER BY (status = 'claimed') DESC, claimed_at DESC NULLS LAST
       LIMIT 1
       FOR UPDATE SKIP LOCKED
     )
     UPDATE scripts s
     SET status = 'claimed', claimed_by = $1, claim_token = coalesce(s.claim_token, s.prev_token),
         lease_expires_at = now() + make_interval(secs => $2),
         prev_token = NULL, prev_claimed_by = NULL
     FROM mine
     WHERE s.id = mine.id
     RETURNING s.id, s.language, s.body, s.claim_token, s.lease_expires_at,
       EXTRACT(EPOCH FROM (s.lease_expires_at - now()))::float8 AS remaining`,
    [contributorId, lease],
  );
  if (revived.rowCount) {
    const r = revived.rows[0];
    await logEvent(c, { scriptId: r.id, contributorId, token: r.claim_token, event: 'resumed', language: r.language, leaseExpiresAt: r.lease_expires_at, detail: { revived: true } });
    return toClaim('resumed', r);
  }

  // 3. Claim. Expired leases count as free right here, so recovery never waits for the background job.
  //    SKIP LOCKED: concurrent claimers each take a different row instead of queueing on the same one.
  //    The CTE reads the row *before* the update, so we know whose lease (if any) we just took over.
  const got = await c.query(
    `WITH pick AS (
       SELECT id, status AS old_status, claim_token AS old_token, claimed_by AS old_by
       FROM scripts
       WHERE language = $2
         AND (status = 'available' OR (status = 'claimed' AND lease_expires_at <= now()))
       ORDER BY id
       LIMIT 1
       FOR UPDATE SKIP LOCKED
     )
     UPDATE scripts s
     SET status = 'claimed', claimed_by = $1, claim_token = gen_random_uuid(),
         claimed_at = now(), lease_expires_at = now() + make_interval(secs => $3),
         prev_token = NULL, prev_claimed_by = NULL,
         times_claimed = s.times_claimed + 1
     FROM pick
     WHERE s.id = pick.id
     RETURNING s.id, s.language, s.body, s.claim_token, s.lease_expires_at,
       EXTRACT(EPOCH FROM (s.lease_expires_at - now()))::float8 AS remaining,
       pick.old_status, pick.old_token, pick.old_by`,
    [contributorId, lang, lease],
  );

  if (!got.rowCount) {
    await logEvent(c, { contributorId, event: 'pool_empty', language: lang });
    return { status: 'empty', language: lang, message: `No scripts left in ${lang} right now. Please check back later.` };
  }

  const r = got.rows[0];
  if (r.old_status === 'claimed') {
    // we took over someone's expired lease; record that it expired
    await logEvent(c, { scriptId: r.id, contributorId: r.old_by, token: r.old_token, event: 'expired', language: r.language, detail: { by: 'reclaim' } });
  }
  await logEvent(c, { scriptId: r.id, contributorId, token: r.claim_token, event: 'claimed', language: r.language, leaseExpiresAt: r.lease_expires_at });
  return toClaim('claimed', r);
}

/** Extend a live lease. A lease that already expired can't be revived: the script may be someone else's now. */
export async function heartbeat(contributorId: number, token: string, opts: Opts = {}) {
  const lease = opts.leaseSeconds ?? config.leaseSeconds();
  const r = await pool().query(
    `UPDATE scripts SET lease_expires_at = now() + make_interval(secs => $3)
     WHERE claim_token = $1 AND claimed_by = $2 AND status = 'claimed' AND lease_expires_at > now()
     RETURNING id, language, lease_expires_at,
       EXTRACT(EPOCH FROM (lease_expires_at - now()))::float8 AS remaining`,
    [token, contributorId, lease],
  );
  if (!r.rowCount) {
    await logEvent(pool(), { contributorId, token, event: 'lost' });
    throw new AppError(409, 'lease_lost', 'Your session on this script expired. Get a new script to continue.');
  }
  const row = r.rows[0];
  await logEvent(pool(), { scriptId: row.id, contributorId, token, event: 'heartbeat', language: row.language, leaseExpiresAt: row.lease_expires_at });
  return {
    leaseExpiresAt: new Date(row.lease_expires_at).toISOString(),
    leaseRemainingSeconds: Math.max(0, Number(row.remaining)),
  };
}

/** Best-effort give-back (tab close). The lease expiry is the real guarantee; this just makes recovery instant. */
export async function release(contributorId: number, token: string): Promise<{ released: boolean }> {
  const r = await pool().query(
    `UPDATE scripts
     SET status = 'available', claimed_by = NULL, claim_token = NULL, lease_expires_at = NULL,
         prev_token = NULL, prev_claimed_by = NULL
     WHERE claim_token = $1 AND claimed_by = $2 AND status = 'claimed'
     RETURNING id, language`,
    [token, contributorId],
  );
  if (r.rowCount) {
    await logEvent(pool(), { scriptId: r.rows[0].id, contributorId, token, event: 'released', language: r.rows[0].language });
  }
  return { released: !!r.rowCount };
}

/**
 * The script this token may still submit for: its live (or expired-but-not-reclaimed) lease,
 * or an expired lease the background job already cleaned up but nobody re-claimed (prev_token).
 */
async function scriptForToken(contributorId: number, token: string): Promise<{ id: number; language: string } | null> {
  const r = await pool().query(
    `SELECT id, language FROM scripts
     WHERE (claim_token = $1 AND claimed_by = $2 AND status = 'claimed')
        OR (prev_token = $1 AND prev_claimed_by = $2 AND status = 'available')`,
    [token, contributorId],
  );
  return r.rowCount ? { id: Number(r.rows[0].id), language: r.rows[0].language } : null;
}

async function scriptIdFromEvents(token: string): Promise<{ scriptId: number; language: string } | null> {
  const r = await pool().query(
    `SELECT script_id, language FROM claim_events WHERE claim_token = $1 AND event = 'claimed' LIMIT 1`,
    [token],
  );
  return r.rowCount ? { scriptId: Number(r.rows[0].script_id), language: r.rows[0].language } : null;
}

export async function uploadUrl(contributorId: number, token: string) {
  const s = await scriptForToken(contributorId, token);
  if (!s) throw new AppError(409, 'script_taken', 'This script is no longer yours to record.');
  const key = recordingKey(s.id, token);
  const expiresIn = config.uploadUrlSeconds();
  return { url: await presignPut(key, 'audio/wav', expiresIn), key, contentType: 'audio/wav', expiresIn };
}

async function existingRecording(token: string): Promise<SubmitResult | null> {
  const r = await pool().query('SELECT id, script_id, late FROM recordings WHERE claim_token = $1', [token]);
  if (!r.rowCount) return null;
  const row = r.rows[0];
  return { status: row.late ? 'late_accepted' : 'submitted', recordingId: Number(row.id), scriptId: Number(row.script_id), late: row.late, duplicate: true };
}

/**
 * Turn an uploaded object into a recording. Idempotent per claim token.
 * A late submit is accepted if nobody re-claimed the script; otherwise 409 and the audio is an orphan.
 */
export async function submit(contributorId: number, token: string): Promise<SubmitResult> {
  const prior = await existingRecording(token);
  if (prior) return prior;

  const s = await scriptForToken(contributorId, token);
  if (!s) {
    const ev = await scriptIdFromEvents(token);
    if (!ev) throw new AppError(404, 'unknown_claim', 'No such claim.');
    await logEvent(pool(), { scriptId: ev.scriptId, contributorId, token, event: 'rejected', language: ev.language, detail: { reason: 'script_taken' } });
    throw new AppError(409, 'script_taken', 'Your session expired and this script was given to someone else. Your recording was not used.');
  }

  // Check storage before taking any row lock: you can't submit audio that doesn't exist.
  const key = recordingKey(s.id, token);
  const obj = await headObject(key);
  if (!obj) throw new AppError(400, 'upload_missing', 'Upload the recording before submitting.');
  if (obj.size <= 0 || obj.size > config.maxUploadBytes()) {
    throw new AppError(400, 'upload_invalid', `Recording size ${obj.size} bytes is out of range.`);
  }

  const result = await tx(async (c) => {
    // RETURNING shows post-update values, so `late` is read from the old row in the CTE.
    const r = await c.query(
      `WITH old AS (
         SELECT id, language,
                (status <> 'claimed' OR lease_expires_at < now()) AS late
         FROM scripts
         WHERE id = $3
           AND ((claim_token = $1 AND claimed_by = $2 AND status = 'claimed')
             OR (prev_token = $1 AND prev_claimed_by = $2 AND status = 'available'))
         FOR UPDATE
       )
       UPDATE scripts s
       SET status = 'submitted', claimed_by = NULL, claim_token = NULL, lease_expires_at = NULL,
           prev_token = NULL, prev_claimed_by = NULL
       FROM old
       WHERE s.id = old.id
       RETURNING s.id, old.language, old.late`,
      [token, contributorId, s.id],
    );
    if (!r.rowCount) return null; // re-claimed (or a concurrent retry won) between our read and the lock
    const row = r.rows[0];
    const rec = await c.query(
      `INSERT INTO recordings (script_id, contributor_id, claim_token, s3_key, size_bytes, late)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [row.id, contributorId, token, key, obj.size, row.late],
    );
    await logEvent(c, { scriptId: row.id, contributorId, token, event: row.late ? 'late_accepted' : 'submitted', language: row.language, detail: { recordingId: Number(rec.rows[0].id) } });
    return { status: row.late ? 'late_accepted' : 'submitted', recordingId: Number(rec.rows[0].id), scriptId: Number(row.id), late: row.late, duplicate: false } as SubmitResult;
  });
  if (result) return result;

  const raced = await existingRecording(token);
  if (raced) return raced;
  await logEvent(pool(), { scriptId: s.id, contributorId, token, event: 'rejected', language: s.language, detail: { reason: 'script_taken' } });
  throw new AppError(409, 'script_taken', 'Your session expired and this script was given to someone else. Your recording was not used.');
}
