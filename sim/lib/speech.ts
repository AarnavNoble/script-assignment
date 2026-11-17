// Real speech for the script check: macOS `say` voices, converted with the built-in afconvert.
// Used by sim/script-eval.ts (evaluation) and sim/storm.ts --prepare (demo uploads). macOS only.
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { decodeWav, type Pcm } from '../../lib/wav';
import { resample } from '../../lib/transcribe';
import type { Rng } from './rng';

const run = promisify(execFile);

/**
 * Voices per language (`say -v '?'`). Several where the OS has them; one for hi, ar, bn, id, tr, vi, pl.
 * Swahili has none: callers fall back to synthetic audio and say so.
 */
export const VOICES: Record<string, string[]> = {
  en: ['Albert', 'Samantha', 'Daniel', 'Karen', 'Eddy (English (US))'],
  es: ['Mónica', 'Paulina', 'Eddy (Spanish (Spain))'],
  hi: ['Lekha'],
  pt: ['Luciana', 'Joana', 'Eddy (Portuguese (Brazil))'],
  fr: ['Jacques', 'Thomas', 'Amélie'],
  de: ['Anna', 'Eddy (German (Germany))', 'Flo (German (Germany))'],
  ar: ['Majed'],
  bn: ['Piya'],
  ja: ['Kyoko', 'Eddy (Japanese (Japan))', 'Flo (Japanese (Japan))'],
  ko: ['Yuna', 'Eddy (Korean (South Korea))', 'Flo (Korean (South Korea))'],
  id: ['Damayanti'],
  tr: ['Yelda'],
  vi: ['Linh'],
  it: ['Alice', 'Eddy (Italian (Italy))'],
  pl: ['Zosia'],
};

export type Format = 'wav48' | 'flac16';
const AFCONVERT: Record<Format, { args: string[]; ext: string }> = {
  wav48: { args: ['-f', 'WAVE', '-d', 'LEI16@48000', '-c', '1'], ext: 'wav' },
  // eval cache: lossless, ~half the size of a WAV; Whisper only uses 0-8 kHz anyway
  flac16: { args: ['-f', 'flac', '-d', 'flac@16000', '-c', '1'], ext: 'flac' },
};

export type SpeechKey = { voice: string; rate?: number; text: string };
export const speechId = (k: SpeechKey) => createHash('sha1').update(`${k.voice}|${k.rate ?? ''}|${k.text}`).digest('hex').slice(0, 16);

/** Synthesize once into `dir` (cached by voice + rate + text); returns the file path. */
export async function synth(dir: string, k: SpeechKey, fmt: Format): Promise<string> {
  const out = join(dir, `${speechId(k)}.${AFCONVERT[fmt].ext}`);
  if (existsSync(out)) return out;
  mkdirSync(dir, { recursive: true });
  const tmp = join(tmpdir(), `sa-say-${process.pid}-${speechId(k)}-${Math.random().toString(36).slice(2, 8)}`);
  try {
    writeFileSync(`${tmp}.txt`, k.text); // -f: no shell or argv quoting issues with quotes / dashes
    await run('say', ['-v', k.voice, ...(k.rate ? ['-r', String(k.rate)] : []), '-o', `${tmp}.aiff`, '-f', `${tmp}.txt`]);
    await run('afconvert', [...AFCONVERT[fmt].args, `${tmp}.aiff`, `${tmp}.${AFCONVERT[fmt].ext}`]);
    renameSync(`${tmp}.${AFCONVERT[fmt].ext}`, out); // atomic: a crash never leaves a half file in the cache
  } finally {
    for (const ext of ['txt', 'aiff', AFCONVERT[fmt].ext]) rmSync(`${tmp}.${ext}`, { force: true });
  }
  return out;
}

/** afconvert writes WAVE_FORMAT_EXTENSIBLE (0xFFFE); for 16-bit PCM that is plain PCM, which lib/wav.ts reads. */
function plainPcmHeader(b: Buffer): Buffer {
  let off = 12;
  while (off + 8 <= b.length) {
    const id = b.toString('ascii', off, off + 4);
    const size = b.readUInt32LE(off + 4);
    if (id === 'fmt ' && b.readUInt16LE(off + 8) === 0xfffe && b.readUInt16LE(off + 22) === 16) b.writeUInt16LE(1, off + 8);
    off += 8 + size + (size % 2);
  }
  return b;
}

