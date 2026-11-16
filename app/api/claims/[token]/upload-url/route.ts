import { uploadUrl } from '@/lib/assign';
import { contributorId, handle, parseToken } from '@/lib/http';

/** POST /api/claims/:token/upload-url — presigned PUT straight to storage. */
export async function POST(req: Request, ctx: { params: Promise<{ token: string }> }) {
  return handle(async () => uploadUrl(contributorId(req), parseToken((await ctx.params).token)));
}
