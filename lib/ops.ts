// Read-mostly queries for the ops/audit view and the record/stats pages.
// Every time comparison uses Postgres now(), never the app server or browser clock.
import { GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { pool } from './db';
import { config } from './config';
import { bucket, s3 } from './storage';
import { abandonmentRates, poolSnapshot } from './jobs';

/** Languages that have scripts, with how many registered contributors speak each (for "popular first"). */
export async function languages(): Promise<{ language: string; contributors: number }[]> {
  const r = await pool().query(
    `SELECT s.language, coalesce(c.n, 0)::int AS contributors
     FROM (SELECT DISTINCT language FROM scripts) s
     LEFT JOIN (SELECT language, count(*) AS n FROM contributors GROUP BY language) c USING (language)
     ORDER BY contributors DESC, s.language`,
  );
  return r.rows.map((row) => ({ language: row.language, contributors: Number(row.contributors) }));
}

// Until the QA worker has measured the audio, estimate duration from the WAV size (48 kHz 16-bit mono).
const EST_CENTS = `coalesce(est_pay_cents, round(greatest(size_bytes - 44, 0) / 96000.0 / 3600 * $2)::int)`;

/** A contributor's language plus their earnings by recording status (estimated until approved). */
export async function contributor(id: number) {
  const c = await pool().query('SELECT id, language FROM contributors WHERE id = $1', [id]);
  if (!c.rowCount) return null;
  const e = await pool().query(
    `SELECT status, count(*)::int AS n, sum(${EST_CENTS})::int AS cents,
            sum(coalesce(duration_s, greatest(size_bytes - 44, 0) / 96000.0))::float8 AS seconds
     FROM recordings WHERE contributor_id = $1 GROUP BY status`,
    [id, config.payCentsPerHour()],
  );
  const by: Record<string, { recordings: number; cents: number; seconds: number }> = {};
  for (const row of e.rows) by[row.status] = { recordings: row.n, cents: row.cents ?? 0, seconds: Number(row.seconds ?? 0) };
  const sum = (...ks: string[]) => ks.reduce((a, k) => a + (by[k]?.cents ?? 0), 0);
  return {
    id: Number(c.rows[0].id),
    language: String(c.rows[0].language),
    payCentsPerHour: config.payCentsPerHour(),
    earnings: {
      estimatedCents: sum('pending_checks', 'needs_review'),
      approvedCents: sum('approved'),
      paidCents: sum('paid'),
      byStatus: by,
    },
  };
}

export async function recentAlerts(limit = 20) {
  const r = await pool().query(
    `SELECT id, at, kind, language, message FROM alerts ORDER BY at DESC, id DESC LIMIT $1`,
    [limit],
  );
  return r.rows.map((row) => ({ id: Number(row.id), at: row.at as Date, kind: row.kind as string, language: row.language as string | null, message: row.message as string }));
}

export type LeaseRow = {
  scriptId: number;
  language: string;
  contributorId: number;
  token: string;
  claimedAt: Date;
  leaseExpiresAt: Date;
  /** positive = time left, negative = overdue (expired but the job hasn't cleaned it up yet) */
  remainingSeconds: number;
  lastHeartbeatAt: Date | null;
  heartbeats: number;
};

/** Every row in status 'claimed': live leases and stuck ones (expired, still marked claimed). */
export async function leases(limit = 200): Promise<{ live: LeaseRow[]; stuck: LeaseRow[]; counts: { live: number; stuck: number } }> {
  const r = await pool().query(
    `SELECT s.id, s.language, s.claimed_by, s.claim_token, s.claimed_at, s.lease_expires_at,
            EXTRACT(EPOCH FROM (s.lease_expires_at - now()))::float8 AS remaining,
            hb.last_at, coalesce(hb.n, 0)::int AS heartbeats
     FROM scripts s
     LEFT JOIN LATERAL (
       SELECT max(at) AS last_at, count(*) AS n FROM claim_events e
       WHERE e.script_id = s.id AND e.claim_token = s.claim_token AND e.event = 'heartbeat'
     ) hb ON true
     WHERE s.status = 'claimed'
     ORDER BY s.lease_expires_at
     LIMIT $1`,
    [limit],
  );
  const counts = await pool().query(
    `SELECT count(*) FILTER (WHERE lease_expires_at > now())::int AS live,
            count(*) FILTER (WHERE lease_expires_at <= now())::int AS stuck
     FROM scripts WHERE status = 'claimed'`,
  );
  const rows: LeaseRow[] = r.rows.map((row) => ({
    scriptId: Number(row.id),
    language: row.language,
    contributorId: row.claimed_by,
    token: row.claim_token,
    claimedAt: row.claimed_at,
    leaseExpiresAt: row.lease_expires_at,
    remainingSeconds: Number(row.remaining),
    lastHeartbeatAt: row.last_at,
    heartbeats: row.heartbeats,
  }));
  return {
    live: rows.filter((x) => x.remainingSeconds > 0),
    stuck: rows.filter((x) => x.remainingSeconds <= 0),
    counts: counts.rows[0],
  };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** One script's full history. `q` is a script id or any claim token that ever touched it. */
export async function scriptHistory(q: string) {
  q = q.trim();
  let scriptId: number | null = null;
  if (/^\d+$/.test(q)) scriptId = Number(q);
  else if (UUID.test(q)) {
    const t = await pool().query(
      `SELECT script_id FROM claim_events WHERE claim_token = $1 AND script_id IS NOT NULL LIMIT 1`,
      [q],
    );
    if (t.rowCount) scriptId = Number(t.rows[0].script_id);
    else {
      const s = await pool().query(`SELECT id FROM scripts WHERE claim_token = $1 OR prev_token = $1`, [q]);
      if (s.rowCount) scriptId = Number(s.rows[0].id);
    }
  } else return { error: 'Enter a script id (number) or a claim token (UUID).' as const };
  if (scriptId === null) return { error: 'No script found for that token.' as const };

  const s = await pool().query(
    `SELECT id, language, body, status, claimed_by, claim_token, claimed_at, lease_expires_at, times_claimed,
            EXTRACT(EPOCH FROM (lease_expires_at - now()))::float8 AS remaining
     FROM scripts WHERE id = $1`,
    [scriptId],
  );
  if (!s.rowCount) return { error: `No script ${scriptId}.` as const };
  const ev = await pool().query(
    `SELECT id, at, event, contributor_id, claim_token, lease_expires_at, detail
     FROM claim_events WHERE script_id = $1 ORDER BY at, id`,
    [scriptId],
  );
  const recs = await pool().query(
    `SELECT id, contributor_id, claim_token, status, late, size_bytes, duration_s, est_pay_cents,
            review_note, reviewed_at, paid_at, created_at
     FROM recordings WHERE script_id = $1 ORDER BY created_at`,
    [scriptId],
  );
  // Heartbeats are the bulk of the log; collapse runs of them so the story stays readable.
  type Ev = { id: number; at: Date; event: string; contributorId: number | null; token: string | null; leaseExpiresAt: Date | null; detail: unknown; count?: number; lastAt?: Date };
  const events: Ev[] = [];
  for (const row of ev.rows) {
    const e: Ev = { id: Number(row.id), at: row.at, event: row.event, contributorId: row.contributor_id, token: row.claim_token, leaseExpiresAt: row.lease_expires_at, detail: row.detail };
    const prev = events[events.length - 1];
    if (e.event === 'heartbeat' && prev?.event === 'heartbeat' && prev.token === e.token) {
      prev.count = (prev.count ?? 1) + 1;
      prev.lastAt = e.at;
      prev.leaseExpiresAt = e.leaseExpiresAt;
    } else events.push(e);
  }
  const row = s.rows[0];
  return {
    script: {
      id: Number(row.id), language: row.language, body: row.body, status: row.status,
      claimedBy: row.claimed_by, token: row.claim_token, claimedAt: row.claimed_at,
      leaseExpiresAt: row.lease_expires_at, remainingSeconds: row.remaining === null ? null : Number(row.remaining),
      timesClaimed: row.times_claimed,
    },
    events,
    recordings: recs.rows.map((r) => ({
      id: Number(r.id), contributorId: r.contributor_id, token: r.claim_token, status: r.status, late: r.late,
      sizeBytes: Number(r.size_bytes), durationS: r.duration_s, estPayCents: r.est_pay_cents,
      reviewNote: r.review_note, reviewedAt: r.reviewed_at, paidAt: r.paid_at, createdAt: r.created_at,
    })),
  };
}

export async function abandonment(windowSeconds = 86400, minClaims = 3, limit = 25) {
  const rows = await abandonmentRates(windowSeconds, minClaims);
  return rows.sort((a, b) => b.rate - a.rate || b.abandoned - a.abandoned).slice(0, limit);
}

/** Recordings waiting for a human, newest first, with QA metrics when the worker has filled them. */
export async function reviewQueue(limit = 50) {
  const r = await pool().query(
    `SELECT r.id, r.script_id, r.contributor_id, r.created_at, r.late, r.size_bytes,
            r.duration_s, r.silence_ratio, r.clipping_ratio, r.peak_db, r.rms_db, r.review_note, r.est_pay_cents,
            s.language, left(s.body, 140) AS body,
            -- what the script check heard, so the reviewer can compare it with the script
            (SELECT c FROM jsonb_array_elements(CASE WHEN jsonb_typeof(r.checks) = 'array' THEN r.checks ELSE '[]'::jsonb END) c
             WHERE c->>'name' = 'script_match' LIMIT 1) AS script_check
     FROM recordings r JOIN scripts s ON s.id = r.script_id
     WHERE r.status = 'needs_review'
     ORDER BY r.created_at DESC, r.id DESC
     LIMIT $1`,
    [limit],
  );
  const n = await pool().query(`SELECT count(*)::int AS n FROM recordings WHERE status = 'needs_review'`);
  return {
    total: n.rows[0].n as number,
    items: r.rows.map((row) => ({
      id: Number(row.id), scriptId: Number(row.script_id), contributorId: row.contributor_id, createdAt: row.created_at,
      late: row.late, sizeBytes: Number(row.size_bytes), language: row.language, body: row.body,
      durationS: row.duration_s, silenceRatio: row.silence_ratio, clippingRatio: row.clipping_ratio,
      peakDb: row.peak_db, rmsDb: row.rms_db, qaNote: row.review_note, estPayCents: row.est_pay_cents,
      heard: (row.script_check?.transcript as string | undefined) ?? null,
      scriptError: typeof row.script_check?.value === 'number' ? (row.script_check.value as number) : null,
      scriptMetric: (row.script_check?.metric as string | undefined) ?? null,
    })),
  };
}

/** Recordings per status, with pay. "estimated" until approved. */
export async function recordingTotals() {
  const r = await pool().query(
    `SELECT status, count(*)::int AS n, coalesce(sum(${EST_CENTS.replace('$2', '$1')}), 0)::int AS cents
     FROM recordings GROUP BY status`,
    [config.payCentsPerHour()],
  );
  const out: Record<string, { recordings: number; cents: number }> = {};
  for (const s of ['pending_checks', 'needs_review', 'approved', 'rejected', 'paid']) out[s] = { recordings: 0, cents: 0 };
  for (const row of r.rows) out[row.status] = { recordings: row.n, cents: row.cents };
  return out;
}

const DECISIONS = ['qa_approved', 'qa_rejected', 'qa_review', 'review_approved', 'review_rejected', 'paid'];

/** Audit trail of every review/QA/payout decision: who (qa | reviewer | payout run) and when. */
export async function recentDecisions(limit = 30) {
  const r = await pool().query(
    `SELECT id, at, event, script_id, contributor_id, detail FROM claim_events
     WHERE event = ANY($1) ORDER BY at DESC, id DESC LIMIT $2`,
    [DECISIONS, limit],
  );
  return r.rows.map((row) => ({
    id: Number(row.id), at: row.at as Date, event: row.event as string,
    by: row.event.startsWith('qa_') ? 'qa' : row.event.startsWith('review_') ? 'reviewer' : 'payout run',
    scriptId: row.script_id === null ? null : Number(row.script_id), contributorId: row.contributor_id as number | null,
    detail: row.detail as Record<string, unknown> | null,
  }));
}

export async function recordingKey(recordingId: number): Promise<string | null> {
  const r = await pool().query('SELECT s3_key FROM recordings WHERE id = $1', [recordingId]);
  return r.rowCount ? (r.rows[0].s3_key as string) : null;
}

/** Presigned GET so a reviewer's <audio> streams straight from storage. */
export async function presignGet(key: string, expiresIn = 600): Promise<string> {
  return getSignedUrl(s3(), new GetObjectCommand({ Bucket: bucket(), Key: key, ResponseContentType: 'audio/wav' }), { expiresIn });
}

export async function overview() {
  const [pools, alerts, l, abandoners, totals] = await Promise.all([
    poolSnapshot(), recentAlerts(), leases(), abandonment(), recordingTotals(),
  ]);
  const now = await pool().query('SELECT now() AS now');
  return {
    dbNow: now.rows[0].now as Date,
    lowPoolAlertHours: config.lowPoolAlertHours(),
    leaseSeconds: config.leaseSeconds(),
    pools, alerts, leases: l, abandoners, totals,
  };
}

// ---------- live invariant + metrics (the /ops "Live" card, polled every ~1.5 s; sim/storm.ts) ----------

/**
 * Each token's live interval, rebuilt from claim_events, with the same rules as sim/check.ts ("Handed out
 * twice"): [claimed at, lease end as of its latest lease-setting event (claimed / heartbeat / resumed /
 * soft release)], cut at its last submit / hard release unless a revive came after it.
 *
 * Kept cheap enough to poll every 1-2 s: only scripts that were claimed by two or more different tokens
 * since now() - $1 can have an overlap, so the full event history (mostly heartbeats) is aggregated for
 * those scripts only (claim_events_script index); every other script had a single lease in the range and
 * is trivially fine. The latest lease end is max(ARRAY[id, epoch]) rather than array_agg(... ORDER BY),
 * which avoids a sort per token (ids are < 2^53, exact as float8).
 */
const LIVE_INTERVALS = `
  WITH c AS (
    SELECT script_id, claim_token, at FROM claim_events
    WHERE event = 'claimed' AND at > now() - make_interval(secs => $1) AND script_id IS NOT NULL
  ), multi AS (
    SELECT script_id FROM c GROUP BY script_id HAVING count(DISTINCT claim_token) > 1
  ), tok AS (
    SELECT e.script_id, e.claim_token,
      min(e.at) FILTER (WHERE e.event = 'claimed') AS start,
      max(ARRAY[e.id::float8, EXTRACT(EPOCH FROM e.lease_expires_at)::float8])
        FILTER (WHERE e.event IN ('claimed','heartbeat','resumed','released') AND e.lease_expires_at IS NOT NULL) AS lease_last,
      max(e.at) FILTER (WHERE e.event IN ('submitted','late_accepted') OR (e.event = 'released' AND e.lease_expires_at IS NULL)) AS last_cut,
      max(e.at) FILTER (WHERE e.event = 'resumed' AND e.detail->>'revived' = 'true') AS last_revived,
      max(e.at) FILTER (WHERE e.event = 'released') AS released
    FROM claim_events e JOIN multi m ON m.script_id = e.script_id
    WHERE e.at > now() - make_interval(secs => $1) AND e.claim_token IS NOT NULL
    GROUP BY e.script_id, e.claim_token
  ), iv AS (
    SELECT script_id, claim_token, start, released,
      CASE WHEN last_cut IS NOT NULL AND (last_revived IS NULL OR last_cut > last_revived)
           THEN LEAST(to_timestamp(lease_last[2]), last_cut) ELSE to_timestamp(lease_last[2]) END AS stop
    FROM tok WHERE start IS NOT NULL AND lease_last IS NOT NULL
  )`;

export type LiveInvariant = { handedOutTwice: number; leasesChecked: number; recordedTwice: number; windowMinutes: number };

/**
 * Scripts handed out twice: pairs of different tokens on one script whose live intervals overlap, for
 * leases handed out in the last `windowMinutes` (leasesChecked) and the window before it (so a lease that
 * started just before the window is still compared). Like sim/check.ts, an overlap whose earlier lease
 * ends exactly at its own release event is logging skew (the release committed before the later claim
 * could pick the row), not a double hand-out. recordedTwice: scripts with more than one non-rejected
 * recording (also enforced by a unique index; counted here as a live check).
 */
export async function liveInvariant(windowMinutes = 30): Promise<LiveInvariant> {
  const win = Math.max(1, windowMinutes) * 60;
  const r = await pool().query(
    `${LIVE_INTERVALS}
     SELECT
       (SELECT count(*) FROM c WHERE at > now() - make_interval(secs => $2))::int AS leases,
       (SELECT count(*) FROM iv e JOIN iv l
          ON e.script_id = l.script_id AND e.claim_token <> l.claim_token
         AND (e.start, e.claim_token) < (l.start, l.claim_token)
         AND e.start < l.stop AND l.start < e.stop
        WHERE GREATEST(e.stop, l.stop) > now() - make_interval(secs => $2)
          AND NOT (e.released IS NOT NULL AND e.stop = e.released))::int AS overlaps,
       (SELECT count(*) FROM (SELECT script_id FROM recordings WHERE status <> 'rejected'
          GROUP BY script_id HAVING count(*) > 1) x)::int AS recorded_twice`,
    [2 * win, win],
  );
  const row = r.rows[0];
  return { handedOutTwice: row.overlaps, leasesChecked: row.leases, recordedTwice: row.recorded_twice, windowMinutes: win / 60 };
}

export type LiveRates = {
  claims: number; resumes: number; revives: number; heartbeats: number;
  expired: number; expiredByJob: number; expiredByReclaim: number; released: number;
  lateAccepted: number; rejected: number; submitted: number; lost: number;
  qaApproved: number; qaRejected: number; qaReview: number; poolEmpty: number;
};

const emptyRates = (): LiveRates => ({
  claims: 0, resumes: 0, revives: 0, heartbeats: 0, expired: 0, expiredByJob: 0, expiredByReclaim: 0, released: 0,
  lateAccepted: 0, rejected: 0, submitted: 0, lost: 0, qaApproved: 0, qaRejected: 0, qaReview: 0, poolEmpty: 0,
});

function addEvent(r: LiveRates, event: string, by: string | null, revived: boolean, n: number) {
  switch (event) {
    case 'claimed': r.claims += n; break;
    case 'resumed': if (revived) r.revives += n; else r.resumes += n; break;
    case 'heartbeat': r.heartbeats += n; break;
    case 'expired': r.expired += n; if (by === 'reclaim') r.expiredByReclaim += n; else r.expiredByJob += n; break;
    case 'released': r.released += n; break;
    case 'late_accepted': r.lateAccepted += n; break;
    case 'rejected': r.rejected += n; break;
    case 'submitted': r.submitted += n; break;
    case 'lost': r.lost += n; break;
    case 'qa_approved': r.qaApproved += n; break;
    case 'qa_rejected': r.qaRejected += n; break;
    case 'qa_review': r.qaReview += n; break;
    case 'pool_empty': r.poolEmpty += n; break;
  }
}

/** Event counts since `since` (DB time), e.g. over a storm run. */
export async function eventCountsSince(since: Date): Promise<LiveRates> {
  const r = await pool().query(
    `SELECT event, detail->>'by' AS by, coalesce(detail->>'revived' = 'true', false) AS revived, count(*)::int AS n
     FROM claim_events WHERE at >= $1 GROUP BY 1, 2, 3`,
    [since],
  );
  const out = emptyRates();
  for (const row of r.rows) addEvent(out, row.event, row.by, row.revived, row.n);
  return out;
}

export type Live = LiveInvariant & {
  dbNow: Date;
  liveLeases: number;
  /** event counts over the last `rateWindowSeconds` */
  rates: LiveRates;
  rateWindowSeconds: number;
  /** claims and expiries per bucket, oldest first; the last bucket is the current (partial) one */
  series: { bucketSeconds: number; claims: number[]; expired: number[] };
  queryMs: number;
};

/** Everything the Live card shows, in three small parallel queries. */
export async function live(windowMinutes = 30): Promise<Live> {
  const t = performance.now();
  const BUCKET = 5, BUCKETS = 36, RATE = 60; // 3 min of 5 s buckets; rates over the last 60 s
  const [inv, ev, now] = await Promise.all([
    liveInvariant(windowMinutes),
    pool().query(
      `SELECT floor(EXTRACT(EPOCH FROM (now() - at)) / $2)::int AS b, event, detail->>'by' AS by,
              coalesce(detail->>'revived' = 'true', false) AS revived, count(*)::int AS n
       FROM claim_events WHERE at > now() - make_interval(secs => $1)
       GROUP BY 1, 2, 3, 4`,
      [BUCKET * BUCKETS, BUCKET],
    ),
    pool().query(
      `SELECT now() AS now, (SELECT count(*) FROM scripts WHERE status = 'claimed' AND lease_expires_at > now())::int AS live`,
    ),
  ]);
  const rates = emptyRates();
  const claims = new Array<number>(BUCKETS).fill(0);
  const expired = new Array<number>(BUCKETS).fill(0);
  for (const row of ev.rows) {
    const b = Math.min(BUCKETS - 1, Math.max(0, row.b)); // b = buckets ago (0 = current)
    if (row.event === 'claimed') claims[BUCKETS - 1 - b] += row.n;
    if (row.event === 'expired') expired[BUCKETS - 1 - b] += row.n;
    if (row.b * BUCKET < RATE) addEvent(rates, row.event, row.by, row.revived, row.n);
  }
  return {
    ...inv,
    dbNow: now.rows[0].now,
    liveLeases: now.rows[0].live,
    rates,
    rateWindowSeconds: RATE,
    series: { bucketSeconds: BUCKET, claims, expired },
    queryMs: Math.round((performance.now() - t) * 10) / 10,
  };
}
