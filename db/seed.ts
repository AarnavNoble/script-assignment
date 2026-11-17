import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from 'pg';
import { scriptBodies } from './sentences';

export const LANGUAGES = [
  'en', 'es', 'hi', 'pt', // popular: ~80% of contributors
  'fr', 'de', 'ar', 'bn', 'ja', 'ko', 'id', 'tr', 'vi', 'it', 'pl', 'sw',
];
export const POPULAR = LANGUAGES.slice(0, 4);

export type SeedOptions = {
  databaseUrl?: string;
  contributors?: number;        // registered contributors (default 2,000)
  scriptsPerLanguage?: number;  // default 1,200
  scriptsByLanguage?: Record<string, number>; // per-language override
  popularShare?: number;        // share of contributors in POPULAR (default 0.8)
};

/** Create the database if it doesn't exist (connects to the `postgres` maintenance DB). */
export async function ensureDatabase(databaseUrl: string): Promise<void> {
  const url = new URL(databaseUrl);
  const name = url.pathname.replace(/^\//, '');
  url.pathname = '/postgres';
  const c = new Client({ connectionString: url.toString() });
  await c.connect();
  try {
    const r = await c.query('SELECT 1 FROM pg_database WHERE datname = $1', [name]);
    if (r.rowCount === 0) await c.query(`CREATE DATABASE "${name.replace(/"/g, '')}"`);
  } finally {
    await c.end();
  }
}

/** Contributor i's language: first `popularShare` spread over POPULAR, the rest over the long tail. */
export function languageFor(i: number, n: number, popularShare = 0.8): string {
  const cut = Math.round(n * popularShare);
  if (i < cut) return POPULAR[i % POPULAR.length];
  const tail = LANGUAGES.slice(POPULAR.length);
  return tail[(i - cut) % tail.length];
}

/** Drop everything, apply schema.sql, insert contributors + scripts. */
export async function seed(opts: SeedOptions = {}): Promise<void> {
  const databaseUrl = opts.databaseUrl ?? process.env.DATABASE_URL!;
  const contributors = opts.contributors ?? 2000;
  const perLang = opts.scriptsPerLanguage ?? 1200;
  const share = opts.popularShare ?? 0.8;

  await ensureDatabase(databaseUrl);
  const c = new Client({ connectionString: databaseUrl });
  await c.connect();
  try {
    await c.query('DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;');
    await c.query(readFileSync(join(process.cwd(), 'db', 'schema.sql'), 'utf8'));

    const ids = Array.from({ length: contributors }, (_, i) => i + 1);
    const langs = ids.map((_, i) => languageFor(i, contributors, share));
    await c.query(
      'INSERT INTO contributors (id, language) SELECT * FROM unnest($1::int[], $2::text[])',
      [ids, langs],
    );

    for (const lang of LANGUAGES) {
      const n = opts.scriptsByLanguage?.[lang] ?? perLang;
      if (n <= 0) continue;
      // ORDER BY ord: ids follow array order, so script #1.. of a language are the distinct first pass
      await c.query(
        `INSERT INTO scripts (language, body)
         SELECT $1::text, b FROM unnest($2::text[]) WITH ORDINALITY AS t(b, ord) ORDER BY ord`,
        [lang, scriptBodies(lang, n)],
      );
    }
    await c.query('ANALYZE');
  } finally {
    await c.end();
  }
}
