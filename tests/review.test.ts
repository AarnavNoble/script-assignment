// R4.1: lifecycle past "recorded": approve / reject / re-record / paid.
import { describe, it, expect, beforeEach } from 'vitest';
import { claim, submit } from '@/lib/assign';
import { approve, reject, sendToReview, markPaid, saveMetrics } from '@/lib/review';
import { reset, upload, q, scriptRow, expectAppError, claimed } from './helpers';

// a submitted take that QA has measured (as the QA worker does before deciding)
async function record(who: number, lang = 'en') {
  const c = claimed(await claim(who, lang));
  await upload(c.scriptId, c.token);
  const s = await submit(who, c.token);
  await saveMetrics(s.recordingId, { durationS: 180, silenceRatio: 0.2, clippingRatio: 0, peakDb: -6, rmsDb: -20, sha256: `sha-${s.recordingId}`, checks: [] });
  return { ...c, recordingId: s.recordingId };
}

const recStatus = async (id: number) => (await q<{ status: string }>('SELECT status FROM recordings WHERE id=$1', [id]))[0].status;

describe('R4 review lifecycle', () => {
  beforeEach(() => reset({ en: 1, fr: 3 }, 20));

  it('approve -> recording approved, script approved', async () => {
    const r = await record(1);
    expect(await approve(r.recordingId, 'qa')).toEqual({ recordingId: r.recordingId, status: 'approved' });
    expect(await recStatus(r.recordingId)).toBe('approved');
    expect((await scriptRow(r.scriptId)).status).toBe('approved');
    expect((await claim(2, 'en')).status).toBe('empty');
  });

  it('reject -> recording rejected, script available and claimable, and a new recording can be submitted', async () => {
    const r = await record(1);
    expect((await claim(2, 'en')).status).toBe('empty'); // submitted scripts aren't handed out
    await reject(r.recordingId, 'qa', 'too quiet');
    expect(await recStatus(r.recordingId)).toBe('rejected');
    expect((await scriptRow(r.scriptId)).status).toBe('available');

    const again = await record(2);
    expect(again.scriptId).toBe(r.scriptId);
    expect(again.recordingId).not.toBe(r.recordingId);
    const recs = await q(`SELECT status, contributor_id FROM recordings WHERE script_id=$1 ORDER BY id`, [r.scriptId]);
    expect(recs).toEqual([{ status: 'rejected', contributor_id: 1 }, { status: 'pending_checks', contributor_id: 2 }]);
  });

  it('a second live recording for the same script is impossible (unique violation)', async () => {
    const r = await record(1);
    const err = await q(
      `INSERT INTO recordings (script_id, contributor_id, claim_token, s3_key, size_bytes)
       VALUES ($1, 2, gen_random_uuid(), 'x', 1)`, [r.scriptId],
    ).catch((e) => e);
    expect(err).toMatchObject({ code: '23505', constraint: 'one_live_recording_per_script' });
  });

  it('needs_review -> approve by reviewer works; markPaid moves approved -> paid and sums est pay', async () => {
    const a = await record(1, 'fr');
    const b = await record(2, 'fr');
    await saveMetrics(a.recordingId, { durationS: 3600, silenceRatio: 0, clippingRatio: 0, peakDb: -3, rmsDb: -20, sha256: 'a', checks: {} });
    await sendToReview(b.recordingId, 'borderline');
    expect(await recStatus(b.recordingId)).toBe('needs_review');
    await approve(a.recordingId, 'qa');
    await approve(b.recordingId, 'reviewer', 'ok');

    const p = await markPaid();
    expect(p).toMatchObject({ recordings: 2, contributors: 2, totalCents: 525 }); // 1 h + 3 min at $5/h
    expect(await recStatus(a.recordingId)).toBe('paid');
    expect(await recStatus(b.recordingId)).toBe('paid');
    expect((await q(`SELECT paid_at FROM recordings WHERE id=$1`, [a.recordingId]))[0].paid_at).not.toBeNull();
    expect(await markPaid()).toMatchObject({ recordings: 0 }); // already paid
  });

  it('markPaid leaves non-approved recordings alone', async () => {
    const a = await record(1, 'fr');
    expect(await markPaid()).toMatchObject({ recordings: 0 });
    expect(await recStatus(a.recordingId)).toBe('pending_checks');
  });

  it('reviewing an already-decided recording -> 409 not_reviewable', async () => {
    const a = await record(1, 'fr');
    const b = await record(2, 'fr');
    await approve(a.recordingId, 'qa');
    await reject(b.recordingId, 'qa', 'noise');
    await expectAppError(approve(a.recordingId, 'reviewer'), 409, 'not_reviewable');
    await expectAppError(reject(a.recordingId, 'reviewer', 'x'), 409, 'not_reviewable');
    await expectAppError(approve(b.recordingId, 'reviewer'), 409, 'not_reviewable');
    await expectAppError(reject(b.recordingId, 'reviewer', 'x'), 409, 'not_reviewable');
    await markPaid();
    await expectAppError(reject(a.recordingId, 'reviewer', 'x'), 409, 'not_reviewable');
    expect((await scriptRow(a.scriptId)).status).toBe('approved'); // a failed reject didn't free the script
  });

  it('a reviewer can only approve after QA sent it to review; QA can only approve a measured take', async () => {
    const a = await record(1, 'fr');
    await expectAppError(approve(a.recordingId, 'reviewer'), 409, 'not_reviewable'); // still pending_checks
    const c = claimed(await claim(2, 'fr'));
    await upload(c.scriptId, c.token);
    const s = await submit(2, c.token); // no metrics yet
    await expectAppError(approve(s.recordingId, 'qa'), 409, 'not_reviewable');
    await approve(a.recordingId, 'qa');
    // a late saveMetrics on a decided take changes nothing
    await saveMetrics(a.recordingId, { durationS: 3600, silenceRatio: 0, clippingRatio: 0, peakDb: 0, rmsDb: 0, sha256: 'x', checks: [] });
    expect((await q<{ est_pay_cents: number }>('SELECT est_pay_cents FROM recordings WHERE id=$1', [a.recordingId]))[0].est_pay_cents).toBe(25);
  });

  it('concurrent approve + reject on the same recording: exactly one wins', async () => {
    const a = await record(1, 'fr');
    const rs = await Promise.allSettled([approve(a.recordingId, 'qa'), reject(a.recordingId, 'reviewer', 'x')]);
    expect(rs.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const s = await recStatus(a.recordingId);
    expect((await scriptRow(a.scriptId)).status).toBe(s === 'approved' ? 'approved' : 'available');
  });
});
