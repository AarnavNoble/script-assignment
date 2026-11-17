'use client';
import { useEffect, useRef, useState } from 'react';

// The /ops "Live" card: the no-double-hand-out invariant, rebuilt from the audit log every ~1.5 s,
// plus a few rates and a sparkline of claims vs expiries. Data: GET /api/ops/live (lib/ops.ts live()).

type Rates = {
  claims: number; resumes: number; revives: number; heartbeats: number;
  expired: number; expiredByJob: number; expiredByReclaim: number; released: number;
  lateAccepted: number; rejected: number; submitted: number; lost: number;
  qaApproved: number; qaRejected: number; qaReview: number; poolEmpty: number;
};
type Live = {
  handedOutTwice: number; leasesChecked: number; recordedTwice: number; windowMinutes: number;
  dbNow: string; liveLeases: number; rates: Rates; rateWindowSeconds: number;
  series: { bucketSeconds: number; claims: number[]; expired: number[] };
  queryMs: number;
};

const POLL_MS = 1500;
const fmt = (n: number) => n.toLocaleString('en-US');

function Spark({ claims, expired, bucketSeconds }: { claims: number[]; expired: number[]; bucketSeconds: number }) {
  const W = 240, H = 44, P = 2;
  const max = Math.max(1, ...claims, ...expired);
  const n = Math.max(2, claims.length);
  const x = (i: number) => P + (i * (W - 2 * P)) / (n - 1);
  const y = (v: number) => H - P - (v / max) * (H - 2 * P);
  const line = (vs: number[]) => vs.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join('');
  const area = `${line(claims)}L${x(claims.length - 1).toFixed(1)},${H - P}L${x(0).toFixed(1)},${H - P}Z`;
  const minutes = Math.round((claims.length * bucketSeconds) / 60);
  return (
    <div className="live-spark">
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H} preserveAspectRatio="none" role="img"
        aria-label={`Claims and expiries per ${bucketSeconds} s over the last ${minutes} min`}>
        <line x1={P} x2={W - P} y1={H - P} y2={H - P} stroke="var(--border)" strokeWidth="1" />
        <path d={area} fill="var(--accent-soft)" />
        <path d={line(claims)} fill="none" stroke="var(--accent)" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
        <path d={line(expired)} fill="none" stroke="var(--warn)" strokeWidth="1.5" strokeDasharray="3 2" vectorEffect="non-scaling-stroke" />
      </svg>
      <div className="row small muted live-legend">
        <span><i style={{ background: 'var(--accent)' }} />claims</span>
        <span><i style={{ background: 'var(--warn)' }} />expiries</span>
        <span className="spacer" />
        <span>last {minutes} min, per {bucketSeconds} s</span>
      </div>
    </div>
  );
}

function Stat({ label, value, tone, title }: { label: string; value: string; tone?: string; title?: string }) {
  return (
    <div className="live-stat" title={title}>
      <div className={`live-stat-v num ${tone ?? ''}`}>{value}</div>
      <div className="live-stat-l">{label}</div>
    </div>
  );
}

