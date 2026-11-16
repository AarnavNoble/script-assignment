// Pure, framework-free WAV helpers for the browser recorder (no DOM, no Node APIs),
// so they can be checked with tsx against lib/wav.ts decodeWav.

export const TARGET_RATE = 48000;
/** 16-bit mono: 2 bytes per sample. 3 min at 48 kHz = 17,280,044 bytes. */
export const bytesPerSecond = (rate = TARGET_RATE) => rate * 2;

export function concatChunks(chunks: Float32Array[]): Float32Array {
  let len = 0;
  for (const c of chunks) len += c.length;
  const out = new Float32Array(len);
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.length; }
  return out;
}

/**
 * Linear-interpolation resampler, used only when the AudioContext can't run at 48 kHz
 * (the device rate is then e.g. 44.1 kHz). Good enough for speech; not band-limited.
 */
export function resampleLinear(input: Float32Array, fromRate: number, toRate: number): Float32Array {
  if (fromRate === toRate || input.length === 0) return input;
  const outLen = Math.max(1, Math.round((input.length * toRate) / fromRate));
  const out = new Float32Array(outLen);
  const step = fromRate / toRate;
  for (let i = 0; i < outLen; i++) {
    const pos = i * step;
    const i0 = Math.floor(pos);
    const i1 = Math.min(i0 + 1, input.length - 1);
    const t = pos - i0;
    out[i] = input[Math.min(i0, input.length - 1)] * (1 - t) + input[i1] * t;
  }
  return out;
}

/** Float32 samples in [-1, 1] -> 44-byte-header 16-bit PCM mono WAV. */
export function encodeWav(samples: Float32Array, sampleRate: number): ArrayBuffer {
  const dataBytes = samples.length * 2;
  const buf = new ArrayBuffer(44 + dataBytes);
  const v = new DataView(buf);
  const ascii = (off: number, s: string) => { for (let i = 0; i < s.length; i++) v.setUint8(off + i, s.charCodeAt(i)); };
  ascii(0, 'RIFF');
  v.setUint32(4, 36 + dataBytes, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  v.setUint32(16, 16, true);             // fmt chunk size
  v.setUint16(20, 1, true);              // PCM
  v.setUint16(22, 1, true);              // mono
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * 2, true); // byte rate
  v.setUint16(32, 2, true);              // block align
  v.setUint16(34, 16, true);             // bits per sample
  ascii(36, 'data');
  v.setUint32(40, dataBytes, true);
  let off = 44;
  for (let i = 0; i < samples.length; i++, off += 2) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    v.setInt16(off, s < 0 ? Math.round(s * 0x8000) : Math.round(s * 0x7fff), true);
  }
  return buf;
}

/** Chunks captured at `captureRate` -> a 48 kHz WAV (resampling only if needed). */
export function chunksToWav(chunks: Float32Array[], captureRate: number): { wav: ArrayBuffer; seconds: number; resampled: boolean } {
  const pcm = concatChunks(chunks);
  const resampled = captureRate !== TARGET_RATE;
  const out = resampled ? resampleLinear(pcm, captureRate, TARGET_RATE) : pcm;
  return { wav: encodeWav(out, TARGET_RATE), seconds: out.length / TARGET_RATE, resampled };
}
