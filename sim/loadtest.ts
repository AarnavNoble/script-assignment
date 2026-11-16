// Phase 5 experiment 3 (+5): load test of the DB hot path, in real time (no time scaling).
//
//   npx tsx --env-file=.env sim/loadtest.ts [--levels 1,10,100] [--no-refine] [--measure 60] [--warmup 15]
//        [--scripts 100000] [--port 3321] [--db postgres://.../sa_loadtest] [--skip hot,pool,lock,explain]
//
// Today's traffic (1x) = ~300 online, ~5-min sessions: 1 claim/s + ~10 heartbeats/s.
// Per level: R = level claims/s, open-loop Poisson arrivals; each session = claim, heartbeats every 30 s,
// release at the end (no upload/submit: uploads go to MinIO, not Postgres; release is the same kind of
// single-row UPDATE + event insert as submit). Session length lognormal, median 300 s, sigma 0.5.
// The first R x E[session] live leases are written straight into the table (length-biased residual
// lifetimes, random heartbeat phase), so the level starts in steady state instead of after a 5-min ramp.
// Then `warmup` s of arrivals (discarded) + `measure` s measured. Claim/heartbeat latency is client-side.
// Server: one `next start` process (dist .next-sim) with PG_POOL_MAX=20 unless a scenario says otherwise.
// Writes results/loadtest.md, loadtest.csv, loadtest.json, loadtest_explain.txt.
import http from 'node:http';
import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { readFileSync, writeFileSync, createWriteStream, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { Pool } from 'pg';
import { makeRng } from './lib/rng';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const RES = join(ROOT, 'results');
const argv = process.argv.slice(2);
const get = (k: string) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
const LEVELS = (get('--levels') ?? '1,10,100').split(',').map(Number);
const REFINE = !argv.includes('--no-refine');
const MEASURE_S = Number(get('--measure') ?? 60);
const WARMUP_S = Number(get('--warmup') ?? 15);
const SCRIPTS_PER_LANG = Number(get('--scripts') ?? 100000);
const PORT = Number(get('--port') ?? 3321);
const DB = get('--db') ?? 'postgres://postgres:postgres@localhost:5433/sa_loadtest';
const SKIP = new Set((get('--skip') ?? '').split(','));
const CONTRIBUTORS = Number(get('--contributors') ?? 300000);
const LEASE_S = 600, HB_S = 30, SESSION_MEDIAN_S = 300, SESSION_SIGMA = 0.5;
const E_SESSION_S = SESSION_MEDIAN_S * Math.exp(SESSION_SIGMA ** 2 / 2);
const KNEE_MS = 50;
const PG_CONTAINER = 'script-assignment-postgres-1';
const PROBE_ID = CONTRIBUTORS + 1; // a contributor that only the EXPLAIN probes use
const sleep = (ms: number) => new Promise((r) => setTimeout(r, Math.max(0, ms)));
const log = (...a: unknown[]) => console.log('[load]', ...a);

// ---------- the exact SQL from lib/assign.ts (read from source so EXPLAIN tests what ships) ----------
const assignSrc = readFileSync(join(ROOT, 'lib', 'assign.ts'), 'utf8');
function sqlFrom(marker: string, order = 'id', candidates = ''): string {
  const i = assignSrc.indexOf(marker);
  if (i < 0) throw new Error(`claim SQL marker ${marker} not found in lib/assign.ts`);
  const start = assignSrc.lastIndexOf('`', i);
  const end = assignSrc.indexOf('`', i);
  return assignSrc.slice(start + 1, end).replace('${order}', order).replace('${candidates}', candidates).replace(/\$\{CLAIM_COLUMNS\}/g, 'id');
}
// Current lib/assign.ts (fresh_first v3): pickAndClaim(candidates) with ORDER BY id; fresh_first tries the
// never-held candidates first (partial index scripts_fresh), then the lowest_id candidates.
const FRESH_CANDIDATES = /'fresh_first'\s*\?\s*await pickAndClaim\([^`]*`([^`]+)`/.exec(assignSrc)?.[1];
const PICK_CANDIDATES = [...assignSrc.matchAll(/pickAndClaim\(c, contributorId, lang, lease,\s*`([^`]+)`\)/g)].map((m) => m[1]).find((x) => x !== FRESH_CANDIDATES);
const PICK_SQL = sqlFrom('WITH pick AS', 'id', PICK_CANDIDATES);
const PICK_FRESH_SQL = sqlFrom('WITH pick AS', 'id', FRESH_CANDIDATES);
if (!PICK_CANDIDATES || !FRESH_CANDIDATES || PICK_SQL.includes('${')) throw new Error('could not extract the claim SQL from lib/assign.ts');
const REVIVE_SQL = sqlFrom('WITH mine AS');
const RESUME_SQL = sqlFrom("WHERE claimed_by = $1 AND status = 'claimed' AND lease_expires_at > now()");

// ---------- HTTP client ----------
const agent = new http.Agent({ keepAlive: true, maxSockets: 2048 });
type Sample = { ep: string; status: number; ms: number; t: number };
let samples: Sample[] = [];
function post(path: string, who: number, body: unknown): Promise<{ status: number; json: any }> {
  const data = JSON.stringify(body ?? {});
  const t = performance.now();
  return new Promise((res) => {
    const req = http.request({ host: '127.0.0.1', port: PORT, path, method: 'POST', agent, timeout: 10000,
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data), 'x-contributor-id': String(who) } }, (r) => {
      const chunks: Buffer[] = [];
      r.on('data', (c) => chunks.push(c));
      r.on('end', () => {
        const ms = performance.now() - t;
        const ep = path.endsWith('/heartbeat') ? 'heartbeat' : path.includes('/release') ? 'release' : 'claim';
        samples.push({ ep, status: r.statusCode ?? 0, ms, t: Date.now() });
        let json: any = null;
        try { json = JSON.parse(Buffer.concat(chunks).toString()); } catch { /* not json */ }
        res({ status: r.statusCode ?? 0, json });
      });
    });
    const fail = () => {
      const ep = path.endsWith('/heartbeat') ? 'heartbeat' : path.includes('/release') ? 'release' : 'claim';
      samples.push({ ep, status: 0, ms: performance.now() - t, t: Date.now() });
      res({ status: 0, json: null });
    };
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', fail);
    req.end(data);
  });
}

// ---------- server ----------
let server: ChildProcess | null = null;
async function startServer(pgPoolMax: number) {
  await stopServer();
  const env = {
    ...process.env, DATABASE_URL: DB, LEASE_SECONDS: String(LEASE_S), HEARTBEAT_SECONDS: String(HB_S), PG_POOL_MAX: String(pgPoolMax),
    CLAIM_ORDER: 'lowest_id', NEXT_DIST_DIR: '.next-sim', NODE_ENV: 'production', NEXT_TELEMETRY_DISABLED: '1', S3_BUCKET: 'recordings-loadtest',
  };
  const out = createWriteStream(join(RES, 'loadtest_server.log'), { flags: 'a' });
  const child = spawn(process.execPath, [join(ROOT, 'node_modules', 'next', 'dist', 'bin', 'next'), 'start', '-p', String(PORT)], { cwd: ROOT, env: env as NodeJS.ProcessEnv, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  child.stdout!.pipe(out); child.stderr!.pipe(out);
  server = child;
  for (let i = 0; i < 200; i++) {
    const r = await new Promise<number>((res) => { const q = http.get({ host: '127.0.0.1', port: PORT, path: '/api/stats', agent }, (x) => { x.resume(); x.on('end', () => res(x.statusCode ?? 0)); }); q.on('error', () => res(0)); });
    if (r === 200) break;
    await sleep(300);
  }
  // warm the routes (first-request compile/JIT)
  for (let i = 0; i < 20; i++) { await post('/api/claims/not-a-uuid/heartbeat', 1, {}); await post('/api/claims/not-a-uuid/release?contributor=1', 1, {}); }
  samples = [];
  log(`server pid ${child.pid} (PG_POOL_MAX=${pgPoolMax})`);
}
async function stopServer() {
  if (!server) return;
  const s = server; server = null;
  try { process.kill(-s.pid!, 'SIGTERM'); } catch { /* gone */ }
  for (let i = 0; i < 50 && s.exitCode === null; i++) await sleep(100);
  try { process.kill(-s.pid!, 'SIGKILL'); } catch { /* gone */ }
}
process.on('exit', () => { if (server) try { process.kill(-server.pid!, 'SIGKILL'); } catch { /* gone */ } });

// ---------- resource sampling ----------
function sh(cmd: string, args: string[]): Promise<string> {
  return new Promise((res) => execFile(cmd, args, { timeout: 10000 }, (_e, out) => res(String(out ?? ''))));
}
async function serverCpu(): Promise<number> {
  if (!server?.pid) return NaN;
  const out = await sh('ps', ['-axo', 'pgid=,%cpu=']);
  return out.split('\n').map((l) => l.trim().split(/\s+/)).filter((p) => Number(p[0]) === server!.pid).reduce((s, p) => s + Number(p[1]), 0);
}
async function pgCpu(): Promise<number> {
  const out = await sh('docker', ['stats', '--no-stream', '--format', '{{.CPUPerc}}', PG_CONTAINER]);
  return Number(out.trim().replace('%', ''));
}

// ---------- DB setup ----------
// Docker's 64 MB /dev/shm is too small for parallel workers on the 1.6M-row setup statements
const admin = new Pool({ connectionString: DB, max: 4, options: '-c max_parallel_workers_per_gather=0 -c max_parallel_maintenance_workers=0' });
async function setupDb() {
  const { seed } = await import('../db/seed');
  process.chdir(ROOT);
  log(`seeding ${DB}: ${CONTRIBUTORS} contributors, 16 x ${SCRIPTS_PER_LANG} scripts`);
  await seed({ databaseUrl: DB, contributors: CONTRIBUTORS, scriptsPerLanguage: SCRIPTS_PER_LANG });
  await admin.query(`INSERT INTO contributors (id, language) VALUES ($1, 'en') ON CONFLICT DO NOTHING`, [PROBE_ID]);
  // A realistic mix: the first ~40% of each language's scripts are done (as lowest-id-first claiming leaves it),
  // 5% of those were QA-rejected and are back in the pool (QA rejection does not set prev_token); the rest is never-claimed.
  await admin.query(`
    WITH r AS (SELECT id, row_number() OVER (PARTITION BY language ORDER BY id) AS rn, count(*) OVER (PARTITION BY language) AS n FROM scripts)
    UPDATE scripts s SET status = CASE WHEN r.rn % 20 = 0 THEN 'available' WHEN r.rn % 7 = 0 THEN 'submitted' ELSE 'approved' END,
      claimed_at = now() - interval '1 day'
    FROM r WHERE s.id = r.id AND r.rn <= r.n * 0.4`);
  await admin.query('VACUUM ANALYZE');
  const mix = (await admin.query(`SELECT status, (prev_token IS NOT NULL) AS has_prev, count(*) AS n FROM scripts GROUP BY 1, 2 ORDER BY 1, 2`)).rows;
  log('status mix', mix.map((r) => `${r.status}${r.has_prev ? '+prev' : ''}=${r.n}`).join(' '));
  return mix;
}
async function resetDb() {
  await admin.query(`UPDATE scripts SET status = 'available', claimed_by = NULL, claim_token = NULL, claimed_at = NULL, lease_expires_at = NULL,
    prev_token = NULL, prev_claimed_by = NULL, times_claimed = 0 WHERE times_claimed > 0 OR status = 'claimed'`);
  await admin.query('TRUNCATE claim_events');
  await admin.query('VACUUM ANALYZE scripts');
  await admin.query('VACUUM ANALYZE claim_events');
}

// ---------- EXPLAIN ----------
async function explain(sql: string, params: unknown[], analyze = true, withText = true): Promise<{ text: string; ms: number; json: any }> {
  const c = await admin.connect();
  try {
    await c.query('BEGIN');
    const j = (await c.query(`EXPLAIN (ANALYZE ${analyze}, BUFFERS, FORMAT JSON) ${sql}`, params)).rows[0]['QUERY PLAN'][0];
    await c.query('ROLLBACK');
    if (!withText) return { text: '', ms: j['Execution Time'] ?? NaN, json: j };
    await c.query('BEGIN');
    const t = (await c.query(`EXPLAIN (ANALYZE ${analyze}, BUFFERS) ${sql}`, params)).rows.map((r) => r['QUERY PLAN']).join('\n');
    await c.query('ROLLBACK');
    return { text: t, ms: j['Execution Time'] ?? NaN, json: j };
  } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; } finally { c.release(); }
}
const pickParams = (lang = 'en') => [PROBE_ID, lang, LEASE_S];

// ---------- one level ----------
type Scenario = { name: string; level: number; hot: boolean; pgPoolMax: number; measureS?: number };
type Pcts = { n: number; p50: number; p95: number; p99: number; max: number };
type LevelResult = {
  scenario: Scenario; targetClaimsPerS: number; liveAtStart: number; achievedClaimsPerS: number; achievedHbPerS: number; achievedReqPerS: number;
  claim: Pcts; heartbeat: Pcts; release: Pcts; errors: number; errorRate: number; hb409: number; claimStatus: Record<string, number>;
  serverCpu: number; pgCpu: number; pgActive: number; pgIdleInTx: number; pgLockWait: number; pgLwlockWait: number; pgPoolMax: number; tps: number;
  dbPickMs: number[]; dbReviveMs: number[]; clientLoopP99: number; inflightMax: number;
};
const pcts = (xs: number[]): Pcts => {
  const s = [...xs].sort((a, b) => a - b);
  const p = (q: number) => (s.length ? s[Math.min(s.length - 1, Math.ceil(q * s.length) - 1)] : NaN);
  return { n: s.length, p50: p(0.5), p95: p(0.95), p99: p(0.99), max: s.length ? s[s.length - 1] : NaN };
};

const contributorsByLang = new Map<string, number[]>();
async function loadContributors() {
  const r = await admin.query('SELECT id, language FROM contributors WHERE id <= $1 ORDER BY id', [CONTRIBUTORS]);
  for (const row of r.rows) { const l = contributorsByLang.get(row.language) ?? []; l.push(row.id); contributorsByLang.set(row.language, l); }
}

async function runLevel(sc: Scenario, seed: number): Promise<LevelResult> {
  const rng = makeRng(seed);
  const R = sc.level; // claims/s; 1x = 1 claim/s
  const measureS = sc.measureS ?? MEASURE_S;
  await resetDb();
  // idle contributors: everyone (spread mode) or one language's contributors (hot mode: all claim 'en')
  const pool0 = sc.hot ? [...(contributorsByLang.get('en') ?? [])] : [...contributorsByLang.values()].flat();
  const idle = pool0;
  const take = () => { const i = rng.int(idle.length); const id = idle[i]; idle[i] = idle[idle.length - 1]; idle.pop(); return id; };
  const body = sc.hot ? { language: 'en' } : {};
  // steady-state start: N0 = R x E[session] live leases
  const n0 = Math.round(R * E_SESSION_S);
  if (n0 > idle.length * 0.8) throw new Error(`level ${R}: need ${n0} live sessions, only ${idle.length} contributors`);
  const pre = Array.from({ length: n0 }, () => take());
  const t = await admin.query(`
    WITH c AS (SELECT u.id, ${sc.hot ? `'en'::text` : 'k.language'} AS language, row_number() OVER (PARTITION BY ${sc.hot ? `'en'::text` : 'k.language'} ORDER BY u.id) AS rn
               FROM unnest($1::int[]) AS u(id) JOIN contributors k ON k.id = u.id),
         f AS (SELECT id, language, row_number() OVER (PARTITION BY language ORDER BY id) AS rn FROM scripts WHERE status = 'available' ${sc.hot ? `AND language = 'en'` : ''})
    UPDATE scripts s SET status = 'claimed', claimed_by = c.id, claim_token = gen_random_uuid(), claimed_at = now(),
      lease_expires_at = now() + make_interval(secs => ${LEASE_S}), prev_token = NULL, prev_claimed_by = NULL, times_claimed = s.times_claimed + 1
    FROM f JOIN c USING (language, rn) WHERE s.id = f.id
    RETURNING s.claimed_by AS who, s.claim_token AS token`, [pre]);
  await admin.query('ANALYZE scripts');
  log(`${sc.name}: ${R} claims/s target, ${t.rowCount} live leases pre-populated`);

  let stopped = false;
  const timers = new Set<NodeJS.Timeout>();
  const later = (ms: number, fn: () => void) => { const h = setTimeout(() => { timers.delete(h); if (!stopped) fn(); }, ms); timers.add(h); };
  let inflight = 0, inflightMax = 0;
  const track = <T>(p: Promise<T>) => { inflight++; inflightMax = Math.max(inflightMax, inflight); return p.finally(() => { inflight--; }); };
  const lengthBiased = () => { for (;;) { const L = SESSION_MEDIAN_S * Math.exp(SESSION_SIGMA * rng.normal()); if (rng.next() < L / (SESSION_MEDIAN_S * 6)) return L; } };
  const runSession = (who: number, token: string, remainingS: number, firstHbS: number) => {
    const endAt = Date.now() + remainingS * 1000;
    const hb = (delayS: number) => later(delayS * 1000, async () => {
      if (Date.now() >= endAt) return;
      await track(post(`/api/claims/${token}/heartbeat`, who, {}));
      if (Date.now() + HB_S * 1000 < endAt) hb(HB_S);
    });
    if (firstHbS < remainingS) hb(firstHbS);
    later(remainingS * 1000, async () => { await track(post(`/api/claims/${token}/release?contributor=${who}`, who, {})); idle.push(who); });
  };
  for (const r of t.rows) { const L = lengthBiased(); runSession(r.who, r.token, rng.next() * L, rng.next() * HB_S); }

  const claimStatus: Record<string, number> = {};
  const arrive = async () => {
    if (!idle.length) { claimStatus.no_idle_contributor = (claimStatus.no_idle_contributor ?? 0) + 1; return; }
    const who = take();
    const r = await track(post('/api/claims', who, body));
    const k = r.status === 200 ? String(r.json?.status) : `http_${r.status}`;
    claimStatus[k] = (claimStatus[k] ?? 0) + 1;
    if (r.status === 200 && r.json?.token) runSession(who, r.json.token, Math.min(2700, SESSION_MEDIAN_S * Math.exp(SESSION_SIGMA * rng.normal())), HB_S);
    else idle.push(who);
  };
  // open loop: Poisson arrivals, scheduled against the wall clock so a slow server doesn't slow the arrivals
  samples = [];
  const t0 = Date.now();
  const tMeasure = t0 + WARMUP_S * 1000;
  const tEnd = tMeasure + measureS * 1000;
  const arrivals = (async () => {
    let next = Date.now();
    while (next < tEnd) {
      next += -Math.log(1 - rng.next()) * (1000 / R);
      const wait = next - Date.now();
      if (wait > 1) await sleep(wait);
      if (Date.now() >= tEnd) break;
      void arrive();
    }
  })();

  // sampling during the measured window
  const loop = monitorEventLoopDelay({ resolution: 10 });
  const cpuS: number[] = [], pgS: number[] = [], act: number[] = [], iit: number[] = [], lockW: number[] = [], lwW: number[] = [];
  const dbPick: number[] = [], dbRevive: number[] = [];
  let tx0 = 0, tx1 = 0;
  await sleep(tMeasure - Date.now());
  loop.enable();
  tx0 = Number((await admin.query(`SELECT xact_commit + xact_rollback AS n FROM pg_stat_database WHERE datname = current_database()`)).rows[0].n);
  const sampler = (async () => {
    let i = 0;
    while (Date.now() < tEnd - 500) {
      const a = (await admin.query(`SELECT state, wait_event_type, count(*) AS n FROM pg_stat_activity
        WHERE datname = current_database() AND pid <> pg_backend_pid() AND backend_type = 'client backend' AND query NOT LIKE '%pg_stat_activity%' GROUP BY 1, 2`)).rows;
      const n = (pred: (r: any) => boolean) => a.filter(pred).reduce((s, r) => s + Number(r.n), 0);
      act.push(n((r) => r.state === 'active')); iit.push(n((r) => r.state === 'idle in transaction'));
      lockW.push(n((r) => r.wait_event_type === 'Lock')); lwW.push(n((r) => r.wait_event_type === 'LWLock'));
      if (i % 10 === 0) {
        // Postgres-side execution time of the claim's pick and revive statements under load (rolled back)
        try { dbPick.push((await explain(PICK_SQL, pickParams(), true, false)).ms); dbRevive.push((await explain(REVIVE_SQL, [PROBE_ID, LEASE_S], true, false)).ms); } catch { /* ignore */ }
      }
      i++;
      await sleep(200);
    }
  })();
  const cpuLoop = (async () => { while (Date.now() < tEnd - 1500) { cpuS.push(await serverCpu()); await sleep(1000); } })();
  const pgLoop = (async () => { while (Date.now() < tEnd - 2500) { pgS.push(await pgCpu()); } })();
  await Promise.all([arrivals, sampler, cpuLoop, pgLoop]);
  tx1 = Number((await admin.query(`SELECT xact_commit + xact_rollback AS n FROM pg_stat_database WHERE datname = current_database()`)).rows[0].n);
  loop.disable();
  stopped = true;
  for (const h of timers) clearTimeout(h);
  timers.clear();
  const tw = Date.now();
  while (inflight > 0 && Date.now() - tw < 15000) await sleep(100);

  const win = samples.filter((s) => s.t >= tMeasure && s.t <= tEnd);
  const of = (ep: string) => win.filter((s) => s.ep === ep);
  const ok = (s: Sample) => s.status > 0 && s.status < 500;
  const errors = win.filter((s) => !ok(s)).length;
  const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
  const res: LevelResult = {
    scenario: sc, targetClaimsPerS: R, liveAtStart: t.rowCount ?? 0,
    achievedClaimsPerS: of('claim').filter(ok).length / measureS, achievedHbPerS: of('heartbeat').filter(ok).length / measureS, achievedReqPerS: win.filter(ok).length / measureS,
    claim: pcts(of('claim').map((s) => s.ms)), heartbeat: pcts(of('heartbeat').map((s) => s.ms)), release: pcts(of('release').map((s) => s.ms)),
    errors, errorRate: win.length ? errors / win.length : 0, hb409: of('heartbeat').filter((s) => s.status === 409).length, claimStatus,
    serverCpu: avg(cpuS), pgCpu: avg(pgS.filter(Number.isFinite)), pgActive: avg(act), pgIdleInTx: avg(iit), pgLockWait: avg(lockW), pgLwlockWait: avg(lwW), pgPoolMax: sc.pgPoolMax,
    tps: (tx1 - tx0) / measureS, dbPickMs: dbPick, dbReviveMs: dbRevive, clientLoopP99: loop.percentile(99) / 1e6, inflightMax,
  };
  log(`${sc.name}: claims ${res.achievedClaimsPerS.toFixed(1)}/s hb ${res.achievedHbPerS.toFixed(1)}/s; claim p50/p95/p99 ${res.claim.p50.toFixed(1)}/${res.claim.p95.toFixed(1)}/${res.claim.p99.toFixed(1)} ms; hb p95 ${res.heartbeat.p95.toFixed(1)}; errors ${errors}; node ${res.serverCpu.toFixed(0)}% pg ${res.pgCpu.toFixed(0)}%; pg active ${res.pgActive.toFixed(1)} idle-in-tx ${res.pgIdleInTx.toFixed(1)}; db pick ${med(dbPick).toFixed(2)} ms revive ${med(dbRevive).toFixed(2)} ms; client loop p99 ${res.clientLoopP99.toFixed(0)} ms`);
  await sleep(2000);
  return res;
}
const med = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : NaN; };

// ---------- 5. lock comparison: SKIP LOCKED vs plain FOR UPDATE, direct SQL, one language ----------
// K concurrent closed-loop claimers in 'en': pick + update (the claim's step 3), hold 0 ms, then put the row back.
// The FOR UPDATE variant is a throwaway copy of the query with SKIP LOCKED removed; lib/ is untouched.
async function lockCompare(): Promise<{ variant: string; k: number; n: number; perS: number; p50: number; p95: number; p99: number }[]> {
  const out: { variant: string; k: number; n: number; perS: number; p50: number; p95: number; p99: number }[] = [];
  const en = contributorsByLang.get('en')!;
  for (const variant of ['skip_locked', 'for_update']) {
    for (const k of [1, 4, 16, 32]) {
      await resetDb();
      const sql = variant === 'skip_locked' ? PICK_SQL : PICK_SQL.replace('FOR UPDATE SKIP LOCKED', 'FOR UPDATE');
      const p = new Pool({ connectionString: DB, max: k });
      const lat: number[] = [];
      const until = Date.now() + 15000;
      await Promise.all(Array.from({ length: k }, async (_, w) => {
        let i = 0;
        while (Date.now() < until) {
          const who = en[(w * 7919 + i++ * 31) % en.length];
          const c = await p.connect();
          const t = performance.now();
          try {
            await c.query('BEGIN');
            const r = await c.query(sql, [who, 'en', LEASE_S]);
            await c.query('COMMIT');
            lat.push(performance.now() - t);
            if (r.rowCount) await c.query(`UPDATE scripts SET status = 'available', claimed_by = NULL, claim_token = NULL, lease_expires_at = NULL WHERE id = $1`, [r.rows[0].id]);
          } catch { await c.query('ROLLBACK').catch(() => {}); } finally { c.release(); }
        }
      }));
      await p.end();
      const s = pcts(lat);
      out.push({ variant, k, n: s.n, perS: s.n / 15, p50: s.p50, p95: s.p95, p99: s.p99 });
      log(`lock ${variant} k=${k}: ${(s.n / 15).toFixed(0)} claims/s p50/p95/p99 ${s.p50.toFixed(2)}/${s.p95.toFixed(2)}/${s.p99.toFixed(2)} ms`);
    }
  }
  return out;
}

// ---------- main ----------
async function main() {
  const tStart = Date.now();
  writeFileSync(join(RES, 'loadtest_server.log'), '');
  const mix = await setupDb();
  await loadContributors();
  const explains: string[] = [];
  const explainState = async (label: string) => {
    const pick = await explain(PICK_SQL, pickParams());
    const fresh = await explain(PICK_FRESH_SQL, pickParams());
    const revive = await explain(REVIVE_SQL, [PROBE_ID, LEASE_S]);
    const resume = await explain(RESUME_SQL, [PROBE_ID, LEASE_S]);
    explains.push(`==== ${label} ====\n\n-- claim step 3 (pick + update), CLAIM_ORDER=lowest_id, language 'en'\n${pick.text}\n\n-- same, CLAIM_ORDER=fresh_first\n${fresh.text}\n\n-- claim step 2 (revive own expired lease)\n${revive.text}\n\n-- claim step 1 (resume live lease)\n${resume.text}\n`);
    return { pick: pick.ms, fresh: fresh.ms, revive: revive.ms, resume: resume.ms, pickPlan: pick.text, revivePlan: revive.text, freshPlan: fresh.text };
  };

  const results: LevelResult[] = [];
  const explainAt: Record<string, Awaited<ReturnType<typeof explainState>>> = {};
  await resetDb();
  explainAt.idle = await explainState('table at rest: 1.6M scripts, no live leases');
  await startServer(20);
  const runScenario = async (sc: Scenario) => { const r = await runLevel(sc, 1000 + results.length); results.push(r); return r; };
  const pass = (r: LevelResult) => r.claim.p95 <= KNEE_MS && r.errors === 0;

  for (const L of LEVELS) await runScenario({ name: `${L}x`, level: L, hot: false, pgPoolMax: 20, measureS: L === 1 ? 120 : MEASURE_S });
  // knee search: keep raising until p95 > 50 ms or errors; then bisect (geometric) between the last pass and first fail
  if (REFINE) {
    let lo = Math.max(...results.filter(pass).map((r) => r.targetClaimsPerS), 0);
    let hi = Math.min(...results.filter((r) => !pass(r)).map((r) => r.targetClaimsPerS), Infinity);
    while (!Number.isFinite(hi) && lo < 2000) { const r = await runScenario({ name: `${lo * 2}x`, level: lo * 2, hot: false, pgPoolMax: 20 }); if (pass(r)) lo *= 2; else hi = lo * 2; }
    for (let i = 0; i < 3 && hi / lo > 1.25 && lo > 0; i++) {
      const mid = Math.round(Math.sqrt(lo * hi));
      const r = await runScenario({ name: `${mid}x`, level: mid, hot: false, pgPoolMax: 20 });
      if (pass(r)) lo = mid; else hi = mid;
    }
  }
  const spread = results.filter((r) => !r.scenario.hot && r.scenario.pgPoolMax === 20).sort((a, b) => a.targetClaimsPerS - b.targetClaimsPerS);
  const kneeLo = Math.max(0, ...spread.filter(pass).map((r) => r.targetClaimsPerS));
  const kneeHi = Math.min(Infinity, ...spread.filter((r) => !pass(r)).map((r) => r.targetClaimsPerS));
  log(`knee between ${kneeLo} and ${kneeHi} claims/s`);

  // EXPLAIN with the live leases of 100x in the table (30k live leases sit at the low ids the claim scans first)
  if (!SKIP.has('explain')) {
    await resetDb();
    const n0 = Math.round(100 * E_SESSION_S);
    const ids = [...contributorsByLang.values()].flat().slice(0, n0);
    await admin.query(`
      WITH c AS (SELECT k.id, k.language, row_number() OVER (PARTITION BY k.language ORDER BY k.id) AS rn FROM contributors k WHERE k.id = ANY($1::int[])),
           f AS (SELECT id, language, row_number() OVER (PARTITION BY language ORDER BY id) AS rn FROM scripts WHERE status = 'available')
      UPDATE scripts s SET status = 'claimed', claimed_by = c.id, claim_token = gen_random_uuid(), claimed_at = now(),
        lease_expires_at = now() + make_interval(secs => ${LEASE_S}), times_claimed = s.times_claimed + 1
      FROM f JOIN c USING (language, rn) WHERE s.id = f.id`, [ids]);
    await admin.query('VACUUM ANALYZE scripts');
    explainAt.live100x = await explainState(`table with ${n0} live leases, all in en (the 100x lease count concentrated in the probed language: worst case)`);
  }

  // pool size: is the 20-connection pool the limit? same level as the first failing one, pool 10 / 50
  if (!SKIP.has('pool') && Number.isFinite(kneeHi)) {
    for (const pm of [50]) { await startServer(pm); await runScenario({ name: `${kneeHi}x pool${pm}`, level: kneeHi, hot: false, pgPoolMax: pm }); }
    await startServer(20);
  }
  // 5. hot language: everyone claims 'en'
  if (!SKIP.has('hot')) {
    for (const L of [1, 10, Math.max(10, kneeLo)].filter((x, i, a) => a.indexOf(x) === i)) await runScenario({ name: `${L}x hot-en`, level: L, hot: true, pgPoolMax: 20 });
  }
  await stopServer();
  const lock = SKIP.has('lock') ? [] : await lockCompare();

  // ---------- outputs ----------
  const csvRows = ['scenario,target_claims_per_s,live_leases_at_start,achieved_claims_per_s,achieved_heartbeats_per_s,achieved_req_per_s,claim_n,claim_p50_ms,claim_p95_ms,claim_p99_ms,claim_max_ms,hb_n,hb_p50_ms,hb_p95_ms,hb_p99_ms,release_p95_ms,errors,error_rate,hb_409,node_cpu_pct,pg_cpu_pct,pg_active_conns,pg_idle_in_tx_conns,pg_lock_waits,pg_lwlock_waits,pg_pool_max,pg_tps,db_pick_ms_median,db_revive_ms_median,client_loop_p99_ms,inflight_max'];
  for (const r of results) csvRows.push([r.scenario.name, r.targetClaimsPerS, r.liveAtStart, r.achievedClaimsPerS.toFixed(2), r.achievedHbPerS.toFixed(2), r.achievedReqPerS.toFixed(1), r.claim.n, r.claim.p50.toFixed(2), r.claim.p95.toFixed(2), r.claim.p99.toFixed(2), r.claim.max.toFixed(1), r.heartbeat.n, r.heartbeat.p50.toFixed(2), r.heartbeat.p95.toFixed(2), r.heartbeat.p99.toFixed(2), r.release.p95.toFixed(2), r.errors, r.errorRate.toFixed(5), r.hb409, r.serverCpu.toFixed(0), r.pgCpu.toFixed(0), r.pgActive.toFixed(2), r.pgIdleInTx.toFixed(2), r.pgLockWait.toFixed(2), r.pgLwlockWait.toFixed(2), r.pgPoolMax, r.tps.toFixed(0), med(r.dbPickMs).toFixed(3), med(r.dbReviveMs).toFixed(3), r.clientLoopP99.toFixed(1), r.inflightMax].join(','));
  writeFileSync(join(RES, 'loadtest.csv'), csvRows.join('\n') + '\n');
  if (lock.length) writeFileSync(join(RES, 'loadtest_locks.csv'), ['variant,concurrent_claimers,claims,claims_per_s,p50_ms,p95_ms,p99_ms', ...lock.map((l) => `${l.variant},${l.k},${l.n},${l.perS.toFixed(1)},${l.p50.toFixed(3)},${l.p95.toFixed(3)},${l.p99.toFixed(3)}`)].join('\n') + '\n');
  writeFileSync(join(RES, 'loadtest_explain.txt'), explains.join('\n'));
  const data = { results, lock, explainAt, kneeLo, kneeHi, mix: mix.map((r: any) => ({ status: r.status, hasPrev: r.has_prev, n: Number(r.n) })), realMinutes: (Date.now() - tStart) / 60000 };
  writeFileSync(join(RES, 'loadtest.json'), JSON.stringify(data, null, 2));
  renderLoad();
  log(`done in ${((Date.now() - tStart) / 60000).toFixed(1)} min`);
}

// ---------- loadtest.md (also: --report-only re-renders from loadtest.json) ----------
function renderLoad() {
  const j = JSON.parse(readFileSync(join(RES, 'loadtest.json'), 'utf8'));
  const R: LevelResult[] = j.results;
  const f = (x: number, d = 1) => (Number.isFinite(x) ? x.toFixed(d) : 'n/a');
  const spread = R.filter((r) => !r.scenario.hot && r.scenario.pgPoolMax === 20).sort((a, b) => a.targetClaimsPerS - b.targetClaimsPerS);
  const pass = (r: LevelResult) => r.claim.p95 <= KNEE_MS && r.errors === 0;
  const lo = spread.filter(pass).at(-1), hi = spread.find((r) => !pass(r));
  const L: string[] = ['# Load test', ''];
  const total = j.mix.reduce((s: number, m: any) => s + m.n, 0);
  L.push(`**Setup.** Real time (no scaling). One \`next start\` process (Next.js 15, Node ${process.version}) with a ${R[0]?.pgPoolMax ?? 20}-connection pg pool, Postgres 16 in Docker (max_connections 300), the load generator in a separate Node process (keep-alive HTTP), all on one 10-core laptop. Table: ${total.toLocaleString('en-US')} scripts (16 languages x ${SCRIPTS_PER_LANG.toLocaleString('en-US')}; ${j.mix.map((m: any) => `${m.status}${m.hasPrev ? ' with prev_token' : ''} ${m.n.toLocaleString('en-US')}`).join(', ')}), ${CONTRIBUTORS.toLocaleString('en-US')} contributors (80% in en/es/hi/pt). 1x = today's traffic: 1 claim/s, sessions lognormal (median 5 min, sigma ${SESSION_SIGMA}, mean ${f(E_SESSION_S / 60, 2)} min), heartbeat every ${HB_S} s, release at the end (no upload/submit; release is the same single-row UPDATE + audit insert as submit, and uploads go to MinIO, not Postgres). Open-loop Poisson arrivals at level x 1 claim/s; each level starts in steady state (level x ${f(E_SESSION_S, 0)} live leases written directly into the table, length-biased remaining lifetimes, random heartbeat phase), then ${WARMUP_S} s warm-up (discarded) and ${MEASURE_S} s measured (120 s at 1x). Latency is client-side, request start to last byte. "Error" = timeout (10 s), connection error or 5xx. Postgres-side: \`pg_stat_activity\` sampled every 200 ms (connections active / idle in transaction / waiting on locks), \`pg_stat_database\` commits per second, and the claim's pick statement and revive statement timed with \`EXPLAIN ANALYZE\` (in a rolled-back transaction, for a probe contributor) every ~2 s during the level. pg_stat_statements isn't loaded in this container, so that is the DB-side measure. CPU: \`ps\` for the Node server (100% = one core), \`docker stats\` for Postgres.`, '');
  L.push('| Scenario | Target claims/s | Live leases | Achieved claims/s | Heartbeats/s | Claim p50 / p95 / p99 (ms) | Heartbeat p50 / p95 / p99 (ms) | Release p95 | Errors | Node CPU % | Postgres CPU % | PG conns active / idle-in-tx (pool) | Lock waits | Commits/s | DB pick / revive exec (ms, median) | Client loop p99 (ms) |');
  L.push('|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|');
  for (const r of R) L.push(`| ${r.scenario.name} | ${r.targetClaimsPerS} | ${r.liveAtStart.toLocaleString('en-US')} | ${f(r.achievedClaimsPerS)} | ${f(r.achievedHbPerS)} | ${f(r.claim.p50)} / **${f(r.claim.p95)}** / ${f(r.claim.p99)} | ${f(r.heartbeat.p50)} / ${f(r.heartbeat.p95)} / ${f(r.heartbeat.p99)} | ${f(r.release.p95)} | ${r.errors}${r.errors ? ` (${f(100 * r.errorRate, 2)}%)` : ''} | ${f(r.serverCpu, 0)} | ${f(r.pgCpu, 0)} | ${f(r.pgActive)} / ${f(r.pgIdleInTx)} (${r.pgPoolMax}) | ${f(r.pgLockWait, 2)} | ${f(r.tps, 0)} | ${f(med(r.dbPickMs), 2)} / ${f(med(r.dbReviveMs), 2)} | ${f(r.clientLoopP99, 0)} |`);
  L.push('');
  const knee = lo ? `**One Postgres + one Node process handles ~${lo.targetClaimsPerS} claims/s (${lo.targetClaimsPerS}x today's traffic, plus ${f(lo.achievedHbPerS, 0)} heartbeats/s) with claim p95 ${f(lo.claim.p95)} ms**${hi ? `; at ${hi.targetClaimsPerS} claims/s p95 is ${f(hi.claim.p95)} ms${hi.errors ? ` with ${hi.errors} errors` : ''}` : ''}. This is a laptop: Node, Postgres (in a Docker VM) and the load generator share 10 cores with whatever else is running.` : 'No level passed.';
  L.push('**Knee.** ' + knee, '');
  L.push('<!-- LOAD_INTERP -->', '');
  if (j.lock?.length) {
    L.push('## Hot language: SKIP LOCKED vs plain FOR UPDATE', '');
    L.push('Direct SQL (no HTTP), all claimers in `en`, K concurrent closed-loop claimers for 15 s each: the claim\'s pick+update in its own transaction, then the row is put back (so everyone keeps competing for the lowest ids). `for_update` is a throwaway copy of the query with `SKIP LOCKED` removed (lib/ untouched).', '');
    L.push('| Variant | Concurrent claimers | Claims/s | p50 (ms) | p95 (ms) | p99 (ms) |', '|---|---|---|---|---|---|');
    for (const l of j.lock) L.push(`| ${l.variant} | ${l.k} | ${f(l.perS, 0)} | ${f(l.p50, 2)} | ${f(l.p95, 2)} | ${f(l.p99, 2)} |`);
    L.push('', '<!-- LOCK_INTERP -->', '');
  }
  L.push('## EXPLAIN (ANALYZE, BUFFERS)', '');
  L.push(`Full plans: [loadtest_explain.txt](loadtest_explain.txt) (current lib/, fresh_first v3)${j.explainV3 ? ' and [loadtest_explain_v2.txt](loadtest_explain_v2.txt) (the build the load test ran on, fresh_first v2)' : ''}. The SQL is read from lib/assign.ts at run time, so it is exactly what ships. Execution time (ms) for a probe contributor in \`en\`:`, '');
  L.push('| Code | Table state | claim pick (lowest_id; v3 fallback) | claim pick (fresh_first) | revive own expired lease | resume live lease |', '|---|---|---|---|---|---|');
  const stateLabel = (k: string) => (k === 'idle' ? 'at rest, 0 live leases' : `${Math.round(100 * E_SESSION_S).toLocaleString('en-US')} live leases, all in en (100x lease count in one language, worst case)`);
  for (const [k, v] of Object.entries(j.explainAt as Record<string, any>)) L.push(`| fresh_first v2 | ${stateLabel(k)} | ${f(v.pick, 3)} | ${f(v.fresh, 3)} (one sorted query) | ${f(v.revive, 3)} | ${f(v.resume, 3)} |`);
  if (j.explainV3) for (const [k, v] of Object.entries(j.explainV3 as Record<string, any>)) L.push(`| fresh_first v3 (current) | ${stateLabel(k)} | ${f(v.pick, 3)} | ${f(v.fresh, 3)} (scripts_fresh) | ${f(v.revive, 3)} | ${f(v.resume, 3)} |`);
  L.push('', '<!-- EXPLAIN_INTERP -->', '');
  writeFileSync(join(RES, 'loadtest.md'), interpretLoad(L.join('\n'), j, R, spread, lo, hi, f));
}

function interpretLoad(text: string, j: any, R: LevelResult[], spread: LevelResult[], lo: LevelResult | undefined, hi: LevelResult | undefined, f: (x: number, d?: number) => string): string {
  const by = (name: string) => R.find((r) => r.scenario.name === name);
  const p50 = by(`${hi?.targetClaimsPerS}x pool50`);
  const top = spread.at(-1);
  const hot = R.filter((r) => r.scenario.hot).sort((a, b) => a.targetClaimsPerS - b.targetClaimsPerS);
  const loadInterp: string[] = [];
  if (lo && hi) {
    loadInterp.push(`**Where the bottleneck is.** Not Postgres's execution capacity: even at ${hi.targetClaimsPerS} claims/s only ${f(hi.pgActive)} backends were executing a statement on average, and the claim's pick statement took ${f(med(hi.dbPickMs), 2)} ms inside Postgres. What runs out is the pg pool, because of how long each transaction holds its connection: a claim is ~7 round trips (BEGIN, contributor, resume, revive, pick, audit insert, COMMIT) and every round trip waits for a turn of the single Node event loop. As Node gets busy (${f(lo.serverCpu, 0)}% of one core at ${lo.targetClaimsPerS}/s, ${f(hi.serverCpu, 0)}% at ${hi.targetClaimsPerS}/s${top && top !== hi ? `, ${f(top.serverCpu, 0)}% at ${top.targetClaimsPerS}/s` : ''}), connections sit "idle in transaction" (${f(lo.pgIdleInTx)} on average at ${lo.targetClaimsPerS}/s, ${f(hi.pgIdleInTx)} at ${hi.targetClaimsPerS}/s), bursts exhaust the 20 connections, and requests queue: at ${hi.targetClaimsPerS}/s the median claim is still ${f(hi.claim.p50)} ms but p95 is ${f(hi.claim.p95)} ms (bimodal: fast, or queued behind the pool).`);
    if (p50) loadInterp.push('', `Raising the pool to 50 connections at the same ${hi.targetClaimsPerS} claims/s brought claim p95 from ${f(hi.claim.p95)} to ${f(p50.claim.p95)} ms (p99 ${f(p50.claim.p99)} ms)${p50.errors ? `, with ${p50.errors} requests that got no HTTP response or a 5xx (${f(100 * p50.errorRate, 3)}%)` : ''}. So the first limit is pool size vs. Node turnaround; the next is the Node process itself, near one full core at ${top?.targetClaimsPerS ?? hi.targetClaimsPerS}/s (${f(top?.serverCpu ?? hi.serverCpu, 0)}%). Postgres used ${f(hi.pgCpu, 0)}% of a core at ${hi.targetClaimsPerS}/s (${f(hi.tps, 0)} commits/s: every heartbeat is an UPDATE plus an audit insert). One run per level, so the exact knee position (between ${lo.targetClaimsPerS} and ${hi.targetClaimsPerS}) carries run-to-run noise.`);
    loadInterp.push('', `**What scales next.** Before Postgres: more Node processes and a bigger pool, or fewer round trips per claim (one SQL function instead of ~7 statements). The DB-side pick cost grows with the number of live leases in the language, because lowest-id order scans past them in the \`scripts_free\` index (${f(med(by('1x')?.dbPickMs ?? []), 2)} ms at 1x vs ${f(med(by('100x')?.dbPickMs ?? []), 2)} ms at 100x under load; see EXPLAIN below). Heartbeats are ~92% of requests; at 100x that is ~1,000 writes/s plus audit rows, the first thing to move off the primary (e.g. to Redis) if traffic ever gets there. Today's traffic (1x) uses ${f(by('1x')?.serverCpu ?? NaN, 0)}% of a core for Node and ${f(by('1x')?.pgCpu ?? NaN, 0)}% for Postgres.`);
    if (hot.length) loadInterp.push('', `**Hot language (all claims in en).** Claim p95 ${hot.map((r) => `${f(r.claim.p95)} ms at ${r.targetClaimsPerS}/s`).join(', ')}, vs ${hot.map((r) => { const s2 = spread.find((x) => x.targetClaimsPerS === r.targetClaimsPerS); return s2 ? `${f(s2.claim.p95)} ms` : 'n/a'; }).join(', ')} with claims spread over 16 languages. No errors, and essentially no lock waits (${hot.map((r) => f(r.pgLockWait, 2)).join(', ')} sessions waiting on a lock on average). What does grow is the pick statement (${hot.map((r) => `${f(med(r.dbPickMs), 2)} ms`).join(', ')}), because all live leases are now in the one language the index scan walks.`);
  }
  let out = text.replace('<!-- LOAD_INTERP -->', loadInterp.join('\n'));
  const lk = j.lock as { variant: string; k: number; perS: number; p95: number; p99: number }[];
  if (lk?.length) {
    const g = (v: string, k: number) => lk.find((x) => x.variant === v && x.k === k);
    const kmax = Math.max(...lk.map((x) => x.k));
    const s1 = g('skip_locked', kmax), f1 = g('for_update', kmax), s0 = g('skip_locked', 1);
    out = out.replace('<!-- LOCK_INTERP -->', `**Interpretation.** With SKIP LOCKED, claims scale with concurrency (${s0 ? f(s0.perS, 0) : 'n/a'}/s with 1 claimer, ${s1 ? f(s1.perS, 0) : 'n/a'}/s with ${kmax}) and p95 stays at ${s1 ? f(s1.p95, 1) : 'n/a'} ms. Without it, claimers queue on the same lowest row; each waiter re-checks the row after the holder commits and moves on to the next one, so throughput flattens (${f1 ? f(f1.perS, 0) : 'n/a'}/s at ${kmax}) and the tail grows (p95 ${f1 ? f(f1.p95, 1) : 'n/a'} ms, p99 ${f1 ? f(f1.p99, 1) : 'n/a'} ms vs ${s1 ? f(s1.p99, 1) : 'n/a'} ms). Both rates are far above what the HTTP path reaches (the Node process limits it first), so in the HTTP test SKIP LOCKED shows up only as the flat hot-language latency above.`);
  }
  const e = j.explainAt as Record<string, { pick: number; fresh: number; revive: number; resume: number }>;
  if (e?.idle) out = out.replace('<!-- EXPLAIN_INTERP -->', [
    `**Indexes used.** The lowest_id pick is an \`Index Scan using scripts_free\` (\`(language, id) WHERE status IN ('available','claimed')\`) under \`LIMIT 1 ... FOR UPDATE SKIP LOCKED\`: it reads the language's free rows in id order and stops at the first unlocked match (${f(e.idle.pick, 2)} ms at rest). Its cost is proportional to the live leases ahead of the first free row: with ${Math.round(100 * E_SESSION_S).toLocaleString('en-US')} live leases in the probed language it filters out all of them (${f(e.live100x?.pick ?? NaN, 2)} ms, ~4,700 buffers). Spread over 16 languages at 100x, roughly a quarter of that lands in each popular language, consistent with the ~2 ms measured under load. Resume uses \`one_claim_per_contributor\` (${f(e.idle.resume, 3)} ms); revive uses a BitmapOr of \`one_claim_per_contributor\` and \`scripts_prev_token\` (${f(e.idle.revive, 3)} ms; it reads every row that has a prev_token, since there is no index on \`prev_claimed_by\`, so its cost grows with released or expired rows nobody has re-claimed).`,
    '',
    `**fresh_first v2 (the build this load test ran on) did not use the index order.** \`ORDER BY (status <> 'available' OR prev_token IS NOT NULL), id\` is an expression, so Postgres bitmap-scans every free row of the language (62,000 for en here) and sorts them, spilling to disk (\`Sort Method: external merge\`) because they exceed work_mem: ${f(e.idle.fresh, 1)} ms per claim at rest vs ${f(e.idle.pick, 2)} ms for lowest_id. At 1x that is invisible; at the measured knee (~${lo?.targetClaimsPerS ?? 'n/a'} claims/s) it would be ~${f((e.idle.fresh * (lo?.targetClaimsPerS ?? 57)) / 1000, 1)} s of Postgres time per second. ${j.explainV3 ? `**Fixed in v3 (current lib/):** a partial index \`scripts_fresh (language, id) WHERE status = 'available' AND prev_token IS NULL\` is tried first with \`LIMIT 1 ... SKIP LOCKED\`, and the lowest_id query is the fallback. Re-measured on a freshly seeded 16 x 100k table: the fresh pick takes ${f(j.explainV3.idle.fresh, 3)} ms at rest and ${f(j.explainV3.live100x.fresh, 3)} ms with the worst-case live leases (it never visits claimed rows), the fallback ${f(j.explainV3.idle.pick, 3)} / ${f(j.explainV3.live100x.pick, 3)} ms. The HTTP load levels above ran with lowest_id, so they are unaffected.` : `Fix (not tested here): a second partial index \`(language, id) WHERE status = 'available' AND prev_token IS NULL\`, try it first with \`LIMIT 1 ... SKIP LOCKED\`, and fall back to the lowest_id query when it finds nothing.`}`,
  ].join('\n'));
  if (lo) {
    j.summary = `one Postgres + one Node process handles **~${lo.targetClaimsPerS} claims/s** (${lo.targetClaimsPerS}x today's 1 claim/s, plus ${f(lo.achievedHbPerS, 0)} heartbeats/s) **before claim p95 > 50 ms** on this laptop (p95 ${f(lo.claim.p95)} ms there${hi ? `; ${f(hi.claim.p95)} ms at ${hi.targetClaimsPerS}/s` : ''}). The limit is the 20-connection pg pool waiting on the single Node event loop (connections idle in transaction), not Postgres${hi && p50 ? `: at ${hi.targetClaimsPerS}/s only ${f(hi.pgActive)} backends were executing on average, and a 50-connection pool brought p95 back to ${f(p50.claim.p95)} ms` : ''}. 1x: claim p95 ${f(by('1x')?.claim.p95 ?? NaN)} ms; 10x: ${f(by('10x')?.claim.p95 ?? NaN)} ms; 100x: ${f(by('100x')?.claim.p95 ?? NaN)} ms with ${by('100x')?.errors ?? 'n/a'} failed requests.`;
    j.section = ['| Level | Claims/s achieved | Heartbeats/s | Claim p50 / p95 / p99 (ms) | Errors | Node CPU % | Postgres CPU % |', '|---|---|---|---|---|---|---|',
      ...R.map((r) => `| ${r.scenario.name} | ${f(r.achievedClaimsPerS)} | ${f(r.achievedHbPerS)} | ${f(r.claim.p50)} / **${f(r.claim.p95)}** / ${f(r.claim.p99)} | ${r.errors} | ${f(r.serverCpu, 0)} | ${f(r.pgCpu, 0)} |`), '', `**Conclusion:** ${j.summary}`, '', 'Caveat: a laptop, with Node, Postgres (inside the Docker VM), MinIO and the load generator sharing 10 cores with other processes. A real database server has more headroom; what carries over is the shape: the pool / Node limit comes first, and the pick cost grows with live leases per language.'].join('\n');
    writeFileSync(join(RES, 'loadtest.json'), JSON.stringify(j, null, 2));
  }
  return out;
}

// --explain-only: re-seed the 16 x 100k table and EXPLAIN the current claim SQL (used after fresh_first v3 landed)
async function explainOnly() {
  const { existsSync: ex, renameSync } = await import('node:fs');
  await setupDb();
  await resetDb();
  const run = async () => ({
    pick: await explain(PICK_SQL, pickParams()), fresh: await explain(PICK_FRESH_SQL, pickParams()),
    revive: await explain(REVIVE_SQL, [PROBE_ID, LEASE_S]), resume: await explain(RESUME_SQL, [PROBE_ID, LEASE_S]),
  });
  const idle = await run();
  // worst case for the pick: the 100x live-lease count, all in the probed language
  const n0 = Math.round(100 * E_SESSION_S);
  await admin.query(`
    WITH c AS (SELECT id, row_number() OVER (ORDER BY id) AS rn FROM contributors WHERE id <= $1),
         f AS (SELECT id, row_number() OVER (ORDER BY id) AS rn FROM scripts WHERE status = 'available' AND language = 'en')
    UPDATE scripts s SET status = 'claimed', claimed_by = c.id, claim_token = gen_random_uuid(), claimed_at = now(),
      lease_expires_at = now() + make_interval(secs => ${LEASE_S}), times_claimed = s.times_claimed + 1
    FROM f JOIN c USING (rn) WHERE s.id = f.id`, [n0]);
  await admin.query('VACUUM ANALYZE scripts');
  const live = await run();
  const txt = (label: string, r: Awaited<ReturnType<typeof run>>) => `==== ${label} ====\n\n-- claim step 3, lowest_id (and fresh_first's fallback): candidates ${PICK_CANDIDATES}\n${r.pick.text}\n\n-- claim step 3, fresh_first first query: candidates ${FRESH_CANDIDATES}\n${r.fresh.text}\n\n-- claim step 2 (revive own expired lease)\n${r.revive.text}\n\n-- claim step 1 (resume live lease)\n${r.resume.text}\n`;
  if (ex(join(RES, 'loadtest_explain.txt')) && !ex(join(RES, 'loadtest_explain_v2.txt'))) renameSync(join(RES, 'loadtest_explain.txt'), join(RES, 'loadtest_explain_v2.txt'));
  writeFileSync(join(RES, 'loadtest_explain.txt'), [txt('table at rest: 1.6M scripts, no live leases (current lib/, fresh_first v3)', idle), txt(`table with ${n0} live leases, all in en (worst case), current lib/`, live)].join('\n'));
  const j = JSON.parse(readFileSync(join(RES, 'loadtest.json'), 'utf8'));
  const ms = (r: Awaited<ReturnType<typeof run>>) => ({ pick: r.pick.ms, fresh: r.fresh.ms, revive: r.revive.ms, resume: r.resume.ms });
  j.explainV3 = { idle: ms(idle), live100x: ms(live) };
  writeFileSync(join(RES, 'loadtest.json'), JSON.stringify(j, null, 2));
  log('v3 explain', JSON.stringify(j.explainV3));
}

if (argv.includes('--report-only')) { renderLoad(); process.exit(0); }
if (argv.includes('--explain-only')) { explainOnly().then(async () => { await admin.end(); renderLoad(); process.exit(0); }).catch((e) => { console.error(e); process.exit(1); }); }
else
main().then(async () => { await admin.end(); process.exit(0); }).catch(async (e) => { console.error(e); await stopServer(); process.exit(1); });
