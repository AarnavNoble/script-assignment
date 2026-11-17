// Live lease timeline for the ops page: per script, each claim token's lease as a bar over the last few minutes.
// Rebuilt from claim_events the same way sim/check.ts rebuilds a token's live interval: it starts at
// 'claimed', its lease end is the latest lease_expires_at from claimed/heartbeat/resumed/released, it is cut
// at submit, and a revive ('resumed' with detail.revived) extends it again (after a gap where it had lapsed).
// Every time is Postgres time.
import { pool } from './db';
import { config } from './config';

export type EndReason =
  | 'live'          // lease open, but no heartbeat lately (a vanished tab still inside its lease, or a stall)
  | 'heartbeating'  // lease open and heartbeats arriving
  | 'submitted'
  | 'late_accepted' // submitted after the lease lapsed, nobody had re-claimed it
  | 'released'      // tab closed politely: lease shortened to a grace (live: still inside the grace)
  | 'expired'       // lease ran out (vanished tab)
  | 'reclaimed'     // lease ran out and the next claim took the script
  | 'rejected';     // lease ran out, someone else took it, then the late take was turned away

/** One stretch of a token holding the lease. A revived token has several, with a gap between them. */
export type Piece = {
  start: Date;
  /** last time the holder was seen (claim / heartbeat / resume / release / submit); solid up to here */
  activeEnd: Date;
  /** where the lease ended (or will end); hatched from activeEnd to here */
  end: Date;
  /** how this piece ended; the last piece's is the segment's endReason */
  ended: EndReason;
};

export type Segment = {
  token: string;
  contributorId: number;
  start: Date;
  /** live: now; otherwise when the lease actually ended (submit time or lease end) */
  end: Date;
  endReason: EndReason;
  live: boolean;
  heartbeats: Date[];
  revived: boolean;
  /** latest lease_expires_at this token was given */
  leaseEnd: Date | null;
  pieces: Piece[];
  /** a late submit was turned away (script re-claimed) */
  rejectedAt: Date | null;
  /** a heartbeat got 409 (stale tab) */
  lostAt: Date | null;
};

export type TimelineRow = { scriptId: number; language: string; segments: Segment[] };

export type Timeline = {
  now: Date;
  since: Date;
  minutes: number;
  leaseSeconds: number;
  heartbeatSeconds: number;
  rows: TimelineRow[];
};

const LIFECYCLE = ['claimed', 'resumed', 'heartbeat', 'released', 'expired', 'submitted', 'late_accepted', 'rejected', 'lost'];

type Ev = {
  script_id: string; language: string; contributor_id: number | null; claim_token: string; event: string;
  at: Date; lease_expires_at: Date | null; detail: Record<string, unknown> | null; claimed_at: Date | null; now: Date;
};

/**
 * The `limit` scripts with the most recent lease activity in the last `minutes` (plus scripts whose lease is
 * still open with no events in the window, e.g. a vanished tab under a long lease), each with its tokens.
 * One statement: an index range scan on claim_events_at for the window, then claim_events_script per script.
 */
export async function leaseTimeline({ minutes = 3, limit = 25 }: { minutes?: number; limit?: number } = {}): Promise<Timeline> {
  minutes = Math.min(60, Math.max(0.5, minutes));
  limit = Math.min(100, Math.max(1, Math.floor(limit)));
  const leaseS = config.leaseSeconds();
  const hbS = config.heartbeatSeconds();
  const r = await pool().query<Ev>(
    `WITH w AS (SELECT now() AS now, now() - make_interval(secs => $1) AS since),
     active AS (
       SELECT e.script_id, max(e.at) AS last_at
       FROM claim_events e, w
       WHERE e.at >= w.since AND e.script_id IS NOT NULL AND e.claim_token IS NOT NULL AND e.event = ANY($3)
       GROUP BY e.script_id
       UNION ALL
       -- open leases with nothing logged in the window
       SELECT s.id, s.claimed_at FROM scripts s, w
       WHERE s.status = 'claimed' AND s.lease_expires_at >= w.since
     ),
     top AS (
       SELECT script_id, max(last_at) AS last_at FROM active GROUP BY script_id ORDER BY 2 DESC LIMIT $2
     ),
     tok AS (
       -- events far enough back to know each token's lease end at the window start
       SELECT e.* FROM top
       JOIN claim_events e ON e.script_id = top.script_id
       , w
       WHERE e.at >= w.since - make_interval(secs => $4) AND e.claim_token IS NOT NULL AND e.event = ANY($3)
     ),
     starts AS (
       -- the token's claim may be older than the lookback (a long heartbeating session); one lookup per token
       SELECT k.claim_token, c.at
       FROM (SELECT DISTINCT claim_token FROM tok) k
       LEFT JOIN LATERAL (
         SELECT at FROM claim_events ce WHERE ce.claim_token = k.claim_token AND ce.event = 'claimed' LIMIT 1
       ) c ON true
     )
     SELECT t.script_id, s.language, t.contributor_id, t.claim_token, t.event, t.at, t.lease_expires_at, t.detail,
            st.at AS claimed_at, w.now
     FROM tok t
     JOIN scripts s ON s.id = t.script_id
     JOIN starts st ON st.claim_token = t.claim_token
     CROSS JOIN w
     ORDER BY t.script_id, t.at, t.id`,
    [minutes * 60, limit, LIFECYCLE, leaseS],
  );
  const now: Date = r.rows[0]?.now ?? (await pool().query('SELECT now() AS now')).rows[0].now;
  const since = new Date(now.getTime() - minutes * 60_000);
  return { now, since, minutes, leaseSeconds: leaseS, heartbeatSeconds: hbS, rows: buildRows(r.rows, now, since, hbS) };
}

