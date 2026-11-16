import { AppError } from '@/lib/errors';
import { handle } from '@/lib/http';
import { scriptHistory } from '@/lib/ops';

export const dynamic = 'force-dynamic';

/** GET /api/ops/history?q=<script id | claim token> — one script's full claim_events history. */
export async function GET(req: Request) {
  return handle(async () => {
    const q = new URL(req.url).searchParams.get('q') ?? '';
    const r = await scriptHistory(q);
    if ('error' in r) throw new AppError(404, 'not_found', r.error ?? 'not found');
    return r;
  });
}
