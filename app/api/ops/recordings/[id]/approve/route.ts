import { z } from 'zod';
import { body, handle } from '@/lib/http';
import { approve } from '@/lib/review';
import { recordingId } from '../recording-id';

const Body = z.object({ note: z.string().max(500).optional() });

/** POST /api/ops/recordings/:id/approve — a reviewer approves a queued recording. */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    const id = recordingId((await ctx.params).id);
    const { note } = await body(req, Body);
    return approve(id, 'reviewer', note);
  });
}
