// QA worker for the simulation, run as a child process (forked by simulate.ts) so audio analysis
// doesn't block the simulated clients' timers. Loops lib/qa.ts runQaOnce() with N concurrent loops.
// Env (DATABASE_URL, S3_*) comes from the parent. Parent sends {cmd:'drain'}: finish everything pending,
// report totals, exit.
import { runQaOnce, type QaResult } from '../lib/qa';
import { pool, closePool } from '../lib/db';

const loops = Number(process.env.SIM_QA_LOOPS ?? 2);
const limit = Number(process.env.SIM_QA_LIMIT ?? 100);
const idleMs = Number(process.env.SIM_QA_IDLE_MS ?? 1000);
const total: QaResult = { processed: 0, approved: 0, rejected: 0, review: 0, skipped: 0, errors: 0 };
let draining = false;
let batches = 0;
const quiet = { error: (...a: unknown[]) => console.error('[qa]', ...a), warn: () => {} };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function loop() {
  for (;;) {
    let r: QaResult;
    try {
      r = await runQaOnce({ limit, logger: quiet });
    } catch (e) {
      total.errors++;
      console.error('[qa] batch failed', (e as Error).message);
      await sleep(idleMs);
      continue;
    }
    batches++;
    for (const k of Object.keys(total) as (keyof QaResult)[]) total[k] += r[k];
    if (r.processed + r.skipped + r.errors === 0) {
      if (draining) {
        const left = Number((await pool().query(`SELECT count(*) AS n FROM recordings WHERE status = 'pending_checks'`)).rows[0].n);
        if (left === 0) return;
      }
      await sleep(draining ? 100 : idleMs);
    }
  }
}

process.on('message', (m: { cmd?: string }) => { if (m?.cmd === 'drain') draining = true; });

(async () => {
  const t = Date.now();
  // each loop exits only once draining and nothing is pending
  await Promise.all(Array.from({ length: loops }, () => loop()));
  await closePool();
  process.send?.({ done: true, total, batches, ms: Date.now() - t });
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
