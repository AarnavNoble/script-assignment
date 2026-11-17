import styles from './findings.module.css';

export const metadata = { title: 'Findings · Script Recorder' };

// Numbers come from results/results.md (simulation) and results/experiments.md (experiments).
const headline = [
  { value: '0', label: 'scripts handed out twice', note: 'across 7,267 leases, 300 contributors misbehaving for 3 simulated hours' },
  { value: '243 / 275', label: 'late takes saved', note: 'was 9 / 288 handing out the lowest free id; never-held first: ~93 → ~13 contributor-hours wasted per 3 h (QA off)' },
  { value: '~57 / s', label: 'claims before p95 > 50 ms', note: '57x the interview’s traffic on one Postgres + one Node process; 75/s at p95 37 ms with a 50-connection pool' },
  { value: '~2 h', label: 'warning before a pool runs dry', note: 'popular languages run out at ~2.7 h at today’s traffic mix' },
  { value: '3%', label: 'of takes left for a person', note: 'QA as a whole on synthetic test voices, 15 languages; the script check alone rejects 90% of wrong readings, 0.6% of correct ones wrongly' },
];

export default function FindingsPage() {
  return (
    <main className="page">
      <h1>What the experiments found</h1>
      <p className="sub">Measured, not assumed: a 300-contributor simulation against the real API, a lease-length sweep, a claim-order comparison, a load test and a forecast check.</p>

      <div className={styles.tiles}>
        {headline.map((h) => (
          <div key={h.label} className={`card corners ${styles.tile}`}>
            <div className={styles.value}>{h.value}</div>
            <div className={styles.label}>{h.label}</div>
            <div className="small muted">{h.note}</div>
          </div>
        ))}
      </div>

      <section className="card" data-tag="CLAIM.ORDER">
        <div className="card-head"><h2>The surprise: late takes were almost always thrown away</h2></div>
        <p className={styles.text}>
          When a contributor stalls past the lease, their take is accepted if nobody re-claimed the script. My first version
          handed out the lowest free id, so an expired script was always the next one out, and in busy languages it was
          re-taken within seconds. Handing out never-held scripts first keeps it back for its owner, with no drop in
          recordings. Simulation, seed 42, QA off.
        </p>
        <div className="table-wrap">
          <table>
            <thead>
              <tr><th></th><th className="r">Lowest id first</th><th className="r">Never-held first v1</th><th className="r">v2</th><th className="r">v3 (shipped)</th></tr>
            </thead>
            <tbody>
              <tr><td>Late takes accepted</td><td className="r num">9 / 288</td><td className="r num">41 / 279</td><td className="r num">246 / 278</td><td className="r num"><strong>243 / 275</strong></td></tr>
              <tr><td>Contributor-hours wasted (per 3 h)</td><td className="r num">93</td><td className="r num">82</td><td className="r num">12</td><td className="r num"><strong>13</strong></td></tr>
              <tr><td>Recordings</td><td className="r num">6,487</td><td className="r num">6,525</td><td className="r num">6,532</td><td className="r num">6,499</td></tr>
              <tr><td>Claim query (100k scripts / language)</td><td className="r num">0.5 ms</td><td className="r num">–</td><td className="r num">37.6 ms</td><td className="r num"><strong>0.09 ms</strong></td></tr>
            </tbody>
          </table>
        </div>
      </section>

      <section className="card" data-tag="SCRIPT.CHECK">
        <div className="card-head"><h2>Did they read the script?</h2></div>
        <p className={styles.text}>
          QA transcribes each take locally and compares it with the script, with thresholds per language. The table is the
          script check alone, cross-validated on 2,520 synthetic readings in 14 languages (correct, a different sentence,
          half the sentence, the wrong language, noisy and fast). With the audio checks judged against each script’s length,
          QA as a whole leaves 3% of takes for a person instead of all of them (33% before that change). Real voices will
          move these numbers.
        </p>
        <div className="table-wrap">
          <table>
            <thead><tr><th>Script check alone</th><th className="r">Approved</th><th className="r">To review</th><th className="r">Rejected</th></tr></thead>
            <tbody>
              <tr><td>Correct readings</td><td className="r num">96.6%</td><td className="r num">2.8%</td><td className="r num"><strong>0.6%</strong></td></tr>
              <tr><td>Wrong readings</td><td className="r num"><strong>0.2%</strong></td><td className="r num">9.6%</td><td className="r num"><strong>90.2%</strong></td></tr>
            </tbody>
          </table>
        </div>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img className={styles.chart} style={{ marginTop: 12 }} src="/api/results/script-check.png" alt="Script-match error rates per language" />
      </section>

      <section className="card" data-tag="LEASE.SWEEP">
        <div className="card-head"><h2>Lease length: idle scripts vs takes lost to network stalls</h2></div>
        <p className={styles.text}>Shorter leases recover abandoned scripts sooner but lose more takes to network stalls. Handing out the lowest id first, 15 minutes was cheapest; with never-held first, stalls barely lose takes at any length and 5 minutes is cheapest. The default stays at 10 minutes as margin for throttled background tabs.</p>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img className={styles.chart} src="/api/results/lease_tradeoff.png" alt="Lease length tradeoff chart" />
      </section>

      <div className="grid2">
        <section className="card" data-tag="POOL.SIM">
          <div className="card-head"><h2>Pools over 3 hours</h2></div>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img className={styles.chart} src="/api/results/pool_over_time.png" alt="Available scripts per language over time" />
        </section>
        <section className="card" data-tag="FORECAST">
          <div className="card-head"><h2>Run-out forecast vs actual</h2></div>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img className={styles.chart} src="/api/results/forecast.png" alt="Forecast vs actual run-out" />
        </section>
      </div>
    </main>
  );
}
