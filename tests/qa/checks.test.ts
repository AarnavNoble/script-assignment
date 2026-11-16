import { describe, it, expect } from 'vitest';
import { analyze, check, expectedDurationS, QA_THRESHOLDS } from '@/lib/checks';
import { decodeWav, encodeWav } from '@/lib/wav';
import { speech, noiseOnly, variants } from './synth';

// Round-trip through the real 16-bit WAV codec so tests see what the worker sees.
const viaWav = (p: ReturnType<typeof speech>) => decodeWav(encodeWav(p));

describe('analyze() on synthetic signals (48 kHz)', () => {
  const v = variants(48000);
  const run = (name: string) => analyze(viaWav(v[name].pcm), { expectedS: v[name].expectedS });

  it('normal speech-like audio passes with sane metrics', () => {
    const a = run('normal');
    expect(a.verdict).toBe('pass');
    expect(a.reasons).toEqual([]);
    expect(a.metrics.durationS).toBeCloseTo(11.1, 1);
    expect(a.metrics.silenceRatio).toBeGreaterThan(0.1);
    expect(a.metrics.silenceRatio).toBeLessThan(0.4);
    expect(a.detail.activeRmsDb).toBeGreaterThan(-21);
    expect(a.detail.activeRmsDb).toBeLessThan(-19);
    expect(a.metrics.peakDb).toBeLessThan(-3);
    expect(a.metrics.clippingRatio).toBe(0);
    expect(a.metrics.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(a.metrics.checks.every((c) => c.status === 'pass')).toBe(true);
  });

  it('room tone only fails as silent', () => {
    const a = run('silent');
    expect(a.verdict).toBe('fail');
    expect(a.reasons).toEqual(['silent']);
    expect(a.metrics.silenceRatio).toBe(1);
  });

  it('digital zero fails as silent with finite dB values (safe for JSON/Postgres)', () => {
    const a = run('digital_zero');
    expect(a.verdict).toBe('fail');
    expect(a.reasons).toContain('silent');
    expect(Number.isFinite(a.metrics.peakDb)).toBe(true);
    expect(Number.isFinite(a.metrics.rmsDb)).toBe(true);
    expect(JSON.parse(JSON.stringify(a.metrics.checks))).toEqual(a.metrics.checks);
  });

  it('quiet speech (-40 dBFS) goes to review, not fail', () => {
    const a = run('quiet');
    expect(a.verdict).toBe('review');
    expect(a.reasons).toEqual(['quiet']);
    expect(check(a, 'speech_level')!.status).toBe('warn');
  });

  it('constant hiss above the silence gate but with no speech fails as inaudible', () => {
    const a = run('hiss_no_speech');
    expect(a.verdict).toBe('fail');
    expect(a.reasons).toContain('inaudible');
  });

  it('speech below the silence gate (-62 dBFS) fails as silent', () => {
    expect(run('whisper').reasons).toEqual(['silent']);
  });

  it('heavy clipping fails as distorted; mild clipping goes to review', () => {
    const heavy = run('clipped_heavy');
    expect(heavy.verdict).toBe('fail');
    expect(heavy.reasons).toEqual(['distorted']);
    expect(heavy.metrics.clippingRatio).toBeGreaterThan(QA_THRESHOLDS.clipping.failAboveRatio);
    const mild = run('clipped_mild');
    expect(mild.verdict).toBe('review');
    expect(mild.reasons).toEqual(['clipping']);
  });

  it('a few loud clean peaks touching full scale are not clipping', () => {
    const p = speech({ seed: 3 });
    // 5 single-sample spikes at full scale, plus one 2-sample crest
    for (const i of [60000, 120000, 200000, 300000, 400000]) p.samples[i] = 1;
    p.samples[450000] = 0.995; p.samples[450001] = 0.995;
    const a = analyze(viaWav(p));
    expect(a.detail.rawClipRatio).toBeGreaterThan(0);
    expect(a.metrics.clippingRatio).toBe(0);
    expect(check(a, 'clip_runs')!.value).toBe(0);
    expect(a.verdict).toBe('pass');
  });

  it('too short fails; 3-5 s goes to review', () => {
    expect(run('too_short')).toMatchObject({ verdict: 'fail', reasons: ['too_short'] });
    expect(run('short_borderline')).toMatchObject({ verdict: 'review', reasons: ['too_short'] });
  });

  it('too long fails (> 10 min)', () => {
    const a = analyze(noiseOnly({ sr: 1000, seconds: 601, levelDb: -20 }));
    expect(check(a, 'duration')).toMatchObject({ status: 'fail', reason: 'too_long' });
  });

  it('long leading/trailing padding goes to review; 40 s of padding fails', () => {
    const p = run('padded');
    expect(p.verdict).toBe('review');
    expect(p.reasons).toContain('padded');
    expect(p.detail.leadingSilenceS).toBeCloseTo(5, 0);
    expect(p.detail.trailingSilenceS).toBeGreaterThan(5);
    const h = run('padded_heavy');
    expect(h.verdict).toBe('fail');
    expect(h.reasons).toEqual(['padded']);
  });

  it('a click in the padding does not count as speech onset', () => {
    const p = speech({ lead: 5, trail: 0.6, seed: 4 });
    for (let i = 48000; i < 48000 + 48; i++) p.samples[i] = 0.5; // 1 ms click at t = 1 s
    const a = analyze(viaWav(p));
    expect(a.detail.leadingSilenceS).toBeCloseTo(5, 0);
  });

  it('dead air in the middle goes to review as long_pause', () => {
    const a = run('long_pause');
    expect(a.verdict).toBe('review');
    expect(a.reasons).toContain('long_pause');
    expect(a.detail.longestPauseS).toBeGreaterThan(8);
  });

  it('speech running into the last frame goes to review as truncated', () => {
    const a = run('cut_off');
    expect(a.verdict).toBe('review');
    expect(a.reasons).toEqual(['truncated']);
  });

  it('much longer than the script needs goes to review as lengthened', () => {
    const a = run('lengthened');
    expect(a.verdict).toBe('review');
    expect(a.reasons).toEqual(['lengthened']);
    // and without an expected length the same audio passes
    expect(analyze(v.lengthened.pcm).verdict).toBe('pass');
  });

  it('expectedDurationS uses 2.5 words/s', () => {
    expect(expectedDurationS('one two three four five')).toBe(2);
    expect(expectedDurationS('  ')).toBe(0);
  });

  it('every check row has name/status/threshold, and fail reasons outrank warn reasons', () => {
    const a = analyze(speech({ seconds: 1.5, lead: 0.2, trail: 0.2, levelDb: -40 })); // short + quiet
    for (const c of a.metrics.checks) {
      expect(typeof c.name).toBe('string');
      expect(['pass', 'warn', 'fail']).toContain(c.status);
      expect(typeof c.threshold).toBe('string');
    }
    expect(a.verdict).toBe('fail');
    expect(a.reasons).toEqual(['too_short']); // 'quiet' (a warn) is not listed under a fail
  });
});

describe('sample-rate independence', () => {
  const at48 = variants(48000);
  const at1 = variants(1000);
  for (const name of Object.keys(at48)) {
    it(`${name}: 1 kHz and 48 kHz give the same verdict and reasons`, () => {
      const a = analyze(viaWav(at48[name].pcm), { expectedS: at48[name].expectedS });
      const b = analyze(viaWav(at1[name].pcm), { expectedS: at1[name].expectedS });
      expect(b.verdict).toBe(a.verdict);
      expect(b.reasons).toEqual(a.reasons);
      expect(b.metrics.durationS).toBeCloseTo(a.metrics.durationS, 2);
      expect(Math.abs(b.metrics.silenceRatio - a.metrics.silenceRatio)).toBeLessThan(0.03);
    });
  }
});

describe('hashes', () => {
  it('sha256 is identical for identical audio and differs for different audio', () => {
    const a = analyze(viaWav(speech({ seed: 1 })));
    const b = analyze(viaWav(speech({ seed: 1 })));
    const c = analyze(viaWav(speech({ seed: 2 })));
    expect(a.metrics.sha256).toBe(b.metrics.sha256);
    expect(a.metrics.sha256).not.toBe(c.metrics.sha256);
  });

  it('fingerprint survives a volume change and resampling, but not different content', () => {
    const base = analyze(viaWav(speech({ seed: 1 })));
    const louder = analyze(viaWav(speech({ seed: 1, levelDb: -17 })));
    // 48 kHz -> 16 kHz by averaging each 3 samples (a real resampled copy of the same take)
    const src = speech({ seed: 1 }).samples;
    const down = new Float32Array(Math.floor(src.length / 3));
    for (let i = 0; i < down.length; i++) down[i] = (src[3 * i] + src[3 * i + 1] + src[3 * i + 2]) / 3;
    const resampled = analyze(viaWav({ sampleRate: 16000, samples: down }));
    const other = analyze(viaWav(speech({ seed: 2 })));
    expect(louder.metrics.sha256).not.toBe(base.metrics.sha256);
    expect(louder.detail.fingerprint).toBe(base.detail.fingerprint);
    expect(resampled.detail.fingerprint).toBe(base.detail.fingerprint);
    expect(other.detail.fingerprint).not.toBe(base.detail.fingerprint);
  });
});
