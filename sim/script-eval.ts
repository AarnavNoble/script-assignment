// Script-check evaluation: does Whisper + lib/scriptmatch.ts tell a correct reading from a wrong one?
//
//   npm run whisper                      # whisper-server on :8178 (other terminal)
//   npm run script-eval                  # synthesize (cached), transcribe (cached), choose thresholds, report
//   npm run script-eval -- --fresh       # re-transcribe everything (fresh timings)
//   npm run script-eval -- --qa          # also measure QA throughput end to end (own DB sa_scriptcheck + bucket)
//   flags: --sentences 30  --langs en,es  --url http://127.0.0.1:8178
//
// For each of the 15 languages with a macOS voice, ~30 sentences, six cases each:
//   correct         right sentence, voice i, default rate
//   correct_slow    right sentence, another voice (where there is one), rate 140 wpm
//   noisy_fast      right sentence, a third voice, rate 240 wpm, background noise at 15-20 dB SNR
//   wrong_script    a different sentence of the same language
//   partial         only the first half of the sentence
//   wrong_language  an English reading (a Spanish one for English scripts)
// Every take goes through the production path: 48 kHz 16-bit WAV with room tone at both ends ->
// lib/transcribe.ts (resample to 16 kHz, POST to whisper-server) -> lib/scriptmatch.ts.
// Reported outcomes are 2-fold cross-validated over sentences (even / odd); shipped thresholds use all sentences.
//
// Outputs: results/script-check.md, results/script-check.csv, results/script-check.json,
// results/script-check.png. Audio + transcripts are cached under results/script-eval-cache/ (gitignored).
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { cpus } from 'node:os';
import { SENTENCES } from '../db/sentences';
import { encodeWav } from '../lib/wav';
import { transcribe } from '../lib/transcribe';
import { errorRate, verdictFor, SCRIPT_THRESHOLDS, type Metric, type ScriptThreshold, type ScriptVerdict } from '../lib/scriptmatch';
import { analyze } from '../lib/checks';
import { VOICES, synth, loadPcm, addNoise, makeTake, firstHalf, pool, speechId, type SpeechKey } from './lib/speech';
import { makeRng, deriveSeed } from './lib/rng';

const ROOT = process.cwd();
const RESULTS = join(ROOT, 'results');
const CACHE = join(RESULTS, 'script-eval-cache');
const AUDIO = join(CACHE, 'audio');
const TRANSCRIPTS = join(CACHE, 'transcripts.jsonl');
const SR = 48000;

const KINDS = ['correct', 'correct_slow', 'noisy_fast', 'wrong_script', 'partial', 'wrong_language'] as const;
type Kind = (typeof KINDS)[number];
const CORRECT_KINDS: readonly Kind[] = ['correct', 'correct_slow', 'noisy_fast'];
const isCorrect = (k: Kind) => CORRECT_KINDS.includes(k);
const SLOW = 140, FAST = 240;

/** Relative costs used to choose thresholds (see the report): a wrongly rejected honest take is the worst outcome. */
const COST = { wrongReject: 20, wrongApprove: 10, review: 1 };
/** Minimum width of the review band (reject threshold - approve threshold). */
const MIN_BAND = 0.1;
/** One metric for every language: CER (see the report for the WER comparison). */
const SHIP_METRIC: Metric = 'cer';
/** Whisper-small can't transcribe these: the check is off (lib/scriptmatch.ts `skip`). */
const SKIP_LANGS = new Set(['bn']);
const GRID = Array.from({ length: 21 }, (_, i) => Math.round(i * 5) / 100); // 0, 0.05, ..., 1.0

type Case = {
  id: string; lang: string; kind: Kind; idx: number;
  expected: string; spoken: SpeechKey; spokenLang: string; snrDb?: number; seed: number;
};
type Result = Case & { transcript: string | null; ms: number | null; durationS: number; wer: number; cer: number; audioVerdict: string };

function args() {
  const a = process.argv.slice(2);
  const get = (f: string) => { const i = a.indexOf(f); return i >= 0 ? a[i + 1] : undefined; };
  return {
    sentences: Number(get('--sentences') ?? 30),
    langs: (get('--langs') ?? Object.keys(VOICES).join(',')).split(','),
    url: get('--url') ?? process.env.WHISPER_URL ?? 'http://127.0.0.1:8178',
    fresh: a.includes('--fresh'),
    qa: a.includes('--qa'),
  };
}

