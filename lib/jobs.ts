// The periodic job (every 5 min in prod). Correctness never depends on it:
// the claim query already treats expired leases as free. This is cleanup, stats and alerts.
import { pool } from './db';
import { config } from './config';
import { listObjects } from './storage';
import { logEvent } from './assign';

/** 1. Release expired leases. Keeps prev_token so a stalled contributor can still submit late. */
export async function cleanupExpired(): Promise<number> {
  // SKIP LOCKED: a row a claim is taking right now is the claim's; skip it. Locking expired rows in a
  // plain multi-row UPDATE deadlocked with claims (the claim waits on the job's pending index entry for
  // the same contributor while the job waits on the row the claim picked).
  const r = await pool().query(
    `WITH expired AS (
       SELECT id FROM scripts
       WHERE status = 'claimed' AND lease_expires_at <= now()
       FOR UPDATE SKIP LOCKED
     )
     UPDATE scripts s
     SET status = 'available', prev_token = s.claim_token, prev_claimed_by = s.claimed_by,
         claimed_by = NULL, claim_token = NULL, lease_expires_at = NULL
     FROM expired
     WHERE s.id = expired.id AND s.status = 'claimed' AND s.lease_expires_at <= now()
     RETURNING s.id, s.language, s.prev_token, s.prev_claimed_by`,
  );
  for (const row of r.rows) {
    await logEvent(pool(), { scriptId: row.id, contributorId: row.prev_claimed_by, token: row.prev_token, event: 'expired', language: row.language, detail: { by: 'job' } });
  }
  return r.rowCount ?? 0;
}

export type PoolRow = {
  language: string;
  available: number;
  claimed: number;
  submitted: number;
  approved: number;
  claimsLastWindow: number;
  /** available / (claims per hour over the forecast window); null if no recent claims */
  hoursLeft: number | null;
};

/** Current pool per language + the run-out forecast. Read-only (the /stats page uses it too). */
export async function poolSnapshot(): Promise<PoolRow[]> {
  const windowS = config.forecastWindowSeconds();
  const r = await pool().query(
    `WITH counts AS (
       SELECT language,
         count(*) FILTER (WHERE status = 'available' OR (status = 'claimed' AND lease_expires_at <= now())) AS available,
         count(*) FILTER (WHERE status = 'claimed' AND lease_expires_at > now()) AS claimed,
         count(*) FILTER (WHERE status = 'submitted') AS submitted,
         count(*) FILTER (WHERE status = 'approved') AS approved
       FROM scripts GROUP BY language
     ), rate AS (
       SELECT language, count(*) AS claims
       FROM claim_events
       WHERE event = 'claimed' AND at > now() - make_interval(secs => $1)
       GROUP BY language
     )
     SELECT c.*, coalesce(r.claims, 0) AS claims_last_window
     FROM counts c LEFT JOIN rate r USING (language)
     ORDER BY c.language`,
    [windowS],
  );
  return r.rows.map((row) => {
    const claims = Number(row.claims_last_window);
    const perHour = claims / (windowS / 3600);
    return {
      language: row.language,
      available: Number(row.available),
      claimed: Number(row.claimed),
      submitted: Number(row.submitted),
      approved: Number(row.approved),
      claimsLastWindow: claims,
      hoursLeft: perHour > 0 ? Number(row.available) / perHour : null,
    };
  });
}

/** 2 + 3. Write pool_stats; alert on languages that will run dry soon (or already have). */
export async function statsAndAlerts(): Promise<{ rows: PoolRow[]; alerts: string[] }> {
  const rows = await poolSnapshot();
  const alerts: string[] = [];
  for (const p of rows) {
    await pool().query(
      `INSERT INTO pool_stats (language, available, claimed, submitted, approved, claims_last_window, hours_left)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [p.language, p.available, p.claimed, p.submitted, p.approved, p.claimsLastWindow, p.hoursLeft],
    );
    let kind: string | null = null;
    let msg = '';
    if (p.available === 0) {
      kind = 'pool_empty';
      msg = `${p.language}: no scripts available`;
    } else if (p.hoursLeft !== null && p.hoursLeft < config.lowPoolAlertHours()) {
      kind = 'low_pool';
      msg = `${p.language}: ~${p.hoursLeft.toFixed(1)} h of scripts left at the current claim rate (${p.available} available)`;
    }
    if (kind) {
      alerts.push(msg);
      await pool().query(
        `INSERT INTO alerts (kind, language, message, detail) VALUES ($1, $2, $3, $4)`,
        [kind, p.language, msg, JSON.stringify(p)],
      );
    }
  }
  return { rows, alerts };
}

/** 4. Objects in storage with no recordings row, older than ORPHAN_AGE_SECONDS (prod: lifecycle rule). */
export async function findOrphans(): Promise<string[]> {
  const cutoff = Date.now() - config.orphanAgeSeconds() * 1000;
  const objs = (await listObjects('recordings/')).filter((o) => o.lastModified.getTime() < cutoff);
  if (!objs.length) return [];
  const known = await pool().query('SELECT s3_key FROM recordings WHERE s3_key = ANY($1)', [objs.map((o) => o.key)]);
  const have = new Set(known.rows.map((r) => r.s3_key));
  const orphans = objs.map((o) => o.key).filter((k) => !have.has(k));
  if (orphans.length) {
    await pool().query(`INSERT INTO alerts (kind, message, detail) VALUES ('orphans', $1, $2)`,
      [`${orphans.length} uploaded objects with no recording`, JSON.stringify({ keys: orphans.slice(0, 100) })]);
  }
  return orphans;
}

export type Abandoner = { contributorId: number; claims: number; abandoned: number; rate: number };

/** 5. Contributors who let leases expire a lot (prod: cool-down). Window and threshold are parameters. */
export async function abandonmentRates(windowSeconds = 86400, minClaims = 3): Promise<Abandoner[]> {
  const r = await pool().query(
    `SELECT contributor_id,
       count(*) FILTER (WHERE event = 'claimed') AS claims,
       count(*) FILTER (WHERE event IN ('expired','released')) AS abandoned
     FROM claim_events
     WHERE at > now() - make_interval(secs => $1) AND contributor_id IS NOT NULL
     GROUP BY contributor_id
     HAVING count(*) FILTER (WHERE event = 'claimed') >= $2
     ORDER BY 3 DESC`,
    [windowSeconds, minClaims],
  );
  return r.rows.map((row) => ({
    contributorId: row.contributor_id,
    claims: Number(row.claims),
    abandoned: Number(row.abandoned),
    rate: Number(row.abandoned) / Number(row.claims),
  }));
}

export async function runJob(opts: { abandonThreshold?: number } = {}) {
  const expired = await cleanupExpired();
  const { rows, alerts } = await statsAndAlerts();
  const orphans = await findOrphans();
  const abusers = (await abandonmentRates()).filter((a) => a.rate > (opts.abandonThreshold ?? 0.5));
  for (const a of abusers) {
    await pool().query(`INSERT INTO alerts (kind, message, detail) VALUES ('abandonment', $1, $2)`,
      [`contributor ${a.contributorId} abandoned ${a.abandoned}/${a.claims} claims`, JSON.stringify(a)]);
  }
  return { expired, pools: rows.length, alerts, orphans: orphans.length, abandoners: abusers.length };
}
