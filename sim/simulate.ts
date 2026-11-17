// Phase 3 simulation: 300 online contributors (of 2,000) against the real HTTP API, time-scaled.
//
//   npm run sim -- [--minutes 180] [--online 300] [--lease 600] [--heartbeat 30] [--no-heartbeat]
//                  [--scale 60] [--seed 42] [--out results] [--port 3201] [--server start|dev|external] [--no-qa] [--claim-order lowest_id|fresh_first]
//                  [--stall-abs median,sigma,max]   (stall length lognormal in sim-minutes instead of 1.1-2.5x lease)
//
// All durations in options are SIMULATED seconds/minutes; they are divided by `scale` for the server.
// Writes into outDir: run.json, sessions.jsonl, latencies.csv, server.log. Then run `npm run check`.
import { mkdirSync, writeFileSync, createWriteStream } from 'node:fs';
import { fork, type ChildProcess } from 'node:child_process';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { makeRng, deriveSeed } from './lib/rng';
import { makeVariants } from './lib/audio';
import { Api } from './lib/http';
import { startServer, buildIfNeeded, type ServerMode } from './lib/server';
import { BEHAVIORS, DEFAULT_MIX, runSession, type Behavior, type SessionCtx, type SessionRecord, type StallDist } from './lib/behaviors';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export type SimOptions = {
  scale: number;              // simulated seconds per real second
  minutes: number;            // simulated minutes of arrivals
  online: number;             // concurrent sessions
  contributors: number;       // registered
  scriptsPerLanguage: number;
  scriptsByLanguage?: Record<string, number>;
  popularShare: number;
  leaseSeconds: number;       // simulated
  heartbeatSeconds: number;   // simulated
  heartbeat: boolean;
  jobIntervalSeconds: number; // simulated
  forecastWindowSeconds: number; // simulated
  lowPoolAlertHours: number;  // simulated
  orphanAgeSeconds: number;   // simulated
  uploadUrlSeconds: number;   // simulated
  sessionMedianMin: number;
  sessionSigma: number;
  arrivalGapMin: number;      // mean simulated gap before a freed slot is refilled
  emptyLingerMin: number;     // how long a contributor who hit "empty" stays before leaving
  stallFactor: [number, number];
  stallAbsMin?: StallDist;    // fixed stall-length distribution in simulated minutes (overrides stallFactor); default off
  mix: Record<Behavior, number>;
  drainMinutes: number;       // after arrivals stop, wait this long (simulated) for sessions to finish
  seed: number;
  outDir: string;
  port: number;
  server: ServerMode;
  baseUrl?: string;
  build: boolean;             // force `next build` into distDir first
  distDir: string;
  databaseUrl: string;
  bucket: string;
  pgPoolMax: number;          // server's Postgres pool
  reseed: boolean;            // drop + seed the DB and empty the bucket first
  audioSampleRate: number;
  claimOrder?: 'lowest_id' | 'fresh_first'; // CLAIM_ORDER for the server (lib/config.ts); default fresh_first (the app default)
  qa: boolean;                // run the QA worker (lib/qa.ts) in a child process during the run, drain it at the end
  qaLoops: number;            // concurrent runQaOnce loops in the worker
  qaLimit: number;            // recordings per runQaOnce batch
  qaDrainTimeoutS: number;    // real seconds to wait for QA to finish the backlog
  quiet: boolean;
  // --- storm mode (sim/storm.ts) ---
  minContributorId: number;   // only these contributors take part (keeps a live demo's low ids free for a human)
  maxContributorId: number;
  takeSeconds?: [number, number]; // audio take length range (real seconds of audio); default ~3-min takes
  /** storm only: build takes from real TTS readings (sim/lib/speech-takes.ts); gets the synthetic variants as fallback */
  speechTakes?: (variants: import('./lib/audio').AudioVariant[]) => SessionCtx['takeFor'];
  job: boolean;               // run lib/jobs runJob in-process on jobIntervalSeconds (off when the target already runs one)
  /** Called once arrivals start, with live handles for progress reporting. */
  onStart?: (live: { api: Api; records: SessionRecord[]; t0: Date; realStart: number; inflight: () => number }) => void;
};

