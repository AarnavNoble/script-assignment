// Invariant checker + metrics for a simulation run. Reads claim_events / recordings / scripts / pool_stats
// from the DB and joins on the simulator's own session log (sessions.jsonl) when present.
//
//   npm run check -- [--out results] [--run results] [--db postgres://.../sa_sim] [--no-plot]
//
// Writes results.md + CSVs into --out, and pool_over_time.png via sim/plot_pool.py.
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { Pool } from 'pg';
import type { SessionRecord } from './lib/behaviors';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const POPULAR = ['en', 'es', 'hi', 'pt']; // same as db/seed.ts POPULAR (not imported to keep this file DB-agnostic)

export type CheckOptions = {
  databaseUrl: string;
  outDir: string;           // where results.md + CSVs go
  runDir?: string;          // where run.json + sessions.jsonl + latencies.csv are (default: outDir)
  plot: boolean;
  write: boolean;           // false: compute only (for experiments)
  scale?: number;           // override when there is no run.json
  t0?: string;
  payCentsPerHour?: number;
  quiet?: boolean;
};

export type Stat = { n: number; mean: number | null; p50: number | null; p95: number | null; max: number | null };

export type CheckResult = {
  handedOutTwice: number;
  handedOutTwiceExamples: unknown[];
  rawTimestampOverlaps: number;
  releaseLogSkew: { n: number; maxMs: number; claimInsertedAfterRelease: number };
  lateAcceptAfterReclaim: number;
  recordedTwice: number;
  consistencyIssues: Record<string, number>;
  intervals: number;
  recovery: {
    vanish: { n: number; censored: number; claimable: Stat; reclaimed: Stat; idleScriptMinutes: number; ownerReturned: number; vanishedTotal: number };
    polite: { n: number; censored: number; claimable: Stat; reclaimed: Stat };
  };
  late: {
    accepted: number; rejected: number; minutesLost: number; dollarsLost: number;
    byGroup: Record<string, { accepted: number; rejected: number }>;
    falseExpiries: number; // sessions that were alive (stalled, not gone) and lost their recording
    liveLeaseLost: number; // heartbeating sessions that got 409 unexpectedly
    resumedThenLost: number; // of those: resumed an old lease with < 1 heartbeat interval left, lost it before the first heartbeat
    resumedSessions: number; // sessions whose first claim returned 'resumed' (owner came back to a live lease)
  };
  pool: {
    runOut: { language: string; popular: boolean; firstEmptyMin: number | null; firstZeroSnapshotMin: number | null; scripts: number; doneAtEnd: number }[];
    emptyHits: number; contributorsHitEmpty: number; contributorsHitEmptyByLang: Record<string, number>;
  };
  throughput: {
    simMinutes: number; realSeconds: number; claims: number; claimsPerRealSec: number; claimsPerSimMin: number;
    peakClaimsPerSimMin: number; recordings: number; recordingsPerSimHour: number; audioHours: number; payoutDollars: number;
    nominalGB: number; uploadedGB: number; approvedHours: number;
  };
  qa: {
    byStatus: Record<string, number>; reasons: Record<string, Record<string, number>>; byAudioKind: Record<string, Record<string, number>>;
    approvedHours: number; approvedPayoutDollars: number; reviewHours: number; reviewPayoutDollars: number; rejectedHours: number;
    pending: number; decisionLagRealS: Stat; returnedToPool: number; returnedByLang: Record<string, number>; rerecordedScripts: number;
  };
  rejectedWithoutReclaim: number;
  behaviors: Record<string, number | string>;
  latency: { endpoint: string; n: number; p50: number; p95: number; p99: number; max: number; errors: number }[];
  run: Record<string, unknown> | null;
};

const pct = (sorted: number[], p: number) => sorted.length ? sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))] : null;
function stat(xs: number[]): Stat {
  const s = [...xs].sort((a, b) => a - b);
  return { n: s.length, mean: s.length ? s.reduce((a, b) => a + b, 0) / s.length : null, p50: pct(s, 50), p95: pct(s, 95), max: s.length ? s[s.length - 1] : null };
}
const f = (x: number | null | undefined, d = 2) => (x === null || x === undefined || !Number.isFinite(x) ? 'n/a' : x.toFixed(d));
const fi = (x: number) => x.toLocaleString('en-US');

