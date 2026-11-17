// Real TTS readings for the storm (sim/storm.ts), so a QA worker with the script check on sees takes
// that actually read their script. Pre-generated once with `npm run storm -- --prepare` into
// results/storm-speech-cache/ (gitignored): one 48 kHz WAV per (language, sentence) for the first
// PREPARE_PER_LANG script bodies of each language (the storm claims low ids).
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { scriptBodies } from '../../db/sentences';
import { LANGUAGES } from '../../db/seed';
import { decodeWav, encodeWav } from '../../lib/wav';
import { VOICES, synth, makeTake, pool } from './speech';
import { pickVariant, uniqueCopy, type AudioVariant } from './audio';
import type { Rng } from './rng';

export const STORM_CACHE = join(process.cwd(), 'results', 'storm-speech-cache');
const MANIFEST = join(STORM_CACHE, 'manifest.json');
export const PREPARE_PER_LANG = 60;
/** Minimum speech length of a storm reading; with ~0.7 s of room tone each side the take is >= 5 s and < 50% silent. */
const MIN_SPEECH_S = 4.0;
const TAKE_S = 5.15;
const wavSeconds = (path: string) => {
  const b = readFileSync(path);
  return (b.length - 44) / 2 / 48000; // 48 kHz 16-bit mono; header size difference is negligible here
};

/** Share of storm takes that read a different sentence of the same language (-> wrong_script on camera). */
export const WRONG_READING_SHARE = 0.05;

type Manifest = Record<string, Record<string, string>>; // lang -> body -> file name

export async function prepareStormSpeech(log: (s: string) => void = console.log): Promise<void> {
  const manifest: Manifest = existsSync(MANIFEST) ? JSON.parse(readFileSync(MANIFEST, 'utf8')) : {};
  const jobs: { lang: string; text: string; voice: string }[] = [];
  for (const lang of LANGUAGES) {
    const V = VOICES[lang];
    if (!V) { log(`[storm --prepare] ${lang}: no TTS voice on this machine; the storm uploads synthetic takes for it (QA's ${lang} policy reviews, never rejects)`); continue; }
    const bodies = [...new Set(scriptBodies(lang, PREPARE_PER_LANG))];
    bodies.forEach((text, i) => jobs.push({ lang, text, voice: V[i % V.length] }));
  }
  const t0 = Date.now();
  let done = 0;
  await pool(jobs, 6, async (j) => {
    let path = await synth(join(STORM_CACHE, j.lang), { voice: j.voice, text: j.text }, 'wav48');
    // QA reviews takes under 5 s and takes over 50% silent, so a 2-3 s sentence can't just be padded:
    // read short ones slower (say -r, words per minute; ~180 is the default) to reach ~MIN_SPEECH_S.
    const d = wavSeconds(path);
    if (d < MIN_SPEECH_S) {
      const rate = Math.max(90, Math.round((180 * d) / (MIN_SPEECH_S + 0.2)));
      path = await synth(join(STORM_CACHE, j.lang), { voice: j.voice, rate, text: j.text }, 'wav48');
    }
    (manifest[j.lang] ??= {})[j.text] = path.slice(STORM_CACHE.length + 1);
    if (++done % 100 === 0) log(`[storm --prepare] ${done}/${jobs.length}`);
  });
  writeFileSync(MANIFEST, JSON.stringify(manifest, null, 1));
  // drop readings no longer referenced (e.g. the default-rate take of a sentence that was re-read slower)
  const keep = new Set(Object.values(manifest).flatMap((m) => Object.values(m)));
  for (const lang of Object.keys(manifest)) {
    for (const f of readdirSync(join(STORM_CACHE, lang))) if (!keep.has(`${lang}/${f}`)) rmSync(join(STORM_CACHE, lang, f));
  }
  log(`[storm --prepare] ${jobs.length} readings ready in ${STORM_CACHE} (${((Date.now() - t0) / 1000).toFixed(0)} s)`);
}

export type TakeFor = (rng: Rng, language: string | undefined, body: string | undefined) => { kind: string; durationS: number; wav: Buffer };

/**
 * Returns a take generator for the simulator, or null when nothing was prepared. Mix per take:
 * 5% silent, 3% clipped, 3% too short (the synthetic variants, as before), 5% a reading of a
 * different sentence, the rest the right sentence. Every take gets fresh room tone, a random lead /
 * trail and level, and one quieter 1.5 s stretch, so QA's duplicate and near-duplicate checks see
 * distinct takes even when the same sentence is read twice. Languages without a voice (Swahili) and
 * bodies outside the cache fall back to the synthetic variants.
 */
export function loadStormSpeech(variants: AudioVariant[]): { takeFor: TakeFor; languages: string[]; missing: string[] } | null {
  if (!existsSync(MANIFEST)) return null;
  const manifest: Manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'));
  const missing = LANGUAGES.filter((l) => !manifest[l]);
  const synthetic = (rng: Rng) => {
    const v = pickVariant(rng, variants);
    return { kind: v.kind, durationS: v.durationS, wav: uniqueCopy(rng, v) };
  };
  const takeFor: TakeFor = (rng, lang, body) => {
    const files = lang ? manifest[lang] : undefined;
    if (!files || !body || !files[body]) return synthetic(rng);
    const x = rng.next();
    if (x < 0.11) {
      // the same defect odds as pickVariant: 5% silent, 3% clipped, 3% too short
      const v = variants.find((a) => a.kind === (x < 0.05 ? 'silent' : x < 0.08 ? 'clipped' : 'short'))!;
      return { kind: v.kind, durationS: v.durationS, wav: uniqueCopy(rng, v) };
    }
    let kind = 'speech';
    let file = files[body];
    if (x < 0.11 + WRONG_READING_SHARE) {
      const others = Object.keys(files).filter((t) => t !== body);
      if (others.length) { file = files[rng.pick(others)]; kind = 'wrong_reading'; }
    }
    const pcm = decodeWav(readFileSync(join(STORM_CACHE, file)));
    const sr = pcm.sampleRate;
    const dur = pcm.samples.length / sr;
    // >= ~5.4 s in total (QA reviews takes under 5 s), each edge <= 3 s (QA's padding rule), mostly speech
    const pad = Math.min(2.4, Math.max(0.4, (TAKE_S - dur) / 2));
    const s = makeTake(pcm.samples, sr, rng, { leadS: pad + rng.uniform(0, 0.15), trailS: pad + rng.uniform(0, 0.15), levelDb: rng.uniform(-26, -19) });
    const len = Math.round(1.5 * sr);
    const start = rng.int(Math.max(1, s.length - len));
    for (let i = start; i < Math.min(s.length, start + len); i++) s[i] *= 0.7;
    return { kind, durationS: s.length / sr, wav: encodeWav({ sampleRate: sr, samples: s }) };
  };
  return { takeFor, languages: Object.keys(manifest), missing };
}
