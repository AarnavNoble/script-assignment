// npm run jobs — runs the periodic job every JOB_INTERVAL_SECONDS (prod: a cron or scheduled task).
import { runJob } from '../lib/jobs';
import { config } from '../lib/config';

async function tick() {
  try {
    const r = await runJob();
    console.log(new Date().toISOString(), JSON.stringify(r));
  } catch (e) {
    console.error('job failed', e);
  }
}

tick();
setInterval(tick, config.jobIntervalSeconds() * 1000);
