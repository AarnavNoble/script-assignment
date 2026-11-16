// The seven session behaviors from the spec. Each session is one contributor visit:
// claim -> (heartbeats) -> one of: submit, vanish, release, refresh, two tabs, stall, double submit.
import type { Api, Res } from './http';
import type { Rng } from './rng';
import { nominalBytes, pickVariant, uniqueCopy, type AudioVariant } from './audio';

export const BEHAVIORS = ['normal', 'vanish', 'polite_release', 'refresh', 'two_tabs', 'stall', 'double_submit'] as const;
export type Behavior = (typeof BEHAVIORS)[number];

export const DEFAULT_MIX: Record<Behavior, number> = {
  normal: 68, vanish: 10, polite_release: 5, refresh: 6, two_tabs: 4, stall: 4, double_submit: 3,
};

export type StallDist = { median: number; sigma: number; max: number };

export type SessionCtx = {
  api: Api;
  rng: Rng;
  variants: AudioVariant[];
  /** real milliseconds per simulated minute */
  msPerSimMin: number;
  leaseSimMin: number;
  heartbeatSimMin: number;
  heartbeatOn: boolean;
  sessionMedianMin: number;
  sessionSigma: number;
  stallFactor: [number, number]; // stall length as a multiple of the lease
  /** If set, stall length is lognormal in absolute simulated minutes (independent of the lease) instead of stallFactor x lease. */
  stallAbsMin?: StallDist;
  emptyLingerMin: number;
  stopping: () => boolean; // hard stop: abandon in-flight work
};

export type SessionRecord = {
  session: number;
  contributor: number;
  language: string;
  behavior: Behavior;
  startedAt: number; // real epoch ms (client clock)
  endedAt?: number;
  plannedMin?: number;
  claimStatus?: string; // claimed | resumed | empty | error
  token?: string;
  scriptId?: number;
  scriptLanguage?: string;
  outcome?: string; // submitted | late_accepted | rejected | vanished | released | empty | lost | error | cut
  vanishedAt?: number;
  releasedAt?: number;
  stallStart?: number;
  stallEnd?: number;
  stallMin?: number; // planned stall length, simulated minutes
  heartbeatsOk?: number;
  lastHeartbeatOk?: number;
  resumeSameToken?: boolean; // refresh + two tabs
  resumeStatus?: string;
  tabBAfterSubmit?: number; // HTTP status of the second tab's heartbeat after tab A submitted (expect 409)
  recordingId?: number;
  duplicateSubmits?: { status: number; recordingId?: number; duplicate?: boolean }[];
  doubleSubmitConsistent?: boolean;
  audioKind?: string;
  audioDurationS?: number;
  uploadBytes?: number;
  nominalBytes?: number;
  errors?: string[];
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, Math.max(0, ms)));

function err(rec: SessionRecord, what: string, r: Res) {
  (rec.errors ??= []).push(`${what}: ${r.status} ${r.error ?? JSON.stringify(r.json)?.slice(0, 160)}`);
}

/** Heartbeat every heartbeatSimMin until `until` (real ms). Returns false if the lease was lost. */
async function heartbeatUntil(ctx: SessionCtx, rec: SessionRecord, who: number, token: string, until: number): Promise<boolean> {
  const hb = ctx.heartbeatSimMin * ctx.msPerSimMin;
  for (;;) {
    if (ctx.stopping()) return false;
    const wait = Math.min(hb, until - Date.now());
    if (wait > 0) await sleep(wait);
    if (Date.now() >= until) return true;
    if (!ctx.heartbeatOn) continue;
    const r = await ctx.api.heartbeat(who, token);
    if (r.status === 200) {
      rec.heartbeatsOk = (rec.heartbeatsOk ?? 0) + 1;
      rec.lastHeartbeatOk = Date.now();
    } else if (r.status === 409) {
      return false;
    } else {
      err(rec, 'heartbeat', r); // transient: keep going, the next one may work
    }
  }
}