export function LivePanel() {
  const [d, setD] = useState<Live | null>(null);
  const [failed, setFailed] = useState(false);
  const busy = useRef(false);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      if (busy.current) return; // never stack polls if the server is slow
      busy.current = true;
      try {
        const r = await fetch('/api/ops/live', { cache: 'no-store' });
        if (!r.ok) throw new Error(String(r.status));
        const j = (await r.json()) as Live;
        if (alive) { setD(j); setFailed(false); }
      } catch {
        if (alive) setFailed(true);
      } finally {
        busy.current = false;
      }
    };
    void load();
    const id = setInterval(load, POLL_MS);
    return () => { alive = false; clearInterval(id); };
  }, []);

  const twice = d?.handedOutTwice ?? 0;
  const ok = d !== null && twice === 0;
  const perMin = (n: number) => (d ? Math.round((n * 60) / d.rateWindowSeconds) : 0);
  const r = d?.rates;

  return (
    <section className="card live-card" aria-live="polite">
      <style>{CSS}</style>
      <div className="card-head">
        <h2>Live</h2>
        <span className="row small muted">
          {failed ? <span className="pill warn">reconnecting</span> : <span className={`live-dot ${d ? 'on' : ''}`} aria-hidden />}
          {d ? `updated ${new Date(d.dbNow).toLocaleTimeString()}` : 'loading'}
        </span>
      </div>

      <div className="live-top">
        <div className={`live-big ${d === null ? '' : ok ? 'ok' : 'bad'}`}>
          <div className="live-big-l">Handed out twice</div>
          <div className="live-big-v num">{d ? fmt(twice) : '–'}</div>
          <div className="small muted">
            {d ? `across ${fmt(d.leasesChecked)} leases in the last ${d.windowMinutes} min` : 'checking the audit log'}
          </div>
        </div>
        <div className="live-side">
          <div className="row">
            <span className="muted small">Recorded twice</span>
            <span className={`pill ${d === null ? '' : d.recordedTwice === 0 ? 'ok' : 'bad'} num`}>{d ? fmt(d.recordedTwice) : '–'}</span>
          </div>
          {d && <Spark claims={d.series.claims} expired={d.series.expired} bucketSeconds={d.series.bucketSeconds} />}
        </div>
      </div>

      <div className="live-stats">
        <Stat label="claims / min" value={r ? fmt(perMin(r.claims)) : '–'} />
        <Stat label="live leases" value={d ? fmt(d.liveLeases) : '–'} />
        <Stat label="expired → back in pool" value={r ? fmt(r.expired) : '–'} tone={r && r.expired ? 'warn' : ''}
          title={r ? `last ${d!.rateWindowSeconds} s: ${r.expiredByJob} by the job, ${r.expiredByReclaim} taken over by a claim, ${r.revives} revived by their owner` : undefined} />
        <Stat label="late accepted" value={r ? fmt(r.lateAccepted) : '–'} tone={r && r.lateAccepted ? 'ok' : ''}
          title={r ? `${r.rejected} late takes rejected (script already re-claimed)` : undefined} />
        <Stat label="QA approved" value={r ? fmt(r.qaApproved) : '–'} tone={r && r.qaApproved ? 'ok' : ''} />
        <Stat label="QA rejected" value={r ? fmt(r.qaRejected) : '–'} tone={r && r.qaRejected ? 'bad' : ''}
          title={r ? `${r.qaReview} sent to review` : undefined} />
      </div>
      <div className="small muted live-foot">
        Counts are over the last {d?.rateWindowSeconds ?? 60} s{r ? ` · ${fmt(r.submitted)} submits, ${fmt(r.released)} closed tabs, ${fmt(r.revives)} revived, ${fmt(r.rejected)} late rejected` : ''}
      </div>
    </section>
  );
}

const CSS = `
.live-card .live-top { display: grid; grid-template-columns: minmax(200px, 1fr) minmax(220px, 1.3fr); gap: 20px; align-items: center; margin-bottom: 16px; }
@media (max-width: 640px) { .live-card .live-top { grid-template-columns: 1fr; } }
.live-big { border-radius: var(--radius); padding: 14px 16px; background: var(--surface-2); transition: background-color .3s; }
.live-big.ok { background: var(--ok-soft); }
.live-big.bad { background: var(--bad-soft); }
.live-big-l { font-size: 13px; color: var(--muted); }
.live-big-v { font-size: 44px; font-weight: 600; line-height: 1.1; letter-spacing: -0.02em; }
.live-big.ok .live-big-v { color: var(--ok); }
.live-big.bad .live-big-v { color: var(--bad); }
.live-side { display: flex; flex-direction: column; gap: 10px; min-width: 0; }
.live-spark svg { display: block; }
.live-legend { gap: 12px; margin-top: 2px; }
.live-legend i { display: inline-block; width: 10px; height: 2px; border-radius: 1px; vertical-align: middle; margin-right: 5px; }
.live-stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(110px, 1fr)); gap: 8px; }
.live-stat { background: var(--surface-2); border-radius: 8px; padding: 8px 10px; }
.live-stat-v { font-size: 20px; font-weight: 600; line-height: 1.2; }
.live-stat-v.ok { color: var(--ok); }
.live-stat-v.warn { color: var(--warn); }
.live-stat-v.bad { color: var(--bad); }
.live-stat-l { font-size: 12px; color: var(--muted); }
.live-foot { margin-top: 10px; }
.live-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--border); display: inline-block; }
.live-dot.on { background: var(--ok); animation: live-pulse 1.5s ease-in-out infinite; }
@keyframes live-pulse { 50% { opacity: .35; } }
@media (prefers-reduced-motion: reduce) { .live-dot.on { animation: none; } .live-big { transition: none; } }
`;
