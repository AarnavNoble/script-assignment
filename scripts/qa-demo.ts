// npx tsx scripts/qa-demo.ts — run analyze() on synthetic variants at 48 kHz and 1 kHz, print verdicts.
import { analyze, check } from '../lib/checks';
import { variants } from '../tests/qa/synth';

const rows: Record<string, string | number>[] = [];
for (const sr of [48000, 1000]) {
  for (const [name, { pcm, expectedS }] of Object.entries(variants(sr))) {
    const a = analyze(pcm, { expectedS });
    rows.push({
      variant: name,
      kHz: sr / 1000,
      verdict: a.verdict,
      reasons: a.reasons.join(',') || '-',
      dur_s: a.metrics.durationS.toFixed(1),
      silence: a.metrics.silenceRatio.toFixed(2),
      speech_dB: a.detail.activeRmsDb.toFixed(1),
      peak_dB: a.metrics.peakDb.toFixed(1),
      clip: a.metrics.clippingRatio.toFixed(4),
      lead_s: a.detail.leadingSilenceS.toFixed(1),
      trail_s: a.detail.trailingSilenceS.toFixed(1),
      pause_s: a.detail.longestPauseS.toFixed(1),
      abrupt: String(check(a, 'ends_abruptly')?.value ?? '-'),
    });
  }
}

const cols = Object.keys(rows[0]);
const w = cols.map((c) => Math.max(c.length, ...rows.map((r) => String(r[c]).length)));
const line = (vals: string[]) => '| ' + vals.map((v, i) => v.padEnd(w[i])).join(' | ') + ' |';
console.log(line(cols));
console.log('|' + w.map((x) => '-'.repeat(x + 2)).join('|') + '|');
for (const r of rows) console.log(line(cols.map((c) => String(r[c]))));
