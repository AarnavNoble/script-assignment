// Phase 2 correctness cases 1-10 against real Postgres + MinIO. Case 11 (job) is in jobs.test.ts.
import { describe, it, expect, beforeEach } from 'vitest';
import { claim, heartbeat, release, submit, uploadUrl } from '@/lib/assign';
import { reset, upload, sleep, q, scriptRow, expectAppError, claimed } from './helpers';

describe('1. race', () => {
  beforeEach(() => reset({ en: 50 }, 200));

  it('200 concurrent claims by 200 contributors on 50 scripts: 50 distinct winners, 150 empty, no script twice', async () => {
    const ids = Array.from({ length: 200 }, (_, i) => i + 1);
    const results = await Promise.all(ids.map((id) => claim(id, 'en')));

    const wins = results.flatMap((r, i) => (r.status === 'claimed' ? [{ who: ids[i], ...r }] : []));
    const empties = results.filter((r) => r.status === 'empty');
    expect(wins).toHaveLength(50);
    expect(empties).toHaveLength(150);
    expect(new Set(wins.map((w) => w.scriptId)).size).toBe(50);
    expect(new Set(wins.map((w) => w.who)).size).toBe(50);
    expect(new Set(wins.map((w) => w.token)).size).toBe(50);

    // The database agrees: every script claimed exactly once, by the winner the API reported.
    const rows = await q<{ id: string; status: string; claimed_by: number; claim_token: string; times_claimed: number }>(
      'SELECT id, status, claimed_by, claim_token, times_claimed FROM scripts ORDER BY id');
    expect(rows).toHaveLength(50);
    for (const r of rows) {
      expect(r.status).toBe('claimed');
      expect(r.times_claimed).toBe(1);
      const w = wins.find((x) => x.scriptId === Number(r.id))!;
      expect(w.who).toBe(r.claimed_by);
      expect(w.token).toBe(r.claim_token);
    }
    const [ev] = await q<{ claimed: string; empty: string }>(
      `SELECT count(*) FILTER (WHERE event='claimed') AS claimed, count(*) FILTER (WHERE event='pool_empty') AS empty FROM claim_events`);
    expect(Number(ev.claimed)).toBe(50);
    expect(Number(ev.empty)).toBe(150);
  });
});

