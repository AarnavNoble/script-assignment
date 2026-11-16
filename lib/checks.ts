// Automatic audio QA. Pure: no I/O, no DB. lib/qa.ts feeds it decoded PCM and acts on the verdict.
//
// Every check maps to a common speech-data rejection reason
// ("inaudible, silent, truncated or distorted; padded, duplicated or lengthened"):
//   duration        -> truncated (too short) / lengthened (too long)
//   expected_length -> truncated / lengthened, relative to the script's word count
//   silence_ratio   -> silent
//   speech_level    -> inaudible
//   peak_level      -> inaudible (nothing ever gets loud)
//   clipping        -> distorted
//   padding_*       -> padded
//   longest_pause   -> lengthened / dead air in the middle
//   ends_abruptly   -> truncated (speech still going in the last frame)
//   (duplicate_audio is decided in lib/qa.ts with the sha256 / fingerprint computed here)
//
// Everything is measured in seconds or as ratios, never in samples, so a 1 kHz simulated file and
// a 48 kHz real one with the same content get the same verdict. The one per-sample quantity
// (clip run length) is converted from microseconds, see clipMinRunUs.
import { createHash } from 'node:crypto';
import type { Pcm } from './wav';
import type { Metrics } from './review';

/**
 * All QA thresholds in one place. "fail" = reject automatically, "review" = send to the human queue.
 * dBFS: 0 = digital full scale, -6 dB = half amplitude, -20 dB = a tenth.
 */