export const DEFAULTS: SimOptions = {
  scale: 60,
  minutes: 180,
  online: 300,
  contributors: 2000,
  scriptsPerLanguage: 1200,
  popularShare: 0.8,
  leaseSeconds: 600,
  heartbeatSeconds: 30,
  heartbeat: true,
  jobIntervalSeconds: 300,
  forecastWindowSeconds: 3600,
  lowPoolAlertHours: 2,
  orphanAgeSeconds: 3600,
  uploadUrlSeconds: 900,
  sessionMedianMin: 5,
  sessionSigma: 0.5,
  arrivalGapMin: 0.25,
  emptyLingerMin: 2,
  stallFactor: [1.1, 2.5],
  mix: DEFAULT_MIX,
  drainMinutes: 45,
  seed: 42,
  outDir: 'results',
  port: 3201,
  server: 'start',
  build: false,
  distDir: '.next-sim',
  databaseUrl: `${(process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/scripts').replace(/\/[^/]*$/, '')}/sa_sim`,
  bucket: 'recordings-sim',
  pgPoolMax: 20,
  reseed: true,
  audioSampleRate: 1000,
  qa: true,
  qaLoops: 2,
  qaLimit: 100,
  qaDrainTimeoutS: 300,
  quiet: false,
  minContributorId: 1,
  maxContributorId: Number.MAX_SAFE_INTEGER,
  job: true,
};

/** Env for the server and for in-process lib calls (runJob, storage). Real seconds = simulated / scale. */
export function simEnv(o: SimOptions): Record<string, string> {
  const s = (sim: number) => String(sim / o.scale);
  return {
    DATABASE_URL: o.databaseUrl,
    S3_ENDPOINT: process.env.S3_ENDPOINT || 'http://localhost:9000',
    S3_BUCKET: o.bucket,
    S3_KEY: process.env.S3_KEY || 'minioadmin',
    S3_SECRET: process.env.S3_SECRET || 'minioadmin',
    S3_REGION: process.env.S3_REGION || 'us-east-1',
    LEASE_SECONDS: s(o.leaseSeconds),
    HEARTBEAT_SECONDS: s(o.heartbeatSeconds),
    JOB_INTERVAL_SECONDS: s(o.jobIntervalSeconds),
    FORECAST_WINDOW_SECONDS: s(o.forecastWindowSeconds),
    LOW_POOL_ALERT_HOURS: String(o.lowPoolAlertHours / o.scale),
    ORPHAN_AGE_SECONDS: s(o.orphanAgeSeconds),
    UPLOAD_URL_SECONDS: String(Math.max(1, Math.round(o.uploadUrlSeconds / o.scale))),
    PG_POOL_MAX: String(o.pgPoolMax),
    CLAIM_ORDER: o.claimOrder ?? 'fresh_first',
    // lib/qa.ts rejects takes that aren't at an accepted rate (prod: 48000). The sim uploads at
    // audioSampleRate (1000 Hz by default, to keep ~2 GB per run instead of ~110 GB), so accept that too.
    ACCEPTED_SAMPLE_RATES: process.env.ACCEPTED_SAMPLE_RATES || `48000,${o.audioSampleRate}`,
  };
}

export type SimResult = {
  outDir: string;
  t0: string;               // DB time at the start of arrivals
  arrivalsEnd: string;      // DB time when arrivals stopped
  end: string;              // DB time at the end of the run
  realSeconds: number;
  sessions: number;
  unfinished: number;
  byOutcome: Record<string, number>;
  qa: { total: Record<string, number>; batches: number; drainSeconds: number } | null;
  options: SimOptions;
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, Math.max(0, ms)));

