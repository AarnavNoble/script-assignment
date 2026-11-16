// Recording state transitions after submit. Shared by the QA worker and the ops review queue.
import { tx, pool } from './db';
import { config } from './config';
import { AppError } from './errors';
import { logEvent } from './assign';

export type Metrics = {
  durationS: number;
  silenceRatio: number;
  clippingRatio: number;
  peakDb: number;
  rmsDb: number;
  sha256: string;
  checks: unknown; // per-check pass/fail detail, stored as jsonb
};

export const estPayCents = (durationS: number) => Math.round((durationS / 3600) * config.payCentsPerHour());

/** Store QA metrics and the estimated pay. Doesn't change status. */
export async function saveMetrics(recordingId: number, m: Metrics): Promise<void> {
  await pool().query(
    `UPDATE recordings SET duration_s = $2, silence_ratio = $3, clipping_ratio = $4, peak_db = $5,
       rms_db = $6, audio_sha256 = $7, checks = $8, est_pay_cents = $9
     WHERE id = $1`,
    [recordingId, m.durationS, m.silenceRatio, m.clippingRatio, m.peakDb, m.rmsDb, m.sha256,
      JSON.stringify(m.checks), estPayCents(m.durationS)],
  );
}

type By = 'qa' | 'reviewer';

/** pending_checks|needs_review -> approved; the script is done. */
export async function approve(recordingId: number, by: By, note?: string) {
  return tx(async (c) => {
    const r = await c.query(
      `UPDATE recordings SET status = 'approved', reviewed_at = now(), review_note = $2
       WHERE id = $1 AND status IN ('pending_checks','needs_review')
       RETURNING script_id, contributor_id, claim_token`,
      [recordingId, note ?? null],
    );
    if (!r.rowCount) throw new AppError(409, 'not_reviewable', `recording ${recordingId} is not awaiting a decision`);
    const { script_id, contributor_id, claim_token } = r.rows[0];
    const s = await c.query(`UPDATE scripts SET status = 'approved' WHERE id = $1 RETURNING language`, [script_id]);
    await logEvent(c, { scriptId: script_id, contributorId: contributor_id, token: claim_token, event: by === 'qa' ? 'qa_approved' : 'review_approved', language: s.rows[0]?.language, detail: { recordingId, note } });
    return { recordingId, status: 'approved' as const };
  });
}

/** pending_checks|needs_review -> rejected; the script goes back in the pool (it still needs a good take). */
export async function reject(recordingId: number, by: By, reason: string) {
  return tx(async (c) => {
    const r = await c.query(
      `UPDATE recordings SET status = 'rejected', reviewed_at = now(), review_note = $2, est_pay_cents = 0
       WHERE id = $1 AND status IN ('pending_checks','needs_review')
       RETURNING script_id, contributor_id, claim_token`,
      [recordingId, reason],
    );
    if (!r.rowCount) throw new AppError(409, 'not_reviewable', `recording ${recordingId} is not awaiting a decision`);
    const { script_id, contributor_id, claim_token } = r.rows[0];
    const s = await c.query(
      `UPDATE scripts SET status = 'available' WHERE id = $1 AND status = 'submitted' RETURNING language`,
      [script_id],
    );
    await logEvent(c, { scriptId: script_id, contributorId: contributor_id, token: claim_token, event: by === 'qa' ? 'qa_rejected' : 'review_rejected', language: s.rows[0]?.language, detail: { recordingId, reason } });
    return { recordingId, status: 'rejected' as const };
  });
}

/** pending_checks -> needs_review (borderline: a human decides). */
export async function sendToReview(recordingId: number, reason: string) {
  const r = await pool().query(
    `UPDATE recordings SET status = 'needs_review', review_note = $2
     WHERE id = $1 AND status = 'pending_checks' RETURNING script_id, contributor_id, claim_token`,
    [recordingId, reason],
  );
  if (r.rowCount) {
    const { script_id, contributor_id, claim_token } = r.rows[0];
    await logEvent(pool(), { scriptId: script_id, contributorId: contributor_id, token: claim_token, event: 'qa_review', detail: { recordingId, reason } });
  }
  return { recordingId, status: 'needs_review' as const };
}

/** Weekly payout run: approved -> paid. Returns the total paid per contributor. */
export async function markPaid() {
  const r = await pool().query(
    `UPDATE recordings SET status = 'paid', paid_at = now()
     WHERE status = 'approved'
     RETURNING id, contributor_id, est_pay_cents`,
  );
  const byContributor = new Map<number, number>();
  for (const row of r.rows) byContributor.set(row.contributor_id, (byContributor.get(row.contributor_id) ?? 0) + (row.est_pay_cents ?? 0));
  if (r.rowCount) await logEvent(pool(), { event: 'paid', detail: { recordings: r.rowCount } });
  return { recordings: r.rowCount ?? 0, contributors: byContributor.size, totalCents: [...byContributor.values()].reduce((a, b) => a + b, 0) };
}