export const QA_THRESHOLDS = {
  /** Analysis frame. 20 ms is the standard speech frame: long enough for a stable RMS, short enough
   *  to resolve syllable gaps (syllables are ~150-250 ms). */
  frameMs: 20,

  /** A frame quieter than this (RMS) is silence. Room tone on a laptop/phone mic sits around
   *  -60..-50 dBFS; normal speech frames are -35..-12 dBFS. -50 leaves ~15 dB of headroom under quiet
   *  speech while still calling a typical quiet room "silent". */
  silenceDb: -50,

  /** Speech onset/offset needs this many consecutive non-silent frames (60 ms), so a single click
   *  or keyboard tap in the padding doesn't count as speech. */
  speechMinFrames: 3,

  duration: {
    /** < 3 s: not even one short sentence (the shortest seed script reads in ~5 s). Truncated/empty. */
    failBelowS: 3,
    /** 3-5 s: possible for a very short script, worth a human look. */
    reviewBelowS: 5,
    /** > 5 min: the exercise's scripts are ~3 min (17 MB WAV); 5 min is already 1.7x that. */
    reviewAboveS: 300,
    /** > 10 min: 58 MB at 48 kHz, above the 50 MB upload cap anyway, and no script is that long.
     *  Pay is per approved hour, so overly long audio is a direct "lengthened" cost. */
    failAboveS: 600,
  },

  /** Duration vs what the script should take at a normal reading rate (150 wpm = 2.5 words/s).
   *  Only checked when the caller passes expectedS (lib/qa.ts does so with QA_CHECK_SCRIPT_LENGTH=1).
   *  Review-only: reading speed varies ~2x between people, so neither direction is safe to
   *  auto-reject. */
  expectedLength: {
    wordsPerSecond: 2.5,
    /** < 0.5x: they skipped half the script, or it was cut off. */
    reviewBelowRatio: 0.5,
    /** > 3x: slower than any natural read; likely padding or repeated takes ("lengthened"). */
    reviewAboveRatio: 3,
  },

  silenceRatio: {
    /** >= 90% of frames silent: nothing was said (muted mic, wrong input, empty take). */
    failAbove: 0.9,
    /** 50-90%: read speech is normally 15-40% pauses; over half silent is suspicious but could be
     *  a slow, careful reader. */
    reviewAbove: 0.5,
  },

  /** RMS over non-silent frames only, so pauses don't drag it down. Datasets usually target
   *  -26..-18 dBFS for speech. */
  speechLevel: {
    /** < -45 dBFS: the "active" frames are barely above the silence gate, i.e. noise floor, not
     *  intelligible speech. Inaudible. */
    failBelowDb: -45,
    /** -45..-35 dBFS: quiet; ASR and listeners may struggle. A human decides. */
    reviewBelowDb: -35,
  },

  /** A normal take peaks at -12..-1 dBFS on plosives and stressed syllables. If nothing ever gets
   *  above -20 dBFS, the mic gain is far too low or the speaker is far away. Review-only (speech
   *  level is the real gate). */
  peakLevel: { reviewBelowDb: -20 },

  clipping: {
    /** |s| >= 0.99 counts as at full scale. 16-bit full scale is 0.99997; 0.99 also catches
     *  converters and limiters that saturate just below it. */
    level: 0.99,
    /** A clean peak passes through full scale for 1-2 samples; a clipped one sits flat on it. Runs
     *  lasting at least 60 us (3 samples at 48 kHz) count as clipping. Defined in time so the ratio
     *  means the same thing at any rate. Below ~25 kHz that rounds to 1 sample: one sample already
     *  spans >= 40 us, so a crest can't be told from a flat top and every pinned sample counts. */
    clipMinRunUs: 60,
    clipMinRunSamplesFloor: 1,
    /** >= 1% of samples clipped: audible distortion across the take. Reject as distorted. */
    failAboveRatio: 0.01,
    /** >= 0.1%: noticeable clipping on loud syllables. One plosive (~20 samples) in a 10 s take is
     *  0.004%, well under this, so a single pop passes. */
    reviewAboveRatio: 0.001,
  },

  padding: {
    /** > 3 s of silence before the first word or after the last: browser recordings normally have
     *  0.3-1.5 s at each end (press record, breathe, read; finish, press stop). */
    reviewAboveS: 3,
    /** >= 30 s of edge silence in total: no honest take has half a minute of dead air at the edges.
     *  Pay is per approved hour of audio, so this is the cheapest way to inflate pay. Reject as padded. */
    failTotalAboveS: 30,
  },

  /** Longest silent gap between the first and the last word. Paragraph pauses are 1-3 s; > 5 s of
   *  dead air mid-take means the reader stopped (or the take was stretched). Review-only. */
  longestPause: { reviewAboveS: 5 },

  /** A take whose last 100 ms is still speech at near-full level was probably cut off mid-word
   *  (stop pressed early, upload truncated). Review-only. */
  abruptEnd: { tailMs: 100, withinDbOfSpeech: 10 },

  /** Coarse near-duplicate fingerprint: 250 ms envelope frames, level relative to the loudest frame
   *  (so gain changes don't matter), quantized to 6 dB steps, floor at -36 dB. Same envelope =>
   *  same hash, even after resampling or a volume change. Not robust to trimming or added noise.
   *  Skipped under 5 s (20 frames): two people reading the same short sentence could collide. */
  fingerprint: { frameMs: 250, stepDb: 6, floorDb: -36, minDurationS: 5 },
} as const;

export type Thresholds = typeof QA_THRESHOLDS;

export type CheckStatus = 'pass' | 'warn' | 'fail';
export type Check = {
  name: string;
  value: number | string | null;
  unit?: string;
  status: CheckStatus;
  /** human-readable bands, e.g. "fail < 3; review < 5" */
  threshold: string;
  /** rejection/review reason code when status != pass */
  reason?: string;
};

export type Verdict = 'pass' | 'fail' | 'review';

export type AnalyzeOptions = {
  /** expected duration for this script, seconds (see expectedDurationS) */
  expectedS?: number;
  thresholds?: Thresholds;
};

export type Analysis = {
  metrics: Metrics & { checks: Check[] };
  verdict: Verdict;
  reasons: string[];
  /** extra measurements not stored in their own columns (also present inside checks) */
  detail: {
    activeRmsDb: number;
    leadingSilenceS: number;
    trailingSilenceS: number;
    longestPauseS: number;
    clipRuns: number;
    rawClipRatio: number;
    fingerprint: string | null;
  };
};

/** Expected reading time for a script body at the configured words-per-second. */
export function expectedDurationS(body: string, t: Thresholds = QA_THRESHOLDS): number {
  const words = body.trim().split(/\s+/).filter(Boolean).length;
  return words / t.expectedLength.wordsPerSecond;
}

