// Browser-side helpers for the claims API. Retries only what is safe to retry:
// network failures and 503s. 4xx answers (lease_lost, script_taken, ...) are returned to the caller.

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}

/** True for failures worth retrying (no answer from the server, or the DB is briefly down). */
export const retryable = (e: unknown) => !(e instanceof ApiError) || e.status === 503;

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function withRetry<T>(fn: (attempt: number) => Promise<T>, retries: number, onRetry?: (attempt: number, e: unknown) => void): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn(attempt);
    } catch (e) {
      if (attempt >= retries || !retryable(e)) throw e;
      onRetry?.(attempt + 1, e);
      await sleep(Math.min(8000, 500 * 2 ** attempt) * (0.75 + Math.random() * 0.5));
    }
  }
}

type Opts = { who?: number; body?: unknown; method?: 'GET' | 'POST'; retries?: number; onRetry?: (attempt: number) => void };

export async function api<T>(path: string, opts: Opts = {}): Promise<T> {
  return withRetry(async () => {
    let res: Response;
    try {
      res = await fetch(`/api${path}`, {
        method: opts.method ?? 'POST',
        headers: {
          ...(opts.who ? { 'x-contributor-id': String(opts.who) } : {}),
          ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}),
        },
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
        cache: 'no-store',
      });
    } catch {
      throw new Error('network');
    }
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new ApiError(res.status, json.code ?? 'http_' + res.status, json.message ?? res.statusText);
    return json as T;
  }, opts.retries ?? 0, opts.onRetry);
}

/** PUT a blob to a presigned URL with upload progress (fetch has no upload progress events). */
export function putWithProgress(url: string, blob: Blob, contentType: string, onProgress: (fraction: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', url);
    xhr.setRequestHeader('content-type', contentType); // must match the content type the URL was signed for
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) onProgress(e.loaded / e.total); };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) { onProgress(1); resolve(); }
      else if (xhr.status >= 500) reject(new ApiError(503, 'storage_unavailable', `storage answered ${xhr.status}`));
      else reject(new ApiError(xhr.status, 'upload_failed', `storage answered ${xhr.status}`));
    };
    xhr.onerror = () => reject(new Error('network'));
    xhr.ontimeout = () => reject(new Error('network'));
    xhr.send(blob);
  });
}

export const store = {
  get<T>(key: string, area: 'local' | 'session' = 'local'): T | null {
    try {
      const raw = (area === 'local' ? localStorage : sessionStorage).getItem(key);
      return raw ? (JSON.parse(raw) as T) : null;
    } catch { return null; }
  },
  set(key: string, value: unknown, area: 'local' | 'session' = 'local') {
    try { (area === 'local' ? localStorage : sessionStorage).setItem(key, JSON.stringify(value)); } catch { /* storage unavailable */ }
  },
  del(key: string, area: 'local' | 'session' = 'local') {
    try { (area === 'local' ? localStorage : sessionStorage).removeItem(key); } catch { /* storage unavailable */ }
  },
};

export const money = (cents: number) => `$${(cents / 100).toFixed(2)}`;

export function clock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
