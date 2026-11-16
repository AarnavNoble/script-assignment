import { heartbeat } from '@/lib/assign';
import { contributorId, handle, parseToken } from '@/lib/http';

/** POST /api/claims/:token/heartbeat — extend a live lease; 409 lease_lost otherwise. */
export async function POST(req: Request, ctx: { params: Promise<{ token: string }> }) {
  return handle(async () => heartbeat(contributorId(req), parseToken((await ctx.params).token)));
}