/** presign -> PUT -> submit. Returns the submit response (or the failing step's). */
async function uploadAndSubmit(ctx: SessionCtx, rec: SessionRecord, who: number, token: string, copies = 1): Promise<Res[]> {
  const v = pickVariant(ctx.rng, ctx.variants);
  rec.audioKind = v.kind;
  rec.audioDurationS = v.durationS;
  rec.nominalBytes = nominalBytes(v.durationS);
  const u = await ctx.api.uploadUrl(who, token);
  if (u.status === 200) {
    const body = uniqueCopy(ctx.rng, v);
    rec.uploadBytes = body.length;
    const p = await ctx.api.put(u.json.url, body, u.json.contentType ?? 'audio/wav');
    if (p.status !== 200) err(rec, 'put', p);
  } else if (u.status !== 409) {
    err(rec, 'upload_url', u);
  }
  // Submit even after a 409 on upload-url: the server's verdict (and its audit event) is the source of truth.
  return Promise.all(Array.from({ length: copies }, () => ctx.api.submit(who, token)));
}

function settle(rec: SessionRecord, r: Res) {
  if (r.status === 200) {
    rec.outcome = r.json.status; // submitted | late_accepted
    rec.recordingId = r.json.recordingId;
  } else if (r.status === 409) {
    rec.outcome = 'rejected';
  } else {
    rec.outcome = 'error';
    err(rec, 'submit', r);
  }
}