function planCases(langs: string[], n: number): Case[] {
  const cases: Case[] = [];
  for (const lang of langs) {
    const S = SENTENCES[lang];
    const V = VOICES[lang];
    if (!S || !V) throw new Error(`no sentences or voices for ${lang}`);
    // Bengali: Whisper-small produces no usable Bengali (junk / other scripts, ~5 s per take), so a
    // smaller sample is enough to show it; keeps the run under ~30 min.
    const N = Math.min(lang === 'bn' ? Math.min(n, 10) : n, S.length);
    const other = lang === 'en' ? 'es' : 'en';
    const OV = VOICES[other];
    for (let i = 0; i < N; i++) {
      const base = { lang, idx: i, expected: S[i] };
      const v = (k: number) => V[(i + k) % V.length];
      const add = (kind: Kind, spoken: SpeechKey, spokenLang: string, extra: Partial<Case> = {}) => {
        const seed = deriveSeed(0x5c71, cases.length + 1);
        cases.push({ ...base, id: `${lang}|${kind}|${i}|${speechId(spoken)}`, kind, spoken, spokenLang, seed, ...extra });
      };
      add('correct', { voice: v(0), text: S[i] }, lang);
      add('correct_slow', { voice: v(1), rate: SLOW, text: S[i] }, lang);
      const snr = 15 + 5 * makeRng(deriveSeed(0x5e7, cases.length)).next();
      add('noisy_fast', { voice: v(2), rate: FAST, text: S[i] }, lang, { snrDb: Math.round(snr * 10) / 10 });
      // another sentence, same voice the take of that sentence would use (so it reuses cached audio)
      const j = (i + 7) % N;
      add('wrong_script', { voice: V[j % V.length], text: S[j] }, lang);
      add('partial', { voice: v(0), text: firstHalf(S[i], lang) }, lang);
      add('wrong_language', { voice: OV[i % OV.length], text: SENTENCES[other][i] }, other);
    }
  }
  return cases;
}

type Cached = { id: string; transcript: string | null; ms: number | null };
function readCache(): Map<string, Cached> {
  const m = new Map<string, Cached>();
  if (!existsSync(TRANSCRIPTS)) return m;
  for (const line of readFileSync(TRANSCRIPTS, 'utf8').split('\n')) {
    if (!line) continue;
    try { const r = JSON.parse(line) as Cached; m.set(r.id, r); } catch { /* torn line */ }
  }
  return m;
}

const pct = (x: number, n: number) => (n ? `${((100 * x) / n).toFixed(1)}%` : 'n/a');
const q = (xs: number[], p: number) => {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil(p * s.length) - 1))];
};
const r3 = (x: number) => Math.round(x * 1000) / 1000;

type Choice = ScriptThreshold & { cost: number; margin: number };

/**
 * Grid search over (pass, fail) minimizing COST on the given correct/wrong error rates; ties broken by
 * the largest margin (distance from `pass` to the nearest wrong reading above it and from `fail` to
 * the nearest correct reading at or below it). fail = null means "never reject".
 */
function choose(metric: Metric, correct: number[], wrong: number[]): Choice {
  let best: Choice | null = null;
  const fails: (number | null)[] = [...GRID, null];
  for (const p of GRID) {
    for (const f of fails) {
      if (f !== null && f < p + MIN_BAND - 1e-9) continue;
      const t: ScriptThreshold = { metric, pass: p, fail: f };
      let cost = 0;
      for (const c of correct) { const v = verdictFor(c, t); cost += v === 'fail' ? COST.wrongReject : v === 'review' ? COST.review : 0; }
      for (const w of wrong) { const v = verdictFor(w, t); cost += v === 'pass' ? COST.wrongApprove : v === 'review' ? COST.review : 0; }
      const above = wrong.filter((w) => w > p).map((w) => w - p);
      const below = f === null ? [] : correct.filter((c) => c <= f).map((c) => f - c);
      const margin = Math.min(above.length ? Math.min(...above) : 1, below.length ? Math.min(...below) : 1);
      if (!best || cost < best.cost - 1e-9 || (Math.abs(cost - best.cost) < 1e-9 && margin > best.margin + 1e-9)) {
        best = { metric, pass: p, fail: f, cost, margin };
      }
    }
  }
  return best!;
}

