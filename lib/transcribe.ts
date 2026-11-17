// Speech-to-text for the script check, via a whisper.cpp server (`npm run whisper`).
// QA must never get stuck on the transcriber: every failure (unset, down, slow, bad reply) returns
// null after one retry, and the take is decided on the audio checks alone (the skip is recorded in
// its checks, see lib/qa.ts).
import { decodeWav, encodeWav, type Pcm } from './wav';
import { deflateRawSync } from 'node:zlib';
import { config } from './config';

export type Transcript = { text: string; ms: number };
export type Transcriber = (wav: Buffer, language: string) => Promise<Transcript | null>;

/** Whisper's input format. Sending it ready-made means the server needs no ffmpeg (--convert). */
export const WHISPER_RATE = 16000;

/**
 * Band-limited resampling (windowed sinc, Hann window, 8 zero crossings per side): 48 kHz -> 16 kHz
 * low-passes at ~7.6 kHz before decimating, so nothing above the new Nyquist folds back as noise.
 * Works for any ratio, up or down.
 */
export function resample(x: Float32Array, from: number, to: number): Float32Array {
  if (from === to) return x;
  const ratio = to / from;
  const n = Math.floor(x.length * ratio);
  const out = new Float32Array(n);
  const cutoff = Math.min(1, ratio) * 0.95; // fraction of the input Nyquist
  const zeros = 8;
  const width = Math.ceil(zeros / cutoff); // input samples each side
  for (let i = 0; i < n; i++) {
    const t = i / ratio;
    const c = Math.floor(t);
    let acc = 0, wsum = 0;
    for (let k = c - width + 1; k <= c + width; k++) {
      if (k < 0 || k >= x.length) continue;
      const d = t - k;
      const a = Math.PI * d * cutoff;
      const sinc = a === 0 ? 1 : Math.sin(a) / a;
      const win = 0.5 + 0.5 * Math.cos((Math.PI * d) / (width + 1));
      const w = sinc * win;
      acc += x[k] * w;
      wsum += w;
    }
    out[i] = wsum ? acc / wsum : 0; // normalized taps: unity gain at DC, edges included
  }
  return out;
}

/** Any 16-bit PCM WAV (lib/wav.ts) -> 16 kHz mono 16-bit WAV. */
export function toWhisperWav(wav: Buffer): Buffer {
  const pcm: Pcm = decodeWav(wav); // stereo is already averaged to mono
  return encodeWav({ sampleRate: WHISPER_RATE, samples: resample(pcm.samples, pcm.sampleRate, WHISPER_RATE) });
}

type Fetch = typeof fetch;

/**
 * Whisper's own "decoder failed" test: text that compresses better than 2.4x is a repetition loop
 * ("तो तो तो तो ..."). Greedy decoding loops like this on some takes in some languages (measured: Hindi).
 */
export function looksLooped(text: string): boolean {
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.length < 40) return false;
  return bytes.length / deflateRawSync(bytes).length > 2.4;
}

/**
 * Transcribe a take in the given language (ISO 639-1, as in scripts.language). Returns null when
 * WHISPER_URL is unset (check off) or the server failed twice. `opts` is for tests.
 *
 * Decoding: greedy at temperature 0 with Whisper's temperature fallback off (WHISPER_TEMPERATURE_INC=0),
 * because the server's fallback also fires on low confidence, which re-decoded every Bengali take
 * ~5x (2.5 s -> 7 s+). Only when the greedy text is a repetition loop do we decode once more at
 * temperature 0.4 (one pass, so the extra time is bounded). `ms` covers both calls.
 */
export async function transcribe(
  wav: Buffer, language: string,
  opts: { url?: string; timeoutMs?: number; fetchImpl?: Fetch; retries?: number; temperatureInc?: number; loopRetry?: boolean } = {},
): Promise<Transcript | null> {
  const url = opts.url ?? config.whisperUrl();
  if (!url) return null;
  let body: Buffer;
  try {
    body = toWhisperWav(wav);
  } catch {
    return null; // undecodable audio: QA's own decode rejects it anyway
  }
  const f = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? config.whisperTimeoutMs();
  const attempts = 1 + (opts.retries ?? 1);
  const t0 = performance.now();
  const call = async (temperature: number, inc: number): Promise<string | null> => {
    for (let a = 0; a < attempts; a++) {
      try {
        const form = new FormData();
        form.append('file', new Blob([new Uint8Array(body)], { type: 'audio/wav' }), 'take.wav');
        form.append('language', language);
        form.append('response_format', 'json');
        form.append('temperature', String(temperature));
        form.append('temperature_inc', String(inc));
        const r = await f(`${url}/inference`, { method: 'POST', body: form, signal: AbortSignal.timeout(timeoutMs) });
        if (!r.ok) throw new Error(`whisper ${r.status}`);
        const j = (await r.json()) as { text?: unknown; error?: unknown };
        if (typeof j.text !== 'string') throw new Error(`whisper reply without text: ${JSON.stringify(j).slice(0, 120)}`);
        return j.text.trim();
      } catch {
        // timeout, connection refused, 5xx, bad JSON: retry once, then give up
      }
    }
    return null;
  };
  let text = await call(0, opts.temperatureInc ?? config.whisperTemperatureInc());
  if (text === null) return null;
  if ((opts.loopRetry ?? true) && looksLooped(text)) {
    const again = await call(0.4, 0); // one sampled decode, not the 5-step ladder: bounded time
    if (again !== null && !looksLooped(again)) text = again;
  }
  return { text, ms: Math.round(performance.now() - t0) };
}
