// `npm run script-eval -- --qa`: QA throughput end to end with the script check on vs off.
// Uses its own database (sa_scriptcheck) and bucket (recordings-scriptcheck), never the app's, and
// drops / empties both afterwards. Real claim -> upload -> submit -> runQaOnce, one worker.
import { join } from 'node:path';
import { S3Client, CreateBucketCommand, DeleteBucketCommand, DeleteObjectsCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';
import { Client } from 'pg';
import { SENTENCES } from '../db/sentences';
import { encodeWav } from '../lib/wav';
import { VOICES, synth, loadPcm, makeTake, pool as inParallel } from './lib/speech';
import { makeRng } from './lib/rng';

const DB_NAME = 'sa_scriptcheck';
const BUCKET = 'recordings-scriptcheck';
const PER_LANG = 8;
const WRONG_SHARE = 0.1;

export async function qaThroughput(whisperUrl: string): Promise<string> {
  const base = (process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5433/scripts').replace(/\/[^/]*$/, '');
  const dbUrl = `${base}/${DB_NAME}`;
  Object.assign(process.env, {
    DATABASE_URL: dbUrl, S3_BUCKET: BUCKET, S3_ENDPOINT: process.env.S3_ENDPOINT ?? 'http://localhost:9000',
    S3_KEY: process.env.S3_KEY ?? 'minioadmin', S3_SECRET: process.env.S3_SECRET ?? 'minioadmin', ACCEPTED_SAMPLE_RATES: '48000',
  });
  if (!process.env.DATABASE_URL!.endsWith(`/${DB_NAME}`) || process.env.S3_BUCKET !== BUCKET) throw new Error('refusing to run outside sa_scriptcheck');
  const { seed } = await import('../db/seed');
  const { pool, closePool } = await import('../lib/db');
  const { claim, submit } = await import('../lib/assign');
  const { putObject, recordingKey, s3 } = await import('../lib/storage');
  const { runQaOnce } = await import('../lib/qa');
  const { transcribe } = await import('../lib/transcribe');

  try { await s3().send(new CreateBucketCommand({ Bucket: BUCKET })); } catch (e) {
    const n = (e as { name?: string }).name;
    if (n !== 'BucketAlreadyOwnedByYou' && n !== 'BucketAlreadyExists') throw e;
  }
  const langs = Object.keys(VOICES);
  const audioDir = join(process.cwd(), 'results', 'script-eval-cache', 'audio');

  async function round(withCheck: boolean) {
    await seed({ databaseUrl: dbUrl, contributors: 400, scriptsPerLanguage: 0, scriptsByLanguage: Object.fromEntries(langs.map((l) => [l, PER_LANG])) });
    const rng = makeRng(withCheck ? 1 : 2);
    let who = 1;
    const takes: { lang: string; wrong: boolean }[] = [];
    for (const lang of langs) for (let k = 0; k < PER_LANG; k++) takes.push({ lang, wrong: rng.next() < WRONG_SHARE });
    const planned = await inParallel(takes, 6, async (t) => {
      const id = who++;
      const c = await claim(id, t.lang);
      if (c.status === 'empty') throw new Error('pool empty');
      const S = SENTENCES[t.lang];
      const text = t.wrong ? S[(S.indexOf(c.body) + 5) % S.length] : c.body;
      const f = await synth(audioDir, { voice: VOICES[t.lang][0], text }, 'flac16');
      const x = await loadPcm(f, 48000);
      const r = makeRng(id * 7919 + (withCheck ? 1 : 0));
      // pad to >= 6 s like a browser take (press record, read, stop), within the padding rule (<= 3 s each end)
      const pad = Math.min(2.5, Math.max(0.6, (6 - x.length / 48000) / 2));
      const wav = encodeWav({ sampleRate: 48000, samples: makeTake(x, 48000, r, { leadS: pad + r.uniform(0, 0.3), trailS: pad, levelDb: -24 }) });
      await putObject(recordingKey(c.scriptId, c.token), wav);
      await submit(id, c.token);
      return { ...t, bytes: wav.length };
    });
    const t0 = Date.now();
    const tot = { processed: 0, approved: 0, rejected: 0, review: 0, errors: 0 };
    for (;;) {
      const r = await runQaOnce({ limit: 10, transcriber: withCheck ? (w, l) => transcribe(w, l, { url: whisperUrl }) : null });
      for (const k of Object.keys(tot) as (keyof typeof tot)[]) tot[k] += r[k];
      if (r.processed + r.errors === 0) break;
    }
    const s = (Date.now() - t0) / 1000;
    const notes = (await pool().query(`SELECT review_note, count(*)::int n FROM recordings GROUP BY 1 ORDER BY 2 DESC`)).rows;
    const tms = (await pool().query(`SELECT (c->>'transcribeMs')::int ms FROM recordings, jsonb_array_elements(checks) c WHERE c->>'name' = 'script_match' AND c ? 'transcribeMs'`)).rows.map((r) => r.ms as number);
    return { n: planned.length, wrong: planned.filter((p) => p.wrong).length, s, tot, notes, tms };
  }

  try {
    const off = await round(false);
    const on = await round(true);
    const fmt = (r: typeof on) => `${r.n} takes in ${r.s.toFixed(1)} s = **${(r.n / r.s).toFixed(1)} takes/s** (approved ${r.tot.approved}, rejected ${r.tot.rejected}, review ${r.tot.review}, errors ${r.tot.errors})`;
    const notes = (r: typeof on) => r.notes.map((x) => `${x.review_note || '(approved)'} ${x.n}`).join(', ');
    const sorted = [...on.tms].sort((a, b) => a - b);
    return [
      `One QA worker (\`runQaOnce\`, batch 10), real Postgres + MinIO (own DB \`${DB_NAME}\`), ${PER_LANG} takes per language x ${langs.length} languages, ~${(WRONG_SHARE * 100).toFixed(0)}% of them a different sentence (${on.wrong} this run), each a TTS reading padded to >= 6 s at 48 kHz:`,
      '',
      `- check off: ${fmt(off)}; outcomes: ${notes(off)}`,
      `- check on: ${fmt(on)}; outcomes: ${notes(on)}`,
      `- transcription inside QA: p50 ${sorted[Math.floor(sorted.length / 2)]} ms, p95 ${sorted[Math.ceil(sorted.length * 0.95) - 1]} ms`,
      '',
      'Where the time goes (40 sentence takes, measured separately): Whisper ~300 ms per take on the GPU (Metal, flash attention on; the model loads once at server start, not per request). Resampling 48 -> 16 kHz in TS was ~100 ms per take until it got a precomputed-filter path (now ~8 ms). One server, one request at a time: 3.3 takes/s; 2 requests in flight: 3.4/s; two servers on ports 8178/8179 with -t 4 each, 2 in flight: 4.2/s. The GPU is the bottleneck, so a second server on the same laptop adds ~25%; a faster GPU or a smaller/quantized model is what would move it.',
    ].join('\n');
  } finally {
    await closePool();
    // clean up: empty + delete the bucket, drop the database
    const c: S3Client = s3();
    for (;;) {
      const l = await c.send(new ListObjectsV2Command({ Bucket: BUCKET }));
      if (!l.Contents?.length) break;
      await c.send(new DeleteObjectsCommand({ Bucket: BUCKET, Delete: { Objects: l.Contents.map((o) => ({ Key: o.Key! })) } }));
    }
    await c.send(new DeleteBucketCommand({ Bucket: BUCKET })).catch(() => {});
    const admin = new Client({ connectionString: `${base}/postgres` });
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS ${DB_NAME} WITH (FORCE)`).finally(() => admin.end());
  }
}
