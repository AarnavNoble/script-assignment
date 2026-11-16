import { z } from 'zod';
import { submit } from '@/lib/assign';
import { body, contributorId, handle, tokenSchema } from '@/lib/http';

const Body = z.object({ token: tokenSchema });

/** POST /api/recordings — submit the uploaded audio for a claim. Idempotent per token. */
export async function POST(req: Request) {
  return handle(async () => {
    const who = contributorId(req);
    const { token } = await body(req, Body);
    return submit(who, token);
  });
}
