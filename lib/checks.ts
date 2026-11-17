// Automatic audio QA. Pure: no I/O, no DB. lib/qa.ts feeds it decoded PCM and acts on the verdict.
//
// Every check maps to a common speech-data rejection reason
// ("inaudible, silent, truncated or distorted; padded, duplicated or lengthened"):
//   duration        -> absolute floors / ceilings (< 1 s, > 10 min; < 2-3 s without script text)
//   expected_length -> truncated / lengthened, relative to the script's expected reading time
//   silence_ratio   -> silent (whole take) / mostly silent (between the first and last word)
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
    /** < 1 s: no sentence fits in a second (a one-word script would still have room tone around it). */
    failBelowS: 1,
    /** Without script text only (no expected length to compare against): < 2 s fails, < 3 s goes to
     *  review. Scripts are single sentences (~2-7 s of speech), so these sit below any real reading.
     *  With script text, "too short" is judged relative to the script instead (expectedLength). */
    noScript: { failBelowS: 2, reviewBelowS: 3 },
    /** > 5 min: the exercise's scripts are ~3 min (17 MB WAV); 5 min is already 1.7x that. */
    reviewAboveS: 300,
    /** > 10 min: 58 MB at 48 kHz, above the 50 MB upload cap anyway, and no script is that long.
     *  Pay is per approved hour, so overly long audio is a direct "lengthened" cost. */
    failAboveS: 600,
  },

  /** Speech length vs what the script should take (expectedDurationS). Measured on the speech span
   *  (first to last speech frame), so room tone at the ends doesn't count; padding has its own rule.
   *  On by default whenever lib/qa.ts has the script text (QA_CHECK_SCRIPT_LENGTH=0 turns it off).
   *  Calibration (results/script-check.md): macOS voices at their default rate read at ratio ~0.7,
   *  at 240 wpm ~0.55, at 140 wpm ~0.8; a half-sentence reading lands at ~0.35. */
  expectedLength: {
    /** Speaking rate in letters per second (graphemes with a letter or digit; no spaces or
     *  punctuation, so unspaced Japanese / Korean and agglutinative languages count the same way),
     *  measured on macOS voices at their default rate (median of 30 sentences per language)... */
    ttsLettersPerSecond: {
      en: 14.5, es: 15.7, hi: 6.9, pt: 12.3, fr: 16.8, de: 13.7, ar: 7.2, bn: 6.0, ja: 5.8, ko: 5.0,
      id: 12.1, tr: 11.9, vi: 11.0, it: 14.8, pl: 13.4,
      sw: 12.0, // no voice: assumed like Indonesian (Latin script, similar word structure)
    } as Record<string, number>,
    /** ...then slowed to a typical read-aloud pace: TTS reads English at 3.7 words/s, people at ~2.5
     *  (150 wpm), so x0.7. For English this reproduces the old 2.5 words/s constant. */
    humanFactor: 0.7,
    /** Unknown language: a middle-of-the-range rate. */
    fallbackLettersPerSecond: 12,
    /** < 0.3x: 3x faster than a typical reader. Nobody reads a whole sentence that fast: truncated or skipped. */
    failBelowRatio: 0.3,
    /** < 0.4x: a very fast reader or a cut-off take; a person checks (unless the script check heard the whole script, see lib/qa.ts). */
    reviewBelowRatio: 0.4,
    /** > 3x: slower than any natural read; likely repeated takes or stretched audio ("lengthened"). */
    reviewAboveRatio: 3,
    /** > 6x: a 4 s sentence spread over 25 s of speech: lengthened to inflate pay. */
    failAboveRatio: 6,
  },

  silenceRatio: {
    /** >= 90% of the whole take silent: nothing was said (muted mic, wrong input, empty take). */
    failAbove: 0.9,
    /** Review when >= 50% of the SPEECH SPAN (first to last word) is silent: read speech is normally
     *  15-40% pauses. Measured inside the span because a one-sentence take is mostly room tone at the
     *  ends (1 s + 3 s of speech + 1 s is 40% silent before any pause); edge silence is the padding rule's job. */
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

const letterSeg = typeof Intl !== 'undefined' && 'Segmenter' in Intl ? new Intl.Segmenter('und', { granularity: 'grapheme' }) : null;
/** Letters in a script: grapheme clusters containing a letter or digit (spaces, punctuation excluded). */
export function scriptLetters(body: string): number {
  const s = body.normalize('NFC');
  const gs = letterSeg ? [...letterSeg.segment(s)].map((g) => g.segment) : [...s];
  return gs.filter((g) => /[\p{L}\p{N}]/u.test(g)).length;
}

/** Expected speech time for a script at a typical read-aloud pace, seconds (see QA_THRESHOLDS.expectedLength). */
export function expectedDurationS(body: string, language = 'en', t: Thresholds = QA_THRESHOLDS): number {
  const E = t.expectedLength;
  const lps = (E.ttsLettersPerSecond[language] ?? E.fallbackLettersPerSecond) * E.humanFactor;
  return scriptLetters(body) / lps;
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

  // Too short: relative to the script when there is one (expected_length), else absolute floors.
  const hasScript = !!(opts.expectedS && opts.expectedS > 0);
  const shortFail = hasScript ? D.failBelowS : D.noScript.failBelowS;
  const shortReview = hasScript ? D.failBelowS : D.noScript.reviewBelowS;
  add({
    name: 'duration', value: r2(durationS), unit: 's',
    status: durationS < shortFail || durationS > D.failAboveS ? 'fail'
      : durationS < shortReview || durationS > D.reviewAboveS ? 'warn' : 'pass',
    threshold: `fail < ${shortFail} or > ${D.failAboveS}; review ${shortReview > shortFail ? `< ${shortReview} or ` : ''}> ${D.reviewAboveS}${hasScript ? ' (short: see expected_length)' : ' (no script text)'}`,
    reason: durationS < shortReview ? 'too_short' : durationS > D.reviewAboveS ? 'too_long' : undefined,
  });

  if (hasScript && hasSpeech) { // no speech: silence_ratio already fails it
    // speech span: first to last speech frame (the whole take if no speech was found)
    const spanS = hasSpeech ? Math.max(0, durationS - leadingSilenceS - trailingSilenceS) : 0;
    const ratio = spanS / opts.expectedS!;
    const E = t.expectedLength;
    const short = ratio < E.reviewBelowRatio, long = ratio > E.reviewAboveRatio;
    add({
      name: 'expected_length', value: r2(ratio), unit: 'x expected',
      status: ratio < E.failBelowRatio || ratio > E.failAboveRatio ? 'fail' : short || long ? 'warn' : 'pass',
      threshold: `speech ${r2(spanS)} s vs ${r2(opts.expectedS!)} s expected: fail < ${E.failBelowRatio}x or > ${E.failAboveRatio}x; review < ${E.reviewBelowRatio}x or > ${E.reviewAboveRatio}x`,
      reason: short ? 'truncated' : long ? 'lengthened' : undefined,
    });
  }

  const S = t.silenceRatio;
  // pauses inside the speech span (first to last speech frame)
  let spanSilent = 0;
  if (hasSpeech) for (let f = first; f <= last; f++) if (silent(f)) spanSilent++;
  const internalSilence = hasSpeech ? spanSilent / (last - first + 1) : 1;
  const silentTake = silenceRatio >= S.failAbove;
  add({
    name: 'silence_ratio', value: r4(silenceRatio),
    status: silentTake ? 'fail' : internalSilence >= S.reviewAbove ? 'warn' : 'pass',
    threshold: `fail >= ${S.failAbove} of the take; review >= ${S.reviewAbove} of the speech span (now ${r2(internalSilence)}) (frames < ${t.silenceDb} dBFS)`,
    reason: silentTake ? 'silent' : internalSilence >= S.reviewAbove ? 'mostly_silent' : undefined,
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
