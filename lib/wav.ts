// Minimal 16-bit PCM mono WAV encode/decode. 3 min at 48 kHz = 17.3 MB, the size in the exercise.

export type Pcm = { sampleRate: number; samples: Float32Array }; // samples in [-1, 1]

export function encodeWav({ sampleRate, samples }: Pcm): Buffer {
  const dataBytes = samples.length * 2;
  const b = Buffer.alloc(44 + dataBytes);
  b.write('RIFF', 0, 'ascii');
  b.writeUInt32LE(36 + dataBytes, 4);
  b.write('WAVE', 8, 'ascii');
  b.write('fmt ', 12, 'ascii');
  b.writeUInt32LE(16, 16);          // fmt chunk size
  b.writeUInt16LE(1, 20);           // PCM
  b.writeUInt16LE(1, 22);           // mono
  b.writeUInt32LE(sampleRate, 24);
  b.writeUInt32LE(sampleRate * 2, 28); // byte rate
  b.writeUInt16LE(2, 32);           // block align
  b.writeUInt16LE(16, 34);          // bits per sample
  b.write('data', 36, 'ascii');
  b.writeUInt32LE(dataBytes, 40);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    b.writeInt16LE(s < 0 ? Math.round(s * 0x8000) : Math.round(s * 0x7fff), 44 + i * 2);
  }
  return b;
}

/** Decode 16-bit PCM WAV (mono, or stereo averaged to mono). Walks chunks, so extra chunks are fine. */
export function decodeWav(buf: Buffer): Pcm {
  if (buf.length < 12 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('not a RIFF/WAVE file');
  }
  let off = 12;
  let fmt: { channels: number; sampleRate: number; bits: number; format: number } | null = null;
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    const body = off + 8;
    if (id === 'fmt ') {
      fmt = { format: buf.readUInt16LE(body), channels: buf.readUInt16LE(body + 2), sampleRate: buf.readUInt32LE(body + 4), bits: buf.readUInt16LE(body + 14) };
    } else if (id === 'data') {
      if (!fmt) throw new Error('data chunk before fmt chunk');
      if (fmt.format !== 1 || fmt.bits !== 16) throw new Error(`unsupported WAV: format ${fmt.format}, ${fmt.bits}-bit`);
      const end = Math.min(buf.length, body + size);
      const frames = Math.floor((end - body) / (2 * fmt.channels));
      const samples = new Float32Array(frames);
      for (let i = 0; i < frames; i++) {
        let sum = 0;
        for (let ch = 0; ch < fmt.channels; ch++) sum += buf.readInt16LE(body + (i * fmt.channels + ch) * 2) / 0x8000;
        samples[i] = sum / fmt.channels;
      }
      return { sampleRate: fmt.sampleRate, samples };
    }
    off = body + size + (size % 2); // chunks are word-aligned
  }
  throw new Error('no data chunk');
}
