import { Pool, type PoolClient } from 'pg';

// One pool per process. Cached on globalThis so Next.js dev hot reloads don't leak pools.
const g = globalThis as unknown as { __pgPool?: Pool };

export function pool(): Pool {
  if (!g.__pgPool) {
    g.__pgPool = new Pool({
      connectionString: process.env.DATABASE_URL,
      max: Number(process.env.PG_POOL_MAX ?? 20),
      // fail fast (503 to the client) instead of queueing forever if the pool is exhausted
      connectionTimeoutMillis: Number(process.env.PG_CONNECT_TIMEOUT_MS ?? 5000),
    });
  }
  return g.__pgPool;
}

export async function closePool(): Promise<void> {
  if (g.__pgPool) {
    const p = g.__pgPool;
    g.__pgPool = undefined;
    await p.end();
  }
}

export async function tx<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const c = await pool().connect();
  try {
    await c.query('BEGIN');
    const out = await fn(c);
    await c.query('COMMIT');
    return out;
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    c.release();
  }
}

export function isUniqueViolation(e: unknown, constraint?: string): boolean {
  const err = e as { code?: string; constraint?: string };
  return err?.code === '23505' && (constraint === undefined || err.constraint === constraint);
}
