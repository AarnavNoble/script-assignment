'use client';
// Live lease timeline: one row per script, one bar per claim token, the x axis sliding with Postgres time.
// Solid = the holder was heard from (claim / heartbeats / submit); hatched = lease time left after the last
// heartbeat. Bar geometry is in absolute time, so between polls only one CSS variable (the slide) changes.
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type MouseEvent } from 'react';
import s from './timeline.module.css';

type EndReason = 'live' | 'heartbeating' | 'submitted' | 'late_accepted' | 'released' | 'expired' | 'reclaimed' | 'rejected';
type Piece = { start: string; activeEnd: string; end: string; ended: EndReason };
type Segment = {
  token: string; contributorId: number; start: string; end: string; endReason: EndReason; live: boolean;
  heartbeats: string[]; revived: boolean; leaseEnd: string | null; pieces: Piece[]; rejectedAt: string | null; lostAt: string | null;
};
type Row = { scriptId: number; language: string; segments: Segment[] };
type Timeline = { now: string; since: string; minutes: number; leaseSeconds: number; heartbeatSeconds: number; rows: Row[] };

const POLL_MS = 2000;
const LABEL_W = 84;
const ROW_H = 20;
const BAR_H = 10;
const AXIS_H = 22;
const TOP = 16; // room for the "now" label above the plot
const FUTURE_FRAC = 0.12; // a sliver right of "now" so the lease still ahead is visible
const PALETTE = 8;

// hash, not id % n: contributor ids often share a stride (seeded per language), which would collapse to a few colors
const slot = (id: number) => {
  let h = id | 0;
  h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b); h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35); h ^= h >>> 16;
  return (h >>> 0) % PALETTE;
};
const color = (id: number) => `var(--tl-c${slot(id)})`;
const ms = (iso: string) => new Date(iso).getTime();
const hms = (t: number) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
const dur = (msec: number) => {
  const sec = Math.max(0, Math.round(msec / 1000));
  return sec < 90 ? `${sec} s` : `${Math.floor(sec / 60)} min ${sec % 60} s`;
};

const ENDED: Record<EndReason, string> = {
  live: 'Lease open, no heartbeat lately',
  heartbeating: 'Live, heartbeating',
  submitted: 'Submitted',
  late_accepted: 'Submitted late (lease had lapsed, nobody took it): accepted',
  released: 'Tab closed: lease cut to a short grace',
  expired: 'Lease expired (tab vanished)',
  reclaimed: 'Lease expired; the next claim took the script',
  rejected: 'Lease expired, script re-claimed; late take rejected',
};

