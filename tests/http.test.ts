// HTTP layer: call the Next.js route handlers directly with real Requests.
import { describe, it, expect, beforeEach } from 'vitest';
import { POST as claimsPOST } from '@/app/api/claims/route';
import { POST as heartbeatPOST } from '@/app/api/claims/[token]/heartbeat/route';
import { POST as releasePOST } from '@/app/api/claims/[token]/release/route';
import { POST as uploadUrlPOST } from '@/app/api/claims/[token]/upload-url/route';
import { POST as recordingsPOST } from '@/app/api/recordings/route';
import { reset, upload, sleep } from './helpers';

const B = 'http://test.local/api';
type Init = { who?: number | string; body?: unknown; raw?: string; query?: string };

function req(path: string, { who, body, raw, query = '' }: Init = {}) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (who !== undefined) headers['x-contributor-id'] = String(who);
  return new Request(`${B}${path}${query}`, { method: 'POST', headers, body: raw ?? (body === undefined ? undefined : JSON.stringify(body)) });
}
const ctx = (token: string) => ({ params: Promise.resolve({ token }) });
async function call(res: Promise<Response>) {
  const r = await res;
  return { status: r.status, json: await r.json() };
}

describe('HTTP routes', () => {
  beforeEach(() => reset({ en: 1 }, 20));

  it('POST /claims without x-contributor-id -> 400 missing_contributor with {code,message}', async () => {
    const r = await call(claimsPOST(req('/claims', { body: { language: 'en' } })));
    expect(r.status).toBe(400);
    expect(r.json).toEqual({ code: 'missing_contributor', message: expect.any(String) });
  });

  it('non-integer contributor id -> 400', async () => {
    expect((await call(claimsPOST(req('/claims', { who: 'abc' })))).status).toBe(400);
    expect((await call(claimsPOST(req('/claims', { who: -1 })))).status).toBe(400);
  });

  it('bad JSON body -> 400 bad_json; bad language -> 400 bad_request', async () => {
    expect((await call(claimsPOST(req('/claims', { who: 1, raw: '{nope' })))).json.code).toBe('bad_json');
    expect((await call(claimsPOST(req('/claims', { who: 1, body: { language: 'x' } })))).json.code).toBe('bad_request');
  });

  it('claim -> 200; empty pool -> 200 with status empty', async () => {
    const a = await call(claimsPOST(req('/claims', { who: 1, body: { language: 'en' } })));
    expect(a.status).toBe(200);
    expect(a.json).toMatchObject({ status: 'claimed', language: 'en', token: expect.any(String), heartbeatSeconds: 30 });
    expect(a.json.leaseRemainingSeconds).toBeGreaterThan(590);
    const b = await call(claimsPOST(req('/claims', { who: 2, body: { language: 'en' } })));
    expect(b).toEqual({ status: 200, json: { status: 'empty', language: 'en', message: expect.any(String) } });
  });

  it('empty body (curl / sendBeacon) is accepted and falls back to the contributor language', async () => {
    // contributor 1's seeded language is en
    const r = await call(claimsPOST(req('/claims', { who: 1 })));
    expect(r.json).toMatchObject({ status: 'claimed', language: 'en' });
  });

  it('unknown contributor -> 404 {code,message}', async () => {
    const r = await call(claimsPOST(req('/claims', { who: 999, body: { language: 'en' } })));
    expect(r).toEqual({ status: 404, json: { code: 'unknown_contributor', message: expect.any(String) } });
  });

  it('bad UUID token on dynamic routes -> 400 bad_token', async () => {
    for (const h of [heartbeatPOST, releasePOST, uploadUrlPOST]) {
      const r = await call(h(req('/claims/not-a-uuid/x', { who: 1 }), ctx('not-a-uuid')));
      expect(r).toEqual({ status: 400, json: { code: 'bad_token', message: expect.any(String) } });
    }
    const r = await call(recordingsPOST(req('/recordings', { who: 1, body: { token: 'nope' } })));
    expect(r.status).toBe(400);
  });

  it('full flow + 409 shapes: heartbeat, submit early 400, submit, duplicate, old-token heartbeat 409', async () => {
    const c = (await call(claimsPOST(req('/claims', { who: 1, body: { language: 'en' } })))).json;
    const hb = await call(heartbeatPOST(req(`/claims/${c.token}/heartbeat`, { who: 1 }), ctx(c.token)));
    expect(hb.status).toBe(200);
    expect(hb.json).toMatchObject({ leaseRemainingSeconds: expect.any(Number) });

    const early = await call(recordingsPOST(req('/recordings', { who: 1, body: { token: c.token } })));
    expect(early).toEqual({ status: 400, json: { code: 'upload_missing', message: expect.any(String) } });

    const u = await call(uploadUrlPOST(req(`/claims/${c.token}/upload-url`, { who: 1 }), ctx(c.token)));
    expect(u.status).toBe(200);
    expect(u.json).toMatchObject({ url: expect.stringContaining('recordings-tests'), key: `recordings/${c.scriptId}/${c.token}.wav` });
    await upload(c.scriptId, c.token);

    const s1 = await call(recordingsPOST(req('/recordings', { who: 1, body: { token: c.token } })));
    expect(s1).toMatchObject({ status: 200, json: { status: 'submitted', duplicate: false } });
    const s2 = await call(recordingsPOST(req('/recordings', { who: 1, body: { token: c.token } })));
    expect(s2).toMatchObject({ status: 200, json: { status: 'submitted', duplicate: true, recordingId: s1.json.recordingId } });

    const lost = await call(heartbeatPOST(req(`/claims/${c.token}/heartbeat`, { who: 1 }), ctx(c.token)));
    expect(lost).toEqual({ status: 409, json: { code: 'lease_lost', message: expect.any(String) } });
  });

  it('submit after re-claim -> 409 {code:"script_taken",message}', async () => {
    const { claim } = await import('@/lib/assign');
    const c = await claim(1, 'en', { leaseSeconds: 1 });
    if (c.status === 'empty') throw new Error('expected a claim');
    await sleep(1500);
    await call(claimsPOST(req('/claims', { who: 2, body: { language: 'en' } })));
    const r = await call(recordingsPOST(req('/recordings', { who: 1, body: { token: c.token } })));
    expect(r).toEqual({ status: 409, json: { code: 'script_taken', message: expect.any(String) } });
  });

  it('release via ?contributor= query (sendBeacon has no headers) frees the script', async () => {
    const c = (await call(claimsPOST(req('/claims', { who: 1, body: { language: 'en' } })))).json;
    const r = await call(releasePOST(req(`/claims/${c.token}/release`, { query: '?contributor=1' }), ctx(c.token)));
    expect(r).toEqual({ status: 200, json: { released: true } });
    const b = await call(claimsPOST(req('/claims', { who: 2, body: { language: 'en' } })));
    expect(b.json).toMatchObject({ status: 'claimed', scriptId: c.scriptId });
  });
});