export async function runSimulation(partial: Partial<SimOptions> = {}): Promise<SimResult> {
  const o: SimOptions = { ...DEFAULTS, ...partial, mix: { ...DEFAULTS.mix, ...(partial.mix ?? {}) } };
  process.chdir(ROOT); // seed() reads db/schema.sql relative to cwd
  const outDir = resolve(ROOT, o.outDir);
  mkdirSync(outDir, { recursive: true });
  const log = (...a: unknown[]) => { if (!o.quiet) console.log('[sim]', ...a); };

  // lib/* reads env per call, so set it before the first pool()/s3() use.
  const env = simEnv(o);
  Object.assign(process.env, env);
  const { pool, closePool } = await import('../lib/db');
  const { runJob } = await import('../lib/jobs');
  const { seed, ensureDatabase } = await import('../db/seed');
  const storage = await import('../lib/storage');
  const { CreateBucketCommand, DeleteObjectsCommand } = await import('@aws-sdk/client-s3');

  // 1. Fresh DB + bucket
  if (o.reseed) {
    log(`seeding ${o.databaseUrl} (${o.contributors} contributors, ${o.scriptsPerLanguage}/language)`);
    await seed({ databaseUrl: o.databaseUrl, contributors: o.contributors, scriptsPerLanguage: o.scriptsPerLanguage, scriptsByLanguage: o.scriptsByLanguage, popularShare: o.popularShare });
  } else {
    await ensureDatabase(o.databaseUrl);
  }
  try {
    await storage.s3().send(new CreateBucketCommand({ Bucket: o.bucket }));
  } catch (e) {
    const name = (e as { name?: string }).name;
    if (name !== 'BucketAlreadyOwnedByYou' && name !== 'BucketAlreadyExists') throw e;
  }
  if (o.reseed) {
    const objs = await storage.listObjects('');
    for (let i = 0; i < objs.length; i += 1000) {
      await storage.s3().send(new DeleteObjectsCommand({ Bucket: o.bucket, Delete: { Objects: objs.slice(i, i + 1000).map((x) => ({ Key: x.key })), Quiet: true } }));
    }
    log(`emptied bucket ${o.bucket} (${objs.length} objects)`);
  }

  const contributors = (await pool().query('SELECT id, language FROM contributors WHERE id BETWEEN $1 AND $2 ORDER BY id',
    [o.minContributorId, Math.min(o.maxContributorId, 2 ** 31 - 1)])).rows as { id: number; language: string }[];
  if (contributors.length < o.online) throw new Error(`only ${contributors.length} contributors (ids ${o.minContributorId}-${o.maxContributorId}) for ${o.online} online`);

  // 2. Server
  if (o.server === 'start') buildIfNeeded(ROOT, o.distDir, o.build);
  const server = await startServer({ root: ROOT, port: o.port, mode: o.server, distDir: o.distDir, env, logFile: join(outDir, 'server.log'), baseUrl: o.baseUrl });
  log(`server ${server.mode} at ${server.base}`);
  const api = new Api(server.base);

  let qaChild: ChildProcess | null = null;
  let qaDone: Promise<{ total: Record<string, number>; batches: number } | null> = Promise.resolve(null);
  if (o.qa) {
    const qaLog = createWriteStream(join(outDir, 'qa.log'));
    qaChild = fork(join(ROOT, 'sim', 'qa-worker.ts'), [], {
      cwd: ROOT, execArgv: ['--import', 'tsx'], stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      env: { ...process.env, ...env, SIM_QA_LOOPS: String(o.qaLoops), SIM_QA_LIMIT: String(o.qaLimit) },
    });
    qaChild.stdout?.pipe(qaLog);
    qaChild.stderr?.pipe(qaLog);
    const child = qaChild;
    qaDone = new Promise((res) => {
      child.on('message', (m: any) => { if (m?.done) res({ total: m.total, batches: m.batches }); });
      child.on('exit', () => res(null));
    });
  }

  const loop = monitorEventLoopDelay({ resolution: 10 });
  let jobTimer: NodeJS.Timeout | undefined;
  const records: SessionRecord[] = [];
  const inflight = new Set<Promise<unknown>>();
  let jobRuns = 0;
  let jobErrors = 0;
  let jobMsMax = 0;

  try {
    await api.warm();
    const variants = makeVariants(o.seed, o.audioSampleRate, 12, o.takeSeconds);
    const msPerSimMin = (60 / o.scale) * 1000;
    let stopping = false;
    const ctxBase = {
      api, variants, msPerSimMin,
      takeFor: o.speechTakes?.(variants),
      leaseSimMin: o.leaseSeconds / 60,
      heartbeatSimMin: o.heartbeatSeconds / 60,
      heartbeatOn: o.heartbeat,
      sessionMedianMin: o.sessionMedianMin,
      sessionSigma: o.sessionSigma,
      stallFactor: o.stallFactor,
      stallAbsMin: o.stallAbsMin,
      emptyLingerMin: o.emptyLingerMin,
      stopping: () => stopping,
    };

    // idle pool with O(1) random removal; uniform over idle contributors = arrivals follow the registered mix
    const idle = contributors.map((c) => c.id);
    const langOf = new Map(contributors.map((c) => [c.id, c.language]));
    const master = makeRng(o.seed);
    const takeIdle = () => {
      const i = master.int(idle.length);
      const id = idle[i];
      idle[i] = idle[idle.length - 1];
      idle.pop();
      return id;
    };

    const t0 = (await pool().query('SELECT now() AS t')).rows[0].t as Date;
    const realStart = Date.now();
    const arrivalsEnd = realStart + o.minutes * msPerSimMin;
    loop.enable();
    log(`run start ${t0.toISOString()}; ${o.minutes} sim-min = ${(o.minutes * msPerSimMin / 1000).toFixed(0)} real s; lease ${o.leaseSeconds}s sim (${o.leaseSeconds / o.scale}s real), heartbeat ${o.heartbeat ? o.heartbeatSeconds + 's sim' : 'OFF'}`);

    // background job, same cadence as prod (scaled); never overlaps itself
    let jobBusy = false;
    if (o.job) jobTimer = setInterval(async () => {
      if (jobBusy) return;
      jobBusy = true;
      const t = performance.now();
      try { await runJob(); jobRuns++; } catch (e) { jobErrors++; if (!o.quiet) console.error('[sim] job failed', (e as Error).message); }
      jobMsMax = Math.max(jobMsMax, performance.now() - t);
      jobBusy = false;
    }, (o.jobIntervalSeconds / o.scale) * 1000);

    let sessionNo = 0;
    const slot = async (initialDelayMs: number) => {
      await sleep(initialDelayMs);
      while (Date.now() < arrivalsEnd) {
        const n = sessionNo++;
        const rng = makeRng(deriveSeed(o.seed, n));
        const who = takeIdle();
        const rec: SessionRecord = { session: n, contributor: who, language: langOf.get(who)!, behavior: rng.weighted(o.mix), startedAt: Date.now() };
        records.push(rec);
        try {
          await runSession({ ...ctxBase, rng } as SessionCtx, rec);
        } catch (e) {
          rec.outcome = 'error';
          (rec.errors ??= []).push(String((e as Error)?.stack ?? e));
        }
        rec.endedAt = Date.now();
        idle.push(who);
        await sleep(master.exp(o.arrivalGapMin) * msPerSimMin);
      }
    };
    // stagger the first arrivals over one median session so the start isn't a 300-claim spike
    for (let i = 0; i < o.online; i++) {
      const p = slot(master.uniform(0, o.sessionMedianMin) * msPerSimMin);
      inflight.add(p);
      p.finally(() => inflight.delete(p));
    }
    o.onStart?.({ api, records, t0, realStart, inflight: () => inflight.size });

    // progress
    const progress = setInterval(() => {
      const simMin = (Date.now() - realStart) / msPerSimMin;
      const done = records.filter((r) => r.endedAt).length;
      log(`t=${simMin.toFixed(0)} sim-min sessions=${records.length} done=${done} reqs=${api.samples.length} netErr=${api.errors} loopP99=${(loop.percentile(99) / 1e6).toFixed(0)}ms`);
    }, 20000);

    await sleep(arrivalsEnd - Date.now());
    const arrivalsEndDb = (await pool().query('SELECT now() AS t')).rows[0].t as Date;
    log(`arrivals stopped; draining ${inflight.size} slots (max ${o.drainMinutes} sim-min)`);
    await Promise.race([Promise.all([...inflight]), sleep(o.drainMinutes * msPerSimMin)]);
    stopping = true;
    clearInterval(progress);
    clearInterval(jobTimer);
    while (jobBusy) await sleep(50);
    let qa: SimResult['qa'] = null;
    if (qaChild) {
      const pending = Number((await pool().query(`SELECT count(*) AS n FROM recordings WHERE status = 'pending_checks'`)).rows[0].n);
      log(`draining QA: ${pending} recordings pending`);
      const t = Date.now();
      qaChild.send({ cmd: 'drain' });
      const r = await Promise.race([qaDone, sleep(o.qaDrainTimeoutS * 1000).then(() => null)]);
      qa = { total: r?.total ?? {}, batches: r?.batches ?? 0, drainSeconds: (Date.now() - t) / 1000 };
      if (!r) log('QA drain timed out or worker died (see qa.log)');
      else log(`QA done: ${JSON.stringify(r.total)}`);
    }
    // one last job run so pool_stats reflects QA rejections returned to the pool
    if (o.job) try { await runJob(); jobRuns++; } catch (e) { jobErrors++; }
    const end = (await pool().query('SELECT now() AS t')).rows[0].t as Date;
    loop.disable();
    const realSeconds = (Date.now() - realStart) / 1000;

    // 3. Outputs
    let unfinished = 0;
    for (const r of records) if (!r.endedAt) { unfinished++; r.outcome ??= 'cut'; }
    const byOutcome: Record<string, number> = {};
    for (const r of records) byOutcome[`${r.behavior}:${r.outcome}`] = (byOutcome[`${r.behavior}:${r.outcome}`] ?? 0) + 1;

    const sess = createWriteStream(join(outDir, 'sessions.jsonl'));
    for (const r of records) sess.write(JSON.stringify(r) + '\n');
    await new Promise<void>((res) => sess.end(res));
    const lat = createWriteStream(join(outDir, 'latencies.csv'));
    lat.write('endpoint,status,ms,sim_min\n');
    for (const s of api.samples) lat.write(`${s.endpoint},${s.status},${s.ms.toFixed(2)},${((s.at - realStart) / msPerSimMin).toFixed(3)}\n`);
    await new Promise<void>((res) => lat.end(res));

    const result: SimResult = {
      outDir, t0: t0.toISOString(), arrivalsEnd: arrivalsEndDb.toISOString(), end: end.toISOString(),
      realSeconds, sessions: records.length, unfinished, byOutcome, qa, options: o,
    };
    writeFileSync(join(outDir, 'run.json'), JSON.stringify({
      ...result,
      behaviors: BEHAVIORS,
      env,
      realStartMs: realStart,
      requests: api.samples.length,
      networkErrors: api.errors,
      job: { runs: jobRuns, errors: jobErrors, maxMs: Math.round(jobMsMax) },
      eventLoopDelayMs: { p50: loop.percentile(50) / 1e6, p99: loop.percentile(99) / 1e6, max: loop.max / 1e6 },
      node: process.version,
    }, null, 2));
    log(`done in ${realSeconds.toFixed(0)} s real: ${records.length} sessions, ${unfinished} unfinished, ${api.samples.length} requests, ${api.errors} network errors`);
    return result;
  } finally {
    if (jobTimer) clearInterval(jobTimer);
    if (qaChild && qaChild.exitCode === null) qaChild.kill('SIGTERM');
    await server.stop();
    await closePool();
  }
}