async function main() {
  const o = args();
  const t0 = Date.now();
  try {
    const r = await fetch(o.url, { signal: AbortSignal.timeout(3000) });
    await r.text();
  } catch {
    console.error(`whisper-server not reachable at ${o.url}; start it with: npm run whisper`);
    process.exit(1);
  }
  const cases = planCases(o.langs, o.sentences);
  console.log(`[eval] ${cases.length} takes over ${o.langs.length} languages (${o.sentences} sentences each, ${KINDS.length} cases)`);

  // 1. synthesize unique utterances (parallel; `say` is single-threaded)
  const uniq = new Map<string, SpeechKey>();
  for (const c of cases) uniq.set(speechId(c.spoken), c.spoken);
  const tSynth = Date.now();
  let made = 0;
  await pool([...uniq.values()], Math.max(2, Math.min(8, cpus().length - 2)), async (k) => {
    await synth(AUDIO, k, 'flac16');
    if (++made % 200 === 0) console.log(`[eval] audio ${made}/${uniq.size}`);
  });
  console.log(`[eval] ${uniq.size} utterances ready (${((Date.now() - tSynth) / 1000).toFixed(0)} s)`);

  // 2. build each take at 48 kHz and transcribe (cached by case id)
  const cache = o.fresh ? new Map<string, Cached>() : readCache();
  mkdirSync(CACHE, { recursive: true });
  const tAsr = Date.now();
  let done = 0, fresh = 0;
  const results: Result[] = await pool(cases, 2, async (c) => {
    const rng = makeRng(c.seed);
    let x = await loadPcm(join(AUDIO, `${speechId(c.spoken)}.flac`), SR);
    if (c.snrDb !== undefined) x = addNoise(x, SR, c.snrDb, rng);
    const take = makeTake(x, SR, rng, { leadS: rng.uniform(0.4, 1.0), trailS: rng.uniform(0.4, 1.0), levelDb: rng.uniform(-28, -20) });
    const wav = encodeWav({ sampleRate: SR, samples: take });
    let hit = cache.get(c.id);
    if (!hit) {
      const tr = await transcribe(wav, c.lang, { url: o.url });
      hit = { id: c.id, transcript: tr?.text ?? null, ms: tr?.ms ?? null };
      appendFileSync(TRANSCRIPTS, JSON.stringify(hit) + '\n');
      fresh++;
    }
    if (++done % 250 === 0) console.log(`[eval] transcribed ${done}/${cases.length} (${fresh} new)`);
    const heard = hit.transcript ?? '';
    const a = analyze({ sampleRate: SR, samples: take });
    return {
      ...c, transcript: hit.transcript, ms: hit.ms, durationS: take.length / SR,
      wer: errorRate(c.expected, heard, c.lang, 'wer'), cer: errorRate(c.expected, heard, c.lang, 'cer'),
      audioVerdict: a.verdict,
    };
  });
  console.log(`[eval] transcripts: ${fresh} new, ${cases.length - fresh} cached (${((Date.now() - tAsr) / 1000).toFixed(0)} s)`);

  // 3. thresholds. Reported numbers are 2-fold cross-validated: every take is scored with thresholds
  //    chosen on the OTHER half of the sentences (even <-> odd). The shipped thresholds are then
  //    chosen the same way on all sentences.
  const metricOf = (lang: string): Metric => (SKIP_LANGS.has(lang) ? 'wer' : SHIP_METRIC);
  const pick = (rows: Result[], m: Metric) => choose(m, rows.filter((r) => isCorrect(r.kind)).map((r) => r[m]), rows.filter((r) => !isCorrect(r.kind)).map((r) => r[m]));
  const cv = new Map<Result, ScriptVerdict>();
  const cvAlt = new Map<Result, ScriptVerdict>(); // same procedure with the other metric, for comparison
  const foldTh: Record<string, ScriptThreshold[]> = {};
  for (const lang of o.langs) {
    const R = results.filter((r) => r.lang === lang);
    foldTh[lang] = [];
    for (const fold of [0, 1]) {
      const sel = R.filter((r) => r.idx % 2 === fold), out = R.filter((r) => r.idx % 2 !== fold);
      const m = metricOf(lang), alt: Metric = m === 'cer' ? 'wer' : 'cer';
      const th = pick(sel, m), thAlt = pick(sel, alt);
      foldTh[lang].push(th);
      for (const r of out) {
        cv.set(r, r.transcript === null ? 'review' : verdictFor(r[m], th));
        cvAlt.set(r, r.transcript === null ? 'review' : verdictFor(r[alt], thAlt));
      }
    }
  }
  const chosen: Record<string, Choice> = Object.fromEntries(o.langs.map((l) => [l, pick(results.filter((r) => r.lang === l), metricOf(l))]));
  const table: Record<string, ScriptThreshold> = Object.fromEntries(Object.entries(chosen).map(([l, c]) => [l, { metric: c.metric, pass: c.pass, fail: c.fail }]));
  const shipped = Object.fromEntries(o.langs.map((l) => [l, SCRIPT_THRESHOLDS[l]]));
  const sameAsShipped = o.langs.every((l) => {
    const a = table[l], b = shipped[l];
    if (SKIP_LANGS.has(l)) return !!b?.skip;
    return b && a.metric === b.metric && a.pass === b.pass && a.fail === b.fail;
  });

  // 4. write CSV + JSON
  const csvEsc = (s: unknown) => { const v = s === null || s === undefined ? '' : String(s); return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v; };
  const csv = ['lang,kind,idx,fold,voice,rate,snr_db,spoken_lang,duration_s,transcribe_ms,wer,cer,metric,error_rate,cv_verdict,shipped_verdict,audio_verdict,expected,spoken,transcript'];
  for (const r of results) {
    const th = table[r.lang];
    const rate = r[th.metric];
    csv.push([r.lang, r.kind, r.idx, r.idx % 2, r.spoken.voice, r.spoken.rate ?? '', r.snrDb ?? '', r.spokenLang, r3(r.durationS), r.ms ?? '',
      r3(r.wer), r3(r.cer), th.metric, r3(rate), cv.get(r), r.transcript === null ? 'review' : verdictFor(rate, th), r.audioVerdict,
      r.expected, r.spoken.text, r.transcript ?? ''].map(csvEsc).join(','));
  }
  writeFileSync(join(RESULTS, 'script-check.csv'), csv.join('\n') + '\n');
  writeFileSync(join(RESULTS, 'script-check.json'), JSON.stringify({ chosen: table, cost: COST, minBand: MIN_BAND, langs: o.langs, skip: [...SKIP_LANGS] }, null, 2) + '\n');

  // 5. report
  const md: string[] = [];
  const line = (s = '') => md.push(s);
  type Outcome = { correct: Record<ScriptVerdict, number>; wrong: Record<ScriptVerdict, number>; nCorrect: number; nWrong: number };
  const tally = (rows: Result[], v: Map<Result, ScriptVerdict> | ((r: Result) => ScriptVerdict)): Outcome => {
    const oc: Outcome = { correct: { pass: 0, review: 0, fail: 0 }, wrong: { pass: 0, review: 0, fail: 0 }, nCorrect: 0, nWrong: 0 };
    for (const r of rows) {
      const x = typeof v === 'function' ? v(r) : v.get(r)!;
      if (isCorrect(r.kind)) { oc.correct[x]++; oc.nCorrect++; } else { oc.wrong[x]++; oc.nWrong++; }
    }
    return oc;
  };
  const covered = results.filter((r) => !SKIP_LANGS.has(r.lang));
  const oh = tally(covered, cv);
  const ohAll = tally(results, (r) => (SKIP_LANGS.has(r.lang) ? 'review' : cv.get(r)!)); // if bn were sent to review instead of skipped
  const oShip = tally(covered, (r) => (r.transcript === null ? 'review' : verdictFor(r[table[r.lang].metric], table[r.lang])));
  const ms = covered.map((r) => r.ms).filter((x): x is number => x !== null);
  const msBn = results.filter((r) => SKIP_LANGS.has(r.lang)).map((r) => r.ms).filter((x): x is number => x !== null);
  const durs = covered.map((r) => r.durationS);
  const mix = (oc: Outcome, wrongShare = 0.05) => (1 - wrongShare) * (oc.correct.review / oc.nCorrect) + wrongShare * (oc.wrong.review / oc.nWrong);
  const nLang = o.langs.filter((l) => !SKIP_LANGS.has(l)).length;

  line('# Script check: did they read the script?');
  line();
  line(`Generated by \`npm run script-eval\` (sim/script-eval.ts) against whisper.cpp \`whisper-server\` with ggml-small (multilingual) on this laptop (10-core Apple Silicon). ${results.length} synthesized takes: ${o.langs.length} languages x ${o.sentences} sentences (Bengali 10) x ${KINDS.length} cases (3 correct, 3 wrong). Every take goes through the production path: a 48 kHz WAV with room tone at both ends -> lib/transcribe.ts -> lib/scriptmatch.ts.`);
  line();
  line(`**All numbers below are cross-validated**: each take is judged with thresholds chosen on the other half of that language's sentences (even vs odd), so no take is scored by thresholds fit to it. Bengali is excluded from the headline because the check is switched off for it (see below).`);
  line();
  line('## Headline');
  line();
  const wrongN = oh.nWrong, corrN = oh.nCorrect;
  line(`Without this check a person has to listen to every take to confirm it matches the script. With it, **only ${(100 * mix(oh)).toFixed(1)}% go to review** (at a realistic mix of 95% correct / 5% wrong readings; ${pct(oh.correct.review + oh.wrong.review, corrN + wrongN)} of this eval's 50/50 mix); **wrong readings caught: ${pct(oh.wrong.fail, wrongN)}** (${pct(oh.wrong.review, wrongN)} sent to review, ${pct(oh.wrong.pass, wrongN)} slipped through); **correct readings wrongly rejected: ${pct(oh.correct.fail, corrN)}** (${oh.correct.fail} of ${corrN}).`);
  line();
  line(`${nLang} languages. Correct readings: ${pct(oh.correct.pass, corrN)} approved, ${pct(oh.correct.review, corrN)} to review, ${pct(oh.correct.fail, corrN)} rejected (n = ${corrN}). Wrong readings: ${pct(oh.wrong.fail, wrongN)} rejected, ${pct(oh.wrong.review, wrongN)} to review, ${pct(oh.wrong.pass, wrongN)} approved (n = ${wrongN}). With the shipped thresholds (fit on all sentences, so optimistic): correct ${pct(oShip.correct.pass, corrN)} / ${pct(oShip.correct.review, corrN)} / ${pct(oShip.correct.fail, corrN)}, wrong ${pct(oShip.wrong.fail, wrongN)} rejected / ${pct(oShip.wrong.review, wrongN)} / ${pct(oShip.wrong.pass, wrongN)} approved. Counting Bengali as 100% review: ${(100 * mix(ohAll)).toFixed(1)}% to review overall.`);
  line();
  line(`Transcription time per take: **p50 ${q(ms, 0.5)} ms, p95 ${q(ms, 0.95)} ms** (takes ${q(durs, 0.5).toFixed(1)} s median, ${q(durs, 0.95).toFixed(1)} s p95; one whisper-server, 4 threads, Metal; measured on the run that produced the cached transcripts). Bengali, had it not been switched off: p50 ${q(msBn, 0.5)} ms. ${results.filter((r) => r.transcript === null).length} transcription failures.`);
  line();
  line('## Per language');
  line();
  line('Cross-validated outcomes; thresholds are the shipped ones (fit on all sentences).');
  line();
  line('| Lang | Approve if CER <= | Reject if > | Correct: approved / review / **wrongly rejected** | Wrong: **rejected** / review / **wrongly approved** | Review at 5% wrong | Correct CER p50 / p95 / max | Wrong CER min / p5 | Thresholds per fold | Same with WER |');
  line('|---|---|---|---|---|---|---|---|---|---|');
  for (const lang of o.langs) {
    const rows = results.filter((r) => r.lang === lang);
    const th = table[lang];
    const m = th.metric;
    const ce = rows.filter((r) => isCorrect(r.kind)).map((r) => r[m]);
    const we = rows.filter((r) => !isCorrect(r.kind)).map((r) => r[m]);
    if (SKIP_LANGS.has(lang)) {
      line(`| ${lang} | check off | | correct readings: ${rows.filter((r) => isCorrect(r.kind) && r[m] >= 0.9).length} of ${ce.length} have error >= 0.9 | | 100% if it were on | ${r3(q(ce, 0.5))} / ${r3(q(ce, 0.95))} / ${r3(Math.max(...ce))} (WER) | ${r3(Math.min(...we))} | | |`);
      continue;
    }
    const oc = tally(rows, cv);
    const alt = tally(rows, cvAlt);
    const ft = foldTh[lang].map((t) => `${t.pass}/${t.fail ?? 'never'}`).join(', ');
    line(`| ${lang} | ${th.pass} | ${th.fail ?? 'never'} | ${oc.correct.pass} / ${oc.correct.review} / **${oc.correct.fail}** of ${oc.nCorrect} | **${oc.wrong.fail}** / ${oc.wrong.review} / **${oc.wrong.pass}** of ${oc.nWrong} | ${(100 * mix(oc)).toFixed(0)}% | ${r3(q(ce, 0.5))} / ${r3(q(ce, 0.95))} / ${r3(Math.max(...ce))} | ${r3(Math.min(...we))} / ${r3(q(we, 0.05))} | ${ft} | ${alt.correct.fail} / ${alt.wrong.pass} / ${(100 * mix(alt)).toFixed(0)}% |`);
  }
  line(`| sw | ${SCRIPT_THRESHOLDS.sw.pass} | never | untested: no TTS voice | | | | | | |`);
  line();
  line('"Same with WER" = wrongly rejected / wrongly approved / review at 5% wrong, with the same procedure on word error rate.');
  line();
  line('![error rates per language](script-check.png)');
  line();
  line('## By case (cross-validated, all covered languages)');
  line();
  line('| Case | n | approved | review | rejected | CER p50 |');
  line('|---|---|---|---|---|---|');
  for (const k of KINDS) {
    const rows = covered.filter((r) => r.kind === k);
    const vs = rows.map((r) => cv.get(r));
    line(`| ${k}${isCorrect(k) ? '' : ' (wrong)'} | ${rows.length} | ${vs.filter((v) => v === 'pass').length} | ${vs.filter((v) => v === 'review').length} | ${vs.filter((v) => v === 'fail').length} | ${r3(q(rows.map((r) => r.cer), 0.5))} |`);
  }
  line();
  const fr = covered.filter((r) => isCorrect(r.kind) && cv.get(r) === 'fail');
  line(`Correct readings wrongly rejected (${fr.length}), what Whisper heard:`);
  line();
  for (const r of fr) line(`- ${r.lang} ${r.kind} (${r.spoken.voice}${r.spoken.rate ? `, ${r.spoken.rate} wpm` : ''}${r.snrDb ? `, ${r.snrDb} dB SNR` : ''}), CER ${r3(r.cer)}: "${r.expected}" -> "${(r.transcript ?? '').replace(/\s+/g, ' ').slice(0, 120)}"`);
  line();
  line('## Chosen thresholds and why');
  line();
  line(`Per language, a grid search over approve-if <= p and reject-if > f with p, f in {0, 0.05, ..., 1.0} (f may be "never") and f >= p + ${MIN_BAND} (a review band, so a take near the line goes to a person instead of being decided by 0.05), minimizing a cost of **${COST.wrongReject} per wrongly rejected correct reading, ${COST.wrongApprove} per wrongly approved wrong reading, ${COST.review} per take sent to review**: a human listen is cheap, telling an honest contributor their take is wrong is the worst outcome, paying for a wrong take is next. Ties go to the thresholds farthest from the nearest misclassified take. **CER for every language**: it gave the fewest wrong rejections in cross-validation (it is not thrown off by Whisper splitting or joining words: German compounds, Korean spacing, Indic word breaks, Turkish suffixes, and gives partial credit for near-miss spellings), and one metric is simpler to explain. The WER column above is the comparison. ${sameAsShipped ? 'These are the values shipped in `SCRIPT_THRESHOLDS` (lib/scriptmatch.ts).' : '**Note: these differ from `SCRIPT_THRESHOLDS` in lib/scriptmatch.ts; copy them over.**'}`);
  line();
  line('| Lang | Approve if <= | Reject if > | Cost on all sentences |');
  line('|---|---|---|---|');
  for (const lang of o.langs) {
    const c = chosen[lang];
    line(SKIP_LANGS.has(lang) ? `| ${lang} | check off | | |` : `| ${lang} | ${c.pass} | ${c.fail ?? 'never'} | ${c.cost} |`);
  }
  line();
  line('**Bengali: check off.** Whisper-small does not produce Bengali: correct readings come back as junk, Devanagari or other scripts (error ~1.0 for correct and wrong alike), and each take costs ~5 s. With no signal, the check could only send every Bengali take to review, so it is switched off for bn (the take is decided on the audio checks, as before, and the skip is recorded in its checks). A larger Whisper model is the fix; see caveats.');
  line();
  line('**Swahili: untested** (no TTS voice). It gets approve if CER <= 0.1 and never rejects: a take that doesn\'t match closely goes to review.');
  line();
  line('## Audio checks on the same takes');
  line();
  const audioReview = results.filter((r) => r.audioVerdict !== 'pass');
  line(`The existing audio checks (lib/checks.ts) flag ${pct(audioReview.length, results.length)} of these takes on their own (${audioReview.filter((r) => r.audioVerdict === 'fail').length} fail, ${audioReview.filter((r) => r.audioVerdict === 'review').length} review), almost all for duration < 5 s: the seed scripts are one sentence, read in 2-6 s. That is independent of the script check and not counted above; with one-sentence scripts the duration rule, not the script check, would dominate the review queue.`);
  line();
  md.push('<!-- EXTRA -->');
  line();
  line('## How the check works');
  line();
  line('- `lib/transcribe.ts` resamples the 48 kHz take to 16 kHz mono in TS (windowed sinc) and POSTs it to `whisper-server` with the script\'s language forced. Greedy decoding at temperature 0 with Whisper\'s server-side fallback off; if the text is a repetition loop (Whisper\'s own test: compresses > 2.4x), one more decode at temperature 0.4. Timeout 30 s, one retry; on failure the check is skipped and recorded, never blocking QA.');
  line('- `lib/scriptmatch.ts` normalizes both texts (NFKC, lowercase, punctuation in every script, Arabic diacritics / letter variants, Indic nukta / chandrabindu) and computes WER, or CER over grapheme clusters. Scripts spell numbers out but Whisper writes digits, so a number in the transcript may stand for up to 4 words (8 characters) at no cost.');
  line('- `lib/qa.ts` runs the transcription before the per-hash duplicate lock and stores a `script_match` check (error rate, metric, thresholds, transcript, transcription ms). Fail -> reject `wrong_script`; between the thresholds -> review `script_mismatch`; combined with the audio checks like the others. Takes the audio checks already reject are not transcribed.');
  line();
  line('## Caveats');
  line();
  line('- **TTS is not people.** These are macOS voices: clean, regular, no accents, no hesitations, no kids, no cheap mics. Real contributors will have higher error rates on correct readings, so expect more review and some false rejects until thresholds are re-fit on a few hundred human-labeled real takes per language (the CSV format here works for that).');
  line('- **Few voices in some languages** (one voice for hi, ar, bn, id, tr, vi, pl): the slow / fast / noisy variants are the same speaker.');
  line('- **Thresholds come from 30 sentences per language** (180 takes, 15 per fold); the "thresholds per fold" column shows how much they move between halves. Cross-validation keeps the reported rates honest about that.');
  line('- **Swahili is untested** (no voice): review-only policy. **Bengali is not covered** (check off). A larger model (ggml-medium / large-v3) would likely fix Bengali and tighten Hindi and Korean, at roughly 3-10x the time per take; that is a model swap (`npm run whisper` points at the file) plus a re-run of this eval.');
  line('- The wrong readings here are blunt (a whole other sentence, half a sentence, another language). Subtler errors (one skipped word, a misread number) mostly land in review or pass: at a WER pass threshold of p, a 12-word script tolerates floor(12 p) wrong words.');
  const extraPath = join(RESULTS, 'script-check.extra.md');
  writeFileSync(join(RESULTS, 'script-check.md'), md.join('\n') + '\n');

  // 6. chart
  try {
    execFileSync('python3', [join(ROOT, 'sim', 'plot_script_check.py'), join(RESULTS, 'script-check.csv'), join(RESULTS, 'script-check.json'), join(RESULTS, 'script-check.png')], { stdio: 'inherit' });
  } catch (e) {
    console.error('[eval] chart failed:', (e as Error).message);
  }

  // 7. optional QA throughput
  if (o.qa) {
    const { qaThroughput } = await import('./script-eval-qa');
    const r = await qaThroughput(o.url);
    const qa = ['## QA throughput with the check on', '', r, ''].join('\n');
    writeFileSync(extraPath, qa);
  }
  if (existsSync(extraPath)) {
    const body = readFileSync(join(RESULTS, 'script-check.md'), 'utf8').replace('<!-- EXTRA -->', readFileSync(extraPath, 'utf8').trim() + '\n\n<!-- EXTRA -->');
    writeFileSync(join(RESULTS, 'script-check.md'), body);
  }
  console.log(`[eval] done in ${((Date.now() - t0) / 1000).toFixed(0)} s; thresholds ${sameAsShipped ? 'match' : 'DIFFER from'} lib/scriptmatch.ts`);
  console.log(JSON.stringify(table));

}

main().catch((e) => { console.error(e); process.exit(1); });
