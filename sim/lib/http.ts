// Thin client for the script-assignment API. Records client-side latency per endpoint.

export type Res<T = any> = { status: number; json: T; ms: number; error?: string };

export type LatencySample = { endpoint: string; status: number; ms: number; at: number };

export class Api {
  readonly samples: LatencySample[] = [];
  errors = 0; // network errors / timeouts

  constructor(readonly base: string, readonly timeoutMs = 15000) {}

  private async call(endpoint: string, url: string, init: RequestInit): Promise<Res> {
    const t = performance.now();
    try {
      const r = await fetch(url, { ...init, signal: AbortSignal.timeout(this.timeoutMs) });
      const text = await r.text();
      const ms = performance.now() - t;
      this.samples.push({ endpoint, status: r.status, ms, at: Date.now() });
      let json: any = null;
      try { json = text ? JSON.parse(text) : null; } catch { json = { raw: text.slice(0, 200) }; }
      return { status: r.status, json, ms };
    } catch (e) {
      const ms = performance.now() - t;
      this.errors++;
      this.samples.push({ endpoint, status: 0, ms, at: Date.now() });
      return { status: 0, json: null, ms, error: String((e as Error)?.message ?? e) };
    }
  }

  private post(endpoint: string, path: string, who: number | null, body?: unknown) {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (who !== null) headers['x-contributor-id'] = String(who);
    return this.call(endpoint, this.base + path, { method: 'POST', headers, body: body === undefined ? undefined : JSON.stringify(body) });
  }

  claim(who: number, language?: string) { return this.post('claim', '/api/claims', who, language ? { language } : {}); }
  heartbeat(who: number, token: string) { return this.post('heartbeat', `/api/claims/${token}/heartbeat`, who); }
  /** Beacon-style: no headers, contributor in the query string. */
  release(who: number, token: string) { return this.post('release', `/api/claims/${token}/release?contributor=${who}`, null); }
  uploadUrl(who: number, token: string) { return this.post('upload_url', `/api/claims/${token}/upload-url`, who); }
  submit(who: number, token: string) { return this.post('submit', '/api/recordings', who, { token }); }
  stats() { return this.call('stats', this.base + '/api/stats', { method: 'GET' }); }

  put(url: string, body: Buffer, contentType: string) {
    return this.call('put', url, { method: 'PUT', headers: { 'content-type': contentType }, body: new Uint8Array(body) });
  }

  /** Hit each route with a request that is rejected before touching the DB, so first-request compile/JIT is out of the run. */
  async warm(): Promise<void> {
    const bad = 'not-a-uuid';
    await this.stats();
    await this.post('warm', `/api/claims/${bad}/heartbeat`, 1);
    await this.post('warm', `/api/claims/${bad}/release`, 1);
    await this.post('warm', `/api/claims/${bad}/upload-url`, 1);
    await this.post('warm', '/api/recordings', 1, {});
    await this.post('warm', '/api/claims', 999_999_999, {});
    this.samples.length = 0;
    this.errors = 0;
  }
}
