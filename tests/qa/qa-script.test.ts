// Integration: the script_match check inside runQaOnce, against real Postgres + MinIO, with an
// injected fake transcriber (no whisper server needed).
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { createHash } from 'node:crypto';
import { seed } from '@/db/seed';
import { pool, closePool } from '@/lib/db';
import { claim, submit } from '@/lib/assign';
import { putObject, recordingKey } from '@/lib/storage';
import { encodeWav } from '@/lib/wav';
import { runQaOnce, QA_DUP_NS } from '@/lib/qa';
import { SCRIPT_THRESHOLDS } from '@/lib/scriptmatch';
import { expectedDurationS } from '@/lib/checks';
import type { Transcriber } from '@/lib/transcribe';
import { speech, noiseOnly } from './synth';

type Rec = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const q = async <T = Rec>(sql: string, p: unknown[] = []) => (await pool().query(sql, p)).rows as T[];
const quiet = { error: () => {}, warn: () => {} };
const rec = async (id: number) => (await q('SELECT * FROM recordings WHERE id = $1', [id]))[0];
const scriptCheck = (r: Rec) => (r.checks as Rec[]).find((c) => c.name === 'script_match') as Rec;
const sha = (b: Buffer) => createHash('sha1').update(b).digest('hex');

let who = 1;
/** claim (in `lang`) -> upload -> submit; returns the recording id, the script body and the uploaded bytes */
async function record(lang: string, wav: Buffer) {
  const c = await claim(who++, lang);
  if (c.status === 'empty') throw new Error('pool empty');
  await putObject(recordingKey(c.scriptId, c.token), wav);
  const s = await submit(who - 1, c.token);
  return { id: s.recordingId, body: c.body, wav };
}

/** Fake transcriber: answers per uploaded audio (by hash); records calls. */
function fake(answers: Map<string, string | null | Error>) {
  const calls: { lang: string }[] = [];
  const t: Transcriber = async (wav, lang) => {
    calls.push({ lang });
    const a = answers.get(sha(wav));
    if (a instanceof Error) throw a;
    return a === null || a === undefined ? null : { text: a, ms: 5 };
  };
  return { t, calls };
}

/** Replace letters so the English error rate lands between pass and fail (a borderline reading). */
function borderline(body: string): string {
  const th = SCRIPT_THRESHOLDS.en;
  const target = (th.pass + (th.fail ?? th.pass + 0.3)) / 2;
  const letters = [...body].filter((c) => /\p{L}/u.test(c)).length;
  let k = Math.round(target * letters);
  return [...body].map((c) => (k > 0 && /\p{L}/u.test(c) && c !== 'q' ? (k--, 'q') : c)).join('');
}

beforeEach(async () => {
  who = 1;
  delete process.env.WHISPER_URL;
  await seed({ databaseUrl: process.env.DATABASE_URL!, contributors: 40, scriptsPerLanguage: 0, scriptsByLanguage: { en: 20, sw: 5, bn: 3 } });
});

afterAll(async () => {
  await closePool();
});

