import { handle } from '@/lib/http';
import { recentDecisions, reviewQueue } from '@/lib/ops';

export const dynamic = 'force-dynamic';

/** GET /api/ops/review — the needs_review queue (newest first) and the decision audit trail. */
export async function GET() {
  return handle(async () => {
    const [queue, decisions] = await Promise.all([reviewQueue(), recentDecisions()]);
    return { queue, decisions };
  });
}
