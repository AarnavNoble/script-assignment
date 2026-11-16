import { NextResponse } from 'next/server';
import { AppError } from '@/lib/errors';
import { handle } from '@/lib/http';
import { presignGet, recordingKey } from '@/lib/ops';
import { recordingId } from '../recording-id';

export const dynamic = 'force-dynamic';

/** GET /api/ops/recordings/:id/audio — redirect to a short-lived presigned GET; the audio streams from storage. */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const key = await recordingKey(recordingId((await ctx.params).id));
    if (!key) throw new AppError(404, 'not_found', 'no such recording');
    return NextResponse.redirect(await presignGet(key), 302);
  } catch (e) {
    return handle(() => Promise.reject(e));
  }
}
