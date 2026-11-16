import { handle } from '@/lib/http';
import { overview } from '@/lib/ops';

export const dynamic = 'force-dynamic';

/** GET /api/ops/overview — pools + forecast, alerts, live/stuck leases, abandonment, recording totals. */
export async function GET() {
  return handle(overview);
}
