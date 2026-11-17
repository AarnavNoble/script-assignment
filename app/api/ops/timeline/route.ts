import { handle } from '@/lib/http';
import { leaseTimeline } from '@/lib/timeline';

export const dynamic = 'force-dynamic';

/** GET /api/ops/timeline?minutes=3&limit=25 — each recently active script's leases as bars over the last N minutes. */
export async function GET(req: Request) {
  return handle(async () => {
    const q = new URL(req.url).searchParams;
    const num = (k: string) => (q.get(k) === null || q.get(k) === '' ? undefined : Number(q.get(k)) || undefined);
    return leaseTimeline({ minutes: num('minutes'), limit: num('limit') });
  });
}
