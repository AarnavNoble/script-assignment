'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError, clock, money, putWithProgress, store, withRetry } from './api';
import { useMicRecorder } from './useMicRecorder';
import { TARGET_RATE } from './wav';
import styles from './recorder.module.css';

type Claim = {
  status: 'claimed' | 'resumed';
  scriptId: number;
  language: string;
  body: string;
  token: string;
  leaseExpiresAt: string;
  leaseRemainingSeconds: number;
  heartbeatSeconds: number;
};
type ClaimResp = Claim | { status: 'empty'; language: string; message: string };
type SubmitResp = { status: 'submitted' | 'late_accepted'; recordingId: number; scriptId: number; late: boolean; duplicate: boolean };
type Contributor = {
  id: number;
  language: string;
  payCentsPerHour: number;
  earnings: { estimatedCents: number; approvedCents: number; paidCents: number };
};
type Who = { id: number; language: string };
type Phase = 'setup' | 'claiming' | 'active' | 'empty' | 'done';
type Result = { kind: 'submitted' | 'late_accepted' | 'taken' | 'other_tab'; scriptId: number; seconds: number; recordingId?: number };
type Notice = { tone: 'ok' | 'warn' | 'bad' | ''; title: string; text?: string };
type SubmitStage = { stage: 'url' | 'upload' | 'finish'; progress: number; retry?: number };

const MAX_SECONDS = 8 * 60; // ~46 MB of WAV, under the server's 50 MB upload limit
const LS_WHO = 'sr.contributor';
const SS_PENDING_RELEASE = 'sr.pendingRelease';

