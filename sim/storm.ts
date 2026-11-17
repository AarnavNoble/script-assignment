// Storm mode: 100-300 simulated contributors hammer an ALREADY RUNNING app (the demo server) for ~60-90
// real seconds while a human records in the browser, then the no-double-hand-out invariant is checked
// over the storm's window. Uses the regular simulator (sim/simulate.ts) with --server external, no
// reseed, no schema changes, no QA child (the running QA worker checks the uploads) and no extra job loop.
//
//   npm run storm -- [--base-url http://localhost:3000] [--seconds 90] [--online 150] [--scale 10]
//                    [--min-contributor 100] [--take-seconds 10,18] [--seed N] [--job]
//                    [--server-lease 60 --server-heartbeat 5]   (only if they can't be read from the server)
//
// Time: the server's lease/heartbeat are real seconds (demo: 60 / 5). The simulator thinks in simulated
// time, so it is given lease = server lease x scale and heartbeat = server heartbeat x scale; at scale 10
// a 5-min session takes 30 real seconds, and a stall of 1.05-1.3 leases outlasts the server's real lease.
//
// Contributors: only ids >= --min-contributor (default 100, never lower), so a human on ids 1-99 never
// shares an identity with the storm.
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runSimulation, type SimOptions } from './simulate';
import type { SessionRecord } from './lib/behaviors';
import type { Api } from './lib/http';

type StormOptions = {
  baseUrl: string;
  seconds: number;
  online: number;
  scale: number;
  minContributorId: number;
  maxContributorId: number;
  takeSeconds: [number, number];
  sampleRate: number;
  seed: number;
  job: boolean;
  serverLease?: number;
  serverHeartbeat?: number;
  outDir: string;
  databaseUrl: string;
  bucket: string;
};

const MIN_STORM_ID = 100;

function parseArgs(argv: string[]): StormOptions {
  const o: StormOptions = {
    baseUrl: 'http://localhost:3000',
    seconds: 90,
    online: 150,
    scale: 10,
    minContributorId: MIN_STORM_ID,
    maxContributorId: Number.MAX_SAFE_INTEGER,
    takeSeconds: [10, 18],
    sampleRate: 48000,
    // a fresh seed per run: the same seed would re-upload byte-identical takes, which QA rejects as duplicates
    seed: Date.now() % 1_000_000,
    job: false,
    outDir: join(tmpdir(), 'script-assignment-storm'),
    databaseUrl: process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5433/scripts',
    bucket: process.env.S3_BUCKET ?? 'recordings',
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const v = argv[i + 1];
    const n = () => { i++; const x = Number(v); if (!Number.isFinite(x)) throw new Error(`${a} needs a number`); return x; };
    switch (a) {
      case '--base-url': o.baseUrl = v.replace(/\/$/, ''); i++; break;
      case '--seconds': o.seconds = n(); break;
      case '--online': o.online = n(); break;
      case '--scale': o.scale = n(); break;
      case '--min-contributor': o.minContributorId = n(); break;
      case '--max-contributor': o.maxContributorId = n(); break;
      case '--take-seconds': { const [lo, hi] = v.split(',').map(Number); o.takeSeconds = [lo, hi ?? lo]; i++; break; }
      case '--sample-rate': o.sampleRate = n(); break;
      case '--seed': o.seed = n(); break;
      case '--job': o.job = true; break;
      case '--server-lease': o.serverLease = n(); break;
      case '--server-heartbeat': o.serverHeartbeat = n(); break;
      case '--out': o.outDir = v; i++; break;
      case '--db': o.databaseUrl = v; i++; break;
      case '--bucket': o.bucket = v; i++; break;
      default: throw new Error(`unknown argument ${a}`);
    }
  }
  if (o.minContributorId < MIN_STORM_ID) throw new Error(`--min-contributor must be >= ${MIN_STORM_ID} (ids below are for the human)`);
  if (o.seconds < 20) throw new Error('--seconds must be >= 20');
  return o;
}