export async function runSession(ctx: SessionCtx, rec: SessionRecord): Promise<SessionRecord> {
  const { api, rng } = ctx;
  const who = rec.contributor;
  const min = ctx.msPerSimMin;
  const planned = Math.min(45, Math.max(0.5, rng.lognormal(ctx.sessionMedianMin, ctx.sessionSigma)));
  rec.plannedMin = planned;
  // draw everything up front so a session's choices depend only on its own RNG stream
  const cutFrac = rng.uniform(0.1, 0.9);
  const stallFrac = rng.uniform(0.1, 0.5);
  const stallMul = rng.uniform(ctx.stallFactor[0], ctx.stallFactor[1]);
  // drawn only when the option is on, so the default RNG stream (and the baseline) is unchanged
  const stallSimMin = ctx.stallAbsMin
    ? Math.min(ctx.stallAbsMin.max, rng.lognormal(ctx.stallAbsMin.median, ctx.stallAbsMin.sigma))
    : stallMul * ctx.leaseSimMin;

  const c = await api.claim(who);
  if (c.status !== 200) {
    rec.claimStatus = 'error';
    rec.outcome = 'error';
    err(rec, 'claim', c);
    return rec;
  }
  rec.claimStatus = c.json.status;
  if (c.json.status === 'empty') {
    rec.outcome = 'empty';
    await sleep(ctx.emptyLingerMin * min); // reads "check back later", then leaves
    return rec;
  }
  const token: string = c.json.token;
  rec.token = token;
  rec.scriptId = c.json.scriptId;
  rec.scriptLanguage = c.json.language;
  const t0 = Date.now();
  const end = t0 + planned * min;

  switch (rec.behavior) {
    case 'normal':
    case 'double_submit': {
      if (!(await heartbeatUntil(ctx, rec, who, token, end))) { rec.outcome = ctx.stopping() ? 'cut' : 'lost'; return rec; }
      if (rec.behavior === 'normal') {
        settle(rec, (await uploadAndSubmit(ctx, rec, who, token))[0]);
        return rec;
      }
      // double click: two concurrent submits, then a retry a moment later (e.g. after a timeout)
      const all = await uploadAndSubmit(ctx, rec, who, token, 2);
      await sleep(0.1 * min);
      all.push(await api.submit(who, token));
      const first = all.find((a) => a.status === 200 && a.json.duplicate === false) ?? all[0];
      settle(rec, first);
      rec.duplicateSubmits = all.map((a) => ({ status: a.status, recordingId: a.json?.recordingId, duplicate: a.json?.duplicate }));
      rec.doubleSubmitConsistent = all.every((a) => a.status === 200 && a.json.recordingId === first.json?.recordingId)
        && all.filter((a) => a.json?.duplicate === false).length === 1;
      return rec;
    }
    case 'vanish': {
      const ok = await heartbeatUntil(ctx, rec, who, token, t0 + cutFrac * planned * min);
      rec.vanishedAt = Date.now();
      rec.outcome = ok ? 'vanished' : (ctx.stopping() ? 'cut' : 'lost');
      return rec;
    }
    case 'polite_release': {
      if (!(await heartbeatUntil(ctx, rec, who, token, t0 + cutFrac * planned * min))) { rec.outcome = ctx.stopping() ? 'cut' : 'lost'; return rec; }
      const r = await api.release(who, token);
      rec.releasedAt = Date.now();
      rec.outcome = r.status === 200 && r.json.released ? 'released' : 'release_failed';
      if (rec.outcome !== 'released') err(rec, 'release', r);
      return rec;
    }
    case 'refresh': {
      if (!(await heartbeatUntil(ctx, rec, who, token, t0 + cutFrac * planned * min))) { rec.outcome = ctx.stopping() ? 'cut' : 'lost'; return rec; }
      const again = await api.claim(who);
      rec.resumeStatus = again.json?.status;
      rec.resumeSameToken = again.status === 200 && again.json.token === token && again.json.status === 'resumed';
      const t = again.json?.token ?? token;
      if (!(await heartbeatUntil(ctx, rec, who, t, end))) { rec.outcome = ctx.stopping() ? 'cut' : 'lost'; return rec; }
      settle(rec, (await uploadAndSubmit(ctx, rec, who, t))[0]);
      return rec;
    }
    case 'two_tabs': {
      // second tab opens a bit later and claims concurrently with a heartbeat from the first
      await sleep(rng.uniform(0, 0.5) * min);
      const [b] = await Promise.all([api.claim(who), api.heartbeat(who, token)]);
      rec.resumeStatus = b.json?.status;
      rec.resumeSameToken = b.status === 200 && b.json.token === token;
      const tokB = b.json?.token ?? token;
      let tabBStatus = 0;
      const tabB = (async () => {
        // tab B heartbeats too, until it sees the lease is gone (after tab A submits)
        const hb = ctx.heartbeatSimMin * min;
        for (;;) {
          await sleep(hb);
          if (ctx.stopping()) return;
          if (!ctx.heartbeatOn && Date.now() < end) continue;
          const r = await api.heartbeat(who, tokB);
          if (r.status !== 200) { tabBStatus = r.status; return; }
          if (!ctx.heartbeatOn) return;
        }
      })();
      const ok = await heartbeatUntil(ctx, rec, who, token, end);
      if (!ok) { rec.outcome = ctx.stopping() ? 'cut' : 'lost'; await tabB; return rec; }
      settle(rec, (await uploadAndSubmit(ctx, rec, who, token))[0]);
      await tabB;
      rec.tabBAfterSubmit = tabBStatus;
      return rec;
    }
    case 'stall': {
      const stallAt = t0 + stallFrac * planned * min;
      if (!(await heartbeatUntil(ctx, rec, who, token, stallAt))) { rec.outcome = ctx.stopping() ? 'cut' : 'lost'; return rec; }
      rec.stallStart = Date.now();
      rec.stallMin = stallSimMin;
      await sleep(stallSimMin * min); // network gone: no heartbeats, still recording
      rec.stallEnd = Date.now();
      if (ctx.stopping()) { rec.outcome = 'cut'; return rec; }
      settle(rec, (await uploadAndSubmit(ctx, rec, who, token))[0]);
      return rec;
    }
  }
}
