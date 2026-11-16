// npm run qa — automatic audio checks. Runs runQaOnce every QA_INTERVAL_MS (default 2000);
// if a batch came back full, it goes again right away to drain a backlog.
// Safe to run several copies at once (see lib/qa.ts for how rows are claimed).
import { runQaOnce } from '../lib/qa';
import { closePool } from '../lib/db';

const intervalMs = Number(process.env.QA_INTERVAL_MS ?? 2000) || 2000;
const limit = Number(process.env.QA_BATCH ?? 10) || 10;
let stopping = false;
let timer: NodeJS.Timeout | undefined;
let inflight: Promise<void> | undefined;

async function tick() {
  let full = false;
  try {
    const t0 = Date.now();
    const r = await runQaOnce({ limit });
    full = r.processed + r.skipped >= limit; // errors excluded: a failing store must not spin
    if (r.processed || r.errors || r.skipped) {
      console.log(`${new Date().toISOString()} qa processed=${r.processed} approved=${r.approved} rejected=${r.rejected} review=${r.review} skipped=${r.skipped} errors=${r.errors} ms=${Date.now() - t0}`);
    }
  } catch (e) {
    console.error(new Date().toISOString(), 'qa batch failed', e);
  }
  if (!stopping) timer = setTimeout(() => { inflight = tick(); }, full ? 0 : intervalMs);
}

async function stop() {
  stopping = true;
  if (timer) clearTimeout(timer);
  await inflight; // finish the current batch so no row is left half-decided
  await closePool();
  process.exit(0);
}
process.on('SIGINT', stop);
process.on('SIGTERM', stop);

console.log(`qa worker: every ${intervalMs} ms, batch ${limit}, db ${process.env.DATABASE_URL?.replace(/\/\/[^@]*@/, '//')}`);
inflight = tick();
