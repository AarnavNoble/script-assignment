import { handle } from '@/lib/http';
import { live } from '@/lib/ops';

export const dynamic = 'force-dynamic';

/**
 * GET /api/ops/live?window=30 — live invariant (scripts handed out twice / recorded twice over the last
 * `window` minutes, rebuilt from the audit log), event rates over the last 60 s, live leases now, and a
 * 3-minute series of claims and expiries. Cheap enough to poll every 1-2 s.
 */
export async function GET(req: Request) {
  const w = Number(new URL(req.url).searchParams.get('window') ?? 30);
  const window = Number.isFinite(w) ? Math.min(24 * 60, Math.max(1, w)) : 30;
  return handle(() => live(window));
}
