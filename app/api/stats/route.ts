import { poolSnapshot } from '@/lib/jobs';
import { handle } from '@/lib/http';

export const dynamic = 'force-dynamic';

/** GET /api/stats — pool per language + hours-left forecast. */
export async function GET() {
  return handle(async () => ({ pools: await poolSnapshot() }));
}
