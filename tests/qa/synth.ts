// Deterministic synthetic "speech" for QA tests and scripts/qa-demo.ts.
// Speech-like = a voiced harmonic tone (f0 ~140 Hz, harmonics up to 420 Hz so it survives 1 kHz
// sampling) plus low-passed noise, shaped by a 4 Hz syllable envelope with phrase pauses, over a
// -65 dBFS room-tone floor. Everything is defined in seconds, so 1 kHz and 48 kHz renders have the
// same content.
import type { Pcm } from '@/lib/wav';

export type SpeechOpts = {
  sr?: number;
  /** seconds of speech (excluding lead/trail) */
  seconds?: number;
  /** RMS of the speech part, dBFS */
  levelDb?: number;
  /** silence before / after the speech, seconds */
  lead?: number;
  trail?: number;
  /** multiply after leveling, then hard-clip to [-1, 1] (gain > 1 => clipping) */
  gain?: number;
  /** insert a silent gap of this many seconds in the middle */
  midGapS?: number;
  /** room-tone floor, dBFS (null = digital silence) */
  floorDb?: number | null;
  seed?: number;
};

export function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const db = (d: number) => 10 ** (d / 20);

export function speech(o: SpeechOpts = {}): Pcm {
  const sr = o.sr ?? 48000;
  const seconds = o.seconds ?? 10;
  const lead = o.lead ?? 0.5;
  const trail = o.trail ?? 0.6;
  const midGap = o.midGapS ?? 0;
  const rand = rng(o.seed ?? 1);
  const total = Math.round((lead + seconds + midGap + trail) * sr);
  const out = new Float32Array(total);

  // per-syllable amplitude (4 syllables/s), so the envelope isn't perfectly periodic
  const syl = Array.from({ length: Math.ceil(seconds * 4) + 1 }, () => 0.5 + 0.5 * rand());
  const speechStart = Math.round(lead * sr);
  const half = seconds / 2;
  // one-pole low-pass for the noise part, time constant fixed in seconds (~500 Hz)
  const alpha = Math.exp(-1 / (sr * 0.0003));
  let lp = 0;
  let sumSq = 0;
  let count = 0;
  for (let i = 0; i < Math.round((seconds + midGap) * sr); i++) {
    let ts = i / sr; // time within speech, gap excluded
    if (midGap && ts >= half) {
      if (ts < half + midGap) continue;
      ts -= midGap;
    }
    // phrase pause: 0.4 s of silence every 2.5 s of speech
    const inPhrase = ts % 2.5 < 2.1;
    const env = inPhrase ? Math.abs(Math.sin(2 * Math.PI * 2 * ts)) ** 0.7 * syl[Math.floor(ts * 4)] : 0;
    const f0 = 140 + 10 * Math.sin(2 * Math.PI * 0.5 * ts);
    const ph = 2 * Math.PI * f0 * ts;
    const voiced = Math.sin(ph) + 0.5 * Math.sin(2 * ph) + 0.3 * Math.sin(3 * ph);
    lp = alpha * lp + (1 - alpha) * (rand() * 2 - 1);
    const v = env * (0.7 * voiced + 0.3 * lp * 4);
    const idx = speechStart + i;
    out[idx] = v;
    if (inPhrase) { sumSq += v * v; count++; }
  }
  const scale = count ? db(o.levelDb ?? -20) / Math.sqrt(sumSq / count) : 0;
  const gain = o.gain ?? 1;
  const floor = o.floorDb === null ? 0 : db(o.floorDb ?? -65) * Math.sqrt(3); // uniform noise RMS = a/sqrt(3)
  for (let i = 0; i < total; i++) {
    const v = out[i] * scale * gain + (rand() * 2 - 1) * floor;
    out[i] = Math.max(-1, Math.min(1, v));
  }
  return { sampleRate: sr, samples: out };
}

/** Room tone / hiss only, no speech. */
export function noiseOnly(o: { sr?: number; seconds?: number; levelDb?: number; seed?: number } = {}): Pcm {
  const sr = o.sr ?? 48000;
  const rand = rng(o.seed ?? 7);
  const a = db(o.levelDb ?? -65) * Math.sqrt(3);
  const out = new Float32Array(Math.round((o.seconds ?? 10) * sr));
  for (let i = 0; i < out.length; i++) out[i] = (rand() * 2 - 1) * a;
  return { sampleRate: sr, samples: out };
}

/** Named variants used by the tests and the demo. */
export function variants(sr = 48000): Record<string, { pcm: Pcm; expectedS?: number }> {
  return {
    normal: { pcm: speech({ sr }) },
    silent: { pcm: noiseOnly({ sr }) },
    digital_zero: { pcm: { sampleRate: sr, samples: new Float32Array(sr * 10) } },
    quiet: { pcm: speech({ sr, levelDb: -40 }) },
    hiss_no_speech: { pcm: noiseOnly({ sr, levelDb: -47 }) },
    whisper: { pcm: speech({ sr, levelDb: -62 }) },
    clipped_heavy: { pcm: speech({ sr, gain: 25 }) },
    clipped_mild: { pcm: speech({ sr, levelDb: -12, gain: 1.4 }) },
    too_short: { pcm: speech({ sr, seconds: 1.5, lead: 0.2, trail: 0.2 }) },
    short_borderline: { pcm: speech({ sr, seconds: 3.5, lead: 0.3, trail: 0.4 }) },
    padded: { pcm: speech({ sr, lead: 5, trail: 5 }) },
    padded_heavy: { pcm: speech({ sr, lead: 20, trail: 20 }) },
    long_pause: { pcm: speech({ sr, midGapS: 8 }) },
    cut_off: { pcm: speech({ sr, trail: 0, seconds: 10.1 }) },
    lengthened: { pcm: speech({ sr, seconds: 30 }), expectedS: 6 },
  };
}
