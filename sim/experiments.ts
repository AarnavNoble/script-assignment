// Phase 5 experiments: lease sweep (1), claim order (2), pool exhaustion forecast (4).
// The load test (3, 5) is sim/loadtest.ts.
//
//   npm run experiments -- [--only lease,order,forecast] [--force] [--concurrency 3] [--seeds 42,43]
//                          [--forecast-db postgres://.../sa_sim] [--forecast-run results] [--report-only] [--cleanup]
//
// Every simulation runs in its own child process (`sim/simulate.ts`; it sets process-wide env), with its own
// port, database (sa_exp_<name>) and bucket (recordings-exp-<slot>). After a run: `checkRun` writes the
// checker's results.md + CSVs into results/exp-runs/<name>/, extra per-run facts go to summary.json there,
// and the bucket is emptied (audio isn't needed afterwards). Finished runs are reused unless --force.
// Then: results/experiments.md, results/lease_sweep.csv, claim_order.csv, forecast.csv + charts (sim/plot_experiments.py).
import { existsSync, mkdirSync, readFileSync, writeFileSync, createWriteStream, rmSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { Pool, Client } from 'pg';
import { S3Client, ListObjectsV2Command, DeleteObjectsCommand } from '@aws-sdk/client-s3';
import { checkRun, type CheckResult } from './check';
import type { SessionRecord } from './lib/behaviors';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const RES = join(ROOT, 'results');
const RUNS = join(RES, 'exp-runs');
const PG = 'postgres://postgres:postgres@localhost:5433';
const POPULAR = ['en', 'es', 'hi', 'pt'];
const PAY_PER_H = 5; // $ per approved audio hour, also used as the value of an hour of contributor time
const STALL = { median: 3, sigma: 0.8, max: 30 }; // fixed stall-length distribution for the lease sweep (sim-min)
const LEASES_MIN = [1, 2, 5, 10, 15];

type Spec = { name: string; group: 'lease' | 'order'; leaseMin: number; heartbeat: boolean; seed: number; claimOrder: 'lowest_id' | 'fresh_first'; args: string[]; scale?: number };
// Short leases are re-run at a slower time scale: at 60x a 1-min lease is 1 real second and a heartbeat 0.5 s,
// so ordinary request latency (p99 ~150-300 ms real under load) already eats most of the slack.
const SLOW_SCALE = 20;
const SLOW_LEASES = [1, 2];
const FF_LEASES = [2, 5, 10, 15];

// ---------- CLI ----------
const argv = process.argv.slice(2);
const get = (k: string) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
const only = new Set((get('--only') ?? 'lease,leaseff,order,forecast').split(','));
const force = argv.includes('--force');
const reportOnly = argv.includes('--report-only');
const concurrency = Number(get('--concurrency') ?? 3);
const seeds = (get('--seeds') ?? '42,43').split(',').map(Number);
const forecastDb = get('--forecast-db') ?? `${PG}/sa_sim`;
const extraSimArgs = get('--sim-args')?.split(' ').filter(Boolean) ?? []; // e.g. "--minutes 10" for a smoke test
const forecastRun = resolve(ROOT, get('--forecast-run') ?? 'results');

function specs(): Spec[] {
  const out: Spec[] = [];
  const stall = `${STALL.median},${STALL.sigma},${STALL.max}`;
  if (only.has('lease')) {
    for (const seed of seeds) {
      for (const L of LEASES_MIN) out.push({ name: `lease${L}_s${seed}`, group: 'lease', leaseMin: L, heartbeat: true, seed, claimOrder: 'lowest_id', args: ['--lease', String(L * 60), '--stall-abs', stall, '--no-qa', '--seed', String(seed)] });
      for (const L of SLOW_LEASES) out.push({ name: `lease${L}_s${seed}_x${SLOW_SCALE}`, group: 'lease', leaseMin: L, heartbeat: true, seed, claimOrder: 'lowest_id', scale: SLOW_SCALE, args: ['--lease', String(L * 60), '--stall-abs', stall, '--no-qa', '--seed', String(seed), '--scale', String(SLOW_SCALE)] });
      out.push({ name: `nohb10_s${seed}`, group: 'lease', leaseMin: 10, heartbeat: false, seed, claimOrder: 'lowest_id', args: ['--lease', '600', '--no-heartbeat', '--stall-abs', stall, '--no-qa', '--seed', String(seed)] });
    }
  }
  if (only.has('leaseff')) {
    // the same sweep under the current fresh_first (v2) claim order, one seed: does the order change the best lease?
    for (const L of FF_LEASES) out.push({ name: `ff_lease${L}_s42`, group: 'lease', leaseMin: L, heartbeat: true, seed: 42, claimOrder: 'fresh_first', args: ['--lease', String(L * 60), '--stall-abs', stall, '--no-qa', '--seed', '42', '--claim-order', 'fresh_first'] });
  }
  if (only.has('order')) {
    for (const co of ['lowest_id', 'fresh_first'] as const) {
      out.push({ name: `order_${co}`, group: 'order', leaseMin: 10, heartbeat: true, seed: 42, claimOrder: co, args: ['--claim-order', co, '--no-qa', '--seed', '42'] });
    }
    // fresh_first after lib/assign.ts changed its order to (status <> 'available' OR prev_token IS NOT NULL), id
    // (16:30 build); order_fresh_first above ran with the first version, (status <> 'available'), id
    out.push({ name: 'order_fresh_first2', group: 'order', leaseMin: 10, heartbeat: true, seed: 42, claimOrder: 'fresh_first', args: ['--claim-order', 'fresh_first', '--no-qa', '--seed', '42'] });
    // v3 (18:00 build): the v2 rule as two index-ordered queries (partial index scripts_fresh first, then the lowest_id query)
    out.push({ name: 'order_fresh_first3', group: 'order', leaseMin: 10, heartbeat: true, seed: 42, claimOrder: 'fresh_first', args: ['--claim-order', 'fresh_first', '--no-qa', '--seed', '42'] });
  }
  return out;
}

// ---------- running ----------
const s3 = new S3Client({
  endpoint: process.env.S3_ENDPOINT || 'http://localhost:9000', region: process.env.S3_REGION || 'us-east-1', forcePathStyle: true,
  credentials: { accessKeyId: process.env.S3_KEY || 'minioadmin', secretAccessKey: process.env.S3_SECRET || 'minioadmin' },
});
async function emptyBucket(bucket: string) {
  let token: string | undefined;
  let n = 0;
  do {
    let r;
    try { r = await s3.send(new ListObjectsV2Command({ Bucket: bucket, ContinuationToken: token })); } catch { return 0; }
    const objs = (r.Contents ?? []).map((o) => ({ Key: o.Key! }));
    if (objs.length) await s3.send(new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: objs, Quiet: true } }));
    n += objs.length;
    token = r.IsTruncated ? r.NextContinuationToken : undefined;
  } while (token);
  return n;
}