/** Read a cached file back as PCM at `rate` (FLAC is decoded with afconvert, then resampled in TS). */
export async function loadPcm(path: string, rate: number): Promise<Float32Array> {
  let pcm: Pcm;
  if (path.endsWith('.flac')) {
    const tmp = join(tmpdir(), `sa-flac-${process.pid}-${Math.random().toString(36).slice(2, 10)}.wav`);
    try {
      await run('afconvert', ['-f', 'WAVE', '-d', 'LEI16@16000', '-c', '1', path, tmp]);
      pcm = decodeWav(plainPcmHeader(readFileSync(tmp)));
    } finally {
      rmSync(tmp, { force: true });
    }
  } else {
    pcm = decodeWav(plainPcmHeader(readFileSync(path)));
  }
  return resample(pcm.samples, pcm.sampleRate, rate);
}

const rms = (x: Float32Array) => {
  let s = 0;
  for (const v of x) s += v * v;
  return Math.sqrt(s / Math.max(1, x.length));
};

/** RMS over samples in frames that are speech (within 30 dB of the loudest 20 ms frame). */
export function speechRms(x: Float32Array, sr: number): number {
  const len = Math.round(sr * 0.02);
  const frames: number[] = [];
  for (let i = 0; i + len <= x.length; i += len) frames.push(rms(x.subarray(i, i + len)));
  const max = Math.max(0, ...frames);
  const act = frames.filter((f) => f > max * 0.0316);
  return act.length ? Math.sqrt(act.reduce((a, f) => a + f * f, 0) / act.length) : 0;
}

/**
 * Background noise at `snrDb` below the speech level: a mix of pink-ish noise (fan / traffic hum,
 * three one-pole low-passes) and a faint 100 Hz mains hum, starting at a random level ramp.
 */
export function addNoise(x: Float32Array, sr: number, snrDb: number, rng: Rng): Float32Array {
  const n = new Float32Array(x.length);
  let b1 = 0, b2 = 0, b3 = 0;
  const a1 = Math.exp(-2 * Math.PI * 4000 / sr), a2 = Math.exp(-2 * Math.PI * 800 / sr), a3 = Math.exp(-2 * Math.PI * 150 / sr);
  for (let i = 0; i < x.length; i++) {
    const w = rng.next() * 2 - 1;
    b1 = a1 * b1 + (1 - a1) * w;
    b2 = a2 * b2 + (1 - a2) * w;
    b3 = a3 * b3 + (1 - a3) * w;
    n[i] = 0.3 * w + b1 + 2 * b2 + 4 * b3 + 0.05 * Math.sin((2 * Math.PI * 100 * i) / sr);
  }
  const k = (speechRms(x, sr) / Math.max(1e-9, rms(n))) * 10 ** (-snrDb / 20);
  const out = new Float32Array(x.length);
  for (let i = 0; i < x.length; i++) out[i] = Math.max(-1, Math.min(1, x[i] + k * n[i]));
  return out;
}

/**
 * Turn a TTS clip into a browser-like take: room tone (~-62 dBFS, below QA's -50 dBFS silence gate)
 * before and after, gain to a speech level of `levelDb`. lead/trail in seconds.
 */
export function makeTake(x: Float32Array, sr: number, rng: Rng, o: { leadS: number; trailS: number; levelDb: number }): Float32Array {
  const lead = Math.round(o.leadS * sr), trail = Math.round(o.trailS * sr);
  const out = new Float32Array(lead + x.length + trail);
  const g = 10 ** (o.levelDb / 20) / Math.max(1e-9, speechRms(x, sr));
  const room = 0.0008 * Math.SQRT2; // uniform noise amplitude for ~-62 dBFS RMS
  for (let i = 0; i < out.length; i++) {
    const s = i >= lead && i < lead + x.length ? x[i - lead] * g : 0;
    out[i] = Math.max(-1, Math.min(1, s + (rng.next() * 2 - 1) * room));
  }
  return out;
}

/** First half of a sentence (by words; by characters for Japanese), for truncated readings. */
export function firstHalf(text: string, lang: string): string {
  if (lang === 'ja') {
    const chars = [...text];
    return chars.slice(0, Math.max(1, Math.floor(chars.length / 2))).join('');
  }
  const words = text.split(/\s+/).filter(Boolean);
  return words.slice(0, Math.max(1, Math.floor(words.length / 2))).join(' ');
}

/** Run `fn` over `items` with at most `n` in flight. */
export async function pool<T, R>(items: T[], n: number, fn: (x: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  }));
  return out;
}