/**
 * Read the server's real lease and heartbeat: one claim as a storm contributor (leaseRemainingSeconds of a
 * fresh claim = the lease; heartbeatSeconds), then a polite release. Falls back to /api/ops/overview's
 * leaseSeconds and to --server-lease / --server-heartbeat.
 */
async function serverTiming(o: StormOptions, probeId: number): Promise<{ lease: number; heartbeat: number; source: string }> {
  let lease = o.serverLease, heartbeat = o.serverHeartbeat;
  let source = 'flags';
  try {
    const r = await fetch(`${o.baseUrl}/api/claims`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-contributor-id': String(probeId) }, body: '{}',
      signal: AbortSignal.timeout(10000),
    });
    const j = await r.json();
    if (r.ok && j.token) {
      if (j.status === 'claimed' && lease === undefined) lease = Math.round(j.leaseRemainingSeconds);
      if (heartbeat === undefined) heartbeat = Number(j.heartbeatSeconds);
      source = `claim probe (contributor ${probeId})`;
      await fetch(`${o.baseUrl}/api/claims/${j.token}/release?contributor=${probeId}`, { method: 'POST', signal: AbortSignal.timeout(10000) }).then((x) => x.text());
    }
  } catch { /* fall through */ }
  if (lease === undefined) {
    try {
      const r = await fetch(`${o.baseUrl}/api/ops/overview`, { signal: AbortSignal.timeout(10000) });
      lease = Number((await r.json()).leaseSeconds);
      source += ' + /api/ops/overview';
    } catch { /* fall through */ }
  }
  if (!lease || !heartbeat || !Number.isFinite(lease) || !Number.isFinite(heartbeat)) {
    throw new Error(`could not read the server's lease/heartbeat from ${o.baseUrl}; pass --server-lease and --server-heartbeat`);
  }
  return { lease, heartbeat, source };
}

const pad = (s: string | number, n: number) => String(s).padStart(n);