export async function checkRun(partial: Partial<CheckOptions> = {}): Promise<CheckResult> {
  const o: CheckOptions = {
    databaseUrl: process.env.CHECK_DATABASE_URL || `${(process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/scripts').replace(/\/[^/]*$/, '')}/sa_sim`,
    outDir: 'results', plot: true, write: true, ...partial,
  };
  const outDir = resolve(ROOT, o.outDir);
  const runDir = resolve(ROOT, o.runDir ?? o.outDir);
  const runPath = join(runDir, 'run.json');
  const run = existsSync(runPath) ? JSON.parse(readFileSync(runPath, 'utf8')) : null;
  const sessions: SessionRecord[] = existsSync(join(runDir, 'sessions.jsonl'))
    ? readFileSync(join(runDir, 'sessions.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
    : [];
  // token -> the session that claimed it (first), and every session that used it (a returning contributor resumes it)
  const byToken = new Map<string, SessionRecord>();
  const sessionsOfToken = new Map<string, SessionRecord[]>();
  for (const s of sessions) if (s.token) {
    if (!byToken.has(s.token)) byToken.set(s.token, s);
    const l = sessionsOfToken.get(s.token) ?? [];
    l.push(s);
    sessionsOfToken.set(s.token, l);
  }
  // the session that uploaded audio for a token (a returning owner's session, if the first one vanished)
  const audioOf = (token: string) => sessionsOfToken.get(token)?.find((x) => x.audioKind) ?? undefined;

  const db = new Pool({ connectionString: o.databaseUrl, max: 4 });
  const q = async <T = any>(sql: string, params: unknown[] = []) => (await db.query(sql, params)).rows as T[];

  try {
    const scale: number = o.scale ?? run?.options?.scale ?? 1;
    const t0 = new Date(o.t0 ?? run?.t0 ?? (await q(`SELECT min(at) AS t FROM claim_events`))[0].t).getTime();
    const tArrEnd = run?.arrivalsEnd ? new Date(run.arrivalsEnd).getTime() : null;
    const tEnd = run?.end ? new Date(run.end).getTime() : new Date((await q(`SELECT max(at) AS t FROM claim_events`))[0].t).getTime();
    const simMin = (t: Date | string | number) => ((new Date(t).getTime() - t0) / 1000) * scale / 60;
    const simDur = (a: Date | string, b: Date | string) => ((new Date(b).getTime() - new Date(a).getTime()) / 1000) * scale / 60;
    const payCents = o.payCentsPerHour ?? 500;

    // ---------- 1. handed out twice ----------
    // Each token's live interval: [claimed at, latest lease_expires_at it was given (claimed / heartbeat /
    // resumed)], cut short by its last release / submit unless a revive ('resumed' with detail.revived)
    // came after it. A revived token can have a gap where it was expired or released; the interval spans
    // the gap on purpose: a revive is only possible while the row still carries this token (as claim_token
    // or prev_token), and any other claim in between would have replaced it, so another token inside the
    // gap is a violation too. Two different tokens' intervals on one script must never overlap.
    const ivSql = `
      WITH tok AS (
        SELECT script_id, claim_token,
          min(at) FILTER (WHERE event = 'claimed') AS start,
          -- lease end as of the token's latest lease-setting event. A soft release (lib/assign.ts release(),
          -- 'released' with lease_expires_at = now() + grace) shortens it; a later heartbeat/resume extends it.
          (array_agg(lease_expires_at ORDER BY id DESC) FILTER (WHERE event IN ('claimed','heartbeat','resumed','released') AND lease_expires_at IS NOT NULL))[1] AS lease_end,
          -- a hard release (older code: 'released' without lease_expires_at) freed the row at once, so it cuts the interval
          max(at) FILTER (WHERE event IN ('submitted','late_accepted') OR (event = 'released' AND lease_expires_at IS NULL)) AS last_cut,
          max(at) FILTER (WHERE event = 'resumed' AND detail->>'revived' = 'true') AS last_revived,
          max(at) FILTER (WHERE event = 'released') AS released,
          max(id) FILTER (WHERE event = 'released') AS released_id,
          min(id) FILTER (WHERE event = 'claimed') AS claimed_id
        FROM claim_events
        WHERE script_id IS NOT NULL AND claim_token IS NOT NULL
        GROUP BY script_id, claim_token
      )
      SELECT script_id, claim_token, start,
        CASE WHEN last_cut IS NOT NULL AND (last_revived IS NULL OR last_cut > last_revived)
             THEN LEAST(lease_end, last_cut) ELSE lease_end END AS stop,
        released, released_id, claimed_id
      FROM tok WHERE start IS NOT NULL`;
    const intervals = Number((await q(`SELECT count(*) AS n FROM (${ivSql}) x`))[0].n);
    // e = the earlier lease, l = the later one
    const rawOverlaps = await q(`
      WITH iv AS (${ivSql})
      SELECT e.script_id, e.claim_token AS earlier_token, e.start AS earlier_start, e.stop AS earlier_stop,
             e.released AS earlier_released, e.released_id AS earlier_released_event_id, l.claimed_id AS later_claimed_event_id,
             l.claim_token AS later_token, l.start AS later_start, l.stop AS later_stop,
             EXTRACT(EPOCH FROM (LEAST(e.stop, l.stop) - GREATEST(e.start, l.start)))::float8 AS overlap_s,
             (e.released IS NOT NULL AND e.stop = e.released) AS release_log_skew,
             (l.claimed_id > e.released_id) AS claim_logged_after_release
      FROM iv e JOIN iv l ON e.script_id = l.script_id AND e.claim_token <> l.claim_token
       AND (e.start, e.claim_token) < (l.start, l.claim_token)
       AND e.start < l.stop AND l.start < e.stop
      ORDER BY e.script_id`);
    // release() is a compare-and-set on claim_token, committed in autocommit, and its 'released' event is
    // inserted by a separate statement afterwards (later now()); a 'claimed' event's at is its transaction
    // start, before the row is picked. A successful release proves the earlier token still owned the row
    // when the release ran, so a later claim can only have picked it after the release committed (picking
    // it earlier would have overwritten the token and made the release a no-op, with no 'released' event).
    // So an overlap that ends at a successful release is logging skew, not a double hand-out. A real double
    // hand-out leaves the earlier interval running to its lease end and is still counted.
    const skew = rawOverlaps.filter((x) => x.release_log_skew);
    const overlaps = rawOverlaps.filter((x) => !x.release_log_skew);
    // a late submit is only OK if nobody else claimed the script in between
    const lateAfterReclaim = await q(`
      WITH la AS (
        SELECT e.script_id, e.claim_token, e.at,
          (SELECT max(lease_expires_at) FROM claim_events h
            WHERE h.script_id = e.script_id AND h.claim_token = e.claim_token AND h.event IN ('claimed','heartbeat','resumed')
              AND h.at <= e.at) AS lease_end
        FROM claim_events e WHERE e.event = 'late_accepted'
      )
      SELECT la.script_id, la.claim_token, la.at, c.claim_token AS other_token, c.at AS other_claimed_at
      FROM la JOIN claim_events c ON c.script_id = la.script_id AND c.event = 'claimed'
        AND c.claim_token <> la.claim_token AND c.at >= la.lease_end AND c.at <= la.at`);
    // the converse: a late submit may only be rejected if someone else did claim the script after this token
    const rejectedWithoutReclaim = await q(`
      SELECT e.script_id, e.claim_token, e.at
      FROM claim_events e
      WHERE e.event = 'rejected' AND e.script_id IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM claim_events c
          WHERE c.script_id = e.script_id AND c.event = 'claimed' AND c.claim_token <> e.claim_token AND c.at <= e.at
            AND c.at >= (SELECT min(at) FROM claim_events m WHERE m.script_id = e.script_id AND m.claim_token = e.claim_token AND m.event = 'claimed'))`);

    // ---------- 2. recorded twice + consistency ----------
    const recordedTwice = Number((await q(`
      SELECT count(*) AS n FROM (SELECT script_id FROM recordings WHERE status <> 'rejected' GROUP BY script_id HAVING count(*) > 1) x`))[0].n);
    const consistency = (await q(`
      SELECT
        (SELECT count(*) FROM recordings r JOIN scripts s ON s.id = r.script_id
          WHERE r.status <> 'rejected' AND s.status NOT IN ('submitted','approved')) AS live_recording_on_unsubmitted_script,
        (SELECT count(*) FROM scripts s WHERE s.status IN ('submitted','approved')
          AND NOT EXISTS (SELECT 1 FROM recordings r WHERE r.script_id = s.id AND r.status <> 'rejected')) AS submitted_script_without_recording,
        (SELECT count(*) FROM recordings r WHERE NOT EXISTS (
          SELECT 1 FROM claim_events e WHERE e.claim_token = r.claim_token AND e.event = 'claimed' AND e.script_id = r.script_id)) AS recording_token_not_claimed_for_script,
        (SELECT count(*) FROM (SELECT claim_token FROM claim_events WHERE event = 'claimed' GROUP BY claim_token HAVING count(*) > 1) x) AS token_claimed_twice
    `))[0];
    const consistencyIssues: Record<string, number> = Object.fromEntries(Object.entries(consistency).map(([k, v]) => [k, Number(v)]));

    // ---------- per-token facts (3, 4) ----------
    type Tok = {
      claim_token: string; script_id: number; language: string; contributor_id: number; claimed_at: Date; last_alive: Date; lease_end: Date;
      released_at: Date | null; release_lease_end: Date | null; submitted_at: Date | null; rejected_at: Date | null; late_ok: boolean; next_claim: Date | null;
    };
    const toks = await q<Tok>(`
      WITH tok AS (
        SELECT claim_token, min(script_id) AS script_id, min(language) AS language, min(contributor_id) AS contributor_id,
          min(at) FILTER (WHERE event = 'claimed') AS claimed_at,
          max(at) FILTER (WHERE event IN ('claimed','heartbeat','resumed')) AS last_alive,
          max(lease_expires_at) FILTER (WHERE event IN ('claimed','heartbeat','resumed')) AS lease_end,
          min(at) FILTER (WHERE event = 'released') AS released_at,
          -- soft release: the shortened lease end it set (NULL for an older hard release = free at once)
          (array_agg(lease_expires_at ORDER BY id) FILTER (WHERE event = 'released'))[1] AS release_lease_end,
          min(at) FILTER (WHERE event IN ('submitted','late_accepted')) AS submitted_at,
          min(at) FILTER (WHERE event = 'rejected') AS rejected_at,
          bool_or(event = 'late_accepted') AS late_ok
        FROM claim_events WHERE claim_token IS NOT NULL GROUP BY claim_token
      )
      SELECT t.*, (SELECT min(c.at) FROM claim_events c
                   WHERE c.script_id = t.script_id AND c.event = 'claimed' AND c.at > t.claimed_at AND c.claim_token <> t.claim_token) AS next_claim
      FROM tok t WHERE t.claimed_at IS NOT NULL`);

    // 3. recovery
    // A vanished lease is "abandoned" unless the same contributor came back while it was still live and
    // resumed it (a later session of theirs got the same token). Recovery stats are over abandoned ones.
    const vanishedAll = toks.filter((t) => {
      const s = byToken.get(t.claim_token);
      if (sessions.length) return s?.behavior === 'vanish' && s.outcome === 'vanished';
      return !t.released_at && !t.submitted_at && !t.rejected_at; // no session log: anything abandoned
    });
    const ownerReturned = vanishedAll.filter((t) => (sessionsOfToken.get(t.claim_token)?.length ?? 0) > 1);
    const vanished = vanishedAll.filter((t) => (sessionsOfToken.get(t.claim_token)?.length ?? 0) <= 1);
    const resumedThenLost = sessions.filter((s) => s.outcome === 'lost' && s.claimStatus === 'resumed' && !s.heartbeatsOk);
    const politeAll = toks.filter((t) => t.released_at && (!sessions.length || byToken.get(t.claim_token)?.behavior === 'polite_release'));
    // since release keeps the token as prev_token, the same contributor coming back revives it: not a recovery
    const polite = politeAll.filter((t) => (sessionsOfToken.get(t.claim_token)?.length ?? 0) <= 1);
    const recoveryRows: string[] = ['kind,token,script_id,language,last_alive_sim_min,claimable_after_min,reclaimed_after_min'];
    const vClaim: number[] = [], vRe: number[] = [], pClaim: number[] = [], pRe: number[] = [];
    let vCens = 0, pCens = 0, idle = 0;
    const censorAt = new Date(tEnd);
    for (const t of vanished) {
      const c = simDur(t.last_alive, t.lease_end);
      vClaim.push(c);
      if (t.next_claim) { const r = simDur(t.last_alive, t.next_claim); vRe.push(r); idle += r; } else { vCens++; idle += simDur(t.last_alive, censorAt); }
      recoveryRows.push(`vanish,${t.claim_token},${t.script_id},${t.language},${f(simMin(t.last_alive))},${f(c)},${t.next_claim ? f(simDur(t.last_alive, t.next_claim)) : ''}`);
    }
    for (const t of polite) {
      // soft release: claimable when the grace lease ends; older hard release: at once
      const c = t.release_lease_end ? Math.max(0, simDur(t.released_at!, t.release_lease_end)) : 0;
      pClaim.push(c);
      if (t.next_claim) pRe.push(simDur(t.released_at!, t.next_claim)); else pCens++;
      recoveryRows.push(`polite,${t.claim_token},${t.script_id},${t.language},${f(simMin(t.released_at!))},${f(c)},${t.next_claim ? f(simDur(t.released_at!, t.next_claim)) : ''}`);
    }

    // 4. late submits: submits that arrived after the token's lease had ended
    const lateRows: string[] = ['token,language,behavior,claimed_sim_min,lease_end_sim_min,verdict,verdict_sim_min,session_minutes'];
    let accepted = 0, rejected = 0, minutesLost = 0;
    const byGroup: Record<string, { accepted: number; rejected: number }> = { popular: { accepted: 0, rejected: 0 }, tail: { accepted: 0, rejected: 0 } };
    for (const t of toks) {
      const g = POPULAR.includes(t.language) ? 'popular' : 'tail';
      if (t.late_ok) {
        accepted++; byGroup[g].accepted++;
        lateRows.push(`${t.claim_token},${t.language},${byToken.get(t.claim_token)?.behavior ?? ''},${f(simMin(t.claimed_at))},${f(simMin(t.lease_end))},late_accepted,${f(simMin(t.submitted_at!))},${f(simDur(t.claimed_at, t.submitted_at!))}`);
      } else if (t.rejected_at && !t.submitted_at) {
        rejected++; byGroup[g].rejected++;
        const lost = simDur(t.claimed_at, t.rejected_at);
        minutesLost += lost;
        lateRows.push(`${t.claim_token},${t.language},${byToken.get(t.claim_token)?.behavior ?? ''},${f(simMin(t.claimed_at))},${f(simMin(t.lease_end))},rejected,${f(simMin(t.rejected_at))},${f(lost)}`);
      }
    }
    const falseExpiries = sessions.filter((s) => s.outcome === 'rejected').length;
    const liveLeaseLost = sessions.filter((s) => s.outcome === 'lost').length;
    const resumedSessions = sessions.filter((s) => s.claimStatus === 'resumed').length;

    // ---------- 5. pool ----------
    const ps = await q(`SELECT at, language, available, claimed, submitted, approved, claims_last_window, hours_left FROM pool_stats ORDER BY at, language`);
    const poolRows = ['sim_min,language,popular,available,claimed,submitted,approved,claims_last_window,hours_left_sim'];
    for (const r of ps) {
      poolRows.push(`${f(simMin(r.at), 1)},${r.language},${POPULAR.includes(r.language) ? 1 : 0},${r.available},${r.claimed},${r.submitted},${r.approved},${r.claims_last_window},${r.hours_left === null ? '' : f(Number(r.hours_left) * scale, 3)}`);
    }
    const firstEmpty = new Map((await q(`SELECT language, min(at) AS at FROM claim_events WHERE event = 'pool_empty' GROUP BY language`)).map((r) => [r.language, r.at]));
    const firstZero = new Map((await q(`SELECT language, min(at) AS at FROM pool_stats WHERE available = 0 GROUP BY language`)).map((r) => [r.language, r.at]));
    const perLang = await q(`SELECT language, count(*) AS scripts, count(*) FILTER (WHERE status IN ('submitted','approved')) AS done FROM scripts GROUP BY language ORDER BY language`);
    const order = (l: string) => (POPULAR.includes(l) ? POPULAR.indexOf(l) : 100) ;
    const runOut = perLang
      .map((r) => ({
        language: r.language as string, popular: POPULAR.includes(r.language),
        firstEmptyMin: firstEmpty.has(r.language) ? simMin(firstEmpty.get(r.language)) : null,
        firstZeroSnapshotMin: firstZero.has(r.language) ? simMin(firstZero.get(r.language)) : null,
        scripts: Number(r.scripts), doneAtEnd: Number(r.done),
      }))
      .sort((a, b) => order(a.language) - order(b.language) || a.language.localeCompare(b.language));
    const empties = await q(`SELECT language, count(*) AS hits, count(DISTINCT contributor_id) AS who FROM claim_events WHERE event = 'pool_empty' GROUP BY language`);
    const emptyHits = empties.reduce((s, r) => s + Number(r.hits), 0);
    const contributorsHitEmpty = Number((await q(`SELECT count(DISTINCT contributor_id) AS n FROM claim_events WHERE event = 'pool_empty'`))[0].n);
    const contributorsHitEmptyByLang = Object.fromEntries(empties.map((r) => [r.language, Number(r.who)]));

    // ---------- QA (lib/qa.ts verdicts) ----------
    const qaStatus = Object.fromEntries((await q(`SELECT status, count(*) AS n FROM recordings GROUP BY status`)).map((r) => [r.status, Number(r.n)]));
    const reasonCounts: Record<string, Record<string, number>> = { rejected: {}, needs_review: {} };
    for (const r of await q(`SELECT status, review_note FROM recordings WHERE status IN ('rejected','needs_review')`)) {
      const reasons = String(r.review_note ?? 'none').split(/\s*\|\s*|,/).map((x: string) => x.trim()).filter(Boolean);
      for (const x of reasons.length ? reasons : ['none']) reasonCounts[r.status][x] = (reasonCounts[r.status][x] ?? 0) + 1;
    }
    // verdict by the kind of audio the simulator uploaded: shows QA catches the defects it should
    const byKind: Record<string, Record<string, number>> = {};
    for (const r of await q(`SELECT claim_token, status FROM recordings`)) {
      const k = audioOf(r.claim_token)?.audioKind ?? 'unknown';
      byKind[k] ??= {};
      byKind[k][r.status] = (byKind[k][r.status] ?? 0) + 1;
    }
    const money = (await q(`
      SELECT
        coalesce(sum(duration_s) FILTER (WHERE status IN ('approved','paid')), 0)::float8 AS approved_s,
        coalesce(sum(est_pay_cents) FILTER (WHERE status IN ('approved','paid')), 0)::float8 AS approved_cents,
        coalesce(sum(duration_s) FILTER (WHERE status = 'needs_review'), 0)::float8 AS review_s,
        coalesce(sum(est_pay_cents) FILTER (WHERE status = 'needs_review'), 0)::float8 AS review_cents,
        coalesce(sum(duration_s) FILTER (WHERE status = 'rejected'), 0)::float8 AS rejected_s,
        count(*) FILTER (WHERE status = 'pending_checks') AS pending
      FROM recordings`))[0];
    // time from submit to the QA decision (real seconds; QA runs at wall-clock speed, not scaled)
    const qaLagS = (await q(`
      SELECT EXTRACT(EPOCH FROM (min(e.at) - r.created_at))::float8 AS s
      FROM recordings r JOIN claim_events e ON e.claim_token = r.claim_token AND e.script_id = r.script_id
        AND e.event IN ('qa_approved','qa_rejected','qa_review')
      GROUP BY r.id, r.created_at`)).map((r) => Number(r.s));
    const qaReturned = await q(`SELECT language, count(*) AS n FROM claim_events WHERE event IN ('qa_rejected','review_rejected') GROUP BY language`);
    const qaReturnedByLang: Record<string, number> = Object.fromEntries(qaReturned.map((r) => [r.language, Number(r.n)]));
    const rerecorded = Number((await q(`
      SELECT count(DISTINCT r.script_id) AS n FROM recordings r
      WHERE r.status = 'rejected' AND EXISTS (SELECT 1 FROM recordings x WHERE x.script_id = r.script_id AND x.id > r.id)`))[0].n);
    const qa = {
      byStatus: qaStatus, reasons: reasonCounts, byAudioKind: byKind,
      approvedHours: Number(money.approved_s) / 3600, approvedPayoutDollars: Number(money.approved_cents) / 100,
      reviewHours: Number(money.review_s) / 3600, reviewPayoutDollars: Number(money.review_cents) / 100,
      rejectedHours: Number(money.rejected_s) / 3600, pending: Number(money.pending),
      decisionLagRealS: stat(qaLagS), returnedToPool: qaReturned.reduce((a, r) => a + Number(r.n), 0), returnedByLang: qaReturnedByLang,
      rerecordedScripts: rerecorded,
    };

    // ---------- 6. throughput (over the arrivals window) ----------
    const winEnd = tArrEnd ?? tEnd;
    const simMinutes = ((winEnd - t0) / 1000) * scale / 60;
    const realSeconds = (winEnd - t0) / 1000;
    const claims = Number((await q(`SELECT count(*) AS n FROM claim_events WHERE event = 'claimed' AND at >= $1 AND at < $2`, [new Date(t0), new Date(winEnd)]))[0].n);
    const per5 = await q(`SELECT floor(EXTRACT(EPOCH FROM (at - $1::timestamptz)) * $2 / 60 / 5) AS b, count(*) AS n
      FROM claim_events WHERE event = 'claimed' AND at >= $1 AND at < $3 GROUP BY 1`, [new Date(t0), scale, new Date(winEnd)]);
    const peakClaimsPerSimMin = per5.reduce((m, r) => Math.max(m, Number(r.n) / 5), 0);
    const recs = await q(`SELECT r.claim_token, r.size_bytes, r.created_at, s.language FROM recordings r JOIN scripts s ON s.id = r.script_id WHERE r.status <> 'rejected'`);
    const sr = Number(run?.options?.audioSampleRate ?? 1000);
    let audioS = 0, nominal = 0, uploaded = 0;
    for (const r of recs) {
      const s = audioOf(r.claim_token);
      const d = s?.audioDurationS ?? (Number(r.size_bytes) - 44) / (2 * sr);
      audioS += d;
      nominal += s?.nominalBytes ?? 44 + d * 48000 * 2;
      uploaded += Number(r.size_bytes);
    }
    const recsInWindow = recs.filter((r) => new Date(r.created_at).getTime() < winEnd).length;
    const byHour = new Map<number, { recordings: number; approved: number; approvedS: number; cents: number }>();
    for (const r of await q(`SELECT created_at, status, duration_s, est_pay_cents FROM recordings`)) {
      const h = Math.floor(simMin(r.created_at) / 60);
      const e = byHour.get(h) ?? { recordings: 0, approved: 0, approvedS: 0, cents: 0 };
      e.recordings++;
      if (r.status === 'approved' || r.status === 'paid') { e.approved++; e.approvedS += Number(r.duration_s ?? 0); e.cents += Number(r.est_pay_cents ?? 0); }
      byHour.set(h, e);
    }
    const audioHours = audioS / 3600;
    const throughput = {
      simMinutes, realSeconds, claims,
      claimsPerRealSec: claims / realSeconds,
      claimsPerSimMin: claims / simMinutes,
      peakClaimsPerSimMin,
      recordings: recs.length,
      recordingsPerSimHour: recsInWindow / (simMinutes / 60),
      audioHours, // submitted (not rejected), nominal take length
      payoutDollars: qa.approvedPayoutDollars, // from APPROVED recordings' est_pay_cents
      approvedHours: qa.approvedHours,
      nominalGB: nominal / 1e9,
      uploadedGB: uploaded / 1e9,
    };

    // ---------- session-level behavior checks ----------
    const of = (b: string) => sessions.filter((s) => s.behavior === b && s.claimStatus !== 'empty' && s.claimStatus !== 'error');
    const frac = (xs: SessionRecord[], p: (s: SessionRecord) => boolean) => `${xs.filter(p).length}/${xs.length}`;
    const refresh = of('refresh').filter((s) => s.resumeStatus !== undefined);
    const two = of('two_tabs').filter((s) => s.resumeStatus !== undefined);
    const dbl = of('double_submit').filter((s) => s.duplicateSubmits);
    const outcomes: Record<string, number> = {};
    for (const s of sessions) outcomes[s.outcome ?? 'none'] = (outcomes[s.outcome ?? 'none'] ?? 0) + 1;
    const behaviors: Record<string, number | string> = {
      sessions: sessions.length,
      refreshResumedSameScript: frac(refresh, (s) => !!s.resumeSameToken),
      twoTabsSameScript: frac(two, (s) => !!s.resumeSameToken),
      twoTabsSecondTabGot409AfterSubmit: frac(two.filter((s) => s.outcome === 'submitted'), (s) => s.tabBAfterSubmit === 409),
      doubleSubmitOneRecording: frac(dbl, (s) => !!s.doubleSubmitConsistent),
      sessionsWithErrors: sessions.filter((s) => s.errors?.length).length,
      ...Object.fromEntries(Object.entries(outcomes).map(([k, v]) => [`outcome_${k}`, v])),
    };

    // ---------- client-side latency ----------
    const latency: CheckResult['latency'] = [];
    const latPath = join(runDir, 'latencies.csv');
    if (existsSync(latPath)) {
      const by = new Map<string, { ms: number[]; errors: number }>();
      const lines = readFileSync(latPath, 'utf8').trim().split('\n').slice(1);
      for (const l of lines) {
        const [ep, st, ms] = l.split(',');
        const e = by.get(ep) ?? { ms: [], errors: 0 };
        e.ms.push(Number(ms));
        const s = Number(st);
        if (s === 0 || s >= 500) e.errors++;
        by.set(ep, e);
      }
      for (const [endpoint, e] of by) {
        const s = e.ms.sort((a, b) => a - b);
        latency.push({ endpoint, n: s.length, p50: pct(s, 50)!, p95: pct(s, 95)!, p99: pct(s, 99)!, max: s[s.length - 1], errors: e.errors });
      }
      latency.sort((a, b) => b.n - a.n);
    }

    const result: CheckResult = {
      handedOutTwice: overlaps.length,
      handedOutTwiceExamples: overlaps.slice(0, 10),
      rawTimestampOverlaps: rawOverlaps.length,
      releaseLogSkew: { n: skew.length, maxMs: skew.reduce((m, x) => Math.max(m, x.overlap_s * 1000), 0), claimInsertedAfterRelease: skew.filter((x) => x.claim_logged_after_release).length },
      lateAcceptAfterReclaim: lateAfterReclaim.length,
      rejectedWithoutReclaim: rejectedWithoutReclaim.length,
      qa,
      recordedTwice,
      consistencyIssues,
      intervals,
      recovery: {
        vanish: { n: vanished.length, censored: vCens, claimable: stat(vClaim), reclaimed: stat(vRe), idleScriptMinutes: idle, ownerReturned: ownerReturned.length, vanishedTotal: vanishedAll.length },
        polite: { n: polite.length, censored: pCens, claimable: stat(pClaim), reclaimed: stat(pRe) },
      },
      late: { accepted, rejected, minutesLost, dollarsLost: (minutesLost / 60) * (payCents / 100), byGroup, falseExpiries, liveLeaseLost, resumedThenLost: resumedThenLost.length, resumedSessions },
      pool: { runOut, emptyHits, contributorsHitEmpty, contributorsHitEmptyByLang },
      throughput, behaviors, latency, run,
    };

    if (o.write) {
      mkdirSync(outDir, { recursive: true });
      writeFileSync(join(outDir, 'pool_over_time.csv'), poolRows.join('\n') + '\n');
      writeFileSync(join(outDir, 'recovery.csv'), recoveryRows.join('\n') + '\n');
      writeFileSync(join(outDir, 'late_submits.csv'), lateRows.join('\n') + '\n');
      writeFileSync(join(outDir, 'runout.csv'), ['language,popular,scripts,recorded_at_end,first_empty_claim_sim_min,first_zero_snapshot_sim_min,contributors_hit_empty,qa_rejected_returned']
        .concat(runOut.map((r) => `${r.language},${r.popular ? 1 : 0},${r.scripts},${r.doneAtEnd},${f(r.firstEmptyMin, 1)},${f(r.firstZeroSnapshotMin, 1)},${contributorsHitEmptyByLang[r.language] ?? 0},${qaReturnedByLang[r.language] ?? 0}`)).join('\n') + '\n');
      writeFileSync(join(outDir, 'throughput_by_hour.csv'), ['sim_hour,recordings,approved,approved_audio_hours,approved_payout_dollars']
        .concat([...byHour.entries()].sort((a, b) => a[0] - b[0]).map(([h, e]) => `${h},${e.recordings},${e.approved},${f(e.approvedS / 3600, 3)},${f(e.cents / 100)}`)).join('\n') + '\n');
      if (latency.length) writeFileSync(join(outDir, 'latency_summary.csv'), ['endpoint,n,p50_ms,p95_ms,p99_ms,max_ms,errors']
        .concat(latency.map((l) => `${l.endpoint},${l.n},${f(l.p50)},${f(l.p95)},${f(l.p99)},${f(l.max)},${l.errors}`)).join('\n') + '\n');
      writeFileSync(join(outDir, 'overlaps.json'), JSON.stringify({ violations: overlaps, releaseLogSkew: skew, lateAfterReclaim, rejectedWithoutReclaim }, null, 2));
      writeFileSync(join(outDir, 'check.json'), JSON.stringify({ ...result, run: undefined }, null, 2));
      writeFileSync(join(outDir, 'results.md'), renderMarkdown(result, { scale, sessionsLogged: sessions.length > 0, byHour, payCents, lateAfterReclaim }));
      if (o.plot) {
        const p = spawnSync('python3', [join(ROOT, 'sim', 'plot_pool.py'), join(outDir, 'pool_over_time.csv'), join(outDir, 'runout.csv'), join(outDir, 'pool_over_time.png')], { encoding: 'utf8' });
        if (p.status !== 0) console.error('[check] plot failed:', p.stderr);
      }
    }
    if (!o.quiet) console.log(`[check] handed out twice: ${result.handedOutTwice}, recorded twice: ${result.recordedTwice}, late accept after reclaim: ${result.lateAcceptAfterReclaim} -> ${join(outDir, 'results.md')}`);
    return result;
  } finally {
    await db.end();
  }
}

function renderMarkdown(r: CheckResult, ctx: { scale: number; sessionsLogged: boolean; byHour: Map<number, { recordings: number; approved: number; approvedS: number; cents: number }>; payCents: number; lateAfterReclaim: unknown[] }): string {
  const o = (r.run?.options ?? {}) as Record<string, any>;
  const t = r.throughput;
  const v = r.recovery.vanish, p = r.recovery.polite;
  const pass = (n: number) => (n === 0 ? '**0 (pass)**' : `**${n} (FAIL)**`);
  const popOut = r.pool.runOut.filter((x) => x.popular);
  const ranOut = r.pool.runOut.filter((x) => x.firstEmptyMin !== null);
  const qa = r.qa;
  const qn = (k: string) => qa.byStatus[k] ?? 0;
  const qTotal = Object.values(qa.byStatus).reduce((a, b) => a + b, 0);
  const topReasons = (m: Record<string, number>) => Object.entries(m).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${fi(n)}`).join(', ') || 'none';
  const L: string[] = [];
  L.push('# Simulation results', '');
  L.push(`Generated by \`npm run sim\` + \`npm run check\` on ${new Date().toISOString().slice(0, 10)}. Every number below is measured from the run's database (\`claim_events\`, \`recordings\`, \`scripts\`, \`pool_stats\`) and the simulator's session log, not assumed.`, '');
  L.push('## Summary', '');
  L.push(`- **Setup:** ${o.online ?? '?'} contributors online (of ${o.contributors ?? '?'} registered), 16 languages x ${o.scriptsPerLanguage ?? '?'} scripts, ${f(t.simMinutes / 60, 1)} simulated hours against the real HTTP API (Next.js \`${(r.run as any)?.options?.server ?? '?'}\` + Postgres + MinIO). Time scale ${ctx.scale}x: lease ${o.leaseSeconds ?? '?'} s, heartbeat ${o.heartbeat === false ? 'OFF' : (o.heartbeatSeconds ?? '?') + ' s'}, job every ${o.jobIntervalSeconds ?? '?'} s (all simulated), claim order \`${o.claimOrder ?? 'fresh_first'}\`. Seed ${o.seed ?? '?'}.`);
  L.push(`- **Handed out twice:** ${pass(r.handedOutTwice)} overlapping leases across ${fi(r.intervals)} lease intervals${r.releaseLogSkew.n ? ` (${r.releaseLogSkew.n} raw timestamp overlaps of at most ${f(r.releaseLogSkew.maxMs, 1)} ms are a transaction-start timestamp artifact at releases, proven not to be double hand-outs; see section 1)` : ''}. **Recorded twice:** ${pass(r.recordedTwice)}. Late submit accepted after someone else re-claimed: ${pass(r.lateAcceptAfterReclaim)}; late submit rejected although nobody else claimed: ${pass(r.rejectedWithoutReclaim)}.`);
  L.push(`- **Vanished tabs:** script claimable again ${f(v.claimable.mean)} min after the last heartbeat on average (p95 ${f(v.claimable.p95)}), actually re-claimed after ${f(v.reclaimed.mean)} min (p95 ${f(v.reclaimed.p95)}; ${v.censored} of ${v.n} not re-claimed before the run ended). **Polite release** (soft: the lease is shortened to a grace period, so another open tab of the same contributor can keep it): claimable ${f(p.claimable.mean)} min after the release, re-claimed after ${f(p.reclaimed.mean)} min (p95 ${f(p.reclaimed.p95)}).`);
  L.push(`- **Late submits (network stall longer than the lease):** ${r.late.accepted} accepted, ${r.late.rejected} rejected because the script had been re-claimed; ${f(r.late.minutesLost, 0)} contributor-minutes lost = $${f(r.late.dollarsLost)} at $${ctx.payCents / 100}/h.`);
  L.push(`- **Pool:** ${ranOut.length ? ranOut.map((x) => `${x.language} ran out at ${f(x.firstEmptyMin! / 60, 2)} h`).join(', ') : 'no language ran out'}; ${fi(r.pool.contributorsHitEmpty)} distinct contributors hit "empty" (${fi(r.pool.emptyHits)} empty responses). ${r.pool.runOut.filter((x) => !x.popular && x.firstEmptyMin === null).length} of ${r.pool.runOut.filter((x) => !x.popular).length} long-tail languages never ran out.`);
  L.push(`- **QA (lib/qa.ts, run during the sim):** of ${fi(qTotal)} submitted takes, ${fi(qn('approved') + qn('paid'))} approved, ${fi(qn('rejected'))} rejected (${topReasons(qa.reasons.rejected)}), ${fi(qn('needs_review'))} sent to human review${qn('needs_review') ? ` (${topReasons(qa.reasons.needs_review)})` : ''}, ${fi(qa.pending)} still pending. ${fi(qa.returnedToPool)} rejected scripts went back into the pool (${fi(qa.rerecordedScripts)} were recorded again before the end).`);
  L.push(`- **Throughput:** ${f(t.claimsPerRealSec, 1)} claims/s real (${f(t.claimsPerSimMin, 1)} per simulated minute, peak ${f(t.peakClaimsPerSimMin, 1)}), ${fi(Math.round(t.recordingsPerSimHour))} submitted recordings per simulated hour. **${f(qa.approvedHours, 1)} approved audio hours = $${fi(Math.round(qa.approvedPayoutDollars))}** payout at $${ctx.payCents / 100}/approved hour (from approved recordings' \`est_pay_cents\`)${qn('needs_review') ? `; another ${f(qa.reviewHours, 1)} h ($${fi(Math.round(qa.reviewPayoutDollars))}) awaits human review` : ''}.`);
  L.push('');

  L.push('## 1. Handed out twice', '');
  L.push('For every claim token: live interval = [`claimed` at, latest `lease_expires_at` from its `claimed` / `heartbeat` / `resumed` events], cut short at its last `released` / `submitted` / `late_accepted` unless the token was revived afterwards (`resumed` with `detail.revived`). A revived token\'s interval spans the gap when it was expired or released: a revive only works while the row still carries that token, so another claim inside the gap would also be a violation. Any two different tokens whose intervals overlap on the same script is a violation. Timestamps are Postgres `now()` (microseconds), compared in SQL.', '');
  L.push(`| Check | Result |`, `|---|---|`);
  L.push(`| Lease intervals checked | ${fi(r.intervals)} |`);
  L.push(`| Overlapping intervals, raw timestamps | ${fi(r.rawTimestampOverlaps)} |`);
  L.push(`| ... of which timestamp skew at releases (explained below, not double hand-outs) | ${fi(r.releaseLogSkew.n)} (max ${f(r.releaseLogSkew.maxMs, 1)} ms real) |`);
  L.push(`| **Overlapping leases (double hand-outs)** | ${pass(r.handedOutTwice)} |`);
  L.push(`| Late submit accepted after another token claimed the script | ${pass(r.lateAcceptAfterReclaim)} |`);
  L.push(`| Late submit rejected although no other token had claimed the script | ${pass(r.rejectedWithoutReclaim)} |`);
  for (const [k, n] of Object.entries(r.consistencyIssues)) L.push(`| ${k.replace(/_/g, ' ')} | ${pass(n)} |`);
  if (r.releaseLogSkew.n) L.push('', `**Timestamp skew at releases (${r.releaseLogSkew.n} raw overlaps, max ${f(r.releaseLogSkew.maxMs, 1)} ms real).** Event times are Postgres \`now()\`, i.e. the *start* of the writing transaction. A \`claimed\` event is stamped when the claim transaction began, before it picks a row; if a release commits while that claim transaction is already running, the claim picks the freed row after the release but is stamped before it. (Before \`release()\` logged inside its own transaction, this gap was up to ~22 ms; now it's about 1 ms.) These are excluded because they provably aren't double hand-outs: release is a compare-and-set on \`claim_token\`, so a successful release means the earlier token still owned the row when it ran. If another claim had picked the row first, it would have overwritten the token and the release would have been a no-op with no \`released\` event, leaving the earlier interval running to its lease end, which would still be counted above. Independent evidence: in ${r.releaseLogSkew.claimInsertedAfterRelease} of ${r.releaseLogSkew.n} cases the later \`claimed\` row has a higher \`claim_events.id\` than the \`released\` row. To remove the skew entirely, stamp \`claimed\` with \`clock_timestamp()\` (time of the pick). Every pair is in overlaps.json.`);
  if (r.handedOutTwice) L.push('', 'Examples (see overlaps.json):', '```json', JSON.stringify(r.handedOutTwiceExamples.slice(0, 5), null, 2), '```');
  L.push('');

  L.push('## 2. Recorded twice', '');
  L.push(`Scripts with more than one non-rejected recording: ${pass(r.recordedTwice)}. Enforced by the partial unique index \`one_live_recording_per_script\`; this check confirms it from the data.`, '');
  L.push(`Session-level checks from the simulator's log:`, '');
  L.push('| Behavior check | Result |', '|---|---|');
  L.push(`| Refresh mid-session got the same script back (status \`resumed\`, same token) | ${r.behaviors.refreshResumedSameScript} |`);
  L.push(`| Second tab got the same script as the first | ${r.behaviors.twoTabsSameScript} |`);
  L.push(`| Second tab's next heartbeat after the first tab submitted got 409 | ${r.behaviors.twoTabsSecondTabGot409AfterSubmit} |`);
  L.push(`| Double submit (2 concurrent + 1 retry) produced exactly one recording, same id for all 3 | ${r.behaviors.doubleSubmitOneRecording} |`);
  L.push(`| Heartbeating sessions that unexpectedly lost their lease | ${r.late.liveLeaseLost}${r.late.resumedThenLost ? ` (${r.late.resumedThenLost} of them: see the resume finding below)` : ''} |`);
  L.push(`| Sessions that started by getting an earlier lease back (\`resumed\`: live resume or revive) | ${fi(r.late.resumedSessions)} |`);
  L.push(`| Sessions with any unexpected HTTP error | ${r.behaviors.sessionsWithErrors} |`);
  L.push('');
  if (r.late.resumedThenLost) {
    L.push(`**Resuming a live lease doesn't extend it (finding).** ${fi(r.late.resumedSessions)} sessions began with \`resumed\` (a contributor whose earlier tab vanished or was closed came back to the same script). Reviving an *expired* lease gives a fresh one, but resuming a still-*live* lease returns it unchanged, so the remaining time can be anywhere from 0 to ${o.leaseSeconds ? o.leaseSeconds / 60 : '?'} min. In ${r.late.resumedThenLost} sessions it was less than one heartbeat interval: the lease expired before the client's first heartbeat (sent ${o.heartbeatSeconds ?? '?'} s after the claim, as the spec'd client does), someone else claimed the script, and the contributor got 409 seconds after being handed it. Fix: extend the lease on resume (a resume is proof of life), or have the client heartbeat right away when \`leaseRemainingSeconds\` < \`heartbeatSeconds\`.`, '');
  }

  L.push('## 3. Recovery time', '');
  L.push('Simulated minutes. "Claimable" = when the claim query would hand the script out again (lease end; for a soft release, the end of its grace lease, RELEASE_GRACE_SECONDS = 1.5 x heartbeat by default). "Re-claimed" = the next `claimed` event on that script by another token, which also depends on demand in that language.', '');
  L.push('| | n | claimable: mean | p95 | re-claimed: mean | p50 | p95 | max | not re-claimed by end |', '|---|---|---|---|---|---|---|---|---|');
  L.push(`| Tab vanished, abandoned (from last heartbeat) | ${v.n} | ${f(v.claimable.mean)} | ${f(v.claimable.p95)} | ${f(v.reclaimed.mean)} | ${f(v.reclaimed.p50)} | ${f(v.reclaimed.p95)} | ${f(v.reclaimed.max)} | ${v.censored} |`);
  L.push(`| Polite release (from release) | ${p.n} | ${f(p.claimable.mean)} | ${f(p.claimable.p95)} | ${f(p.reclaimed.mean)} | ${f(p.reclaimed.p50)} | ${f(p.reclaimed.p95)} | ${f(p.reclaimed.max)} | ${p.censored} |`);
  L.push('', `${v.ownerReturned} of ${v.vanishedTotal} vanished leases weren't abandoned: the same contributor started a new session and got the same script back (resumed while live, or revived after expiry if nobody else had taken it). The simulator lets any idle contributor arrive next, including one whose tab just died. They are excluded from the vanished row; the same goes for polite releases the owner revived.`);
  L.push('', `Total idle script-minutes from abandoned tabs (last heartbeat to re-claim, or to the end of the run): ${f(v.idleScriptMinutes, 0)}. Claimable time is lease minus the time since the last heartbeat, so it can't exceed the lease (${o.leaseSeconds ? o.leaseSeconds / 60 : '?'} min). Re-claim is near-instant after that because the claim query takes the lowest free id first, and an expired lease is always below the frontier of never-claimed scripts. Per-token rows: recovery.csv.`, '');

  L.push('## 4. Late submits', '');
  L.push(`A stalled contributor submits after the lease ended without re-claiming first. The submit is accepted if nobody else claimed the script in the meantime (the token is still on the row or in \`prev_token\`), and rejected (409) otherwise. The checker verifies both directions: ${pass(r.lateAcceptAfterReclaim)} accepted after someone else claimed, ${pass(r.rejectedWithoutReclaim)} rejected without anyone else claiming.`, '');
  L.push('| | accepted late | rejected |', '|---|---|---|');
  for (const [g, x] of Object.entries(r.late.byGroup)) L.push(`| ${g === 'popular' ? 'Popular languages (en, es, hi, pt)' : 'Long-tail languages (12)'} | ${x.accepted} | ${x.rejected} |`);
  L.push(`| **Total** | **${r.late.accepted}** | **${r.late.rejected}** |`);
  L.push('', `Contributor time lost on rejected submits (claim to rejection): **${f(r.late.minutesLost, 1)} minutes = $${f(r.late.dollarsLost)}** at $${ctx.payCents / 100}/h. Per-token rows: late_submits.csv.`, '');

  L.push('## 5. Pool over time', '');
  L.push('![available scripts per language](pool_over_time.png)', '');
  L.push('`pool_over_time.csv`: one row per language per background-job run (every 5 simulated minutes), from `pool_stats`. `hours_left_sim` is the job\'s forecast converted to simulated hours.', '');
  L.push('| Language | Popular | Scripts | Recorded at end (submitted + approved) | QA-rejected, returned to pool | Ran out (first "empty", sim h) | First 0-available snapshot (sim h) | Contributors who hit empty |', '|---|---|---|---|---|---|---|---|');
  for (const x of r.pool.runOut) L.push(`| ${x.language} | ${x.popular ? 'yes' : ''} | ${fi(x.scripts)} | ${fi(x.doneAtEnd)} | ${fi(qa.returnedByLang[x.language] ?? 0)} | ${x.firstEmptyMin === null ? 'never' : f(x.firstEmptyMin / 60, 2)} | ${x.firstZeroSnapshotMin === null ? 'never' : f(x.firstZeroSnapshotMin / 60, 2)} | ${r.pool.contributorsHitEmptyByLang[x.language] ?? 0} |`);
  L.push('', `${fi(r.pool.contributorsHitEmpty)} distinct contributors got "no scripts left" at least once (${fi(r.pool.emptyHits)} empty responses in total). In the simulation, a contributor who hits empty reads the message for ${o.emptyLingerMin ?? '?'} simulated minutes and leaves; their slot is refilled by another random contributor, so demand from the popular languages keeps arriving after they run out.`, '');
  if (popOut.length) L.push(`Popular languages hold 80% of contributors but the same 1/16 of scripts each, so they run out first; the long tail has spare scripts the whole time. A QA rejection puts the script back as available, so a language that ran out can briefly have scripts again (the small bumps after run-out in the chart) until someone re-records them.`, '');

  L.push('## QA', '');
  L.push(`Each submitted take is downloaded, decoded and checked by \`lib/qa.ts\` (running alongside the simulation in a separate process, ${o.qaLoops ?? '?'} loops, drained before this report). Approved takes are paid at \`est_pay_cents\`; rejected ones put the script back in the pool; borderline ones go to a human.`, '');
  L.push('| Status | Recordings |', '|---|---|');
  for (const [k, n] of Object.entries(qa.byStatus).sort((a, b) => b[1] - a[1])) L.push(`| ${k} | ${fi(n)} |`);
  L.push('', `Rejection reasons: ${topReasons(qa.reasons.rejected)}. Review reasons: ${topReasons(qa.reasons.needs_review)}.`, '');
  L.push('Verdict by the kind of take the simulator uploaded (does QA catch what it should?):', '');
  const sts = ['approved', 'paid', 'rejected', 'needs_review', 'pending_checks'].filter((k) => Object.values(qa.byAudioKind).some((m) => m[k]));
  L.push(`| Uploaded take | ${sts.join(' | ')} |`, `|---|${sts.map(() => '---').join('|')}|`);
  const kindLabel: Record<string, string> = { normal: 'normal speech (165-200 s)', silent: 'near-silent', clipped: 'heavily clipped', short: 'too short (2.2 s)' };
  for (const [k, m] of Object.entries(qa.byAudioKind)) L.push(`| ${kindLabel[k] ?? k} | ${sts.map((x) => fi(m[x] ?? 0)).join(' | ')} |`);
  L.push('', `Submit-to-decision time (real seconds, QA is not time-scaled): mean ${f(qa.decisionLagRealS.mean, 1)}, p50 ${f(qa.decisionLagRealS.p50, 1)}, p95 ${f(qa.decisionLagRealS.p95, 1)}, max ${f(qa.decisionLagRealS.max, 1)}. Approved audio: ${f(qa.approvedHours, 1)} h = $${f(qa.approvedPayoutDollars)}; in review: ${f(qa.reviewHours, 1)} h = $${f(qa.reviewPayoutDollars)}; rejected: ${f(qa.rejectedHours, 1)} h (unpaid).`, '');

  L.push('## 6. Throughput', '');
  L.push('| Metric | Value |', '|---|---|');
  L.push(`| Arrivals window | ${f(t.simMinutes / 60, 2)} simulated h = ${f(t.realSeconds, 0)} real s |`);
  L.push(`| Claims (new leases) | ${fi(t.claims)} |`);
  L.push(`| Claims/s (real) | ${f(t.claimsPerRealSec, 2)} |`);
  L.push(`| Claims per simulated minute (mean / peak 5-min) | ${f(t.claimsPerSimMin, 1)} / ${f(t.peakClaimsPerSimMin, 1)} |`);
  L.push(`| Recordings not rejected by QA (incl. drain after arrivals stop) | ${fi(t.recordings)} |`);
  L.push(`| Submitted recordings per simulated hour | ${fi(Math.round(t.recordingsPerSimHour))} |`);
  L.push(`| Submitted audio hours (not rejected) | ${f(t.audioHours, 1)} |`);
  L.push(`| **Approved audio hours** | **${f(qa.approvedHours, 1)}** |`);
  L.push(`| **Payout at $${ctx.payCents / 100}/approved hour** (sum of approved \`est_pay_cents\`) | **$${f(qa.approvedPayoutDollars)}** |`);
  L.push(`| Storage at the production format (48 kHz 16-bit mono) | ${f(t.nominalGB, 1)} GB (uploaded in the sim at ${o.audioSampleRate ?? 1000} Hz: ${f(t.uploadedGB, 2)} GB) |`);
  L.push('', '| Simulated hour (by submit time) | Recordings | Approved | Approved audio hours | Approved payout $ |', '|---|---|---|---|---|');
  for (const [h, e] of [...ctx.byHour.entries()].sort((a, b) => a[0] - b[0])) L.push(`| ${h} | ${fi(e.recordings)} | ${fi(e.approved)} | ${f(e.approvedS / 3600, 1)} | ${f(e.cents / 100)} |`);
  L.push('');
  if (r.latency.length) {
    L.push('Client-side request latency during the run (ms, measured by the simulator; one Next.js process + one Postgres on a laptop; this is not the load test):', '');
    L.push('| Endpoint | Requests | p50 | p95 | p99 | max | 5xx / network errors |', '|---|---|---|---|---|---|---|');
    for (const l of r.latency) L.push(`| ${l.endpoint} | ${fi(l.n)} | ${f(l.p50, 1)} | ${f(l.p95, 1)} | ${f(l.p99, 1)} | ${f(l.max, 0)} | ${l.errors} |`);
    L.push('');
  }

  L.push('## Method', '');
  const mix = o.mix ? Object.entries(o.mix).map(([k, n]) => `${k} ${n}%`).join(', ') : '';
  L.push(`- ${o.online} concurrent sessions; when one ends, a random idle contributor (uniform over the ${o.contributors} registered, so arrivals follow the registered language mix, ~80% popular) starts the next after an exponential gap (mean ${o.arrivalGapMin} sim-min). First arrivals are staggered over ${o.sessionMedianMin} sim-min.`);
  L.push(`- Behavior per session: ${mix}. Session length lognormal, median ${o.sessionMedianMin} sim-min, sigma ${o.sessionSigma}. Vanish / release / refresh happen at a uniform 10-90% of the planned session; the stall starts at 10-50% and lasts ${o.stallFactor?.[0]}-${o.stallFactor?.[1]}x the lease.`);
  L.push(`- Audio: real WAVs from \`lib/wav.ts\` at ${o.audioSampleRate} Hz (speech-like harmonics with a syllable-rate |sin|^0.7 envelope, 1.5-4 s phrases with 0.2-0.8 s pauses, ~0.5 s of room tone at each end): ~89% normal (12 variants, 165-200 s), 5% near-silent, 3% heavily clipped, 3% too short (2.2 s). Every upload perturbs a few samples and halves three random 1-3 s stretches, so QA's exact-hash and envelope-fingerprint duplicate checks see distinct takes. Sizes are reported at the production format (48 kHz).`);
  L.push(`- The background job (\`runJob\` from \`lib/jobs.ts\`) runs in the simulator process every ${o.jobIntervalSeconds} sim-s. After arrivals stop, in-flight sessions drain for up to ${o.drainMinutes} sim-min. Event-loop delay in the simulator: p99 ${f((r.run as any)?.eventLoopDelayMs?.p99, 1)} ms, max ${f((r.run as any)?.eventLoopDelayMs?.max, 0)} ms (timing skew bound).`);
  L.push(`- Reproducible: \`npm run sim -- --seed ${o.seed}\` then \`npm run check\`. Each session's choices come from its own RNG stream (seed + session number); exact counts still vary slightly between runs because request interleaving depends on wall-clock timing.`);
  L.push('');
  return L.join('\n');
}

// ---------- CLI ----------
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const a = process.argv.slice(2);
  const get = (k: string) => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : undefined; };
  checkRun({
    outDir: get('--out') ?? 'results',
    runDir: get('--run'),
    databaseUrl: get('--db') ?? process.env.CHECK_DATABASE_URL ?? `${(process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/scripts').replace(/\/[^/]*$/, '')}/sa_sim`,
    plot: !a.includes('--no-plot'),
    scale: get('--scale') ? Number(get('--scale')) : undefined,
  })
    .then((r) => process.exit(r.handedOutTwice || r.recordedTwice || r.lateAcceptAfterReclaim || r.rejectedWithoutReclaim ? 2 : 0))
    .catch((e) => { console.error(e); process.exit(1); });
}
