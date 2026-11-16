import { release } from '@/lib/assign';
import { contributorId, handle, parseToken } from '@/lib/http';

/**
 * POST /api/claims/:token/release — best-effort give-back, the sendBeacon target on pagehide.
 * sendBeacon can't set headers, so the contributor id may also come as ?contributor=.
 */
export async function POST(req: Request, ctx: { params: Promise<{ token: string }> }) {
  return handle(async () => release(contributorId(req), parseToken((await ctx.params).token)));
}
