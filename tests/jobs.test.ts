// Phase 2 case 11: the background job.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { claim } from '@/lib/assign';
import { cleanupExpired, statsAndAlerts, runJob, poolSnapshot } from '@/lib/jobs';
import { reset, sleep, q, scriptRow, claimed } from './helpers';

describe('11. job', () => {
  beforeEach(() => reset({ en: 10, fr: 4, de: 1 }, 40));
  afterEach(() => {
    process.env.LOW_POOL_ALERT_HOURS = '2';
    process.env.FORECAST_WINDOW_SECONDS = '3600';
  });

  it('cleanupExpired: expired rows -> available with prev_token, live leases untouched', async () => {
    const dead1 = claimed(await claim(1, 'en', { leaseSeconds: 1 }));
    const dead2 = claimed(await claim(2, 'fr', { leaseSeconds: 1 }));
    const live = claimed(await claim(3, 'en'));
    await sleep(1500);
    expect(await cleanupExpired()).toBe(2);
    expect(await scriptRow(dead1.scriptId)).toMatchObject({ status: 'available', claimed_by: null, claim_token: null, lease_expires_at: null, prev_token: dead1.token, prev_claimed_by: 1 });
    expect(await scriptRow(dead2.scriptId)).toMatchObject({ status: 'available', prev_token: dead2.token, prev_claimed_by: 2 });
    expect(await scriptRow(live.scriptId)).toMatchObject({ status: 'claimed', claimed_by: 3, claim_token: live.token });
    const evs = await q(`SELECT claim_token, contributor_id FROM claim_events WHERE event='expired' AND detail->>'by'='job' ORDER BY contributor_id`);
    expect(evs).toEqual([{ claim_token: dead1.token, contributor_id: 1 }, { claim_token: dead2.token, contributor_id: 2 }]);
    expect(await cleanupExpired()).toBe(0); // idempotent
    // the cleaned-up script is claimable by someone else, which clears prev_token
    const again = claimed(await claim(4, 'fr'));
    expect(again.scriptId).toBe(dead2.scriptId);
    expect((await scriptRow(dead2.scriptId)).prev_token).toBeNull();
  });

  it('statsAndAlerts: one pool_stats row per language with correct counts', async () => {
    claimed(await claim(1, 'en'));
    claimed(await claim(2, 'en'));
    claimed(await claim(3, 'fr', { leaseSeconds: 1 }));
    await sleep(1500); // fr lease expired but not cleaned: counted as available
    await statsAndAlerts();
    const rows = await q<Record<string, any>>('SELECT * FROM pool_stats ORDER BY language');
    expect(rows.map((r) => r.language)).toEqual(['de', 'en', 'fr']);
    const by = Object.fromEntries(rows.map((r) => [r.language, r]));
    expect(by.en).toMatchObject({ available: 8, claimed: 2, submitted: 0, approved: 0, claims_last_window: 2 });
    expect(by.fr).toMatchObject({ available: 4, claimed: 0, claims_last_window: 1 });
    expect(by.de).toMatchObject({ available: 1, claimed: 0, claims_last_window: 0, hours_left: null });
    // en: 2 claims in a 1 h window = 2/h, 8 available => 4 h
    expect(by.en.hours_left).toBeCloseTo(4, 5);
  });

  it('low_pool alert when a language forecast is under LOW_POOL_ALERT_HOURS; none above it', async () => {
    for (let i = 1; i <= 6; i++) claimed(await claim(i, 'en')); // 6/h, 4 left => 0.67 h
    claimed(await claim(7, 'fr')); // 1/h, 3 left => 3 h
    const { alerts } = await statsAndAlerts();
    const rows = await q<Record<string, any>>('SELECT kind, language FROM alerts ORDER BY language');
    expect(rows).toEqual([{ kind: 'low_pool', language: 'en' }]);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatch(/^en:/);

    process.env.LOW_POOL_ALERT_HOURS = '5'; // config is read per call
    await statsAndAlerts();
    const kinds = await q(`SELECT kind, language FROM alerts WHERE id > 1 ORDER BY language`);
    expect(kinds).toEqual([{ kind: 'low_pool', language: 'en' }, { kind: 'low_pool', language: 'fr' }]);
  });

  it('pool_empty alert when a language has nothing available', async () => {
    claimed(await claim(1, 'de'));
    await statsAndAlerts();
    expect(await q(`SELECT kind, language FROM alerts`)).toEqual([{ kind: 'pool_empty', language: 'de' }]);
  });

  it('runJob: cleans up, writes stats, reports', async () => {
    claimed(await claim(1, 'en', { leaseSeconds: 1 }));
    await sleep(1500);
    const r = await runJob();
    expect(r).toMatchObject({ expired: 1, pools: 3 });
    expect(await q('SELECT * FROM pool_stats')).toHaveLength(3);
    const snap = await poolSnapshot();
    expect(snap.find((p) => p.language === 'en')).toMatchObject({ available: 10, claimed: 0 });
  });
});
