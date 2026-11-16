'use client';
import { Fragment, useCallback, useEffect, useState } from 'react';
import { api, ApiError, clock, money } from './api';
import { PoolTable, type PoolRow } from './StatsView';

type Lease = { scriptId: number; language: string; contributorId: number; token: string; claimedAt: string; leaseExpiresAt: string; remainingSeconds: number; lastHeartbeatAt: string | null; heartbeats: number };
type Overview = {
  dbNow: string;
  lowPoolAlertHours: number;
  leaseSeconds: number;
  pools: PoolRow[];
  alerts: { id: number; at: string; kind: string; language: string | null; message: string }[];
  leases: { live: Lease[]; stuck: Lease[]; counts: { live: number; stuck: number } };
  abandoners: { contributorId: number; claims: number; abandoned: number; rate: number }[];
  totals: Record<string, { recordings: number; cents: number }>;
};
type QueueItem = {
  id: number; scriptId: number; contributorId: number; createdAt: string; late: boolean; sizeBytes: number; language: string; body: string;
  durationS: number | null; silenceRatio: number | null; clippingRatio: number | null; peakDb: number | null; rmsDb: number | null; qaNote: string | null; estPayCents: number | null;
};
type Decision = { id: number; at: string; event: string; by: string; scriptId: number | null; contributorId: number | null; detail: Record<string, unknown> | null };
type Review = { queue: { total: number; items: QueueItem[] }; decisions: Decision[] };
type HistEvent = { id: number; at: string; event: string; contributorId: number | null; token: string | null; leaseExpiresAt: string | null; detail: Record<string, unknown> | null; count?: number; lastAt?: string };
type History = {
  script: { id: number; language: string; body: string; status: string; claimedBy: number | null; token: string | null; leaseExpiresAt: string | null; remainingSeconds: number | null; timesClaimed: number };
  events: HistEvent[];
  recordings: { id: number; contributorId: number; token: string; status: string; late: boolean; sizeBytes: number; durationS: number | null; estPayCents: number | null; reviewNote: string | null; reviewedAt: string | null; paidAt: string | null; createdAt: string }[];
};

const REFRESH_MS = 4000;
const REASONS = ['Too quiet', 'Background noise', 'Does not match the script', 'Clipping / distorted', 'Mostly silence', 'Wrong language'];

const t = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleTimeString() : '–');
const short = (token: string | null | undefined) => (token ? token.slice(0, 8) : '–');
const pct = (x: number | null) => (x === null || x === undefined ? '–' : `${(x * 100).toFixed(1)}%`);
const db = (x: number | null) => (x === null || x === undefined ? '–' : `${x.toFixed(1)} dB`);

const EVENT_TONE: Record<string, string> = {
  claimed: 'accent', resumed: 'accent', heartbeat: '', submitted: 'ok', late_accepted: 'ok',
  released: 'warn', expired: 'warn', lost: 'warn', rejected: 'bad', pool_empty: 'bad',
  qa_approved: 'ok', review_approved: 'ok', qa_rejected: 'bad', review_rejected: 'bad', qa_review: 'warn', paid: 'ok',
};
const Ev = ({ e }: { e: string }) => <span className={`pill ${EVENT_TONE[e] ?? ''}`}>{e}</span>;

