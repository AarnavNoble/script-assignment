import { z } from 'zod';
import { claim } from '@/lib/assign';
import { body, contributorId, handle } from '@/lib/http';

const Body = z.object({ language: z.string().min(2).max(16).optional() });

/** POST /api/claims — get (or resume) a script. 200 with {status:'empty'} when the language is out. */
export async function POST(req: Request) {
  return handle(async () => {
    const who = contributorId(req);
    const { language } = await body(req, Body);
    return claim(who, language);
  });
}