const DB_FLOOR = -120; // instead of -Infinity for digital silence (JSON- and Postgres-safe)
const toDb = (x: number) => (x > 0 ? Math.max(DB_FLOOR, 20 * Math.log10(x)) : DB_FLOOR);
const r2 = (x: number) => Math.round(x * 100) / 100;
const r4 = (x: number) => Math.round(x * 10000) / 10000;

export function analyze(pcm: Pcm, opts: AnalyzeOptions = {}): Analysis {
  const t = opts.thresholds ?? QA_THRESHOLDS;
  const { sampleRate: sr, samples: x } = pcm;
  const n = x.length;
  const durationS = sr > 0 ? n / sr : 0;

  // ---- sample-level: peak, overall RMS, clipping runs
  const clipMinRun = Math.max(t.clipping.clipMinRunSamplesFloor, Math.round((sr * t.clipping.clipMinRunUs) / 1e6));
  let peak = 0;
  let sumSq = 0;
  let rawClipped = 0;
  let clippedInRuns = 0;
  let clipRuns = 0;
  let run = 0;
  const endRun = () => {
    if (run >= clipMinRun) { clippedInRuns += run; clipRuns++; }
    run = 0;
  };
  for (let i = 0; i < n; i++) {
    const a = Math.abs(x[i]);
    if (a > peak) peak = a;
    sumSq += x[i] * x[i];
    if (a >= t.clipping.level) { rawClipped++; run++; } else if (run) endRun();
  }
  endRun();
  const rmsDb = n ? toDb(Math.sqrt(sumSq / n)) : DB_FLOOR;
  const peakDb = toDb(peak);
  const clippingRatio = n ? clippedInRuns / n : 0;

  // ---- frame-level: silence, active-speech level, padding, pauses
  const frameLen = Math.max(1, Math.round((sr * t.frameMs) / 1000));
  const nFrames = Math.floor(n / frameLen);
  const frameDb = new Float64Array(nFrames);
  for (let f = 0; f < nFrames; f++) {
    let s = 0;
    for (let i = f * frameLen, end = i + frameLen; i < end; i++) s += x[i] * x[i];
    frameDb[f] = toDb(Math.sqrt(s / frameLen));
  }
  const silent = (f: number) => frameDb[f] < t.silenceDb;
  let silentFrames = 0;
  let activeSq = 0;
  let activeCount = 0;
  for (let f = 0; f < nFrames; f++) {
    if (silent(f)) silentFrames++;
    else { activeSq += 10 ** (frameDb[f] / 10); activeCount++; } // mean power of active frames
  }
  const silenceRatio = nFrames ? silentFrames / nFrames : 1;
  const activeRmsDb = activeCount ? toDb(Math.sqrt(activeSq / activeCount)) : DB_FLOOR;

  // speech = first/last run of >= speechMinFrames non-silent frames
  const k = t.speechMinFrames;
  const isOnset = (f: number) => { for (let j = 0; j < k; j++) if (f + j >= nFrames || silent(f + j)) return false; return true; };
  const isOffset = (f: number) => { for (let j = 0; j < k; j++) if (f - j < 0 || silent(f - j)) return false; return true; };
  let first = -1;
  for (let f = 0; f < nFrames; f++) if (isOnset(f)) { first = f; break; }
  let last = -1;
  for (let f = nFrames - 1; f >= 0; f--) if (isOffset(f)) { last = f; break; }
  const frameS = frameLen / sr;
  const hasSpeech = first >= 0 && last >= first;
  const leadingSilenceS = hasSpeech ? first * frameS : durationS;
  const trailingSilenceS = hasSpeech ? Math.max(0, durationS - (last + 1) * frameS) : 0;
  let longestPause = 0;
  if (hasSpeech) {
    let cur = 0;
    for (let f = first; f <= last; f++) {
      if (silent(f)) { cur++; if (cur > longestPause) longestPause = cur; } else cur = 0;
    }
  }
  const longestPauseS = longestPause * frameS;

  // abrupt end: the final tailMs still at speech level
  const tailFrames = Math.max(1, Math.round(t.abruptEnd.tailMs / t.frameMs));
  let tailPow = 0;
  for (let f = Math.max(0, nFrames - tailFrames); f < nFrames; f++) tailPow += 10 ** (frameDb[f] / 10);
  const tailDb = nFrames ? toDb(Math.sqrt(tailPow / Math.min(tailFrames, nFrames))) : DB_FLOOR;
  const endsAbruptly = hasSpeech && trailingSilenceS < t.abruptEnd.tailMs / 1000 && tailDb >= activeRmsDb - t.abruptEnd.withinDbOfSpeech;

  // ---- hashes
  const sha256 = createHash('sha256')
    .update(`${sr}:`)
    .update(Buffer.from(x.buffer, x.byteOffset, x.byteLength))
    .digest('hex');
  const fingerprint = durationS >= t.fingerprint.minDurationS ? envelopeFingerprint(x, sr, t) : null;

  // ---- checks
  const checks: Check[] = [];
  const add = (c: Check) => checks.push(c);
  const D = t.duration;

  add({
    name: 'duration', value: r2(durationS), unit: 's',
    status: durationS < D.failBelowS || durationS > D.failAboveS ? 'fail'
      : durationS < D.reviewBelowS || durationS > D.reviewAboveS ? 'warn' : 'pass',
    threshold: `fail < ${D.failBelowS} or > ${D.failAboveS}; review < ${D.reviewBelowS} or > ${D.reviewAboveS}`,
    reason: durationS < D.reviewBelowS ? 'too_short' : durationS > D.reviewAboveS ? 'too_long' : undefined,
  });

  if (opts.expectedS && opts.expectedS > 0) {
    const ratio = durationS / opts.expectedS;
    const E = t.expectedLength;
    add({
      name: 'expected_length', value: r2(ratio), unit: 'x expected',
      status: ratio < E.reviewBelowRatio || ratio > E.reviewAboveRatio ? 'warn' : 'pass',
      threshold: `review < ${E.reviewBelowRatio}x or > ${E.reviewAboveRatio}x of ${r2(opts.expectedS)} s`,
      reason: ratio < E.reviewBelowRatio ? 'truncated' : ratio > E.reviewAboveRatio ? 'lengthened' : undefined,
    });
  }

  const S = t.silenceRatio;
  add({
    name: 'silence_ratio', value: r4(silenceRatio),
    status: silenceRatio >= S.failAbove ? 'fail' : silenceRatio >= S.reviewAbove ? 'warn' : 'pass',
    threshold: `fail >= ${S.failAbove}; review >= ${S.reviewAbove} (frames < ${t.silenceDb} dBFS)`,
    reason: silenceRatio >= S.failAbove ? 'silent' : silenceRatio >= S.reviewAbove ? 'mostly_silent' : undefined,
  });

  // Speech level is meaningless when there's no speech; silence_ratio already failed in that case.
  const L = t.speechLevel;
  const levelApplies = silenceRatio < S.failAbove;
  add({
    name: 'speech_level', value: r2(activeRmsDb), unit: 'dBFS',
    status: !levelApplies ? 'pass' : activeRmsDb < L.failBelowDb ? 'fail' : activeRmsDb < L.reviewBelowDb ? 'warn' : 'pass',
    threshold: `fail < ${L.failBelowDb}; review < ${L.reviewBelowDb} (RMS of non-silent frames)`,
    reason: !levelApplies ? undefined : activeRmsDb < L.failBelowDb ? 'inaudible' : activeRmsDb < L.reviewBelowDb ? 'quiet' : undefined,
  });

  add({
    name: 'peak_level', value: r2(peakDb), unit: 'dBFS',
    status: levelApplies && peakDb < t.peakLevel.reviewBelowDb ? 'warn' : 'pass',
    threshold: `review < ${t.peakLevel.reviewBelowDb}`,
    reason: levelApplies && peakDb < t.peakLevel.reviewBelowDb ? 'quiet' : undefined,
  });

  const C = t.clipping;
  add({
    name: 'clipping', value: r4(clippingRatio), unit: 'ratio',
    status: clippingRatio >= C.failAboveRatio ? 'fail' : clippingRatio >= C.reviewAboveRatio ? 'warn' : 'pass',
    threshold: `fail >= ${C.failAboveRatio}; review >= ${C.reviewAboveRatio} (samples in runs >= ${clipMinRun} at |s| >= ${C.level})`,
    reason: clippingRatio >= C.failAboveRatio ? 'distorted' : clippingRatio >= C.reviewAboveRatio ? 'clipping' : undefined,
  });
  add({ name: 'clip_runs', value: clipRuns, status: 'pass', threshold: 'info only' });

  const P = t.padding;
  if (hasSpeech) {
    const total = leadingSilenceS + trailingSilenceS;
    const padFail = total >= P.failTotalAboveS;
    add({
      name: 'padding_leading', value: r2(leadingSilenceS), unit: 's',
      status: padFail ? 'fail' : leadingSilenceS > P.reviewAboveS ? 'warn' : 'pass',
      threshold: `review > ${P.reviewAboveS}; fail if leading + trailing >= ${P.failTotalAboveS}`,
      reason: padFail || leadingSilenceS > P.reviewAboveS ? 'padded' : undefined,
    });
    add({
      name: 'padding_trailing', value: r2(trailingSilenceS), unit: 's',
      status: padFail ? 'fail' : trailingSilenceS > P.reviewAboveS ? 'warn' : 'pass',
      threshold: `review > ${P.reviewAboveS}; fail if leading + trailing >= ${P.failTotalAboveS}`,
      reason: padFail || trailingSilenceS > P.reviewAboveS ? 'padded' : undefined,
    });
    add({
      name: 'longest_pause', value: r2(longestPauseS), unit: 's',
      status: longestPauseS > t.longestPause.reviewAboveS ? 'warn' : 'pass',
      threshold: `review > ${t.longestPause.reviewAboveS}`,
      reason: longestPauseS > t.longestPause.reviewAboveS ? 'long_pause' : undefined,
    });
    add({
      name: 'ends_abruptly', value: endsAbruptly ? 1 : 0,
      status: endsAbruptly ? 'warn' : 'pass',
      threshold: `review if last ${t.abruptEnd.tailMs} ms is within ${t.abruptEnd.withinDbOfSpeech} dB of speech level`,
      reason: endsAbruptly ? 'truncated' : undefined,
    });
  }

  // Stored in the checks list so the ops view and the near-duplicate lookup can both read it.
  add({ name: 'fingerprint', value: fingerprint, status: 'pass', threshold: 'info only (near-duplicate lookup)' });

  const fails = checks.filter((c) => c.status === 'fail');
  const warns = checks.filter((c) => c.status === 'warn');
  const verdict: Verdict = fails.length ? 'fail' : warns.length ? 'review' : 'pass';
  const reasons = [...new Set((fails.length ? fails : warns).map((c) => c.reason ?? c.name))];

  return {
    metrics: { durationS, silenceRatio, clippingRatio, peakDb, rmsDb, sha256, checks },
    verdict,
    reasons,
    detail: {
      activeRmsDb, leadingSilenceS, trailingSilenceS, longestPauseS, clipRuns,
      rawClipRatio: n ? rawClipped / n : 0, fingerprint,
    },
  };
}

/** Coarse envelope hash, see QA_THRESHOLDS.fingerprint. */
function envelopeFingerprint(x: Float32Array, sr: number, t: Thresholds): string {
  const F = t.fingerprint;
  const len = Math.max(1, Math.round((sr * F.frameMs) / 1000));
  const frames = Math.floor(x.length / len);
  const db: number[] = [];
  for (let f = 0; f < frames; f++) {
    let s = 0;
    for (let i = f * len, end = i + len; i < end; i++) s += x[i] * x[i];
    db.push(toDb(Math.sqrt(s / len)));
  }
  const max = Math.max(...db);
  const q = db.map((d) => Math.round(Math.max(F.floorDb, d - max) / F.stepDb));
  return createHash('sha256').update(q.join(',')).digest('hex').slice(0, 16);
}

/** Look up a check by name (for tests and the demo). */
export const check = (a: Analysis, name: string) => a.metrics.checks.find((c) => c.name === name);