function detailText(d: Record<string, unknown> | null): string {
  if (!d) return '';
  return Object.entries(d).filter(([, v]) => v !== null && v !== undefined).map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`).join(' · ');
}

export default function OpsView({ order }: { order: string[] }) {
  const [ov, setOv] = useState<Overview | null>(null);
  const [rv, setRv] = useState<Review | null>(null);
  const [failed, setFailed] = useState(false);
  const [q, setQ] = useState('');
  const [hist, setHist] = useState<History | null>(null);
  const [histErr, setHistErr] = useState<string | null>(null);
  const [playing, setPlaying] = useState<number | null>(null);
  const [rejecting, setRejecting] = useState<number | null>(null);
  const [reason, setReason] = useState('');
  const [acting, setActing] = useState<number | null>(null);
  const [actionMsg, setActionMsg] = useState<{ tone: string; text: string } | null>(null);
  const [payout, setPayout] = useState<{ recordings: number; contributors: number; totalCents: number } | null>(null);

  const load = useCallback(async () => {
    try {
      const [o, r] = await Promise.all([api<Overview>('/ops/overview', { method: 'GET' }), api<Review>('/ops/review', { method: 'GET' })]);
      setOv(o);
      setRv(r);
      setFailed(false);
    } catch { setFailed(true); }
  }, []);
  useEffect(() => {
    void load();
    const id = setInterval(load, REFRESH_MS);
    return () => clearInterval(id);
  }, [load]);

  const search = useCallback(async (query: string) => {
    setQ(query);
    setHistErr(null);
    if (!query.trim()) { setHist(null); return; }
    try { setHist(await api<History>(`/ops/history?q=${encodeURIComponent(query.trim())}`, { method: 'GET' })); }
    catch (e) { setHist(null); setHistErr(e instanceof ApiError ? e.message : 'Could not load history.'); }
  }, []);

  const decide = async (id: number, action: 'approve' | 'reject') => {
    setActing(id);
    setActionMsg(null);
    try {
      await api(`/ops/recordings/${id}/${action}`, { body: action === 'reject' ? { reason } : {} });
      setActionMsg({ tone: action === 'approve' ? 'ok' : 'warn', text: `Recording #${id} ${action === 'approve' ? 'approved' : `rejected (${reason}); its script is back in the pool`}.` });
      setRejecting(null);
      setReason('');
      if (playing === id) setPlaying(null);
      await load();
      if (hist) void search(q);
    } catch (e) {
      setActionMsg({ tone: 'bad', text: e instanceof ApiError ? e.message : 'Request failed.' });
    } finally { setActing(null); }
  };

  const runPayout = async () => {
    const n = ov?.totals.approved?.recordings ?? 0;
    if (!window.confirm(`Mark ${n} approved recording(s) as paid (${money(ov?.totals.approved?.cents ?? 0)})?`)) return;
    try {
      setPayout(await api('/ops/payout'));
      await load();
    } catch (e) { setActionMsg({ tone: 'bad', text: e instanceof ApiError ? e.message : 'Payout failed.' }); }
  };

  const dbNow = ov ? new Date(ov.dbNow).getTime() : Date.now();
  const ago = (iso: string | null) => (iso ? `${clock((dbNow - new Date(iso).getTime()) / 1000)} ago` : 'never');
  const totals = ov?.totals;

  return (
    <main className="page">
      <div className="card-head">
        <div>
          <h1>Operations</h1>
          <p className="sub" style={{ marginBottom: 0 }}>Read-mostly. Every decision below is written to the audit log with who and when.</p>
        </div>
        <span className="small muted num">
          {failed ? <span className="pill warn">Can’t reach the server, retrying</span> : ov ? `Database time ${t(ov.dbNow)} · refreshes every ${REFRESH_MS / 1000} s` : 'Loading…'}
        </span>
      </div>
      <div style={{ height: 20 }} />

      {ov && totals && (
        <div className="row" style={{ marginBottom: 16 }}>
          <span className="pill accent">{ov.leases.counts.live} live leases</span>
          <span className={`pill ${ov.leases.counts.stuck ? 'warn' : ''}`}>{ov.leases.counts.stuck} stuck</span>
          <span className={`pill ${rv?.queue.total ? 'warn' : ''}`}>{rv?.queue.total ?? 0} awaiting review</span>
          <span className="pill">{totals.pending_checks.recordings} awaiting checks</span>
          <span className="pill ok">{totals.approved.recordings} approved, unpaid ({money(totals.approved.cents)})</span>
          <span className="pill">{totals.paid.recordings} paid ({money(totals.paid.cents)})</span>
          <span className="pill">{totals.rejected.recordings} rejected</span>
        </div>
      )}

      {actionMsg && <div className={`notice ${actionMsg.tone}`} role="status">{actionMsg.text}</div>}

      {/* ---------- review queue ---------- */}
      <section className="card">
        <div className="card-head">
          <h2>Review queue</h2>
          <span className="small muted">Borderline recordings the automatic checks sent to a person, newest first</span>
        </div>
        {!rv ? <p className="empty-state">Loading…</p> : rv.queue.items.length === 0 ? <p className="empty-state">Nothing waiting for review.</p> : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Rec</th><th>Script</th><th>Lang</th><th>By</th><th>Submitted</th>
                  <th className="r">Duration</th><th className="r">Silence</th><th className="r">Clipping</th><th className="r">RMS</th>
                  <th>Why it’s here</th><th></th>
                </tr>
              </thead>
              <tbody>
                {rv.queue.items.map((r) => (
                  <Fragment key={r.id}>
                    <tr>
                      <td className="mono">#{r.id}</td>
                      <td><a href="#history" onClick={() => void search(String(r.scriptId))}>#{r.scriptId}</a></td>
                      <td>{r.language}</td>
                      <td className="num">{r.contributorId}</td>
                      <td className="small num">{t(r.createdAt)}{r.late && <> <span className="pill warn">late</span></>}</td>
                      <td className="r">{r.durationS === null ? '–' : clock(r.durationS)}</td>
                      <td className="r">{pct(r.silenceRatio)}</td>
                      <td className="r">{pct(r.clippingRatio)}</td>
                      <td className="r">{db(r.rmsDb)}</td>
                      <td className="small">{r.qaNote ?? '–'}</td>
                      <td>
                        <div className="row" style={{ flexWrap: 'nowrap' }}>
                          <button className="small" onClick={() => setPlaying(playing === r.id ? null : r.id)}>{playing === r.id ? 'Hide' : 'Play'}</button>
                          <button className="small" disabled={acting === r.id} onClick={() => decide(r.id, 'approve')}>Approve</button>
                          <button className="small danger" disabled={acting === r.id} onClick={() => { setRejecting(rejecting === r.id ? null : r.id); setReason(''); }}>Reject</button>
                        </div>
                      </td>
                    </tr>
                    {(playing === r.id || rejecting === r.id) && (
                      <tr>
                        <td colSpan={11} style={{ background: 'var(--surface-2)' }}>
                          <p className="small muted" style={{ marginBottom: 8 }}>“{r.body}{r.body.length >= 140 ? '…' : ''}”</p>
                          {playing === r.id && <audio controls autoPlay src={`/api/ops/recordings/${r.id}/audio`} style={{ width: '100%', marginBottom: 8 }} />}
                          {rejecting === r.id && (
                            <div className="row">
                              <input list="reject-reasons" placeholder="Reason (required)" value={reason} onChange={(e) => setReason(e.target.value)} style={{ minWidth: 280 }} autoFocus />
                              <datalist id="reject-reasons">{REASONS.map((x) => <option key={x} value={x} />)}</datalist>
                              <button className="small danger" disabled={!reason.trim() || acting === r.id} onClick={() => decide(r.id, 'reject')}>Reject recording #{r.id}</button>
                              <span className="small muted">The script goes back to the pool to be re-recorded.</span>
                            </div>
                          )}
                        </td>
                      </tr>
                    )}
                  </Fragment>
                ))}
              </tbody>
            </table>
            {rv.queue.total > rv.queue.items.length && <p className="small muted">Showing {rv.queue.items.length} of {rv.queue.total}.</p>}
          </div>
        )}
      </section>

      {/* ---------- pools + alerts ---------- */}
      <div className="grid2">
        <section className="card">
          <div className="card-head"><h2>Pool per language</h2><a href="/stats" className="small">Full stats</a></div>
          {ov ? <PoolTable pools={ov.pools} order={order} lowHours={ov.lowPoolAlertHours} compact /> : <p className="empty-state">Loading…</p>}
        </section>
        <section className="card">
          <div className="card-head"><h2>Recent alerts</h2><span className="small muted">from the background job</span></div>
          {!ov ? <p className="empty-state">Loading…</p> : ov.alerts.length === 0 ? <p className="empty-state">No alerts.</p> : (
            <table>
              <tbody>
                {ov.alerts.map((a) => (
                  <tr key={a.id}>
                    <td className="small num muted" style={{ whiteSpace: 'nowrap' }}>{t(a.at)}</td>
                    <td><span className={`pill ${a.kind === 'pool_empty' ? 'bad' : 'warn'}`}>{a.kind}</span></td>
                    <td className="small">{a.message}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      </div>

      {/* ---------- leases ---------- */}
      <div className="grid2">
        <section className="card">
          <div className="card-head"><h2>Live leases</h2><span className="small muted">lease {ov ? clock(ov.leaseSeconds) : ''}, extended by heartbeats</span></div>
          {!ov ? <p className="empty-state">Loading…</p> : ov.leases.live.length === 0 ? <p className="empty-state">Nobody is recording right now.</p> : (
            <LeaseTable rows={ov.leases.live} ago={ago} onPick={search} />
          )}
        </section>
        <section className="card">
          <div className="card-head"><h2>Stuck leases</h2><span className="small muted">expired but still marked claimed; free to re-claim, the job cleans them up</span></div>
          {!ov ? <p className="empty-state">Loading…</p> : ov.leases.stuck.length === 0 ? <p className="empty-state">None.</p> : (
            <LeaseTable rows={ov.leases.stuck} ago={ago} onPick={search} overdue />
          )}
        </section>
      </div>

      {/* ---------- script history ---------- */}
      <section className="card" id="history">
        <div className="card-head"><h2>Script history</h2><span className="small muted">every event from the audit log</span></div>
        <form className="row" onSubmit={(e) => { e.preventDefault(); void search(q); }}>
          <input placeholder="Script id or claim token" value={q} onChange={(e) => setQ(e.target.value)} style={{ minWidth: 320 }} />
          <button type="submit">Show history</button>
          {hist && <button type="button" className="small" onClick={() => void search(q)}>Refresh</button>}
        </form>
        {histErr && <p className="small" style={{ color: 'var(--bad)', marginTop: 10 }}>{histErr}</p>}
        {hist && (
          <div style={{ marginTop: 16 }}>
            <div className="row" style={{ marginBottom: 8 }}>
              <strong>Script #{hist.script.id}</strong>
              <span className="pill">{hist.script.language}</span>
              <span className="pill accent">{hist.script.status}</span>
              {hist.script.status === 'claimed' && <span className="small muted">by #{hist.script.claimedBy}, {hist.script.remainingSeconds !== null && hist.script.remainingSeconds > 0 ? `${clock(hist.script.remainingSeconds)} left` : `overdue ${clock(-(hist.script.remainingSeconds ?? 0))}`}</span>}
              <span className="small muted">claimed {hist.script.timesClaimed}×</span>
            </div>
            <p className="small muted" style={{ marginBottom: 12 }}>“{hist.script.body}”</p>
            <div className="table-wrap">
              <table>
                <thead><tr><th>Time</th><th>Event</th><th>Contributor</th><th>Token</th><th>Lease until</th><th>Detail</th></tr></thead>
                <tbody>
                  {hist.events.map((e) => (
                    <tr key={e.id}>
                      <td className="small num" style={{ whiteSpace: 'nowrap' }}>{t(e.at)}{e.count ? ` – ${t(e.lastAt)}` : ''}</td>
                      <td><Ev e={e.event} />{e.count ? <span className="small muted"> ×{e.count}</span> : null}</td>
                      <td className="num">{e.contributorId ?? '–'}</td>
                      <td className="mono">{short(e.token)}</td>
                      <td className="small num">{t(e.leaseExpiresAt)}</td>
                      <td className="small muted">{detailText(e.detail)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {hist.recordings.length > 0 && (
              <>
                <h2 style={{ marginTop: 16 }}>Recordings</h2>
                <table>
                  <thead><tr><th>Rec</th><th>Contributor</th><th>Status</th><th>Submitted</th><th className="r">Size</th><th className="r">Pay</th><th>Decision</th></tr></thead>
                  <tbody>
                    {hist.recordings.map((r) => (
                      <tr key={r.id}>
                        <td className="mono">#{r.id}</td>
                        <td className="num">{r.contributorId}</td>
                        <td><Ev e={r.status} />{r.late && <> <span className="pill warn">late</span></>}</td>
                        <td className="small num">{t(r.createdAt)}</td>
                        <td className="r">{(r.sizeBytes / 1e6).toFixed(2)} MB</td>
                        <td className="r">{r.estPayCents === null ? '–' : `${money(r.estPayCents)}${['approved', 'paid'].includes(r.status) ? '' : ' est.'}`}</td>
                        <td className="small">{r.reviewNote ?? ''}{r.reviewedAt ? ` · ${t(r.reviewedAt)}` : ''}{r.paidAt ? ` · paid ${t(r.paidAt)}` : ''}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </>
            )}
          </div>
        )}
      </section>

      {/* ---------- decisions + payout ---------- */}
      <div className="grid2">
        <section className="card">
          <div className="card-head"><h2>Decisions</h2><span className="small muted">automatic checks, reviewers and payout runs</span></div>
          {!rv ? <p className="empty-state">Loading…</p> : rv.decisions.length === 0 ? <p className="empty-state">No decisions yet.</p> : (
            <div className="table-wrap">
              <table>
                <thead><tr><th>Time</th><th>Who</th><th>Event</th><th>Script</th><th>Detail</th></tr></thead>
                <tbody>
                  {rv.decisions.map((d) => (
                    <tr key={d.id}>
                      <td className="small num" style={{ whiteSpace: 'nowrap' }}>{t(d.at)}</td>
                      <td className="small">{d.by}</td>
                      <td><Ev e={d.event} /></td>
                      <td>{d.scriptId ? <a href="#history" onClick={() => void search(String(d.scriptId))}>#{d.scriptId}</a> : '–'}</td>
                      <td className="small muted">{detailText(d.detail)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
        <section className="card">
          <div className="card-head"><h2>Payout</h2><span className="small muted">approved → paid</span></div>
          <p className="small muted" style={{ marginBottom: 12 }}>Pays every approved recording. Amounts are estimated until approval, then fixed.</p>
          <div className="row">
            <button className="primary" onClick={runPayout} disabled={!totals?.approved.recordings}>
              Run payout{totals ? ` (${totals.approved.recordings} · ${money(totals.approved.cents)})` : ''}
            </button>
          </div>
          {payout && <div className="notice ok" style={{ marginTop: 12, marginBottom: 0 }}>Paid {payout.recordings} recording(s) to {payout.contributors} contributor(s), {money(payout.totalCents)} in total.</div>}

          <h2 style={{ marginTop: 24 }}>Abandonment</h2>
          <p className="small muted" style={{ marginBottom: 8 }}>Last 24 h, contributors with 3+ claims. Expired or released ÷ claimed.</p>
          {!ov ? null : ov.abandoners.length === 0 ? <p className="empty-state">No contributor has 3+ claims in the last 24 h.</p> : (
            <table>
              <thead><tr><th>Contributor</th><th className="r">Claims</th><th className="r">Abandoned</th><th className="r">Rate</th></tr></thead>
              <tbody>
                {ov.abandoners.map((a) => (
                  <tr key={a.contributorId} className={a.rate > 0.5 ? 'low' : ''}>
                    <td className="num">#{a.contributorId}</td>
                    <td className="r">{a.claims}</td>
                    <td className="r">{a.abandoned}</td>
                    <td className="r">{Math.round(a.rate * 100)}%</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      </div>
    </main>
  );
}

function LeaseTable({ rows, ago, onPick, overdue }: { rows: Lease[]; ago: (iso: string | null) => string; onPick: (q: string) => void; overdue?: boolean }) {
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr><th>Script</th><th>Lang</th><th>Contributor</th><th>Token</th><th className="r">{overdue ? 'Overdue' : 'Time left'}</th><th>Last heartbeat</th></tr>
        </thead>
        <tbody>
          {rows.slice(0, 50).map((l) => (
            <tr key={l.token}>
              <td><a href="#history" onClick={() => onPick(String(l.scriptId))}>#{l.scriptId}</a></td>
              <td>{l.language}</td>
              <td className="num">{l.contributorId}</td>
              <td className="mono">{l.token.slice(0, 8)}</td>
              <td className="r">{overdue ? <span style={{ color: 'var(--warn)' }}>{clock(-l.remainingSeconds)}</span> : clock(l.remainingSeconds)}</td>
              <td className="small muted">{l.heartbeats ? `${ago(l.lastHeartbeatAt)} (${l.heartbeats})` : 'none yet'}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length > 50 && <p className="small muted">Showing 50 of {rows.length}.</p>}
    </div>
  );
}