describe('2-10. single-contributor lifecycle', () => {
  beforeEach(() => reset({ en: 5, fr: 1 }, 20));

  it('2. resume: the same contributor claiming twice gets the same script and token', async () => {
    const a = claimed(await claim(1, 'en'));
    expect(a.status).toBe('claimed');
    const b = claimed(await claim(1, 'en'));
    expect(b.status).toBe('resumed');
    expect(b.scriptId).toBe(a.scriptId);
    expect(b.token).toBe(a.token);
    expect((await scriptRow(a.scriptId)).times_claimed).toBe(1);
  });

  it('3. expiry returns the script: 1 s lease, sleep 1.5 s, another contributor gets it', async () => {
    await reset({ en: 1 }, 20);
    const a = claimed(await claim(1, 'en', { leaseSeconds: 1 }));
    expect((await claim(2, 'en')).status).toBe('empty'); // still held
    await sleep(1500);
    const b = claimed(await claim(2, 'en'));
    expect(b.status).toBe('claimed');
    expect(b.scriptId).toBe(a.scriptId);
    expect(b.token).not.toBe(a.token);
    const row = await scriptRow(a.scriptId);
    expect(row.claimed_by).toBe(2);
    expect(row.prev_token).toBeNull();
    const [ev] = await q(`SELECT * FROM claim_events WHERE event='expired' AND claim_token=$1`, [a.token]);
    expect(ev).toMatchObject({ contributor_id: 1, detail: { by: 'reclaim' } });
  });

  it('4. fencing: after a re-claim the old token heartbeat -> 409 lease_lost, submit -> 409 script_taken', async () => {
    await reset({ en: 1 }, 20);
    const a = claimed(await claim(1, 'en', { leaseSeconds: 1 }));
    await upload(a.scriptId, a.token); // audio exists, so the rejection is about ownership, not storage
    await sleep(1500);
    const b = claimed(await claim(2, 'en'));
    expect(b.scriptId).toBe(a.scriptId);

    await expectAppError(heartbeat(1, a.token), 409, 'lease_lost');
    await expectAppError(submit(1, a.token), 409, 'script_taken');
    await expectAppError(uploadUrl(1, a.token), 409, 'script_taken');

    // The new holder is untouched, and no recording was created for the old token.
    const row = await scriptRow(a.scriptId);
    expect(row).toMatchObject({ status: 'claimed', claimed_by: 2, claim_token: b.token });
    expect(await q('SELECT * FROM recordings')).toHaveLength(0);
    await expect(heartbeat(2, b.token)).resolves.toHaveProperty('leaseRemainingSeconds');
  });

  it('4b. heartbeat with someone else\'s token -> 409 lease_lost', async () => {
    const a = claimed(await claim(1, 'en'));
    await expectAppError(heartbeat(2, a.token), 409, 'lease_lost');
  });

  it('5a. late but not re-claimed (row still claimed, lease expired): accepted with late=true', async () => {
    const a = claimed(await claim(1, 'en', { leaseSeconds: 1 }));
    await upload(a.scriptId, a.token);
    await sleep(1500);
    await expectAppError(heartbeat(1, a.token), 409, 'lease_lost'); // expired lease can't be revived
    const r = await submit(1, a.token);
    expect(r).toMatchObject({ status: 'late_accepted', late: true, duplicate: false, scriptId: a.scriptId });
    expect((await scriptRow(a.scriptId)).status).toBe('submitted');
    const [rec] = await q('SELECT * FROM recordings WHERE claim_token=$1', [a.token]);
    expect(rec).toMatchObject({ late: true, contributor_id: 1 });
  });

  it('5b. late but not re-claimed after cleanupExpired moved the token to prev_token: accepted with late=true', async () => {
    const { cleanupExpired } = await import('@/lib/jobs');
    const a = claimed(await claim(1, 'en', { leaseSeconds: 1 }));
    await upload(a.scriptId, a.token);
    await sleep(1500);
    expect(await cleanupExpired()).toBe(1);
    const row = await scriptRow(a.scriptId);
    expect(row).toMatchObject({ status: 'available', claim_token: null, prev_token: a.token, prev_claimed_by: 1 });
    await expect(uploadUrl(1, a.token)).resolves.toHaveProperty('key'); // still allowed to upload
    const r = await submit(1, a.token);
    expect(r).toMatchObject({ status: 'late_accepted', late: true, duplicate: false });
    expect(await scriptRow(a.scriptId)).toMatchObject({ status: 'submitted', prev_token: null });
  });

  it('5c. late after cleanup, but someone re-claimed: 409 script_taken', async () => {
    await reset({ en: 1 }, 20);
    const { cleanupExpired } = await import('@/lib/jobs');
    const a = claimed(await claim(1, 'en', { leaseSeconds: 1 }));
    await upload(a.scriptId, a.token);
    await sleep(1500);
    await cleanupExpired();
    const b = claimed(await claim(2, 'en'));
    expect(b.scriptId).toBe(a.scriptId);
    await expectAppError(submit(1, a.token), 409, 'script_taken');
  });

  it('5d. a contributor re-claiming after their own lease expired (not re-claimed) revives it with the same token', async () => {
    // A stalled contributor who comes back keeps their script and token, so the recording they
    // already uploaded under that token is still accepted.
    const a = claimed(await claim(1, 'en', { leaseSeconds: 1 }));
    await upload(a.scriptId, a.token);
    await sleep(1500);
    const b = claimed(await claim(1, 'en'));
    expect(b).toMatchObject({ status: 'resumed', scriptId: a.scriptId, token: a.token });
    expect(b.leaseRemainingSeconds).toBeGreaterThan(1);
    expect(await scriptRow(a.scriptId)).toMatchObject({ status: 'claimed', claim_token: a.token, prev_token: null, times_claimed: 1 });
    await expect(submit(1, a.token)).resolves.toMatchObject({ status: 'submitted', late: false });
  });

  it('5e. revive also works after the job cleaned the lease up (token in prev_token)', async () => {
    const { cleanupExpired } = await import('@/lib/jobs');
    const a = claimed(await claim(1, 'en', { leaseSeconds: 1 }));
    await sleep(1500);
    await cleanupExpired();
    expect(await scriptRow(a.scriptId)).toMatchObject({ status: 'available', prev_token: a.token });
    const b = claimed(await claim(1, 'en'));
    expect(b).toMatchObject({ status: 'resumed', scriptId: a.scriptId, token: a.token });
  });

  it('5f. no revive once someone else re-claimed: the comeback gets a different script, old token fenced', async () => {
    const a = claimed(await claim(1, 'en', { leaseSeconds: 1 }));
    await upload(a.scriptId, a.token);
    await sleep(1500);
    const other = claimed(await claim(2, 'en'));
    expect(other.scriptId).toBe(a.scriptId);
    const b = claimed(await claim(1, 'en'));
    expect(b.status).toBe('claimed');
    expect(b.scriptId).not.toBe(a.scriptId);
    expect(b.token).not.toBe(a.token);
    await expectAppError(submit(1, a.token), 409, 'script_taken');
  });

  it('6a. idempotent submit: twice -> one recording, duplicate on the second, same ids', async () => {
    const a = claimed(await claim(1, 'en'));
    await upload(a.scriptId, a.token, 4096);
    const first = await submit(1, a.token);
    expect(first).toMatchObject({ status: 'submitted', late: false, duplicate: false, scriptId: a.scriptId });
    const second = await submit(1, a.token);
    expect(second).toEqual({ ...first, duplicate: true });
    const recs = await q('SELECT * FROM recordings');
    expect(recs).toHaveLength(1);
    expect(recs[0]).toMatchObject({ claim_token: a.token, size_bytes: '4096', status: 'pending_checks' });
  });

  it('6b. idempotent submit: two concurrent submits -> one recording, one duplicate', async () => {
    const a = claimed(await claim(1, 'en'));
    await upload(a.scriptId, a.token);
    const rs = await Promise.all([submit(1, a.token), submit(1, a.token), submit(1, a.token)]);
    expect(new Set(rs.map((r) => r.recordingId)).size).toBe(1);
    expect(rs.filter((r) => !r.duplicate)).toHaveLength(1);
    expect(rs.filter((r) => r.duplicate)).toHaveLength(2);
    expect(await q('SELECT * FROM recordings')).toHaveLength(1);
  });

  it('7. missing upload: submit with no object in storage -> 400 upload_missing, lease kept', async () => {
    const a = claimed(await claim(1, 'en'));
    await expectAppError(submit(1, a.token), 400, 'upload_missing');
    expect(await scriptRow(a.scriptId)).toMatchObject({ status: 'claimed', claimed_by: 1, claim_token: a.token });
    expect(await q('SELECT * FROM recordings')).toHaveLength(0);
    // after the upload lands, the same submit succeeds
    await upload(a.scriptId, a.token);
    await expect(submit(1, a.token)).resolves.toMatchObject({ status: 'submitted' });
  });

  it('7b. empty upload -> 400 upload_invalid', async () => {
    const a = claimed(await claim(1, 'en'));
    await upload(a.scriptId, a.token, 0);
    await expectAppError(submit(1, a.token), 400, 'upload_invalid');
  });

  it('7c. unknown token -> 404 unknown_claim', async () => {
    await expectAppError(submit(1, '00000000-0000-4000-8000-000000000000'), 404, 'unknown_claim');
  });

  it('8. release: the script is immediately claimable by someone else', async () => {
    await reset({ en: 1 }, 20);
    const a = claimed(await claim(1, 'en'));
    expect((await claim(2, 'en')).status).toBe('empty');
    expect(await release(1, a.token)).toEqual({ released: true });
    const b = claimed(await claim(2, 'en'));
    expect(b.scriptId).toBe(a.scriptId);
    // the released token is dead: no heartbeat, no late submit, release again is a no-op
    await expectAppError(heartbeat(1, a.token), 409, 'lease_lost');
    await upload(a.scriptId, a.token);
    await expectAppError(submit(1, a.token), 409, 'script_taken');
    expect(await release(1, a.token)).toEqual({ released: false });
  });

  it('8c. refresh = release then claim again: the same contributor gets the same script and token back', async () => {
    const a = claimed(await claim(1, 'en'));
    await upload(a.scriptId, a.token);
    expect(await release(1, a.token)).toEqual({ released: true });
    const b = claimed(await claim(1, 'en'));
    expect(b).toMatchObject({ status: 'resumed', scriptId: a.scriptId, token: a.token });
    await expect(submit(1, a.token)).resolves.toMatchObject({ status: 'submitted', late: false });
  });

  it('2b. resume extends the lease (a returning client is alive; avoids expiring before its first heartbeat)', async () => {
    const a = claimed(await claim(1, 'en', { leaseSeconds: 2 }));
    await sleep(1200);
    const b = claimed(await claim(1, 'en', { leaseSeconds: 600 }));
    expect(b).toMatchObject({ status: 'resumed', token: a.token });
    expect(b.leaseRemainingSeconds).toBeGreaterThan(590);
  });

  it('3b. CLAIM_ORDER=fresh_first takes never-claimed scripts before expired leases', async () => {
    const a = claimed(await claim(1, 'en', { leaseSeconds: 1 }));
    await sleep(1500);
    process.env.CLAIM_ORDER = 'fresh_first';
    try {
      const b = claimed(await claim(2, 'en'));
      expect(b.scriptId).not.toBe(a.scriptId); // the expired one is left for its owner a while longer
    } finally {
      process.env.CLAIM_ORDER = 'lowest_id';
    }
    const c = claimed(await claim(3, 'en'));
    expect(c.scriptId).toBe(a.scriptId); // default order: lowest free id, expired lease included
  });

  it('3c. fresh_first also protects a lease the job already reset (token kept in prev_token)', async () => {
    const { cleanupExpired } = await import('@/lib/jobs');
    const a = claimed(await claim(1, 'en', { leaseSeconds: 1 }));
    await sleep(1500);
    await cleanupExpired();
    process.env.CLAIM_ORDER = 'fresh_first';
    try {
      expect(claimed(await claim(2, 'en')).scriptId).not.toBe(a.scriptId);
    } finally {
      process.env.CLAIM_ORDER = 'lowest_id';
    }
  });

  it('8d. soft release: another device still heartbeating keeps the script; otherwise it frees after the grace', async () => {
    await reset({ en: 1 }, 20);
    const a = claimed(await claim(1, 'en'));
    // device A closes its tab (grace 1 s); device B, same contributor and token, is still recording
    expect(await release(1, a.token, { graceSeconds: 1 })).toEqual({ released: true });
    expect((await claim(2, 'en')).status).toBe('empty'); // not handed out during the grace
    await heartbeat(1, a.token); // B's heartbeat restores the full lease
    await sleep(1300);
    expect((await claim(2, 'en')).status).toBe('empty');
    await expect(submit(1, a.token)).rejects.toMatchObject({ code: 'upload_missing' }); // still B's to submit
    // nobody left: release again and the script frees itself after the grace
    await release(1, a.token, { graceSeconds: 1 });
    await sleep(1300);
    expect(claimed(await claim(2, 'en')).scriptId).toBe(a.scriptId);
  });

  it('8e. submit freezes the audio: a PUT to the upload URL after submit does not change the stored recording', async () => {
    const { finalKey, putObject, recordingKey, headObject } = await import('@/lib/storage');
    const a = claimed(await claim(1, 'en'));
    await upload(a.scriptId, a.token, 4096);
    await submit(1, a.token);
    const [rec] = await q<{ s3_key: string; size_bytes: string }>('SELECT s3_key, size_bytes FROM recordings');
    expect(rec.s3_key).toBe(finalKey(a.scriptId, a.token));
    await putObject(recordingKey(a.scriptId, a.token), Buffer.alloc(9999, 1)); // the URL is still valid for a while
    expect(await headObject(rec.s3_key)).toEqual({ size: 4096 });
  });

  it('8b. release by a different contributor is a no-op', async () => {
    const a = claimed(await claim(1, 'en'));
    expect(await release(2, a.token)).toEqual({ released: false });
    expect(await scriptRow(a.scriptId)).toMatchObject({ status: 'claimed', claimed_by: 1 });
  });

  it('9a. one claim per contributor: two concurrent claims by the same contributor get the same script', async () => {
    for (let round = 0; round < 5; round++) {
      await reset({ en: 5 }, 20);
      const rs = (await Promise.all([claim(1, 'en'), claim(1, 'en'), claim(1, 'en')])).map(claimed);
      expect(new Set(rs.map((r) => r.scriptId)).size).toBe(1);
      expect(new Set(rs.map((r) => r.token)).size).toBe(1);
      expect(rs.filter((r) => r.status === 'claimed')).toHaveLength(1);
      const [n] = await q<{ n: string }>(`SELECT count(*) n FROM scripts WHERE claimed_by = 1`);
      expect(Number(n.n)).toBe(1);
    }
  });

  it('9b. one claim per contributor: claiming in another language resumes the existing claim', async () => {
    const a = claimed(await claim(1, 'en'));
    const b = claimed(await claim(1, 'fr'));
    expect(b).toMatchObject({ status: 'resumed', scriptId: a.scriptId, language: 'en' });
  });

  it('9c. one claim per contributor: direct SQL giving a contributor a second claimed row -> unique violation', async () => {
    const a = claimed(await claim(1, 'en'));
    const err = await q(
      `UPDATE scripts SET status='claimed', claimed_by=1, claim_token=gen_random_uuid(), lease_expires_at=now()+interval '10 min'
       WHERE id <> $1 AND language='en' AND id = (SELECT min(id) FROM scripts WHERE id <> $1)`, [a.scriptId],
    ).catch((e) => e);
    expect(err).toMatchObject({ code: '23505', constraint: 'one_claim_per_contributor' });
  });

  it('10. pool empty: exhausted language -> {status:"empty"} and a pool_empty event', async () => {
    await reset({ en: 1 }, 20);
    claimed(await claim(1, 'en'));
    const r = await claim(2, 'en');
    expect(r).toMatchObject({ status: 'empty', language: 'en' });
    expect(await claim(3, 'de')).toMatchObject({ status: 'empty', language: 'de' }); // never had any
    const evs = await q(`SELECT contributor_id, language FROM claim_events WHERE event='pool_empty' ORDER BY id`);
    expect(evs).toEqual([{ contributor_id: 2, language: 'en' }, { contributor_id: 3, language: 'de' }]);
  });

  it('claim for an unknown contributor -> 404 unknown_contributor', async () => {
    await expectAppError(claim(9999, 'en'), 404, 'unknown_contributor');
  });

  it('uploadUrl returns a presigned PUT that actually works for submit', async () => {
    const a = claimed(await claim(1, 'en'));
    const u = await uploadUrl(1, a.token);
    expect(u.key).toBe(`recordings/${a.scriptId}/${a.token}.wav`);
    const put = await fetch(u.url, { method: 'PUT', headers: { 'content-type': u.contentType }, body: Buffer.alloc(2048, 1) });
    expect(put.status).toBe(200);
    await expect(submit(1, a.token)).resolves.toMatchObject({ status: 'submitted', late: false });
  });
});
