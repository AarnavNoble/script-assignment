'use client';
import { useEffect, useState } from 'react';
import { api } from './api';

export type PoolRow = {
  language: string;
  available: number;
  claimed: number;
  submitted: number;
  approved: number;
  claimsLastWindow: number;
  hoursLeft: number | null;
};

const REFRESH_MS = 3000;

export function hoursText(h: number | null): string {
  if (h === null) return 'no recent claims';
  if (h < 1 / 60) return 'under a minute';
  if (h < 1) return `${Math.round(h * 60)} min`;
  if (h < 48) return `${h.toFixed(1)} h`;
  return `${Math.round(h / 24)} days`;
}

export function poolClass(p: PoolRow, lowHours: number) {
  if (p.available === 0) return 'dry';
  if (p.hoursLeft !== null && p.hoursLeft < lowHours) return 'low';
  return '';
}

export function PoolTable({ pools, order, contributors, lowHours, compact }: {
  pools: PoolRow[]; order: string[]; contributors?: Record<string, number>; lowHours: number; compact?: boolean;
}) {
  const rank = new Map(order.map((l, i) => [l, i]));
  const rows = [...pools].sort((a, b) => (rank.get(a.language) ?? 99) - (rank.get(b.language) ?? 99) || a.language.localeCompare(b.language));
  const max = Math.max(1, ...rows.map((p) => p.available + p.claimed + p.submitted + p.approved));
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Language</th>
            {contributors && !compact && <th className="r">Contributors</th>}
            <th className="r">Available</th>
            <th style={{ width: '22%' }}></th>
            <th className="r">Recording now</th>
            {!compact && <th className="r">Submitted</th>}
            {!compact && <th className="r">Approved</th>}
            <th className="r">Claims / h</th>
            <th className="r">Runs out in</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((p) => {
            const cls = poolClass(p, lowHours);
            return (
              <tr key={p.language} className={cls}>
                <td>
                  <strong>{p.language}</strong>{' '}
                  {cls === 'dry' && <span className="pill bad">empty</span>}
                  {cls === 'low' && <span className="pill warn">low</span>}
                </td>
                {contributors && !compact && <td className="r muted">{contributors[p.language] ?? 0}</td>}
                <td className="r">{p.available.toLocaleString()}</td>
                <td><div className="bar"><span style={{ width: `${(p.available / max) * 100}%` }} /></div></td>
                <td className="r">{p.claimed}</td>
                {!compact && <td className="r">{p.submitted}</td>}
                {!compact && <td className="r">{p.approved}</td>}
                <td className="r">{p.claimsLastWindow}</td>
                <td className="r">{hoursText(p.hoursLeft)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export default function StatsView({ order, contributors, lowHours }: { order: string[]; contributors: Record<string, number>; lowHours: number }) {
  const [pools, setPools] = useState<PoolRow[] | null>(null);
  const [updated, setUpdated] = useState<Date | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const r = await api<{ pools: PoolRow[] }>('/stats', { method: 'GET' });
        if (!alive) return;
        setPools(r.pools);
        setUpdated(new Date());
        setFailed(false);
      } catch {
        if (alive) setFailed(true);
      }
    };
    void load();
    const t = setInterval(load, REFRESH_MS);
    return () => { alive = false; clearInterval(t); };
  }, []);

  const low = pools?.filter((p) => poolClass(p, lowHours)) ?? [];
  const total = pools?.reduce((a, p) => a + p.available, 0) ?? 0;
  const live = pools?.reduce((a, p) => a + p.claimed, 0) ?? 0;

  return (
    <main className="page">
      <div className="card-head">
        <div>
          <h1>Script pool</h1>
          <p className="sub" style={{ marginBottom: 0 }}>Scripts left per language, and how long each pool lasts at the claim rate of the last hour.</p>
        </div>
        <span className="small muted num">
          {failed ? <span className="pill warn">Can’t reach the server, retrying</span> : updated ? `Updated ${updated.toLocaleTimeString()} · every ${REFRESH_MS / 1000} s` : 'Loading…'}
        </span>
      </div>
      <div style={{ height: 20 }} />
      {pools && (
        <>
          <div className="row" style={{ marginBottom: 16 }}>
            <span className="pill">{total.toLocaleString()} available</span>
            <span className="pill accent">{live} being recorded</span>
            {low.length > 0
              ? <span className="pill warn">Running low: {low.map((p) => p.language).join(', ')}</span>
              : <span className="pill ok">All pools healthy (over {lowHours} h left)</span>}
          </div>
          <section className="card">
            <PoolTable pools={pools} order={order} contributors={contributors} lowHours={lowHours} />
          </section>
          <p className="small muted">“Runs out in” = available ÷ claims in the last hour. Languages are ordered by how many contributors speak them. Highlighted rows will run out within {lowHours} h.</p>
        </>
      )}
    </main>
  );
}