/** Pure: events (ordered by script, time) -> rows of segments. Exported for tests. */
export function buildRows(events: Ev[], now: Date, since: Date, heartbeatSeconds: number): TimelineRow[] {
  const byScript = new Map<string, { language: string; tokens: Map<string, Ev[]> }>();
  for (const e of events) {
    let s = byScript.get(e.script_id);
    if (!s) byScript.set(e.script_id, (s = { language: e.language, tokens: new Map() }));
    const l = s.tokens.get(e.claim_token) ?? [];
    l.push(e);
    s.tokens.set(e.claim_token, l);
  }
  const rows: TimelineRow[] = [];
  for (const [scriptId, s] of byScript) {
    const segs = [...s.tokens.entries()].map(([token, evs]) => buildSegment(token, evs, now, heartbeatSeconds));
    segs.sort((a, b) => a.start.getTime() - b.start.getTime());
    // a lapsed lease followed by someone else's claim was reclaimed (whether or not the job got there first)
    for (let i = 0; i < segs.length - 1; i++) {
      if (segs[i].endReason === 'expired') {
        segs[i].endReason = 'reclaimed';
        segs[i].pieces[segs[i].pieces.length - 1].ended = 'reclaimed';
      }
    }
    const visible = segs.filter((g) => g.end.getTime() >= since.getTime() || g.live);
    if (visible.length) rows.push({ scriptId: Number(scriptId), language: s.language, segments: visible });
  }
  rows.sort((a, b) => a.scriptId - b.scriptId);
  return rows;
}

function buildSegment(token: string, evs: Ev[], now: Date, heartbeatSeconds: number): Segment {
  const pieces: Piece[] = [];
  const heartbeats: Date[] = [];
  let contributorId = 0;
  let start: Date | null = null;
  let activeEnd: Date | null = null;
  let leaseEnd: Date | null = null;
  let released = false;
  let revived = false;
  let expiredBy: string | null = null;
  let rejectedAt: Date | null = null;
  let lostAt: Date | null = null;
  let done: { at: Date; reason: EndReason } | null = null;

  for (const e of evs) {
    if (e.contributor_id !== null && !contributorId) contributorId = e.contributor_id;
    const isLease = e.lease_expires_at !== null && ['claimed', 'heartbeat', 'resumed', 'released'].includes(e.event);
    if (e.event === 'resumed' && e.detail?.revived && start && leaseEnd && leaseEnd < e.at) {
      // revive: the lease had lapsed (or the grace ran out); close that stretch, start a new one
      pieces.push({ start, activeEnd: activeEnd ?? start, end: leaseEnd, ended: released ? 'released' : 'expired' });
      start = e.at;
      released = false;
      expiredBy = null;
      revived = true;
    } else if (e.event === 'resumed' && e.detail?.revived) {
      revived = true;
    }
    if (!start) start = e.claimed_at && e.claimed_at < e.at ? e.claimed_at : e.at;
    switch (e.event) {
      case 'heartbeat': heartbeats.push(e.at); activeEnd = e.at; released = false; break;
      case 'claimed': case 'resumed': activeEnd = e.at; released = false; break;
      case 'released': activeEnd = e.at; released = true; break;
      case 'expired': expiredBy = String(e.detail?.by ?? 'job'); break;
      case 'submitted': case 'late_accepted':
        done = { at: e.at, reason: e.event };
        // a late submit arrives after the lease lapsed: the holder went quiet at the last heartbeat
        if (!(leaseEnd && leaseEnd < e.at)) activeEnd = e.at;
        break;
      case 'rejected': rejectedAt = e.at; break;
      case 'lost': lostAt = e.at; break;
    }
    if (isLease) leaseEnd = e.lease_expires_at;
  }
  start ??= evs[0].at;
  activeEnd ??= start;

  let end: Date;
  let reason: EndReason;
  let live = false;
  if (done) {
    end = done.at;
    reason = done.reason;
  } else if (leaseEnd && leaseEnd > now) {
    live = true;
    end = now;
    const fresh = now.getTime() - activeEnd.getTime() <= heartbeatSeconds * 2500;
    reason = released ? 'released' : fresh ? 'heartbeating' : 'live';
  } else {
    end = leaseEnd ?? activeEnd;
    reason = rejectedAt ? 'rejected' : released ? 'released' : expiredBy === 'reclaim' ? 'reclaimed' : 'expired';
  }
  // a late submit's piece ends where the lease lapsed; `end` (the submit) is further right, after a gap
  const pieceEnd = done ? (leaseEnd && leaseEnd < done.at ? leaseEnd : done.at) : (leaseEnd ?? end);
  pieces.push({ start, activeEnd, end: pieceEnd, ended: reason });
  return {
    token, contributorId, start: pieces[0].start, end, endReason: reason, live, heartbeats, revived, leaseEnd,
    pieces, rejectedAt, lostAt,
  };
}