describe('script_match in runQaOnce', () => {
  it('correct reading -> approved; another sentence -> rejected wrong_script; borderline -> review; transcript stored', async () => {
    const good = await record('en', encodeWav(speech({ seed: 201 })));
    const wrong = await record('en', encodeWav(speech({ seed: 202 })));
    const unsure = await record('en', encodeWav(speech({ seed: 203 })));
    const answers = new Map<string, string | null | Error>([
      [sha(good.wav), `  ${good.body.toUpperCase()}  `],
      [sha(wrong.wav), 'I usually make a cup of tea before I start working in the morning, every single day.'],
      [sha(unsure.wav), borderline(unsure.body)],
    ]);
    const { t, calls } = fake(answers);
    expect(await runQaOnce({ limit: 10, logger: quiet, transcriber: t })).toMatchObject({ processed: 3, approved: 1, rejected: 1, review: 1 });
    expect(calls.every((c) => c.lang === 'en')).toBe(true);

    const g = await rec(good.id);
    expect(g.status).toBe('approved');
    expect(scriptCheck(g)).toMatchObject({ name: 'script_match', status: 'pass', value: 0, unit: SCRIPT_THRESHOLDS.en.metric, transcript: good.body.toUpperCase() });

    const w = await rec(wrong.id);
    expect(w).toMatchObject({ status: 'rejected', review_note: 'wrong_script', est_pay_cents: 0 });
    expect(scriptCheck(w)).toMatchObject({ status: 'fail', reason: 'wrong_script' });
    expect(scriptCheck(w).value).toBeGreaterThan(SCRIPT_THRESHOLDS.en.fail!);
    expect(scriptCheck(w).threshold).toMatch(/fail >/);

    const u = await rec(unsure.id);
    expect(u).toMatchObject({ status: 'needs_review', review_note: 'script_mismatch' });
    expect(scriptCheck(u).status).toBe('warn');
  });

  it('combines with the audio checks: audio review + script pass stays review; audio review + script fail rejects', async () => {
    const quietOk = await record('en', encodeWav(speech({ seed: 211, levelDb: -40 })));
    const quietWrong = await record('en', encodeWav(speech({ seed: 212, levelDb: -40 })));
    const { t } = fake(new Map([[sha(quietOk.wav), quietOk.body], [sha(quietWrong.wav), 'something else entirely, not the script at all']]));
    await runQaOnce({ limit: 10, logger: quiet, transcriber: t });
    expect(await rec(quietOk.id)).toMatchObject({ status: 'needs_review', review_note: 'quiet' });
    expect(await rec(quietWrong.id)).toMatchObject({ status: 'rejected', review_note: 'wrong_script' });
  });

  it('transcriber down (null) or throwing: decided on audio alone, the skip is recorded', async () => {
    const a = await record('en', encodeWav(speech({ seed: 221 })));
    const b = await record('en', encodeWav(speech({ seed: 222 })));
    const { t } = fake(new Map<string, string | null | Error>([[sha(a.wav), null], [sha(b.wav), new Error('boom')]]));
    expect(await runQaOnce({ limit: 10, logger: quiet, transcriber: t })).toMatchObject({ processed: 2, approved: 2, errors: 0 });
    for (const r of [await rec(a.id), await rec(b.id)]) {
      expect(scriptCheck(r)).toMatchObject({ status: 'pass', value: null, threshold: 'skipped: transcriber unavailable' });
    }
  });

  it('does not transcribe a take the audio checks already reject', async () => {
    const silent = await record('en', encodeWav(noiseOnly({ seed: 231 })));
    const { t, calls } = fake(new Map());
    await runQaOnce({ limit: 10, logger: quiet, transcriber: t });
    expect(calls).toHaveLength(0);
    const r = await rec(silent.id);
    expect(r).toMatchObject({ status: 'rejected', review_note: 'silent' });
    expect(scriptCheck(r).threshold).toMatch(/audio checks already failed/);
  });

  it('Swahili: a mismatch goes to review, never rejected', async () => {
    const s = await record('sw', encodeWav(speech({ seed: 241 })));
    const { t } = fake(new Map([[sha(s.wav), 'completely different words here that do not match']]));
    await runQaOnce({ limit: 10, logger: quiet, transcriber: t });
    expect(await rec(s.id)).toMatchObject({ status: 'needs_review', review_note: 'script_mismatch' });
  });

  it('Bengali (check off): not transcribed, decided on audio, the skip recorded', async () => {
    const s = await record('bn', encodeWav(speech({ seed: 245 })));
    const { t, calls } = fake(new Map());
    await runQaOnce({ limit: 10, logger: quiet, transcriber: t });
    expect(calls).toHaveLength(0);
    const r = await rec(s.id);
    expect(r.status).toBe('approved');
    expect(scriptCheck(r)).toMatchObject({ status: 'pass', value: null });
    expect(scriptCheck(r).threshold).toMatch(/skipped: .*Bengali/);
  });

  it('a short take whose script check passes is approved (waiver recorded); without a transcript it goes to review', async () => {
    // takes of 0.35x their script's expected reading time: "truncated" for the audio checks alone
    const shortTake = async (seed: number) => {
      const c = await claim(who, 'en');
      if (c.status === 'empty') throw new Error('pool empty');
      const wav = encodeWav(speech({ seed, seconds: 0.35 * expectedDurationS(c.body, 'en'), lead: 0.4, trail: 0.4 }));
      await putObject(recordingKey(c.scriptId, c.token), wav);
      return { id: (await submit(who++, c.token)).recordingId, body: c.body, wav };
    };
    const heard = await shortTake(271);
    const unheard = await shortTake(272);
    const { t } = fake(new Map<string, string | null | Error>([[sha(heard.wav), heard.body], [sha(unheard.wav), null]]));
    await runQaOnce({ limit: 10, logger: quiet, transcriber: t });
    const r = await rec(heard.id);
    expect(r.status).toBe('approved');
    const el = (r.checks as Rec[]).find((x) => x.name === 'expected_length')!;
    expect(el).toMatchObject({ status: 'pass', reason: 'truncated' });
    expect(el.threshold).toMatch(/waived/);
    // no transcript (transcriber down): nothing confirms the text is complete -> review
    expect(await rec(unheard.id)).toMatchObject({ status: 'needs_review', review_note: 'truncated' });
  });

  it('transcribes outside the per-hash duplicate lock', async () => {
    const a = await record('en', encodeWav(speech({ seed: 251 })));
    let held: number | null = null;
    const t: Transcriber = async () => {
      held = (await q(`SELECT count(*)::int n FROM pg_locks WHERE locktype = 'advisory' AND classid = $1::int::oid`, [QA_DUP_NS]))[0].n;
      return { text: a.body, ms: 1 };
    };
    await runQaOnce({ limit: 10, logger: quiet, transcriber: t });
    expect(held).toBe(0);
    expect((await rec(a.id)).status).toBe('approved');
  });

  it('off by default: no WHISPER_URL and no injected transcriber -> no script_match check', async () => {
    const a = await record('en', encodeWav(speech({ seed: 261 })));
    await runQaOnce({ limit: 10, logger: quiet });
    const r = await rec(a.id);
    expect(r.status).toBe('approved');
    expect(scriptCheck(r)).toBeUndefined();
  });
});
