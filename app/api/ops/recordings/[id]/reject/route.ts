import { z } from 'zod';
import { body, handle } from '@/lib/http';
import { reject } from '@/lib/review';
import { recordingId } from '../recording-id';

const Body = z.object({ reason: z.string().trim().min(1, 'a reason is required').max(500) });

/** POST /api/ops/recordings/:id/reject — a reviewer rejects with a reason; the script returns to the pool. */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    const id = recordingId((await ctx.params).id);
    const { reason } = await body(req, Body);
    return reject(id, 'reviewer', reason);
  });
}