async function main() {
  const o = parseArgs(process.argv.slice(2));
  const probeId = o.minContributorId; // a storm id; the simulator may pick it later and revive its released script
  const t = await serverTiming(o, probeId);
  const realMsPerSimMin = (60 / o.scale) * 1000;
  // arrivals for most of the run, then a short drain; anything still running at the end is cut (= a vanished tab)
  const drainS = Math.min(20, Math.max(5, o.seconds * 0.2));
  const arrivalsS = o.seconds - drainS;
  console.log(`[storm] target ${o.baseUrl}: server lease ${t.lease}s, heartbeat ${t.heartbeat}s (from ${t.source})`);
  console.log(`[storm] ${o.online} online, contributors >= ${o.minContributorId}, ${o.seconds}s real (arrivals ${arrivalsS.toFixed(0)}s + drain ${drainS.toFixed(0)}s), scale ${o.scale}: 5-min session = ${(5 * realMsPerSimMin / 1000).toFixed(0)}s, sim lease ${t.lease * o.scale}s / heartbeat ${t.heartbeat * o.scale}s`);
  console.log(`[storm] seed ${o.seed}; takes ${o.takeSeconds[0]}-${o.takeSeconds[1]}s at ${o.sampleRate} Hz (~${(((o.takeSeconds[0] + o.takeSeconds[1]) / 2) * o.sampleRate * 2 / 1e6).toFixed(1)} MB each)`);

  let ticker: NodeJS.Timeout | undefined;
  let live: { api: Api; records: SessionRecord[]; t0: Date; realStart: number; inflight: () => number } | null = null;
  const { eventCountsSince, liveInvariant } = await import('../lib/ops');

  const partial: Partial<SimOptions> = {
    server: 'external', baseUrl: o.baseUrl, reseed: false, qa: false, job: o.job,
    databaseUrl: o.databaseUrl, bucket: o.bucket,
    scale: o.scale, leaseSeconds: t.lease * o.scale, heartbeatSeconds: t.heartbeat * o.scale,
    // keep the in-process job (only with --job) on the server's real cadence-ish: every 15 real s
    jobIntervalSeconds: 15 * o.scale,
    online: o.online, minutes: (arrivalsS * 1000) / realMsPerSimMin, drainMinutes: (drainS * 1000) / realMsPerSimMin,
    minContributorId: o.minContributorId, maxContributorId: o.maxContributorId,
    audioSampleRate: o.sampleRate, takeSeconds: o.takeSeconds,
    // stalls just past the real lease, so late takes come back within a 60-90 s storm
    stallFactor: [1.05, 1.3],
    // a bit more of every failure mode than the 3-hour baseline, so it shows on camera
    mix: { normal: 52, vanish: 11, polite_release: 8, refresh: 8, two_tabs: 7, stall: 8, double_submit: 6 },
    sessionMedianMin: 5, sessionSigma: 0.5,
    seed: o.seed, outDir: o.outDir, quiet: true,
    onStart: (h) => {
      live = h;
      let busy = false;
      ticker = setInterval(async () => {
        if (busy || !live) return;
        busy = true;
        try {
          const c = await eventCountsSince(live.t0);
          const errs = live.api.errors + live.api.samples.reduce((n, s) => n + (s.status >= 500 ? 1 : 0), 0);
          const el = ((Date.now() - live.realStart) / 1000).toFixed(0);
          console.log(`[storm ${pad(el, 3)}s] claims ${pad(c.claims, 4)} · active ${pad(live.records.filter((r) => !r.endedAt).length, 3)}`
            + ` · expired→pool ${pad(c.expired, 3)} (revived ${c.revives}) · late ok ${c.lateAccepted} / rej ${c.rejected}`
            + ` · submits ${pad(c.submitted + c.lateAccepted, 4)} · QA ok ${c.qaApproved} rej ${c.qaRejected} rev ${c.qaReview} · errors ${errs}`);
        } catch (e) {
          console.log(`[storm] live query failed: ${(e as Error).message}`);
        } finally {
          busy = false;
        }
      }, 1000);
    },
  };

  let result;
  try {
    result = await runSimulation(partial);
  } finally {
    if (ticker) clearInterval(ticker);
  }

  // ---- summary + invariant over the storm's window ----
  const { closePool } = await import('../lib/db');
  try {
    const t0 = new Date(result.t0);
    const c = await eventCountsSince(t0);
    const minutes = Math.ceil((Date.now() - t0.getTime()) / 60000) + 1;
    const inv = await liveInvariant(minutes);
    const recs = live ? (live as { records: SessionRecord[] }).records : [];
    const uploadedMB = recs.reduce((n, r) => n + (r.uploadBytes ?? 0), 0) / 1e6;
    const byBehavior: Record<string, number> = {};
    for (const r of recs) byBehavior[r.behavior] = (byBehavior[r.behavior] ?? 0) + 1;
    const errors = recs.filter((r) => r.outcome === 'error').length;
    console.log('');
    console.log(`[storm] done in ${result.realSeconds.toFixed(0)}s: ${result.sessions} sessions (${Object.entries(byBehavior).map(([k, v]) => `${k} ${v}`).join(', ')}), ${result.unfinished} cut at the end`);
    console.log(`[storm] claims ${c.claims}, resumes ${c.resumes}, revives ${c.revives}, heartbeats ${c.heartbeats}, released ${c.released}`);
    console.log(`[storm] expired ${c.expired} (job ${c.expiredByJob}, reclaim ${c.expiredByReclaim}), lost ${c.lost}, pool empty ${c.poolEmpty}`);
    console.log(`[storm] submitted ${c.submitted}, late accepted ${c.lateAccepted}, late rejected ${c.rejected}; QA approved ${c.qaApproved}, rejected ${c.qaRejected}, review ${c.qaReview} (QA keeps going after the storm)`);
    console.log(`[storm] uploaded ${uploadedMB.toFixed(0)} MB; sessions with errors ${errors}; out ${result.outDir}`);
    console.log(`[storm] handed out twice: ${inv.handedOutTwice} (across ${inv.leasesChecked} leases in the last ${inv.windowMinutes} min)`);
    console.log(`[storm] recorded twice: ${inv.recordedTwice}`);
    process.exitCode = inv.handedOutTwice === 0 && inv.recordedTwice === 0 ? 0 : 1;
  } finally {
    await closePool();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