export function LeaseTimeline({ minutes = 3, limit = 25 }: { minutes?: number; limit?: number }) {
  const uid = useId().replace(/:/g, '');
  const [data, setData] = useState<Timeline | null>(null);
  const [failed, setFailed] = useState(false);
  const [width, setWidth] = useState(900);
  const [hover, setHover] = useState<{ row: Row; seg: Segment; x: number; y: number } | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const offsetRef = useRef(0); // server clock - browser clock
  const t0Ref = useRef<number | null>(null); // fixed origin so coordinates stay small
  const kRef = useRef(0);
  const nowXRef = useRef(0);
  const heightRows = useRef({ rows: 0, lowerSince: 0 });

  const load = useCallback(async () => {
    if (typeof document !== 'undefined' && document.hidden) return;
    try {
      const res = await fetch(`/api/ops/timeline?minutes=${minutes}&limit=${limit}`, { cache: 'no-store' });
      if (!res.ok) throw new Error(String(res.status));
      const d = (await res.json()) as Timeline;
      offsetRef.current = ms(d.now) - Date.now();
      t0Ref.current ??= ms(d.now);
      setData(d);
      setFailed(false);
    } catch { setFailed(true); }
  }, [minutes, limit]);

  useEffect(() => {
    void load();
    const id = setInterval(load, POLL_MS);
    return () => clearInterval(id);
  }, [load]);

  useLayoutEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setWidth(Math.max(320, Math.floor(e.contentRect.width))));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Slide: one CSS variable per frame, no React render.
  useEffect(() => {
    let raf = 0;
    const tick = () => {
      const svg = svgRef.current;
      if (svg && t0Ref.current !== null) {
        const now = Date.now() + offsetRef.current;
        svg.style.setProperty('--tl-shift', `${nowXRef.current - kRef.current * (now - t0Ref.current)}px`);
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  const windowMs = minutes * 60_000;
  const futureMs = windowMs * FUTURE_FRAC;
  const plotW = width - LABEL_W;
  const k = plotW / (windowMs + futureMs);
  const nowX = LABEL_W + k * windowMs;
  kRef.current = k;
  nowXRef.current = nowX;
  const t0 = t0Ref.current ?? 0;
  const x = (t: number) => k * (t - t0);

  // Height: grow at once, shrink only after the row count has stayed lower for 10 s (no jitter between polls).
  const rows = data?.rows ?? [];
  const hr = heightRows.current;
  if (rows.length >= hr.rows) { hr.rows = rows.length; hr.lowerSince = 0; }
  else if (!hr.lowerSince) hr.lowerSince = Date.now();
  else if (Date.now() - hr.lowerSince > 10_000) { hr.rows = rows.length; hr.lowerSince = 0; }
  const nRows = Math.max(hr.rows, rows.length);
  const plotH = nRows * ROW_H + 6;
  const height = TOP + plotH + AXIS_H;

  // axis ticks, padded so the sliding axis never runs out between polls
  const serverNow = data ? ms(data.now) : 0;
  const stepS = [5, 10, 15, 30, 60, 120, 300, 600].find((v) => v * 1000 >= windowMs / 8) ?? 600;
  const ticks: number[] = [];
  if (data) {
    const step = stepS * 1000;
    for (let t = Math.ceil((serverNow - windowMs - 60_000) / step) * step; t <= serverNow + futureMs + 60_000; t += step) ticks.push(t);
  }

  const onMove = (row: Row, seg: Segment) => (e: MouseEvent) => {
    const r = wrapRef.current?.getBoundingClientRect();
    if (!r) return;
    setHover({ row, seg, x: e.clientX - r.left, y: e.clientY - r.top });
  };

  const slide = { transform: 'translateX(var(--tl-shift, 0px))' } as const;
  const mid = BAR_H / 2;

  return (
    <section className={`card ${s.root}`}>
      <div className="card-head">
        <h2>Leases, live</h2>
        <span className="small muted">
          {failed ? <span className="pill warn">Can’t reach the server, retrying</span>
            : data ? `Each bar is one claim token · last ${minutes} min · lease ${data.leaseSeconds} s, heartbeat every ${data.heartbeatSeconds} s`
            : 'Loading…'}
        </span>
      </div>

      <div className={s.legend} aria-label="Legend">
        <span>
          <svg width="30" height="10">
            <defs><Hatch id={`${uid}-lh`} c="var(--tl-c0)" /></defs>
            <rect x="0" y="1" width="16" height="8" rx="2" fill="var(--tl-c0)" />
            <line x1="5" x2="5" y1="3" y2="7" stroke="var(--surface)" strokeWidth="1.2" /><line x1="11" x2="11" y1="3" y2="7" stroke="var(--surface)" strokeWidth="1.2" />
            <rect x="16" y="1.5" width="13" height="7" fill={`url(#${uid}-lh)`} stroke="var(--tl-c0)" strokeOpacity=".45" />
          </svg>
          holder (color) with heartbeats, then lease time left
        </span>
        <span><svg width="12" height="12"><Mark kind="submitted" x={6} y={6} /></svg>submitted</span>
        <span><svg width="12" height="12"><Mark kind="late_accepted" x={6} y={6} /></svg>late, accepted</span>
        <span><svg width="12" height="12"><Mark kind="expired" x={6} y={6} /></svg>expired (tab vanished)</span>
        <span><svg width="12" height="12"><Mark kind="released" x={6} y={6} /></svg>released (tab closed)</span>
        <span><svg width="14" height="12"><circle cx="7" cy="6" r="4" fill="none" stroke="var(--muted)" strokeWidth="1.6" /></svg>revived, same token</span>
        <span><svg width="12" height="12"><path d="M6 1 L11 6 L6 11 L1 6 Z" fill="none" stroke="var(--bad)" strokeWidth="1.5" /></svg>late take rejected</span>
        <span><svg width="22" height="10"><line x1="1" y1="5" x2="16" y2="5" stroke="var(--muted)" strokeDasharray="2 2" /><path d="M15 2 L20 5 L15 8 Z" fill="var(--muted)" /></svg>next holder</span>
      </div>

      <div ref={wrapRef} className={s.wrap} onMouseLeave={() => setHover(null)}>
        {!data || rows.length === 0 ? (
          <div className={s.empty} style={{ height: Math.max(120, TOP + plotH + AXIS_H) }}>
            {data ? `No lease activity in the last ${minutes} minutes` : failed ? 'Waiting for the server…' : 'Loading…'}
          </div>
        ) : (
          <svg ref={svgRef} className={s.svg} width={width} height={height} role="img" aria-label="Lease timeline">
            <g transform={`translate(0 ${TOP})`}>
            <defs>
              <clipPath id={`${uid}-clip`}><rect x={LABEL_W} y={-TOP} width={plotW} height={height} /></clipPath>
              {/* tick labels fade out at both edges instead of being cut mid-label */}
              <linearGradient id={`${uid}-fade`} gradientUnits="userSpaceOnUse" x1={LABEL_W} x2={width} y1="0" y2="0">
                <stop offset="0" stopColor="#fff" stopOpacity="0" />
                <stop offset={30 / plotW} stopColor="#fff" stopOpacity="1" />
                <stop offset={1 - 30 / plotW} stopColor="#fff" stopOpacity="1" />
                <stop offset="1" stopColor="#fff" stopOpacity="0" />
              </linearGradient>
              <mask id={`${uid}-mask`} maskUnits="userSpaceOnUse" x={LABEL_W} y={-TOP} width={plotW} height={height}>
                <rect x={LABEL_W} y={-TOP} width={plotW} height={height} fill={`url(#${uid}-fade)`} />
              </mask>
              {Array.from({ length: PALETTE }, (_, i) => <Hatch key={i} id={`${uid}-h${i}`} c={`var(--tl-c${i})`} />)}
            </defs>

            {/* future strip + grid + axis */}
            <rect x={nowX} y={0} width={width - nowX} height={plotH} fill="var(--tl-future)" />
            <g mask={`url(#${uid}-mask)`}>
              <g style={slide}>
                {ticks.map((t) => (
                  <g key={t}>
                    <line x1={x(t)} x2={x(t)} y1={0} y2={plotH} stroke="var(--tl-grid)" />
                    <text className={s.tick} x={x(t)} y={plotH + 15} textAnchor="middle">{hms(t)}</text>
                  </g>
                ))}
              </g>
            </g>
            <line x1={nowX} x2={nowX} y1={0} y2={plotH} stroke="var(--accent)" strokeWidth="1.5" />
            <text className={s.nowLabel} x={nowX} y={-5} textAnchor="middle">now</text>

            {rows.map((row, i) => (
              <g key={row.scriptId} className={s.row} style={{ transform: `translateY(${i * ROW_H + 3}px)` }}>
                <text className={s.label} x={0} y={ROW_H / 2 + 1} dominantBaseline="middle">
                  #{row.scriptId} <tspan className={s.lang}>{row.language}</tspan>
                </text>
                <g clipPath={`url(#${uid}-clip)`}>
                  <g style={slide}>
                    <g transform={`translate(0 ${(ROW_H - BAR_H) / 2})`}>
                      {row.segments.map((seg, j) => {
                        const next = row.segments[j + 1];
                        return next && ms(next.start) > ms(seg.end) ? (
                          <g key={`h${seg.token}`}>
                            <line x1={x(ms(seg.end)) + 6} x2={x(ms(next.start)) - 4} y1={mid} y2={mid} stroke="var(--muted)" strokeDasharray="2 2" />
                            <path d={`M${x(ms(next.start)) - 5} ${mid - 3} L${x(ms(next.start))} ${mid} L${x(ms(next.start)) - 5} ${mid + 3} Z`} fill="var(--muted)" />
                          </g>
                        ) : null;
                      })}
                      {row.segments.map((seg) => (
                        <SegmentBars key={seg.token} seg={seg} x={x} uid={uid} onMove={onMove(row, seg)} />
                      ))}
                    </g>
                  </g>
                </g>
              </g>
            ))}
            </g>
          </svg>
        )}

        {hover && data && <Tip {...hover} now={serverNow} width={width} />}
      </div>
    </section>
  );
}

function SegmentBars({ seg, x, uid, onMove }: { seg: Segment; x: (t: number) => number; uid: string; onMove: (e: MouseEvent) => void }) {
  const c = color(seg.contributorId);
  const hatch = `url(#${uid}-h${slot(seg.contributorId)})`;
  const mid = BAR_H / 2;
  const x0 = x(ms(seg.pieces[0].start));
  const last = seg.pieces[seg.pieces.length - 1];
  const x1 = Math.max(x(ms(last.end)), seg.live ? 0 : x(ms(seg.end)));
  return (
    <g className={s.seg} onMouseMove={onMove} onMouseEnter={onMove}>
      {/* hit area */}
      <rect x={x0 - 4} y={-5} width={Math.max(8, x1 - x0 + 10)} height={BAR_H + 10} fill="transparent" />
      {seg.pieces.map((p, i) => {
        const a = x(ms(p.start));
        const b = Math.max(a + 2, x(ms(p.activeEnd)));
        const e = Math.max(b, x(ms(p.end)));
        const isLast = i === seg.pieces.length - 1;
        const nextP = seg.pieces[i + 1];
        return (
          <g key={i}>
            {e > b + 0.5 && <rect x={b} y={0.5} width={e - b} height={BAR_H - 1} fill={hatch} stroke={c} strokeOpacity="0.45" strokeWidth="1" />}
            <rect className={s.solid} x={a} y={0} width={b - a} height={BAR_H} rx={2} fill={c} />
            {/* revived: dotted gap while lapsed, ring where it came back */}
            {nextP && (
              <>
                <line x1={e + 5} x2={x(ms(nextP.start)) - 5} y1={mid} y2={mid} stroke={c} strokeDasharray="1 3" strokeWidth="1.5" strokeLinecap="round" />
                <Mark kind={p.ended} x={e} y={mid} small />
              </>
            )}
            {isLast && !seg.live && (() => {
              // late accept: the lease lapsed first, the take arrived later (dotted gap, then the mark)
              const se = x(ms(seg.end));
              return se > e + 8 ? (
                <>
                  <line x1={e + 2} x2={se - 5} y1={mid} y2={mid} stroke={c} strokeDasharray="1 3" strokeWidth="1.5" strokeLinecap="round" />
                  <Mark kind={p.ended} x={se} y={mid} />
                </>
              ) : <Mark kind={p.ended} x={e} y={mid} />;
            })()}
            {isLast && seg.live && seg.endReason === 'heartbeating' && (
              <circle className={s.beat} cx={b} cy={mid} r={2.2} fill="var(--surface)" />
            )}
          </g>
        );
      })}
      {/* revive rings last, so the next stretch's bar doesn't cover them */}
      {seg.pieces.slice(1).map((p) => (
        <circle key={p.start} cx={x(ms(p.start))} cy={mid} r={4.5} fill="var(--surface)" stroke={c} strokeWidth="1.8" />
      ))}
      {seg.heartbeats.map((h) => {
        const hx = x(ms(h));
        return <line key={h} x1={hx} x2={hx} y1={2} y2={BAR_H - 2} stroke="var(--surface)" strokeWidth="1.2" strokeOpacity="0.85" />;
      })}
      {seg.rejectedAt && (
        <g transform={`translate(${x(ms(seg.rejectedAt))} ${mid})`}>
          <path d="M0 -5 L5 0 L0 5 L-5 0 Z" fill="var(--surface)" stroke="var(--bad)" strokeWidth="1.5" />
        </g>
      )}
    </g>
  );
}

function Hatch({ id, c }: { id: string; c: string }) {
  return (
    <pattern id={id} width="5" height="5" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
      <rect width="5" height="5" fill={c} fillOpacity="0.12" />
      <line x1="0" y1="0" x2="0" y2="5" stroke={c} strokeWidth="2" strokeOpacity="0.55" />
    </pattern>
  );
}

function Mark({ kind, x, y, small = false }: { kind: EndReason; x: number; y: number; small?: boolean }) {
  const r = small ? 4 : 5.5;
  const sc = r / 5.5;
  const fill = kind === 'submitted' ? 'var(--ok)' : kind === 'late_accepted' ? 'var(--warn)'
    : kind === 'released' ? 'var(--muted)' : kind === 'expired' || kind === 'reclaimed' || kind === 'rejected' ? 'var(--bad)' : null;
  if (!fill) return null;
  const glyph = kind === 'submitted' || kind === 'late_accepted'
    ? <path d="M-2.6 0.2 L-0.7 2.1 L2.8 -1.8" fill="none" stroke="var(--surface)" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    : kind === 'released'
      ? <line x1="-2.4" x2="2.4" y1="0" y2="0" stroke="var(--surface)" strokeWidth="1.6" strokeLinecap="round" />
      : <path d="M-2 -2 L2 2 M2 -2 L-2 2" stroke="var(--surface)" strokeWidth="1.6" strokeLinecap="round" />;
  return (
    <g transform={`translate(${x} ${y}) scale(${sc})`} opacity={small ? 0.8 : 1}>
      <circle r={5.5} fill={fill} stroke="var(--surface)" strokeWidth="1" />
      {glyph}
    </g>
  );
}

function Tip({ row, seg, x, y, now, width }: { row: Row; seg: Segment; x: number; y: number; now: number; width: number }) {
  const start = ms(seg.start);
  const end = seg.live ? now : ms(seg.end);
  const left = Math.min(Math.max(0, x + 14), width - 290);
  const lease = seg.leaseEnd ? ms(seg.leaseEnd) : null;
  return (
    <div className={s.tip} style={{ left, top: y + 16 }}>
      <div><strong>Contributor {seg.contributorId}</strong> on script #{row.scriptId} <span className="muted">{row.language}</span></div>
      <div className="mono muted">token {seg.token.slice(0, 8)}</div>
      <div className="num">{hms(start)} → {seg.live ? 'now' : hms(end)} <span className="muted">({dur(end - start)})</span></div>
      <div>{ENDED[seg.endReason]}{seg.live && lease ? `; lease ends in ${dur(lease - now)}` : ''}</div>
      <div className="muted">
        {seg.heartbeats.length} heartbeat{seg.heartbeats.length === 1 ? '' : 's'} in view
        {seg.revived ? ' · revived after a lapse (same token)' : ''}
      </div>
      {seg.rejectedAt && <div style={{ color: 'var(--bad)' }}>Late submit rejected at {hms(ms(seg.rejectedAt))}</div>}
      {seg.lostAt && <div className="muted">A heartbeat was refused at {hms(ms(seg.lostAt))}</div>}
    </div>
  );
}
