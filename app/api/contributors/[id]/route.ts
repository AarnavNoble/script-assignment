import { AppError } from '@/lib/errors';
import { handle } from '@/lib/http';
import { contributor } from '@/lib/ops';

export const dynamic = 'force-dynamic';

/** GET /api/contributors/:id — the contributor's usual language and earnings (estimated until approved). */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    const id = Number((await ctx.params).id);
    if (!Number.isInteger(id) || id <= 0) throw new AppError(400, 'bad_id', 'contributor id must be a positive integer');
    const c = await contributor(id);
    if (!c) throw new AppError(404, 'unknown_contributor', `no contributor ${id}`);
    return c;
  });
}
