import { NextResponse } from 'next/server';
import { z } from 'zod';
import { AppError } from './errors';

// x-contributor-id stands in for real auth (a session cookie / JWT in production).
export function contributorId(req: Request): number {
  const raw = req.headers.get('x-contributor-id') ?? new URL(req.url).searchParams.get('contributor');
  const id = Number(raw);
  if (!raw || !Number.isInteger(id) || id <= 0) throw new AppError(400, 'missing_contributor', 'x-contributor-id header required');
  return id;
}

export const tokenSchema = z.string().uuid();

export function parseToken(token: string): string {
  const r = tokenSchema.safeParse(token);
  if (!r.success) throw new AppError(400, 'bad_token', 'claim token must be a UUID');
  return r.data;
}

/** Parse a JSON body; empty bodies (sendBeacon, curl) count as {}. */
export async function body<T extends z.ZodTypeAny>(req: Request, schema: T): Promise<z.infer<T>> {
  const text = await req.text();
  let json: unknown = {};
  if (text.trim()) {
    try { json = JSON.parse(text); } catch { throw new AppError(400, 'bad_json', 'body is not valid JSON'); }
  }
  const r = schema.safeParse(json);
  if (!r.success) throw new AppError(400, 'bad_request', r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
  return r.data;
}

export function handle(fn: () => Promise<unknown>): Promise<NextResponse> {
  return fn().then(
    (data) => NextResponse.json(data),
    (e) => {
      if (e instanceof AppError) return NextResponse.json({ code: e.code, message: e.message }, { status: e.status });
      const err = e as { code?: string };
      // Postgres unreachable: tell the client to retry with backoff
      if (err?.code === 'ECONNREFUSED' || err?.code === '57P01') {
        return NextResponse.json({ code: 'unavailable', message: 'database unavailable, retry shortly' }, { status: 503 });
      }
      console.error(e);
      return NextResponse.json({ code: 'internal', message: 'internal error' }, { status: 500 });
    },
  );
}
