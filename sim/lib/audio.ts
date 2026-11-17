// Speech-like test audio at a low sample rate, so uploads are ~360 KB instead of 17 MB.
// A set of variants is generated once (each from its own RNG draws) and reused; every upload then gets
// a few unique samples (different sha256) and a few random 1-3 s stretches at half level (different
// envelope fingerprint), so QA's duplicate / near-duplicate checks see distinct takes.
// Tuned against lib/checks.ts analyze(): normal takes pass, the defective ones fail for the right reason.
import { encodeWav } from '../../lib/wav';
import { makeRng, type Rng } from './rng';

export type AudioKind = 'normal' | 'silent' | 'clipped' | 'short';
export type AudioVariant = { kind: AudioKind; durationS: number; sampleRate: number; wav: Buffer };

/** Size of the same take at the production format (48 kHz 16-bit mono WAV). */
export const nominalBytes = (durationS: number) => 44 + Math.round(durationS * 48000) * 2;

const ROOM = 0.003; // room-tone noise amplitude (~ -55 dBFS RMS: "silent" to QA)

/** `durationS` total, including ~0.5 s of room tone at each end (real takes don't start/end mid-word). */
function speech(rng: Rng, sampleRate: number, durationS: number, gain: number): Float32Array {
  const n = Math.round(sampleRate * durationS);
  const pad = Math.round(sampleRate * rng.uniform(0.4, 0.8));
  const out = new Float32Array(n);
  // a voice-ish fundamental + harmonics below Nyquist, ~4 syllable humps/s, phrases of 1.5-4 s with 0.2-0.8 s gaps
  const f0 = rng.uniform(100, 230);
  const syll = rng.uniform(3.5, 5);
  const drift = rng.uniform(0.1, 0.5);
  let phase = 0;
  let phraseOn = true;
  let phraseLeft = rng.uniform(1.5, 4) * sampleRate;
  let phraseGain = rng.uniform(0.6, 1);
  for (let i = 0; i < n; i++) {
    const room = (rng.next() * 2 - 1) * ROOM;
    if (i < pad || i >= n - pad) { out[i] = room; continue; }
    if (--phraseLeft <= 0) {
      phraseOn = !phraseOn;
      phraseLeft = (phraseOn ? rng.uniform(1.5, 4) : rng.uniform(0.2, 0.8)) * sampleRate;
      phraseGain = rng.uniform(0.6, 1);
    }
    const t = i / sampleRate;
    const f = f0 * (1 + 0.05 * Math.sin(2 * Math.PI * drift * t));
    phase += (2 * Math.PI * f) / sampleRate;
    const voiced = 0.6 * Math.sin(phase) + 0.25 * Math.sin(2 * phase) + 0.15 * Math.sin(3 * phase);
    const env = phraseOn ? phraseGain * Math.abs(Math.sin(2 * Math.PI * (syll / 2) * t)) ** 0.7 : 0;
    out[i] = gain * env * (voiced + (rng.next() * 2 - 1) * 0.08) + room;
  }
  return out;
}

/**
 * `takeSeconds` overrides the take length (default: ~3-min takes, 165-200 s normals and 180 s silent/clipped).
 * The storm uses short 48 kHz takes (e.g. [10, 18]) so QA checks real-rate audio without GBs of uploads.
 */
export function makeVariants(seed: number, sampleRate = 1000, normals = 12, takeSeconds?: [number, number]): AudioVariant[] {
  const rng = makeRng(seed);
  const v: AudioVariant[] = [];
  const mk = (kind: AudioKind, d: number, gain: number) =>
    v.push({ kind, durationS: d, sampleRate, wav: encodeWav({ sampleRate, samples: speech(rng, sampleRate, d, gain) }) });
  const [lo, hi] = takeSeconds ?? [165, 200];
  const mid = takeSeconds ? Math.round((lo + hi) / 2) : 180;
  for (let k = 0; k < normals; k++) mk('normal', Math.round(rng.uniform(lo, hi)), rng.uniform(0.35, 0.6));
  mk('silent', mid, 0.002);
  mk('clipped', mid, 6);
  mk('short', 2.2, 0.5);
  return v;
}

/** 5% near-silent, 3% clipped, 3% too short (< 2.5 s), the rest normal. */
export function pickVariant(rng: Rng, variants: AudioVariant[]): AudioVariant {
  const x = rng.next();
  const of = (k: AudioKind) => variants.filter((a) => a.kind === k);
  if (x < 0.05) return of('silent')[0];
  if (x < 0.08) return of('clipped')[0];
  if (x < 0.11) return of('short')[0];
  return rng.pick(of('normal'));
}

/** Copy the buffer; perturb a few samples (new sha256) and halve 3 random 1-3 s stretches (new envelope). */
export function uniqueCopy(rng: Rng, v: AudioVariant): Buffer {
  const b = Buffer.from(v.wav);
  const samples = (b.length - 44) / 2;
  const clamp = (x: number) => Math.max(-32768, Math.min(32767, Math.round(x)));
  if (v.durationS >= 10) {
    for (let k = 0; k < 3; k++) {
      const len = Math.round(rng.uniform(1, 3) * v.sampleRate);
      const start = rng.int(Math.max(1, samples - len));
      for (let i = start; i < start + len; i++) b.writeInt16LE(clamp(b.readInt16LE(44 + 2 * i) * 0.5), 44 + 2 * i);
    }
  }
  for (let k = 0; k < 16; k++) {
    const i = 44 + 2 * rng.int(samples);
    b.writeInt16LE(clamp(b.readInt16LE(i) + (rng.int(5) - 2)), i);
  }
  return b;
}