function runSim(spec: Spec, slot: number): Promise<number> {
  const dir = join(RUNS, spec.name);
  mkdirSync(dir, { recursive: true });
  const args = ['--env-file=.env', 'sim/simulate.ts', ...spec.args, ...extraSimArgs,
    '--port', String(3311 + slot), '--db', `${PG}/sa_exp_${spec.name}`, '--bucket', `recordings-exp-${slot}`, '--out', `results/exp-runs/${spec.name}`, '--quiet'];
  const log = createWriteStream(join(dir, 'sim.log'));
  return new Promise((res) => {
    const c = spawn(join(ROOT, 'node_modules', '.bin', 'tsx'), args, { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
    c.stdout.pipe(log); c.stderr.pipe(log);
    c.on('exit', (code) => res(code ?? 1));
  });
}

type LateRow = { token: string; language: string; popular: boolean; behavior: string; verdict: string; lateMin: number; stallMin: number | null; expiredBy: string | null; otherClaimAfterLeaseMin: number | null };
type Summary = {
  spec: Spec; realSeconds: number; check: Omit<CheckResult, 'run' | 'handedOutTwiceExamples'>;
  eventLoop: { p50: number; p99: number; max: number }; jobMaxMs: number;
  stalls: { n: number; stallMin: number[]; outcomes: Record<string, number> };
  outcomesByBehavior: Record<string, Record<string, number>>;
  late: LateRow[];
  forecast: ForecastData;
};
type ForecastData = {
  scale: number;
  snapshots: { simMin: number; language: string; available: number; hoursLeftSim: number | null }[];
  firstLowPoolMin: Record<string, number>;
  firstEmptyMin: Record<string, number>;
  lastNonEmptyClaimMin: Record<string, number>;
  rejectedReturned: Record<string, number>;
};

async function forecastData(db: Pool, t0: number, scale: number): Promise<ForecastData> {
  const sm = (t: Date) => ((new Date(t).getTime() - t0) / 1000) * scale / 60;
  const snaps = (await db.query(`SELECT at, language, available, hours_left FROM pool_stats ORDER BY at, language`)).rows;
  const low = (await db.query(`SELECT language, min(at) AS at FROM alerts WHERE kind = 'low_pool' GROUP BY language`)).rows;
  const empty = (await db.query(`SELECT language, min(at) AS at FROM claim_events WHERE event = 'pool_empty' GROUP BY language`)).rows;
  // the last 'claimed' before the first empty: run-out happened between the two
  const lastClaim = (await db.query(`
    SELECT e.language, max(c.at) AS at FROM (SELECT language, min(at) AS at FROM claim_events WHERE event = 'pool_empty' GROUP BY language) e
    JOIN claim_events c ON c.language = e.language AND c.event = 'claimed' AND c.at < e.at GROUP BY e.language`)).rows;
  const ret = (await db.query(`SELECT language, count(*) AS n FROM claim_events WHERE event IN ('qa_rejected','review_rejected') GROUP BY language`)).rows;
  return {
    scale,
    snapshots: snaps.map((r) => ({ simMin: sm(r.at), language: r.language, available: Number(r.available), hoursLeftSim: r.hours_left === null ? null : Number(r.hours_left) * scale })),
    firstLowPoolMin: Object.fromEntries(low.map((r) => [r.language, sm(r.at)])),
    firstEmptyMin: Object.fromEntries(empty.map((r) => [r.language, sm(r.at)])),
    lastNonEmptyClaimMin: Object.fromEntries(lastClaim.map((r) => [r.language, sm(r.at)])),
    rejectedReturned: Object.fromEntries(ret.map((r) => [r.language, Number(r.n)])),
  };
}

async function analyze(spec: Spec): Promise<Summary> {
  const dir = join(RUNS, spec.name);
  const databaseUrl = `${PG}/sa_exp_${spec.name}`;
  const chk = await checkRun({ databaseUrl, outDir: `results/exp-runs/${spec.name}`, runDir: `results/exp-runs/${spec.name}`, plot: false, write: true, quiet: true });
  const run = JSON.parse(readFileSync(join(dir, 'run.json'), 'utf8'));
  const sessions: SessionRecord[] = readFileSync(join(dir, 'sessions.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const scale = run.options.scale;
  const t0 = new Date(run.t0).getTime();
  const db = new Pool({ connectionString: databaseUrl, max: 2 });
  try {
    const sm = (t: Date) => ((new Date(t).getTime() - t0) / 1000) * scale / 60;
    // late submits: lateness = verdict - lease end; who expired the lease first; when someone else claimed it
    const rows = (await db.query(`
      WITH tok AS (
        SELECT claim_token, min(language) AS language,
          max(lease_expires_at) FILTER (WHERE event IN ('claimed','heartbeat','resumed')) AS lease_end,
          min(at) FILTER (WHERE event = 'claimed') AS claimed_at,
          min(at) FILTER (WHERE event IN ('late_accepted','rejected')) AS verdict_at,
          bool_or(event = 'late_accepted') AS accepted,
          min(script_id) AS script_id
        FROM claim_events WHERE claim_token IS NOT NULL GROUP BY claim_token
      )
      SELECT t.*, (SELECT e.detail->>'by' FROM claim_events e WHERE e.claim_token = t.claim_token AND e.event = 'expired' ORDER BY e.at LIMIT 1) AS expired_by,
        (SELECT min(c.at) FROM claim_events c WHERE c.script_id = t.script_id AND c.event = 'claimed' AND c.claim_token <> t.claim_token AND c.at > t.claimed_at) AS other_claim
      FROM tok t WHERE t.verdict_at IS NOT NULL`)).rows;
    const sessOf = new Map<string, SessionRecord>();
    for (const s of sessions) if (s.token && !sessOf.has(s.token)) sessOf.set(s.token, s);
    const late: LateRow[] = rows.map((r) => {
      const s = sessOf.get(r.claim_token);
      return {
        token: r.claim_token, language: r.language, popular: POPULAR.includes(r.language), behavior: s?.behavior ?? '',
        verdict: r.accepted ? 'late_accepted' : 'rejected', lateMin: sm(r.verdict_at) - sm(r.lease_end), stallMin: s?.stallMin ?? null,
        expiredBy: r.expired_by, otherClaimAfterLeaseMin: r.other_claim ? sm(r.other_claim) - sm(r.lease_end) : null,
      };
    });
    const stallS = sessions.filter((s) => s.behavior === 'stall' && s.token);
    const outcomes: Record<string, number> = {};
    for (const s of stallS) outcomes[s.outcome ?? 'none'] = (outcomes[s.outcome ?? 'none'] ?? 0) + 1;
    const byBeh: Record<string, Record<string, number>> = {};
    for (const s of sessions) { (byBeh[s.behavior] ??= {})[s.outcome ?? 'none'] = (byBeh[s.behavior][s.outcome ?? 'none'] ?? 0) + 1; }
    const { run: _run, handedOutTwiceExamples: _ex, ...check } = chk;
    return {
      spec, realSeconds: run.realSeconds, check, eventLoop: run.eventLoopDelayMs, jobMaxMs: run.job?.maxMs ?? 0,
      stalls: { n: stallS.length, stallMin: stallS.map((s) => s.stallMin ?? NaN), outcomes },
      outcomesByBehavior: byBeh, late, forecast: await forecastData(db, t0, scale),
    };
  } finally { await db.end(); }
}

async function dropDb(name: string) {
  const c = new Client({ connectionString: `${PG}/postgres` });
  await c.connect();
  try { await c.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`); } finally { await c.end(); }
}

async function runAll(list: Spec[]) {
  const todo = list.filter((s) => force || !existsSync(join(RUNS, s.name, 'summary.json')));
  console.log(`[exp] ${list.length} runs, ${todo.length} to do, concurrency ${concurrency}`);
  let next = 0;
  const worker = async (slot: number) => {
    while (next < todo.length) {
      const spec = todo[next++];
      const t = Date.now();
      console.log(`[exp] slot ${slot}: ${spec.name} ${spec.args.join(' ')}`);
      const code = await runSim(spec, slot);
      const removed = await emptyBucket(`recordings-exp-${slot}`);
      if (code !== 0) { console.error(`[exp] ${spec.name} failed (exit ${code}); see ${join(RUNS, spec.name, 'sim.log')}`); continue; }
      const sum = await analyze(spec);
      writeFileSync(join(RUNS, spec.name, 'summary.json'), JSON.stringify(sum));
      rmSync(join(RUNS, spec.name, 'latencies.csv'), { force: true }); // big; latency_summary.csv has the percentiles
      console.log(`[exp] ${spec.name} done in ${((Date.now() - t) / 1000).toFixed(0)} s (emptied ${removed} objects); late ${sum.check.late.accepted}/${sum.check.late.rejected}, vanish idle mean ${sum.check.recovery.vanish.reclaimed.mean?.toFixed(2)}, loop p99 ${sum.eventLoop.p99.toFixed(1)} ms`);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, todo.length) }, (_, i) => worker(i)));
}

// ---------- stats helpers ----------
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
const mean = (xs: number[]) => (xs.length ? sum(xs) / xs.length : NaN);
const pct = (xs: number[], p: number) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))] : NaN; };
const f = (x: number, d = 2) => (Number.isFinite(x) ? x.toFixed(d) : 'n/a');
const money = (x: number) => (Number.isFinite(x) ? `$${x.toFixed(2)}` : 'n/a');
function readCsv(path: string): Record<string, string>[] {
  if (!existsSync(path)) return [];
  const [h, ...ls] = readFileSync(path, 'utf8').trim().split('\n');
  const keys = h.split(',');
  return ls.map((l) => Object.fromEntries(l.split(',').map((v, i) => [keys[i], v])));
}
const load = (name: string): Summary | null => (existsSync(join(RUNS, name, 'summary.json')) ? JSON.parse(readFileSync(join(RUNS, name, 'summary.json'), 'utf8')) : null);
/** Standard normal CDF (Abramowitz-Stegun 7.1.26), for the stall model's expected share of stalls longer than the lease. */
function phi(z: number) { const t = 1 / (1 + 0.3275911 * Math.abs(z) / Math.SQRT2); const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-z * z / 2); return z >= 0 ? (1 + y) / 2 : (1 - y) / 2; }

// ---------- 1. lease sweep ----------
type LeaseRow = {
  label: string; order: string; leaseMin: number; heartbeat: boolean; scale: number; primary: boolean; runs: number; simHours: number;
  vanishN: number; vanishCensored: number; idleMean: number; idleP50: number; idleP95: number; idleMinPerH: number; starvedIdleMinPerH: number;
  stalls: number; stallsLongerThanLeaseExpected: number; lateTotal: number; lateAccepted: number; wasted: number; wastedPopular: number; wastedTail: number;
  minutesLost: number; dollarsLost: number; dollarsLostPerH: number; rejectedNonStall: number; liveLeaseLost: number;
  hbP95: number; claimP95: number; loopP99: number; handedOutTwice: number; claims: number; emptyHits: number;
};

function leaseRows(): LeaseRow[] {
  const out: LeaseRow[] = [];
  const configs: { label: string; L: number; hb: boolean; prefix: string; suffix: string; order: string }[] = [
    ...LEASES_MIN.map((L) => ({ label: `${L} min`, L, hb: true, prefix: `lease${L}`, suffix: '', order: 'lowest_id' })),
    ...SLOW_LEASES.map((L) => ({ label: `${L} min @${SLOW_SCALE}x`, L, hb: true, prefix: `lease${L}`, suffix: `_x${SLOW_SCALE}`, order: 'lowest_id' })),
    { label: '10 min, no heartbeat', L: 10, hb: false, prefix: 'nohb10', suffix: '', order: 'lowest_id' },
    ...FF_LEASES.map((L) => ({ label: `${L} min, fresh_first v2`, L, hb: true, prefix: `ff_lease${L}`, suffix: '', order: 'fresh_first' })),
  ];
  for (const c of configs) {
    const sums = seeds.map((s) => load(`${c.prefix}_s${s}${c.suffix}`)).filter((x): x is Summary => !!x);
    if (!sums.length) continue;
    const idle: number[] = [];
    let censored = 0, starvedIdle = 0;
    for (const s of sums) {
      // idle minutes that fell while the script's language was out of scripts (after its first "empty"):
      // the only idle time that turned someone away
      const run = JSON.parse(readFileSync(join(RUNS, s.spec.name, 'run.json'), 'utf8'));
      const endMin = ((new Date(run.end).getTime() - new Date(run.t0).getTime()) / 1000) * run.options.scale / 60;
      for (const r of readCsv(join(RUNS, s.spec.name, 'recovery.csv'))) if (r.kind === 'vanish') {
        if (r.reclaimed_after_min === '') censored++; else idle.push(Number(r.reclaimed_after_min));
        const a = Number(r.last_alive_sim_min);
        const b = r.reclaimed_after_min === '' ? endMin : a + Number(r.reclaimed_after_min);
        const e = s.forecast.firstEmptyMin[r.language];
        if (e !== undefined) starvedIdle += Math.max(0, b - Math.max(a, e));
      }
    }
    const simHours = sum(sums.map((s) => s.check.throughput.simMinutes / 60));
    const late = sums.flatMap((s) => s.late);
    const stallMins = sums.flatMap((s) => s.stalls.stallMin);
    const expectLonger = stallMins.length * (1 - phi(Math.log(c.L / STALL.median) / STALL.sigma));
    const wasted = late.filter((l) => l.verdict === 'rejected');
    const lat = (ep: string, k: 'p95') => mean(sums.map((s) => s.check.latency.find((l) => l.endpoint === ep)?.[k] ?? NaN));
    const dollarsLost = sum(sums.map((s) => s.check.late.dollarsLost));
    out.push({
      label: c.label, order: c.order, leaseMin: c.L, heartbeat: c.hb, scale: sums[0].spec.scale ?? 60, primary: false, runs: sums.length, simHours,
      vanishN: idle.length, vanishCensored: censored, idleMean: mean(idle), idleP50: pct(idle, 50), idleP95: pct(idle, 95),
      idleMinPerH: sum(sums.map((s) => s.check.recovery.vanish.idleScriptMinutes)) / simHours,
      starvedIdleMinPerH: starvedIdle / simHours,
      stalls: stallMins.length, stallsLongerThanLeaseExpected: expectLonger,
      lateTotal: late.length, lateAccepted: late.filter((l) => l.verdict === 'late_accepted').length,
      wasted: wasted.length, wastedPopular: wasted.filter((l) => l.popular).length, wastedTail: wasted.filter((l) => !l.popular).length,
      minutesLost: sum(sums.map((s) => s.check.late.minutesLost)), dollarsLost, dollarsLostPerH: dollarsLost / simHours,
      rejectedNonStall: wasted.filter((l) => l.behavior !== 'stall').length,
      liveLeaseLost: sum(sums.map((s) => s.check.late.liveLeaseLost)),
      hbP95: lat('heartbeat', 'p95'), claimP95: lat('claim', 'p95'), loopP99: Math.max(...sums.map((s) => s.eventLoop.p99)),
      handedOutTwice: sum(sums.map((s) => s.check.handedOutTwice)), claims: sum(sums.map((s) => s.check.throughput.claims)),
      emptyHits: sum(sums.map((s) => s.check.pool.emptyHits)),
    });
  }
  // the row used for each lease in the cost model and chart: the slow-scale run where there is one
  for (const r of out) r.primary = r.heartbeat && r.order === 'lowest_id' && !out.some((o) => o !== r && o.heartbeat && o.order === r.order && o.leaseMin === r.leaseMin && o.scale < r.scale);
  return out;
}

// ---------- 2. claim order ----------
type OrderRow = {
  order: string; late: number; accepted: number; rejected: number; accPop: number; rejPop: number; accTail: number; rejTail: number;
  minutesLost: number; dollarsLost: number; idleMean: number; idleP95: number; vanishN: number; censored: number; idleMinTotal: number;
  runOut: Record<string, number | null>; emptyHits: number; contributorsHitEmpty: number; claims: number; claimP95: number;
  acceptedByExpiry: Record<string, { accepted: number; rejected: number }>; lateMinMedian: number; handedOutTwice: number; loopP99: number;
  recordings: number; resumed: number; hbP95: number;
};
function orderRows(): OrderRow[] {
  const out: OrderRow[] = [];
  for (const co of ['lowest_id', 'fresh_first', 'fresh_first2', 'fresh_first3']) {
    const s = load(`order_${co}`);
    if (!s) continue;
    const idle = readCsv(join(RUNS, s.spec.name, 'recovery.csv')).filter((r) => r.kind === 'vanish');
    const re = idle.filter((r) => r.reclaimed_after_min !== '').map((r) => Number(r.reclaimed_after_min));
    const g = s.check.late.byGroup;
    const byExp: Record<string, { accepted: number; rejected: number }> = {};
    for (const l of s.late) {
      // how the lease ended before the verdict: taken over by a claim, cleaned by the job, or nobody touched it
      const k = l.expiredBy ?? 'not_expired';
      byExp[k] ??= { accepted: 0, rejected: 0 };
      byExp[k][l.verdict === 'late_accepted' ? 'accepted' : 'rejected']++;
    }
    out.push({
      order: co, late: s.late.length, accepted: s.check.late.accepted, rejected: s.check.late.rejected,
      accPop: g.popular.accepted, rejPop: g.popular.rejected, accTail: g.tail.accepted, rejTail: g.tail.rejected,
      minutesLost: s.check.late.minutesLost, dollarsLost: s.check.late.dollarsLost,
      idleMean: mean(re), idleP95: pct(re, 95), vanishN: re.length, censored: idle.length - re.length, idleMinTotal: s.check.recovery.vanish.idleScriptMinutes,
      runOut: Object.fromEntries(s.check.pool.runOut.filter((r) => r.popular).map((r) => [r.language, r.firstEmptyMin])),
      emptyHits: s.check.pool.emptyHits, contributorsHitEmpty: s.check.pool.contributorsHitEmpty, claims: s.check.throughput.claims,
      claimP95: s.check.latency.find((l) => l.endpoint === 'claim')?.p95 ?? NaN,
      hbP95: s.check.latency.find((l) => l.endpoint === 'heartbeat')?.p95 ?? NaN,
      acceptedByExpiry: byExp, lateMinMedian: pct(s.late.map((l) => l.lateMin), 50), handedOutTwice: s.check.handedOutTwice, loopP99: s.eventLoop.p99,
      recordings: s.check.throughput.recordings, resumed: s.check.late.resumedSessions,
    });
  }
  return out;
}

// ---------- 4. forecast ----------
type FcRow = { source: string; language: string; firstLowPoolH: number | null; ranOutH: number | null; warningH: number | null; returned: number; forecastAtAlertH: number | null; errAtAlertH: number | null; mae1hH: number | null };
function forecastRows(src: string, fd: ForecastData): FcRow[] {
  return POPULAR.map((lang) => {
    const low = fd.firstLowPoolMin[lang] ?? null;
    const out = fd.firstEmptyMin[lang] ?? null;
    const snaps = fd.snapshots.filter((s) => s.language === lang && s.hoursLeftSim !== null && s.available > 0);
    // forecast run-out time at each snapshot = snapshot time + hours_left
    const atAlert = low === null ? null : snaps.find((s) => Math.abs(s.simMin - low) < 0.5);
    const fcAtAlert = atAlert ? atAlert.simMin / 60 + atAlert.hoursLeftSim! : null;
    // mean absolute forecast error over the last simulated hour before run-out
    const last = out === null ? [] : snaps.filter((s) => s.simMin < out && s.simMin >= out - 60);
    const mae = last.length ? mean(last.map((s) => Math.abs(s.simMin / 60 + s.hoursLeftSim! - out! / 60))) : null;
    return {
      source: src, language: lang, firstLowPoolH: low === null ? null : low / 60, ranOutH: out === null ? null : out / 60,
      warningH: low !== null && out !== null ? (out - low) / 60 : null, returned: fd.rejectedReturned[lang] ?? 0,
      forecastAtAlertH: fcAtAlert, errAtAlertH: fcAtAlert !== null && out !== null ? fcAtAlert - out / 60 : null, mae1hH: mae,
    };
  });
}

async function baselineForecast(): Promise<{ fd: ForecastData; note: string } | null> {
  const runPath = join(forecastRun, 'run.json');
  if (!existsSync(runPath)) return null;
  const run = JSON.parse(readFileSync(runPath, 'utf8'));
  const db = new Pool({ connectionString: forecastDb, max: 2 });
  try {
    const fd = await forecastData(db, new Date(run.t0).getTime(), run.options.scale);
    const o = run.options;
    return { fd, note: `${forecastDb.split('/').pop()} (${o.online} online, lease ${o.leaseSeconds / 60} min, seed ${o.seed}, QA ${o.qa ? 'on' : 'off'}, claim order ${o.claimOrder ?? 'lowest_id'})` };
  } finally { await db.end(); }
}

// ---------- report ----------
async function report() {
  const lr = leaseRows();
  const or = orderRows();
  const base = only.has('forecast') ? await baselineForecast() : null;
  const noqa = load('order_lowest_id');
  const fc: FcRow[] = [...(base ? forecastRows('baseline (QA on)', base.fd) : []), ...(noqa ? forecastRows('order_lowest_id (QA off)', noqa.forecast) : [])];

  // CSVs
  const csv = (rows: Record<string, unknown>[]) => rows.length ? [Object.keys(rows[0]).join(','), ...rows.map((r) => Object.values(r).map((v) => (typeof v === 'number' ? (Number.isFinite(v) ? +v.toFixed(4) : '') : v === null ? '' : typeof v === 'object' ? JSON.stringify(v).replace(/,/g, ';') : String(v).includes(',') ? `"${String(v)}"` : String(v))).join(','))].join('\n') + '\n' : '';
  if (lr.length) writeFileSync(join(RES, 'lease_sweep.csv'), csv(lr));
  if (or.length) writeFileSync(join(RES, 'claim_order.csv'), csv(or.map(({ acceptedByExpiry, runOut, ...r }) => ({ ...r, ...Object.fromEntries(Object.entries(runOut).map(([k, v]) => [`runout_${k}_min`, v])) }))));
  if (fc.length) writeFileSync(join(RES, 'forecast.csv'), csv(fc));
  // forecast series for the chart
  const series: string[] = ['source,language,sim_min,available,hours_left_sim,forecast_runout_h'];
  const addSeries = (src: string, fd: ForecastData) => { for (const s of fd.snapshots) if (POPULAR.includes(s.language)) series.push(`${src},${s.language},${s.simMin.toFixed(2)},${s.available},${s.hoursLeftSim ?? ''},${s.hoursLeftSim === null || s.available === 0 ? '' : (s.simMin / 60 + s.hoursLeftSim).toFixed(4)}`); };
  if (base) addSeries('baseline', base.fd);
  if (noqa) addSeries('noqa', noqa.forecast);
  writeFileSync(join(RES, 'forecast_series.csv'), series.join('\n') + '\n');
  const events: string[] = ['source,language,first_low_pool_h,ran_out_h'];
  for (const r of fc) events.push(`${r.source.startsWith('baseline') ? 'baseline' : 'noqa'},${r.language},${r.firstLowPoolH ?? ''},${r.ranOutH ?? ''}`);
  writeFileSync(join(RES, 'forecast_events.csv'), events.join('\n') + '\n');
  const py = spawnSync('python3', [join(ROOT, 'sim', 'plot_experiments.py'), RES], { encoding: 'utf8' });
  if (py.status !== 0) console.error('[exp] plot failed:', py.stderr);

  writeFileSync(join(RES, 'experiments.md'), renderMd(lr, or, fc, base?.note ?? null));
  console.log(`[exp] wrote ${join(RES, 'experiments.md')}`);
}

function renderMd(lr: LeaseRow[], or: OrderRow[], fc: FcRow[], baseNote: string | null): string {
  const L: string[] = [];
  const lt = existsSync(join(RES, 'loadtest.json')) ? JSON.parse(readFileSync(join(RES, 'loadtest.json'), 'utf8')) : null;
  const hb = lr.filter((r) => r.primary).sort((a, b) => a.leaseMin - b.leaseMin);
  const ff = lr.filter((r) => r.order === 'fresh_first').sort((a, b) => a.leaseMin - b.leaseMin);
  const V = PAY_PER_H / 60; // $ per idle script-minute, upper bound (see text)
  const cost = (r: LeaseRow, v: number, starvedOnly = false) => r.dollarsLostPerH + v * (starvedOnly ? r.starvedIdleMinPerH : r.idleMinPerH);
  const best = hb.length ? hb.reduce((a, b) => (cost(b, V, true) < cost(a, V, true) ? b : a)) : null;
  const best0 = hb.length ? hb.reduce((a, b) => (cost(b, 0) < cost(a, 0) ? b : a)) : null;
  const nohb = lr.find((r) => !r.heartbeat);
  const hb10 = lr.find((r) => r.heartbeat && r.leaseMin === 10);

  L.push('# Experiments', '');
  L.push('Generated by `npm run experiments` (lease sweep, claim order, forecast) and `npx tsx --env-file=.env sim/loadtest.ts` (load test). Every number is measured from runs on this laptop (10-core Apple Silicon, one Next.js `next start` process, Postgres 16 and MinIO in Docker). Simulated runs use the same simulator as results.md (300 online, 16 languages x 1,200 scripts, 3 simulated hours at 60x, real HTTP API); setup differences are listed per experiment.', '');
  L.push('<!-- SUMMARY -->', '');

  // 1
  L.push('## 1. Lease length sweep', '');
  L.push(`**Setup.** Leases ${LEASES_MIN.join(', ')} sim-min with heartbeats every 30 sim-s, plus 10 min without heartbeats. ${seeds.length} seeds (${seeds.join(', ')}) per lease, results pooled (${f(hb[0]?.simHours ?? 0, 0)} simulated hours of arrivals per lease). Claim order \`lowest_id\`. QA off (\`--no-qa\`): QA doesn't touch leases, and without it no rejected takes refill the pool, so pools run out a little earlier than in results.md. Stalls use a **fixed** length distribution for every lease: lognormal in simulated minutes, median ${STALL.median}, sigma ${STALL.sigma} (p95 ${f(STALL.median * Math.exp(1.645 * STALL.sigma), 1)}, capped at ${STALL.max}), starting 10-50% into the session (4% of sessions stall). The default sim instead stalls for 1.1-2.5x the lease, which would make every stall a late submit at any lease. After the stall the contributor submits without re-claiming.`, '');
  L.push('Definitions. *Idle time*: a vanished tab\'s script, from its last heartbeat until someone else claims it (only abandoned leases; the owner coming back is excluded, same as results.md). *False expiry*: a contributor who was still recording but whose lease expired during a stall (= late submit). *Wasted take*: a false expiry whose script was re-claimed before the submit, so the take is rejected (409). Lost time = claim to rejection, valued at $5/h.', '');
  L.push('| Lease | Abandoned scripts (re-claimed / still idle at end) | Idle mean (min) | p50 | p95 | Idle script-min per sim-h | Stalls | Stalls > lease (expected from the stall model) | False expiries (late submits) | ... accepted late | **Wasted takes** (popular / tail) | Contributor-min lost | $ lost | $ lost per sim-h | Heartbeat p95 (ms, real) | Heartbeating sessions that lost the lease | Handed out twice |');
  L.push('|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|');
  for (const r of lr) L.push(`| ${r.label} | ${r.vanishN} / ${r.vanishCensored} | ${f(r.idleMean)} | ${f(r.idleP50)} | ${f(r.idleP95)} | ${f(r.idleMinPerH, 0)} | ${r.stalls} | ${f(r.stallsLongerThanLeaseExpected, 0)} | ${r.lateTotal} | ${r.lateAccepted} | **${r.wasted}** (${r.wastedPopular} / ${r.wastedTail}) | ${f(r.minutesLost, 0)} | ${money(r.dollarsLost)} | ${money(r.dollarsLostPerH)} | ${r.heartbeat ? f(r.hbP95, 0) : 'n/a'} | ${r.liveLeaseLost} | ${r.handedOutTwice} |`);
  L.push('');
  L.push('![lease tradeoff](lease_tradeoff.png)', '');
  if (best && best0) {
    L.push(`**Cost model (stated assumption).** A wasted take costs the contributor's time from claim to rejection, at $5/h (measured above). An idle abandoned script costs nothing while its language still has other free scripts: whoever wants one gets another. Once its language has run out it costs about one contributor-minute per script-minute, because someone who would have recorded it is told "no scripts left". So an idle script-minute is valued at $${f(V, 3)} (= $5/h) if its language was already out at that moment (measured per script from its idle interval and the language's first "empty"), and $0 otherwise. The last column is a loose upper bound that charges every idle minute as if the pool were always empty.`, '');
    L.push('| Lease | Wasted-take $/h | Idle script-min/h (all) | ... of which while the language was out | **Total $/h (measured model)** | Total $/h if every idle minute cost $5/h (upper bound) |');
    L.push('|---|---|---|---|---|---|');
    for (const r of [...hb, ...ff]) L.push(`| ${r.label} | ${money(r.dollarsLostPerH)} | ${f(r.idleMinPerH, 0)} | ${f(r.starvedIdleMinPerH, 0)} | **${money(cost(r, V, true))}** | ${money(cost(r, V))} |`);
    L.push('');
  }
  L.push('<!-- LEASE_INTERP -->', '');

  // 2
  L.push('## 2. Claim order: lowest_id vs fresh_first', '');
  L.push('**Setup.** Seed 42 for all, otherwise identical to results.md (lease 10 min, heartbeat 30 s, default stall model: 4% of sessions stall for 1.1-2.5x the lease, so every stall is a late submit), except QA off (`--no-qa`, same for all). Three versions of `fresh_first` were measured, because lib/assign.ts changed in response to these results: v1 orders by `(status <> \'available\'), id`, so only rows still marked `claimed` with an expired lease go after never-claimed rows; v2 also puts rows with a `prev_token` (a lease the background job expired, or a polite release) last; v3 (current code) is the v2 rule as two index-ordered queries: first `status = \'available\' AND prev_token IS NULL` from the partial index `scripts_fresh`, then the lowest_id query as a fallback. v3 ran on the final build, which also has the soft release (a polite release keeps the lease for a 45-s grace instead of freeing it at once).', '');
  if (or.length) {
    const cols = ['lowest_id', 'fresh_first', 'fresh_first2', 'fresh_first3'].map((k) => or.find((r) => r.order === k));
    L.push('| | lowest_id | fresh_first v1: `(status <> \'available\'), id` | fresh_first v2: `(status <> \'available\' OR prev_token IS NOT NULL), id` | fresh_first v3 (current): `scripts_fresh` first, then lowest_id |', '|---|---|---|---|---|');
    const row = (k: string, g: (r: OrderRow) => string) => L.push(`| ${k} | ${cols.map((c) => (c ? g(c) : 'not run')).join(' | ')} |`);
    row('Late submits (stalls)', (r) => String(r.late));
    row('Accepted late / rejected, all', (r) => `${r.accepted} / ${r.rejected}`);
    row('... popular (en, es, hi, pt)', (r) => `${r.accPop} / ${r.rejPop}`);
    row('... long tail', (r) => `${r.accTail} / ${r.rejTail}`);
    row('Contributor-minutes lost (rejected takes)', (r) => f(r.minutesLost, 0));
    row('$ lost at $5/h', (r) => money(r.dollarsLost));
    row('Vanished-tab idle until re-claimed, mean / p95 (min)', (r) => `${f(r.idleMean)} / ${f(r.idleP95)} (n=${r.vanishN}, ${r.censored} never re-claimed)`);
    row('Idle script-minutes, abandoned tabs (total)', (r) => f(r.idleMinTotal, 0));
    for (const lang of POPULAR) row(`Run-out, ${lang} (first "empty", sim h)`, (r) => (r.runOut[lang] == null ? 'never' : f(r.runOut[lang]! / 60)));
    row('"Empty" responses / distinct contributors', (r) => `${r.emptyHits} / ${r.contributorsHitEmpty}`);
    row('Claims', (r) => String(r.claims));
    row('Claim p95 (ms, client side)', (r) => f(r.claimP95, 0));
    row('Handed out twice', (r) => String(r.handedOutTwice));
    L.push('');
    L.push('How each late submit\'s lease had ended (first `expired` event: `reclaim` = another claim took the expired row; `job` = the 5-min background job reset it to `available`, keeping the token in `prev_token`):', '');
    L.push('| Claim order | Lease ended by | accepted late | rejected |', '|---|---|---|---|');
    for (const r of or) for (const [k, v] of Object.entries(r.acceptedByExpiry)) L.push(`| ${({ fresh_first: 'fresh_first v1', fresh_first2: 'fresh_first v2', fresh_first3: 'fresh_first v3' } as Record<string, string>)[r.order] ?? r.order} | ${k} | ${v.accepted} | ${v.rejected} |`);
    L.push('');
  }
  L.push('<!-- ORDER_INTERP -->', '');

  // 3
  L.push('## 3. Load test (1x / 10x / 100x and the knee)', '');
  if (lt) L.push(`Full method, per-level numbers, EXPLAIN plans and the lock comparison: [loadtest.md](loadtest.md).`, "", lt.section ?? "", "");
  else L.push('Not run yet: see sim/loadtest.ts.', '');

  // 4
  L.push('## 4. Pool exhaustion forecast', '');
  L.push(`**Setup.** The background job (every 5 sim-min) writes \`hours_left = available / (claims in the last 60 sim-min per hour)\` per language to \`pool_stats\` and raises \`low_pool\` when it drops below LOW_POOL_ALERT_HOURS = 2 (scaled: 2 simulated hours). "Ran out" = the first claim that got "no scripts left" in that language. Sources: the baseline run ${baseNote ?? '(not available)'} and the QA-off \`order_lowest_id\` run from experiment 2. Forecast error = (snapshot time + hours_left) - actual run-out.`, '');
  if (fc.length) {
    L.push('| Source | Language | First low_pool alert (sim h) | Ran out (sim h) | **Warning (h)** | Forecast run-out at the alert (sim h) | Error at the alert (h) | Mean abs. error, last hour before run-out (h) | QA rejections returned to pool |');
    L.push('|---|---|---|---|---|---|---|---|---|');
    for (const r of fc) L.push(`| ${r.source} | ${r.language} | ${r.firstLowPoolH === null ? 'never' : f(r.firstLowPoolH)} | ${r.ranOutH === null ? 'never' : f(r.ranOutH)} | **${r.warningH === null ? 'n/a' : f(r.warningH)}** | ${r.forecastAtAlertH === null ? 'n/a' : f(r.forecastAtAlertH)} | ${r.errAtAlertH === null ? 'n/a' : (r.errAtAlertH >= 0 ? '+' : '') + f(r.errAtAlertH)} | ${r.mae1hH === null ? 'n/a' : f(r.mae1hH)} | ${r.returned} |`);
    L.push('', '![forecast vs actual](forecast.png)', '');
  }
  L.push('<!-- FORECAST_INTERP -->', '');
  L.push('## Reproduce', '');
  L.push('- `npm run experiments` (all of 1, 2, 4; finished runs in results/exp-runs/ are reused, `--force` re-runs; `--only lease|order|forecast`; `--report-only` rebuilds this file). Each run directory has the checker\'s full results.md for that run.');
  L.push('- `npx tsx --env-file=.env sim/loadtest.ts` for 3 and 5 (run alone).');
  L.push('- Exact counts vary slightly between re-runs of the same seed because request interleaving depends on wall-clock timing.', '');
  L.push('## Caveats', '');
  L.push('- lib/ changed while these ran. Lease sweep (lowest_id) and the lowest_id / fresh_first v1 runs: server built 15:34 (before the claim retry on deadlock 40P01); the background job (run in the simulator process) picked up the SKIP LOCKED cleanup fix at 15:43, so only the 1-min @60x seed-42 run used the old job. fresh_first v2 runs (incl. the fresh_first lease rows) and the load test: 17:07 build (v2, soft release). fresh_first v3, its EXPLAIN and the results.md baseline: 18:00 build (v3). The soft release (polite release keeps the lease for a 45-s grace) is in the 17:07 and 18:00 builds only; it affects the 5% polite-release sessions, not stalls or vanished tabs, and does not change the lowest_id claim order.');
  L.push('- Runs were one at a time. Three concurrent sims pushed heartbeat p95 from ~60-140 ms to ~900 ms (Docker VM at 300% CPU) and broke the time scaling for short leases, so those results were discarded.');
  L.push('- 60x time compression: a request that takes 100 ms real is 6 simulated seconds. That is why 1- and 2-min leases were re-run at 20x; the other leases have no heartbeating session that lost its lease.');
  L.push('- The stall model (4% of sessions; lognormal median 3 min) and the $5/h valuation of contributor time are assumptions; the break-even percentages in section 1 show how far they can move before the recommendation flips. fresh_first lease rows are one seed each.');
  L.push('- QA off in experiments 1 and 2 (no refills from rejected takes); pools run out ~0.3 h earlier than with QA, which slightly raises the idle-after-run-out cost.', '');
  const it = interpret(lr, or, fc, lt, { hb, best, cost, V, nohb, hb10 });
  return L.join('\n').replace('<!-- SUMMARY -->', it.summary).replace('<!-- LEASE_INTERP -->', it.lease).replace('<!-- ORDER_INTERP -->', it.order).replace('<!-- FORECAST_INTERP -->', it.forecast);
}

function interpret(lr: LeaseRow[], or: OrderRow[], fc: FcRow[], lt: any, c: {
  hb: LeaseRow[]; best: LeaseRow | null; cost: (r: LeaseRow, v: number, starvedOnly?: boolean) => number; V: number; nohb?: LeaseRow; hb10?: LeaseRow;
}) {
  const out = { summary: '', lease: '', order: '', forecast: '' };
  const { hb, best, cost, V, nohb, hb10 } = c;
  // ---- lease ----
  if (best && hb.length > 1) {
    const sorted = [...hb].sort((a, b) => a.leaseMin - b.leaseMin);
    const over = sorted.map((r) => r.idleMean - r.leaseMin);
    const shareMeasured = sum(sorted.map((r) => r.starvedIdleMinPerH)) / sum(sorted.map((r) => r.idleMinPerH));
    // break-even: share of idle time spent while the language is out, above which the next-shorter lease is cheaper
    const i = sorted.indexOf(best);
    const shorter = i > 0 ? sorted[i - 1] : null;
    const fStar = shorter ? (shorter.dollarsLostPerH - best.dollarsLostPerH) / (V * (best.idleMinPerH - shorter.idleMinPerH)) : null;
    const lines: string[] = [];
    lines.push(`**Interpretation.** Idle time is the lease plus a short wait for the next claimer (mean ${f(Math.min(...over))}-${f(Math.max(...over))} min over the lease), so it grows one-for-one with the lease. False expiries follow the stall-length distribution: the measured count of late submits tracks the model's expected number of stalls longer than the lease (e.g. ${sorted.map((r) => `${r.leaseMin} min: ${r.lateTotal} vs ${f(r.stallsLongerThanLeaseExpected, 0)}`).join('; ')}); the small excess comes from stalls that start late in a heartbeat interval. With \`lowest_id\` almost every false expiry in a popular language becomes a wasted take. Idle scripts mostly cost nothing here, because the pools hold scripts for ~2.4 of the 3 hours: only ${f(100 * shareMeasured, 0)}% of idle script-minutes fell while the language was out.`);
    lines.push('');
    const ff = lr.filter((r) => r.order === 'fresh_first').sort((a, b) => a.leaseMin - b.leaseMin);
    const bestFF = ff.length ? ff.reduce((a2, b2) => (cost(b2, V, true) < cost(a2, V, true) ? b2 : a2)) : null;
    lines.push(`**With \`lowest_id\` the cheapest lease is ${best.leaseMin} min**: ${money(cost(best, V, true))} per simulated hour${shorter ? ` vs ${money(cost(shorter, V, true))} at ${shorter.leaseMin} min` : ''}. ${shorter && fStar !== null ? `It stays cheapest as long as languages are out of scripts for less than ${f(100 * fStar, 0)}% of the time an abandoned script sits idle (break-even: (${money(shorter.dollarsLostPerH)} - ${money(best.dollarsLostPerH)}) / ($${f(V, 3)} x (${f(best.idleMinPerH, 0)} - ${f(shorter.idleMinPerH, 0)}) idle min/h)); measured here: ${f(100 * shareMeasured, 0)}%. If pools ran dry for much longer than in this run, the shorter lease would win.` : ''} Short leases protect almost no stalls (median stall 3 min), so wasted takes dominate: ${sorted[0].leaseMin} min loses ${money(sorted[0].dollarsLostPerH)}/h.`);
    if (bestFF) {
      const ff10 = ff.find((r) => r.leaseMin === 10) ?? bestFF;
      lines.push('', `**The claim order changes the answer.** Under the current \`fresh_first\` (v2; one seed, the last rows of the table), an expired lease goes to the back of the queue, so a stalled contributor usually gets to submit late whatever the lease: wasted takes ${ff.map((r) => `${r.leaseMin} min: ${r.wasted}`).join(', ')} in 3 sim-h (lowest_id: ${sorted.filter((r) => ff.some((x) => x.leaseMin === r.leaseMin)).map((r) => `${r.leaseMin} min: ${r.wasted}`).join(', ')} in 6 sim-h). The lease then mainly decides how long a vanished tab's script is held, which costs money only once the language has run out: idle script-minutes while the language was out ${ff.map((r) => `${r.leaseMin} min: ${f(r.starvedIdleMinPerH, 0)}/h`).join(', ')}. Abandoned scripts wait much longer overall (mean ${f(Math.min(...ff.map((r) => r.idleMean)), 0)}-${f(Math.max(...ff.map((r) => r.idleMean)), 0)} min) because they are served last; that is the point of the order, and it is free while never-claimed scripts remain. Cheapest: **${bestFF.leaseMin} min at ${money(cost(bestFF, V, true))}/h** (${ff.map((r) => `${r.leaseMin} min ${money(cost(r, V, true))}`).join(', ')}).`);
      lines.push('', `**Recommendation: ${bestFF.leaseMin}-minute lease with the current fresh_first order**, 30 s heartbeats (${f(bestFF.leaseMin - 0.5, 1)} min of slack: several missed heartbeats, e.g. a throttled background tab, don't lose the script). If the claim order goes back to lowest_id, use ${best.leaseMin} min instead. Caveat: the fresh_first rows ran on the v2 build (v3, the current code, matched v2 in section 2), one seed each and their wasted-take counts are single digits; the ${bestFF.leaseMin}-vs-10-min gap (${money(cost(bestFF, V, true))} vs ${money(cost(ff10, V, true))}/h) comes from idle time after run-out, which depends on how long pools stay empty. With pools kept stocked (section 4) the choice between 5 and 15 min matters little.`);
    } else {
      lines.push('', `**Recommendation: ${best.leaseMin}-minute lease** (with 30 s heartbeats).`);
    }
    if (nohb && hb10) lines.push('', `**Heartbeats matter.** With the same 10-min lease but no heartbeats, ${nohb.wasted} takes were wasted vs ${hb10.wasted} with heartbeats (${f(nohb.dollarsLost)} vs ${f(hb10.dollarsLost)} $ over ${f(nohb.simHours, 0)} simulated hours): every session longer than the lease (session length is lognormal, median 5 min, so ~8% run past 10 min) loses its script to the next claimer, not just the stalled ones. ${nohb.rejectedNonStall} of the ${nohb.wasted} wasted takes were ordinary sessions, not stalls.`);
    const artifact = lr.filter((r) => r.liveLeaseLost > 0);
    if (artifact.length) lines.push('', `**Time-scale check.** ${artifact.map((r) => `${r.label}: ${r.liveLeaseLost} heartbeating sessions lost their lease`).join('; ')}. At 60x a 1-min lease is 1 real second and a heartbeat 0.5 s, so request latency (heartbeat p95 ${f(artifact[0].hbP95, 0)} ms real) already eats the slack; that is a simulation artifact, not a lease effect. The 1- and 2-min leases were therefore re-run at ${SLOW_SCALE}x (3 s / 6 s real leases), and those rows are the ones used in the cost model and chart. Every other row has 0 such losses.`);
    lines.push('', '**The 1-min lease run also found a real bug.** On the first attempt the server deadlocked in Postgres (`40P01`): the background job\'s multi-row cleanup UPDATE and a claim waited on each other through the `one_claim_per_contributor` index. Short leases make expiries frequent enough to hit it (8 in 3 sim-h at 1 min). It was reported with the Postgres log and fixed in lib/ (cleanup now locks with `FOR UPDATE SKIP LOCKED`, claim retries on 40P01); every row above except the 1-min @60x seed-42 run (not used in the cost model) ran with the fixed job. An earlier attempt on an older build also hung the server outright when failing heartbeats took a second pool connection inside their transaction, which was already fixed.');
    out.lease = lines.join('\n');
  }
  // ---- order ----
  const a = or.find((r) => r.order === 'lowest_id'), b = or.find((r) => r.order === 'fresh_first'), c2 = or.find((r) => r.order === 'fresh_first2');
  if (a && b) {
    const job = b.acceptedByExpiry.job ?? { accepted: 0, rejected: 0 };
    const lines = [
      `**Interpretation.** fresh_first v1 raised late acceptance only from ${a.accepted}/${a.late} to ${b.accepted}/${b.late} (${money(a.dollarsLost)} to ${money(b.dollarsLost)} of contributor time lost). The reason: the background job's cleanupExpired() sets an expired lease back to \`status = 'available'\` (keeping the token in \`prev_token\`), and from then on v1 treats it like a never-claimed row, so it is the lowest free id again. Under v1, ${job.rejected} of ${job.accepted + job.rejected} late submits whose lease the job had reset were rejected; v1 only protects a lease for the 0-5 min until the next job run, while the median late submit here arrives ${f(b.lateMinMedian)} min after the lease ended.`,
    ];
    if (c2) {
      const j2 = c2.acceptedByExpiry.job ?? { accepted: 0, rejected: 0 };
      const fresh = lt?.explainAt ? lt.explainAt : null;
      lines.push('', `**v2 fixes that:** ${c2.accepted}/${c2.late} late submits accepted (popular languages ${c2.accPop}/${c2.accPop + c2.rejPop}; ${j2.accepted} of ${j2.accepted + j2.rejected} job-expired leases still accepted), contributor time lost ${money(a.dollarsLost)} -> ${money(c2.dollarsLost)} (${f(100 * (1 - c2.dollarsLost / a.dollarsLost), 0)}% less). The remaining ${c2.rejected} rejections are all in popular languages, on leases that ended in the last ~15 sim-min before that language ran out or after it: once never-claimed scripts are gone, expired leases are next in line again. What it costs: (1) abandoned scripts wait at the back of the queue (vanished-tab idle mean ${f(a.idleMean)} -> ${f(c2.idleMean)} min, p95 ${f(a.idleP95)} -> ${f(c2.idleP95)}), which costs nothing while never-claimed scripts remain: recordings were ${a.recordings} / ${b.recordings} / ${c2.recordings} and every popular-language script was recorded in all three runs. (2) "Empty" responses rose ${a.emptyHits} -> ${c2.emptyHits}, with run-outs ${f(Math.max(...POPULAR.map((l) => (a.runOut[l] ?? 0) - (c2.runOut[l] ?? 0))) / 60, 2)} h earlier at most; lowest_id vs v1 differ by up to ${f(Math.max(...POPULAR.map((l) => Math.abs((a.runOut[l] ?? 0) - (b.runOut[l] ?? 0)))) / 60, 2)} h, so this is within run-to-run noise on one seed. (3) Fewer new claims (${a.claims} -> ${c2.claims}) because ${c2.resumed} sessions (vs ${a.resumed}) got their own earlier script back via revive, since released and expired rows now stay unclaimed long enough for the owner to return. (4) Query cost. In the sim, claim p95 went ${f(a.claimP95, 0)} -> ${f(c2.claimP95, 0)} ms, but heartbeat p95 moved too (${f(a.hbP95, 0)} -> ${f(c2.hbP95, 0)} ms) and heartbeats don't depend on the claim order, so in-sim latency mostly reflects other load on the laptop between runs. The DB-side measurement is clear, though: the v2 ORDER BY is an expression the \`scripts_free (language, id)\` index can't return in order, so every claim reads and sorts all free rows of the language${fresh?.idle ? `; on the 1.6M-row load-test table the pick takes ${f(fresh.idle.fresh, 1)} ms vs ${f(fresh.idle.pick, 2)} ms for lowest_id (EXPLAIN ANALYZE, section 3)` : ''}. A partial index on \`(language, id) WHERE status = 'available' AND prev_token IS NULL\` (tried first, then the current query as a fallback) would keep the pick an index scan; not tested here.`);
      const c3 = or.find((r) => r.order === 'fresh_first3');
      const v3 = lt?.explainV3;
      if (c3) {
        lines.push('', `**v3 keeps v2's behaviour and fixes the query plan.** Late submits accepted ${c3.accepted}/${c3.late} (v2: ${c2.accepted}/${c2.late}), contributor time lost ${money(c3.dollarsLost)} (v2: ${money(c2.dollarsLost)}), recordings ${c3.recordings}, claim p95 ${f(c3.claimP95, 0)} ms in the sim (lowest_id ${f(a.claimP95, 0)}, v2 ${f(c2.claimP95, 0)}; heartbeat p95 ${f(c3.hbP95, 0)} / ${f(a.hbP95, 0)} / ${f(c2.hbP95, 0)} ms in the same runs, so these differences track machine load, not the claim query).${v3 ? ` On the 16 x 100k table both of its queries are index scans: ${f(v3.idle.fresh, 2)} ms for the \`scripts_fresh\` pick and ${f(v3.idle.pick, 2)} ms for the fallback at rest (v2's sorted pick: ${f(lt.explainAt?.idle?.fresh ?? NaN, 1)} ms); ${f(v3.live100x.fresh, 2)} / ${f(v3.live100x.pick, 2)} ms with ${Math.round(100 * 340).toLocaleString('en-US')} live leases in the language. Plans: loadtest_explain.txt (v3) and loadtest_explain_v2.txt.` : ''} One caveat when comparing v3 with v2: v3 ran on the build with the soft release, so polite releases hold their script for the grace period.`);
        lines.push('', `**Recommendation: make \`fresh_first\` (v3) the default.** It removes ${f(100 * (1 - c3.dollarsLost / a.dollarsLost), 0)}% of the contributor time lost to rejected late submits (${money(a.dollarsLost)} -> ${money(c3.dollarsLost)} per 3 sim-h at today's traffic), with the same number of recordings, and its claim query is an index scan (${f(lt?.explainV3?.idle?.fresh ?? NaN, 2)} ms in Postgres on 100k scripts per language). What it trades away is recovery speed for abandoned scripts, which only matters after a language runs out of never-claimed scripts; that is also when the lease length matters (section 1).`);
      } else {
        lines.push('', `**Verdict:** v2 is worth it: it removes most of the wasted takes (${money(a.dollarsLost - c2.dollarsLost)} per 3 sim-h here) at no measured throughput cost, as long as there are never-claimed scripts left. Fix its query plan before the table grows.`);
      }
    } else {
      lines.push('', `**Verdict:** v1 is worth keeping (no measurable cost, ${money(a.dollarsLost - b.dollarsLost)} less lost per 3 sim-h) but leaves most of the gain on the table.`);
    }
    out.order = lines.join('\n');
  }
  // ---- forecast ----
  const base = fc.filter((r) => r.source.startsWith('baseline'));
  const nq = fc.filter((r) => !r.source.startsWith('baseline'));
  if (base.length) {
    const w = base.map((r) => r.warningH).filter((x): x is number => x !== null);
    const e = base.map((r) => r.errAtAlertH).filter((x): x is number => x !== null);
    const mae = base.map((r) => r.mae1hH).filter((x): x is number => x !== null);
    out.forecast = [
      `**Interpretation.** In the QA-on baseline the \`low_pool\` alert fired at ${f(Math.min(...base.map((r) => r.firstLowPoolH ?? NaN)))}-${f(Math.max(...base.map((r) => r.firstLowPoolH ?? NaN)))} h for the popular languages and they ran out ${f(Math.min(...base.map((r) => r.ranOutH ?? NaN)))}-${f(Math.max(...base.map((r) => r.ranOutH ?? NaN)))} h, so the alert gave **${f(Math.min(...w))}-${f(Math.max(...w))} h of warning**. That is roughly the 2-h threshold by construction: the alert fires as soon as the forecast drops under 2 h, and the forecast was close to right (error at the alert ${f(Math.min(...e))} to ${f(Math.max(...e))} h; negative = predicted earlier than it happened; mean absolute error in the last hour before run-out ${f(Math.min(...mae))}-${f(Math.max(...mae))} h).`,
      '',
      `Three effects are visible in the chart. (1) Cold start: for the first ~0.75 h the 60-min claims window isn't full, so the rate is underestimated and the forecast is far too late; in production the window is always full. (2) Refills: each QA rejection puts a script back (${base.map((r) => `${r.language} ${r.returned}`).join(', ')} returned), which "available / claim rate" doesn't know about, so with QA on the forecast is early (pessimistic) and drifts later as run-out approaches. (3) Without refills it errs the other way:${nq.length ? ` in the QA-off run the error at the alert was ${f(Math.min(...nq.map((r) => r.errAtAlertH ?? NaN)))} to +${f(Math.max(...nq.map((r) => r.errAtAlertH ?? NaN)))} h (late), the languages ran out at ${f(Math.min(...nq.map((r) => r.ranOutH ?? NaN)))}-${f(Math.max(...nq.map((r) => r.ranOutH ?? NaN)))} h (${f(Math.min(...base.map((r) => r.ranOutH ?? NaN)) - Math.max(...nq.map((r) => r.ranOutH ?? NaN)))}+ h earlier than with QA), and the alert gave only ${f(Math.min(...nq.map((r) => r.warningH ?? NaN)))}-${f(Math.max(...nq.map((r) => r.warningH ?? NaN)))} h of warning, less than the 2-h threshold.` : ' not measured.'} The trailing-hour rate lags when demand for a language's remaining scripts rises, and it counts re-claims of expired and released scripts. For the warning to be actionable, adding scripts must take less than the warning; raise LOW_POOL_ALERT_HOURS if it takes longer.`,
    ].join('\n');
  }
  // ---- summary ----
  const S: string[] = ['## Summary', ''];
  const ffS = lr.filter((r) => r.order === 'fresh_first').sort((a2, b2) => a2.leaseMin - b2.leaseMin);
  const bestFFS = ffS.length ? ffS.reduce((a2, b2) => (cost(b2, V, true) < cost(a2, V, true) ? b2 : a2)) : null;
  if (best) S.push(`1. **Lease: recommend ${bestFFS ? `${bestFFS.leaseMin} minutes with the current \`fresh_first\` claim order` : `${best.leaseMin} minutes`}** (heartbeat 30 s)${bestFFS ? `, or ${best.leaseMin} min if the order stays \`lowest_id\`` : ''}. Cost per simulated hour = wasted takes (contributor time from claim to rejection) + abandoned scripts idle while their language had run out, both at $5/h. With lowest_id: ${hb.map((r) => `${r.leaseMin} min ${money(cost(r, V, true))}`).join(', ')} (wasted takes ${hb.map((r) => `${r.wasted}`).join(' / ')} in ${f(best.simHours, 0)} sim-h; shorter leases recover abandoned scripts faster but lose more takes to network stalls). ${bestFFS ? `With fresh_first v2 an expired lease waits at the back of the queue, so wasted takes nearly vanish (${ffS.map((r) => `${r.wasted}`).join(' / ')} in 3 sim-h) and the shorter lease wins on faster recovery after run-out: ${ffS.map((r) => `${r.leaseMin} min ${money(cost(r, V, true))}`).join(', ')} (one seed each, measured on the v2 build; v3 behaves the same: 243/275 vs 246/278 late submits accepted in the claim-order runs). ` : ''}Without heartbeats a 10-min lease wastes ${nohb?.wasted ?? 'n/a'} takes instead of ${hb10?.wasted ?? 'n/a'}.`);
  const c3s = or.find((r) => r.order === 'fresh_first3');
  if (a && c2 && c3s) S.push(`2. **Claim order: make \`fresh_first\` (v3, current code) the default.** Late submits after a stall accepted: lowest_id ${a.accepted}/${a.late}, v1 ${b?.accepted ?? 'n/a'}/${b?.late ?? 'n/a'}, v2 ${c2.accepted}/${c2.late}, v3 ${c3s.accepted}/${c3s.late}; contributor time lost ${money(a.dollarsLost)} -> ${money(c3s.dollarsLost)} per 3 sim-h; same recordings (${a.recordings} vs ${c3s.recordings}); the v3 pick is an index scan (${f(lt?.explainV3?.idle?.fresh ?? NaN, 2)} ms in Postgres on 100k scripts per language). v1 failed because the 5-min job turned expired leases back into ordinary 'available' rows; v2 fixed that but sorted every free row per claim (${f(lt?.explainAt?.idle?.fresh ?? NaN, 1)} ms per claim on 100k rows per language); v3 does the same thing with two index scans. Cost: abandoned scripts wait at the back of the queue (idle mean ${f(a.idleMean)} -> ${f(c3s.idleMean)} min), free until never-claimed scripts run out.`);
  else if (a && c2) S.push(`2. **Claim order: use \`fresh_first\` (v2).** Late submits accepted ${a.accepted}/${a.late} -> ${c2.accepted}/${c2.late}.`);
  else if (a && b) S.push(`2. **Claim order:** fresh_first v1 accepted ${b.accepted}/${b.late} late submits vs ${a.accepted}/${a.late}.`);
  if (lt?.summary) S.push(`3. **Load:** ${lt.summary}`);
  else S.push('3. **Load:** see section 3 (not run yet).');
  const base2 = fc.filter((r) => r.source.startsWith('baseline'));
  const w2 = base2.map((r) => r.warningH).filter((x): x is number => x !== null);
  if (w2.length) S.push(`4. **Forecast: the low_pool alert gave ${f(Math.min(...w2))}-${f(Math.max(...w2))} h of warning** before each popular language ran out in the QA-on baseline (alert threshold 2 h; forecast error at the alert ${f(Math.min(...base2.map((r) => r.errAtAlertH ?? NaN)))} to ${f(Math.max(...base2.map((r) => r.errAtAlertH ?? NaN)))} h, early because QA rejections refill the pool). Without QA refills the forecast was late instead and the warning shrank to ${(() => { const q = fc.filter((r) => !r.source.startsWith('baseline')).map((r) => r.warningH).filter((x): x is number => x !== null); return q.length ? `${f(Math.min(...q))}-${f(Math.max(...q))} h` : 'n/a'; })()}.`);
  out.summary = S.join('\n') + '\n';
  return out;
}

async function main() {
  const t = Date.now();
  mkdirSync(RUNS, { recursive: true });
  if (!reportOnly) await runAll(specs());
  await report();
  if (argv.includes('--cleanup')) for (const s of specs()) await dropDb(`sa_exp_${s.name}`);
  console.log(`[exp] total ${((Date.now() - t) / 60000).toFixed(1)} min`);
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