export default function Recorder({ languages }: { languages: string[] }) {
  const [idInput, setIdInput] = useState('1');
  const [langInput, setLangInput] = useState('');
  const [usualLang, setUsualLang] = useState<string | null>(null);
  const [who, setWho] = useState<Who | null>(null);
  const [info, setInfo] = useState<Contributor | null>(null);
  const [phase, setPhase] = useState<Phase>('setup');
  const [claim, setClaim] = useState<Claim | null>(null);
  const [leaseLeft, setLeaseLeft] = useState(0);
  const [leaseTotal, setLeaseTotal] = useState(1);
  const [leaseLost, setLeaseLost] = useState(false);
  const [offline, setOffline] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [emptyMsg, setEmptyMsg] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submit, setSubmit] = useState<SubmitStage | null>(null);
  const [result, setResult] = useState<Result | null>(null);

  const meterRef = useRef<HTMLDivElement>(null);
  const level = useRef(0);
  const rec = useMicRecorder({
    maxSeconds: MAX_SECONDS,
    onLevel: (peak) => {
      const db = 20 * Math.log10(Math.max(peak, 1e-5));
      const frac = Math.min(1, Math.max(0, (db + 60) / 60));
      level.current = Math.max(frac, level.current * 0.8);
      if (meterRef.current) meterRef.current.style.transform = `scaleX(${level.current})`;
    },
  });
  const { discard } = rec;
  useEffect(() => {
    if (rec.state !== 'recording' && meterRef.current) { level.current = 0; meterRef.current.style.transform = 'scaleX(0)'; }
  }, [rec.state]);

  // Refs read by the pagehide / broadcast handlers, which must not go stale.
  const tokenRef = useRef<string | null>(null);
  const whoRef = useRef<Who | null>(null);
  const settledRef = useRef(false); // submitted or taken: nothing left to release
  const deadline = useRef(0);       // performance.now() ms; counts down from the server's remaining seconds
  const peers = useRef(new Map<string, { token: string | null; at: number }>());
  const bc = useRef<BroadcastChannel | null>(null);
  const tabId = useRef('');
  const recState = useRef(rec.state);
  recState.current = rec.state;
  whoRef.current = who;

  const setLease = useCallback((remaining: number) => {
    deadline.current = performance.now() + remaining * 1000;
    setLeaseLeft(remaining);
    setLeaseTotal((t) => Math.max(t, remaining));
  }, []);

  const loadInfo = useCallback(async (id: number) => {
    try { setInfo(await api<Contributor>(`/contributors/${id}`, { method: 'GET' })); } catch { /* not critical */ }
  }, []);

  const applyClaim = useCallback((r: ClaimResp, after: Notice | null) => {
    setLeaseLost(false);
    if (r.status === 'empty') {
      tokenRef.current = null;
      setClaim(null);
      setEmptyMsg(r.message);
      setPhase('empty');
      setNotice(after);
      return;
    }
    tokenRef.current = r.token;
    settledRef.current = false;
    setLeaseTotal(r.leaseRemainingSeconds);
    setLease(r.leaseRemainingSeconds);
    setClaim(r);
    setPhase('active');
    setNotice(after);
    bc.current?.postMessage({ type: 'alive', tab: tabId.current, token: r.token });
  }, [setLease]);

  const getScript = useCallback(async (w: Who, after?: Notice) => {
    setPhase('claiming');
    setError(null);
    setResult(null);
    setLeaseLost(false);
    discard();
    // A release beaconed by this tab just before a reload may still be in flight. Finish it first,
    // so it can't land after the new claim and free the script we're about to be handed.
    const pending = store.get<{ token: string; who: number }>(SS_PENDING_RELEASE, 'session');
    if (pending) {
      await api(`/claims/${pending.token}/release`, { who: pending.who, retries: 2 }).catch(() => {});
      store.del(SS_PENDING_RELEASE, 'session');
    }
    try {
      applyClaim(await api<ClaimResp>('/claims', { who: w.id, body: { language: w.language }, retries: 4 }), after ?? null);
    } catch (e) {
      setPhase('setup');
      setError(e instanceof ApiError ? e.message : 'Could not reach the server. Check your connection and try again.');
    }
    void loadInfo(w.id);
  }, [discard, applyClaim, loadInfo]);

  // ---- start: remember the contributor; resume their script on reload or in a second tab ----
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    const saved = store.get<Who>(LS_WHO);
    if (saved?.id) {
      setIdInput(String(saved.id));
      setLangInput(saved.language);
      setWho(saved);
      void getScript(saved);
    }
  }, [getScript]);

  // look up the contributor's usual language while choosing
  useEffect(() => {
    if (phase !== 'setup') return;
    const id = Number(idInput);
    if (!Number.isInteger(id) || id <= 0) { setUsualLang(null); return; }
    const t = setTimeout(async () => {
      try {
        const c = await api<Contributor>(`/contributors/${id}`, { method: 'GET' });
        setUsualLang(c.language);
        setInfo(c);
        setLangInput((cur) => (cur && store.get<Who>(LS_WHO)?.id === id ? cur : c.language));
        setError(null);
      } catch (e) {
        setUsualLang(null);
        setInfo(null);
        if (e instanceof ApiError && e.status === 404) setError(`There is no contributor #${id}.`);
      }
    }, 250);
    return () => clearTimeout(t);
  }, [idInput, phase]);

  // ---- lease countdown (display only; the deadline always comes from the server) ----
  useEffect(() => {
    if (phase !== 'active') return;
    const t = setInterval(() => setLeaseLeft(Math.max(0, (deadline.current - performance.now()) / 1000)), 250);
    return () => clearInterval(t);
  }, [phase]);

  // ---- lease lost ----
  // Ask again right away: if nobody else claimed the script meanwhile, POST /claims revives our own
  // expired lease (same script, same token), so any take already recorded is still valid.
  const submittingRef = useRef(false);
  const recovering = useRef(false);
  const recRef = useRef(rec);
  recRef.current = rec;
  const recoverLease = useRef<() => Promise<void>>(async () => {});
  recoverLease.current = async () => {
    const w = whoRef.current;
    const old = tokenRef.current;
    setLeaseLost(true);
    setLeaseLeft(0);
    // mid-upload: let the submit finish; it reports submitted, late_accepted or script_taken itself
    if (!w || recovering.current || submittingRef.current) return;
    recovering.current = true;
    try {
      const r = await api<ClaimResp>('/claims', { who: w.id, body: { language: w.language }, retries: 4 });
      const hasTake = recState.current === 'recording' || recState.current === 'stopping' || recState.current === 'recorded';
      if (r.status !== 'empty' && r.token === old) {
        applyClaim(r, {
          tone: 'ok',
          title: 'Your session expired, but we got your script back.',
          text: hasTake ? 'Nobody else had taken it. Your recording is still here.' : 'Nobody else had taken it, so it is still yours.',
        });
        setOffline(false);
        return;
      }
      // Someone else has our old script now: a take of it can't be used.
      if (recState.current === 'recording') await recRef.current.stop();
      discard();
      applyClaim(r, {
        tone: 'warn',
        title: r.status === 'empty' ? 'Your session expired and the script went to someone else.' : 'Your session expired, here’s a new script.',
        text: hasTake
          ? 'Your old script was given to someone else while you were away, so that recording can’t be used. Sorry about that.'
          : 'Your old script was given to someone else while you were away.',
      });
      setOffline(false);
    } catch {
      setOffline(true);
      setNotice({ tone: 'warn', title: 'Your session expired and we can’t reach the server.', text: 'Try again in a moment. If you have a recording, you can still try submitting it.' });
    } finally {
      recovering.current = false;
    }
  };

  // ---- heartbeat every heartbeatSeconds while the page is open ----
  useEffect(() => {
    if (phase !== 'active' || !claim || leaseLost || !who) return;
    let stopped = false;
    const beat = async () => {
      try {
        const r = await api<{ leaseRemainingSeconds: number }>(`/claims/${claim.token}/heartbeat`, { who: who.id });
        if (stopped) return;
        setLease(r.leaseRemainingSeconds); // resync to the database clock
        setOffline(false);
      } catch (e) {
        if (stopped) return;
        if (e instanceof ApiError && e.status === 409) void recoverLease.current();
        else setOffline(true);
      }
    };
    const t = setInterval(beat, claim.heartbeatSeconds * 1000);
    const onShow = (ev: PageTransitionEvent) => { if (ev.persisted) void beat(); }; // back from bfcache
    window.addEventListener('pageshow', onShow);
    return () => { stopped = true; clearInterval(t); window.removeEventListener('pageshow', onShow); };
  }, [phase, claim, leaseLost, who, setLease]);

  // ---- tabs: know whether another open tab holds the same lease ----
  useEffect(() => {
    if (typeof BroadcastChannel === 'undefined') return;
    tabId.current = Math.random().toString(36).slice(2);
    const ch = new BroadcastChannel('script-recorder');
    bc.current = ch;
    ch.onmessage = (e: MessageEvent) => {
      const m = e.data as { type: string; tab: string; token?: string | null };
      if (m.tab === tabId.current) return;
      if (m.type === 'alive') peers.current.set(m.tab, { token: m.token ?? null, at: Date.now() });
      else if (m.type === 'hello') { peers.current.set(m.tab, { token: null, at: Date.now() }); ch.postMessage({ type: 'alive', tab: tabId.current, token: tokenRef.current }); }
      else if (m.type === 'bye') peers.current.delete(m.tab);
      else if (m.type === 'settled' && m.token && m.token === tokenRef.current && !settledRef.current) {
        settledRef.current = true;
        setResult((r) => r ?? { kind: 'other_tab', scriptId: 0, seconds: 0 });
        setPhase('done');
      }
    };
    ch.postMessage({ type: 'hello', tab: tabId.current });
    const t = setInterval(() => ch.postMessage({ type: 'alive', tab: tabId.current, token: tokenRef.current }), 3000);
    return () => { clearInterval(t); ch.postMessage({ type: 'bye', tab: tabId.current }); ch.close(); bc.current = null; };
  }, []);

  // ---- tab close: give the script back right away (lease expiry is the real guarantee) ----
  // pagehide only. visibilitychange -> hidden also fires on a mere tab switch, so it must not release.
  useEffect(() => {
    const onHide = (ev: PageTransitionEvent) => {
      bc.current?.postMessage({ type: 'bye', tab: tabId.current });
      const token = tokenRef.current;
      const id = whoRef.current?.id;
      if (!token || !id || settledRef.current) return;
      if (ev.persisted) return; // into the back/forward cache: the page may come back and resume
      // Another tab of ours still shows this script (it resumed the same lease): leave it to that tab.
      // Peers leave with a 'bye'; a crashed one just ages out, and then the lease expires on its own.
      const cutoff = Date.now() - 120_000;
      for (const p of peers.current.values()) if (p.token === token && p.at > cutoff) return;
      const url = `/api/claims/${token}/release?contributor=${id}`;
      const queued = typeof navigator.sendBeacon === 'function' && navigator.sendBeacon(url);
      if (!queued) fetch(url, { method: 'POST', keepalive: true }).catch(() => {});
      store.set(SS_PENDING_RELEASE, { token, who: id }, 'session');
    };
    window.addEventListener('pagehide', onHide);
    return () => window.removeEventListener('pagehide', onHide);
  }, []);

  // ---- actions ----
  const choose = () => {
    const id = Number(idInput);
    if (!Number.isInteger(id) || id <= 0) { setError('Enter a contributor id (a positive whole number).'); return; }
    const w = { id, language: langInput || usualLang || languages[0] };
    store.set(LS_WHO, w);
    setWho(w);
    void getScript(w);
  };

  const switchContributor = async () => {
    const token = tokenRef.current;
    const id = whoRef.current?.id;
    if (token && id && !settledRef.current) await api(`/claims/${token}/release`, { who: id }).catch(() => {});
    tokenRef.current = null;
    store.del(LS_WHO);
    rec.discard();
    setClaim(null);
    setWho(null);
    setNotice(null);
    setResult(null);
    setPhase('setup');
  };

  const doSubmit = async () => {
    const take = rec.take;
    if (!claim || !take || !who) return;
    setError(null);
    const onRetry = (n: number) => setSubmit((s) => (s ? { ...s, retry: n } : s));
    submittingRef.current = true;
    try {
      setSubmit({ stage: 'url', progress: 0 });
      const u = await api<{ url: string; contentType: string }>(`/claims/${claim.token}/upload-url`, { who: who.id, retries: 4, onRetry });
      setSubmit({ stage: 'upload', progress: 0 });
      await withRetry(() => putWithProgress(u.url, take.blob, u.contentType, (p) => setSubmit({ stage: 'upload', progress: p })), 4, onRetry);
      setSubmit({ stage: 'finish', progress: 1 });
      // idempotent per claim token, so retrying after a lost response is safe
      const r = await api<SubmitResp>('/recordings', { who: who.id, body: { token: claim.token }, retries: 6, onRetry });
      settledRef.current = true;
      bc.current?.postMessage({ type: 'settled', tab: tabId.current, token: claim.token });
      setResult({ kind: r.status, scriptId: r.scriptId, seconds: take.seconds, recordingId: r.recordingId });
      setNotice(null);
      setPhase('done');
      void loadInfo(who.id);
    } catch (e) {
      if (e instanceof ApiError && e.code === 'script_taken') {
        settledRef.current = true;
        setResult({ kind: 'taken', scriptId: claim.scriptId, seconds: take.seconds });
        setNotice(null);
        setPhase('done');
      } else if (e instanceof ApiError && e.code === 'upload_missing') {
        setError('The upload did not reach storage. Submit again; your recording is still here.');
      } else if (e instanceof ApiError) {
        setError(e.message);
      } else {
        setError('Could not reach the server. Your recording is still here, and submitting again is safe.');
      }
    } finally {
      submittingRef.current = false;
      setSubmit(null);
    }
  };

  // ---- render ----
  const recording = rec.state === 'recording';
  const busy = submit !== null;
  const rate = info?.payCentsPerHour ?? 500;
  const estCents = (s: number) => Math.round((s / 3600) * rate);
  const leaseFrac = Math.min(1, leaseLeft / Math.max(1, leaseTotal));

  return (
    <main className="page page-narrow">
      <h1>Record a script</h1>
      <p className="sub">Read the script aloud in a quiet room. Your script is held for you while this page is open.</p>

      {notice && (
        <div className={`notice ${notice.tone}`} role="status">
          <strong>{notice.title}</strong>
          {notice.text && <span className="small">{notice.text}</span>}
        </div>
      )}

      <section className="card">
        {phase === 'setup' ? (
          <div className="row" style={{ alignItems: 'flex-end' }}>
            <label>
              Contributor id
              <input type="number" min={1} value={idInput} onChange={(e) => setIdInput(e.target.value)} style={{ width: 120 }}
                onKeyDown={(e) => { if (e.key === 'Enter') choose(); }} />
            </label>
            <label>
              Language
              <select value={langInput || usualLang || ''} onChange={(e) => setLangInput(e.target.value)}>
                {languages.map((l) => <option key={l} value={l}>{l}{l === usualLang ? ' (usual)' : ''}</option>)}
              </select>
            </label>
            <button className="primary" onClick={choose}>Get script</button>
            <span className="muted small">Stands in for signing in.</span>
          </div>
        ) : (
          <div className="row">
            <span>Contributor <strong>#{who?.id}</strong></span>
            <span className="pill">{who?.language}</span>
            <span className="spacer" />
            {info && (
              <span className="small muted num" title={`$${(rate / 100).toFixed(2)} per approved hour of audio`}>
                Estimated {money(info.earnings.estimatedCents)} · Approved {money(info.earnings.approvedCents)} · Paid {money(info.earnings.paidCents)}
              </span>
            )}
            <button className="small" onClick={switchContributor} disabled={recording || busy}>Switch</button>
          </div>
        )}
        {error && phase === 'setup' && <p className={styles.error}>{error}</p>}
      </section>

      {phase === 'claiming' && <section className="card muted">Finding a script…</section>}

      {phase === 'empty' && (
        <section className="card">
          <h2>No scripts left right now</h2>
          <p className="muted">{emptyMsg} New scripts are added regularly.</p>
          <div className="row" style={{ marginTop: 12 }}>
            <button onClick={() => who && getScript(who)}>Try again</button>
            <a href="/stats" className="small">See which languages have scripts</a>
          </div>
        </section>
      )}

      {phase === 'active' && claim && (
        <>
          <section className="card">
            <div className="card-head">
              <div className="row">
                <h2>Script #{claim.scriptId}</h2>
                <span className="pill">{claim.language}</span>
                {claim.status === 'resumed' && <span className="pill accent" title="Same script and lease as before (refresh or another tab)">Resumed</span>}
              </div>
              <div className={styles.lease} aria-live="off">
                {leaseLost ? (
                  <span className="pill warn">Session expired</span>
                ) : (
                  <>
                    <span className="small muted">Held for you</span>
                    <span className={`num ${styles.leaseClock}`}>{clock(leaseLeft)}</span>
                    {offline && <span className="pill warn">Reconnecting…</span>}
                  </>
                )}
              </div>
            </div>
            {!leaseLost && (
              <div className={styles.leaseBar} title={`Renews every ${claim.heartbeatSeconds} s while this page is open`}>
                <span style={{ transform: `scaleX(${leaseFrac})` }} />
              </div>
            )}
            <p className={styles.script} lang={claim.language}>{claim.body}</p>
            <p className="small muted">Renews automatically every {claim.heartbeatSeconds} s while this page is open.</p>
          </section>

          {leaseLost && (
            <div className="row" style={{ marginBottom: 16 }}>
              <button onClick={() => void recoverLease.current()} disabled={busy}>Try again</button>
              <span className="small muted">Checking whether your script is still free…</span>
            </div>
          )}

          <section className="card">
            <div className="card-head">
              <h2>Recording</h2>
              <span className="small muted">WAV · 48 kHz · 16-bit · mono</span>
            </div>

            {rec.state !== 'recorded' && (
              <>
                <div className={styles.meterRow}>
                  <div className={styles.meter}><div ref={meterRef} className={styles.meterFill} /></div>
                  <span className={`num ${styles.elapsed}`}>{clock(rec.elapsed)}</span>
                </div>
                <div className="row">
                  {!recording ? (
                    <button className="primary" onClick={rec.start} disabled={rec.state === 'starting' || rec.state === 'stopping'}>
                      {rec.state === 'starting' ? 'Starting…' : rec.state === 'stopping' ? 'Finishing…' : '● Start recording'}
                    </button>
                  ) : (
                    <button className="primary" onClick={rec.stop}>■ Stop</button>
                  )}
                  {recording && <span className={`small ${styles.live}`}>Recording</span>}
                  {rec.clipped && <span className="pill warn">Too loud: move back from the mic</span>}
                  <span className="spacer" />
                  {recording && <span className="small muted">Stops by itself at {MAX_SECONDS / 60} min</span>}
                </div>
              </>
            )}

            {rec.take && rec.state === 'recorded' && (
              <div>
                <audio controls src={rec.take.url} className={styles.audio} />
                <p className="small muted num" style={{ margin: '8px 0 14px' }}>
                  {clock(rec.take.seconds)} · {(rec.take.bytes / 1e6).toFixed(1)} MB · estimated {money(estCents(rec.take.seconds))} once approved
                </p>
                {submit ? (
                  <div className={styles.progress}>
                    <div className={styles.progressBar}><span style={{ transform: `scaleX(${submit.stage === 'upload' ? submit.progress : submit.stage === 'finish' ? 1 : 0})` }} /></div>
                    <span className="small muted num">
                      {submit.stage === 'url' ? 'Preparing upload…' : submit.stage === 'upload' ? `Uploading ${Math.round(submit.progress * 100)}%` : 'Submitting…'}
                      {submit.retry ? ` (retry ${submit.retry})` : ''}
                    </span>
                  </div>
                ) : (
                  <div className="row">
                    <button className="primary" onClick={doSubmit}>{error ? 'Submit again' : 'Submit'}</button>
                    <button onClick={rec.discard}>Re-record</button>
                  </div>
                )}
              </div>
            )}

            {rec.error && <p className={styles.error}>{rec.error}</p>}
            {error && <p className={styles.error}>{error}</p>}
            {rec.mic && (
              <p className="small muted" style={{ marginTop: 12 }}>
                {rec.mic.captureRate === TARGET_RATE
                  ? 'Captured at 48 kHz.'
                  : `Your device records at ${(rec.mic.captureRate / 1000).toFixed(1)} kHz; the take is resampled to 48 kHz.`}
                {' '}Raw input: {[
                  rec.mic.echoCancellation === true && 'echo cancellation is ON (browser ignored the request)',
                  rec.mic.noiseSuppression === true && 'noise suppression is ON (browser ignored the request)',
                  rec.mic.autoGainControl === true && 'auto gain is ON (browser ignored the request)',
                ].filter(Boolean).join(', ') || 'echo cancellation, noise suppression and auto gain off.'}
              </p>
            )}
          </section>
        </>
      )}

      {phase === 'done' && result && (
        <section className="card">
          {result.kind === 'submitted' && (
            <div className="notice ok"><strong>Submitted. Thank you!</strong>
              <span className="small">Recording #{result.recordingId} for script #{result.scriptId} · {clock(result.seconds)} · estimated {money(estCents(result.seconds))}, paid once approved.</span></div>
          )}
          {result.kind === 'late_accepted' && (
            <div className="notice ok"><strong>Submitted (after your session expired).</strong>
              <span className="small">Nobody else had taken script #{result.scriptId}, so your recording was accepted · estimated {money(estCents(result.seconds))}, paid once approved.</span></div>
          )}
          {result.kind === 'taken' && (
            <div className="notice bad"><strong>This recording wasn’t used.</strong>
              <span className="small">Your session on script #{result.scriptId} expired and the script was given to someone else before you submitted. Nothing is wrong with your recording; the next script is yours to keep while the page is open.</span></div>
          )}
          {result.kind === 'other_tab' && (
            <div className="notice"><strong>This script was finished in another tab.</strong></div>
          )}
          <div className="row">
            <button className="primary" onClick={() => who && getScript(who)}>Next script</button>
            <span className="small muted">Pay is ${(rate / 100).toFixed(2)} per approved hour of audio; amounts are estimated until a reviewer approves them.</span>
          </div>
        </section>
      )}
    </main>
  );
}