// ---------- CLI ----------
function parseArgs(argv: string[]): Partial<SimOptions> {
  const o: Partial<SimOptions> = {};
  const num = (k: keyof SimOptions, v: string) => { (o as Record<string, unknown>)[k] = Number(v); };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const v = argv[i + 1];
    switch (a) {
      case '--minutes': num('minutes', v); i++; break;
      case '--online': num('online', v); i++; break;
      case '--contributors': num('contributors', v); i++; break;
      case '--scripts': num('scriptsPerLanguage', v); i++; break;
      case '--lease': num('leaseSeconds', v); i++; break;
      case '--heartbeat': num('heartbeatSeconds', v); i++; break;
      case '--no-heartbeat': o.heartbeat = false; break;
      case '--scale': num('scale', v); i++; break;
      case '--seed': num('seed', v); i++; break;
      case '--drain': num('drainMinutes', v); i++; break;
      case '--job': num('jobIntervalSeconds', v); i++; break;
      case '--port': num('port', v); i++; break;
      case '--pg-pool': num('pgPoolMax', v); i++; break;
      case '--out': o.outDir = v; i++; break;
      case '--server': o.server = v as ServerMode; i++; break;
      case '--base-url': o.baseUrl = v; i++; break;
      case '--db': o.databaseUrl = v; i++; break;
      case '--bucket': o.bucket = v; i++; break;
      case '--build': o.build = true; break;
      case '--no-reseed': o.reseed = false; break;
      case '--quiet': o.quiet = true; break;
      case '--no-qa': o.qa = false; break;
      case '--stall-abs': { const [m, sg, mx] = v.split(',').map(Number); o.stallAbsMin = { median: m, sigma: sg, max: mx }; i++; break; }
      case '--claim-order': o.claimOrder = v as SimOptions['claimOrder']; i++; break;
      case '--qa-loops': num('qaLoops', v); i++; break;
      case '--min-contributor': num('minContributorId', v); i++; break;
      case '--max-contributor': num('maxContributorId', v); i++; break;
      case '--sample-rate': num('audioSampleRate', v); i++; break;
      case '--take-seconds': { const [lo, hi] = v.split(',').map(Number); o.takeSeconds = [lo, hi]; i++; break; }
      case '--no-job': o.job = false; break;
      default: throw new Error(`unknown argument ${a}`);
    }
  }
  return o;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runSimulation(parseArgs(process.argv.slice(2)))
    .then(() => process.exit(0))
    .catch((e) => { console.error(e); process.exit(1); });
}
