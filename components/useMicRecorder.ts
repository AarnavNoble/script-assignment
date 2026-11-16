'use client';
// Mic -> AudioWorklet (public/wav-worklet.js) -> Float32 blocks -> 48 kHz 16-bit mono WAV.
import { useCallback, useEffect, useRef, useState } from 'react';
import { chunksToWav, TARGET_RATE } from './wav';

export type RecState = 'idle' | 'starting' | 'recording' | 'stopping' | 'recorded' | 'error';

export type Take = { blob: Blob; url: string; seconds: number; bytes: number; captureRate: number; resampled: boolean };

/** What the browser actually gave us (it may ignore the "raw audio" constraints). */
export type MicInfo = { captureRate: number; echoCancellation?: boolean; noiseSuppression?: boolean; autoGainControl?: boolean; label?: string };

type Live = { stream: MediaStream; ctx: AudioContext; node: AudioWorkletNode; src: MediaStreamAudioSourceNode; chunks: Float32Array[]; frames: number; stopped: Promise<void> };

export function useMicRecorder(opts: { maxSeconds: number; onLevel?: (peak: number, rms: number) => void }) {
  const [state, setState] = useState<RecState>('idle');
  const [elapsed, setElapsed] = useState(0);
  const [take, setTake] = useState<Take | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mic, setMic] = useState<MicInfo | null>(null);
  const [clipped, setClipped] = useState(false);
  const live = useRef<Live | null>(null);
  const onLevel = useRef(opts.onLevel);
  onLevel.current = opts.onLevel;
  const stopRef = useRef<() => Promise<void>>(async () => {});

  const teardown = useCallback(async () => {
    const l = live.current;
    live.current = null;
    if (!l) return;
    try { l.src.disconnect(); l.node.disconnect(); } catch { /* already disconnected */ }
    l.stream.getTracks().forEach((t) => t.stop());
    await l.ctx.close().catch(() => {});
  }, []);

  const start = useCallback(async () => {
    setError(null);
    setClipped(false);
    setElapsed(0);
    setState('starting');
    let stream: MediaStream | null = null;
    let ctx: AudioContext | null = null;
    try {
      // Raw voice: no echo cancellation, noise suppression or automatic gain (they alter the data).
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      });
      let src: MediaStreamAudioSourceNode;
      try {
        ctx = new AudioContext({ sampleRate: TARGET_RATE });
        src = ctx.createMediaStreamSource(stream);
      } catch {
        // e.g. Firefox can't connect a mic to a context at a different rate: record at the device rate, resample later
        await ctx?.close().catch(() => {});
        ctx = new AudioContext();
        src = ctx.createMediaStreamSource(stream);
      }
      await ctx.audioWorklet.addModule('/wav-worklet.js');
      const node = new AudioWorkletNode(ctx, 'wav-capture', {
        numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1],
        channelCount: 1, channelCountMode: 'explicit', channelInterpretation: 'speakers',
      });
      const chunks: Float32Array[] = [];
      let resolveStopped!: () => void;
      const stopped = new Promise<void>((r) => { resolveStopped = r; });
      const l: Live = { stream, ctx, node, src, chunks, frames: 0, stopped };
      const rate = ctx.sampleRate;
      const maxFrames = opts.maxSeconds * rate;
      let shownQuarter = -1;
      node.port.onmessage = (e: MessageEvent) => {
        const m = e.data;
        if (m.type === 'chunk') {
          chunks.push(m.samples as Float32Array);
          l.frames += (m.samples as Float32Array).length;
          onLevel.current?.(m.peak, m.rms);
          if (m.peak >= 0.99) setClipped(true);
          const q = Math.floor((l.frames / rate) * 4);
          if (q !== shownQuarter) { shownQuarter = q; setElapsed(l.frames / rate); }
          if (l.frames >= maxFrames) void stopRef.current();
        } else if (m.type === 'stopped') resolveStopped();
      };
      src.connect(node);
      node.connect(ctx.destination); // outputs silence; keeps the node in the render graph
      await ctx.resume();
      const s = stream.getAudioTracks()[0]?.getSettings?.() ?? {};
      setMic({ captureRate: rate, echoCancellation: s.echoCancellation, noiseSuppression: s.noiseSuppression, autoGainControl: s.autoGainControl, label: stream.getAudioTracks()[0]?.label });
      live.current = l;
      setState('recording');
    } catch (e) {
      stream?.getTracks().forEach((t) => t.stop());
      await ctx?.close().catch(() => {});
      const name = (e as { name?: string }).name;
      setError(name === 'NotAllowedError' ? 'Microphone access was blocked. Allow it in the browser’s site settings and try again.'
        : name === 'NotFoundError' ? 'No microphone found.'
        : `Could not start recording: ${(e as Error).message}`);
      setState('error');
    }
  }, [opts.maxSeconds]);

  const stop = useCallback(async () => {
    const l = live.current;
    if (!l) return;
    setState('stopping');
    l.node.port.postMessage('stop');
    await Promise.race([l.stopped, new Promise((r) => setTimeout(r, 1000))]); // flush the last partial block
    const rate = l.ctx.sampleRate;
    const chunks = l.chunks;
    await teardown();
    const { wav, seconds, resampled } = chunksToWav(chunks, rate);
    const blob = new Blob([wav], { type: 'audio/wav' });
    setTake({ blob, url: URL.createObjectURL(blob), seconds, bytes: blob.size, captureRate: rate, resampled });
    setElapsed(seconds);
    setState('recorded');
  }, [teardown]);
  stopRef.current = stop;

  const discard = useCallback(() => {
    setTake((t) => { if (t) URL.revokeObjectURL(t.url); return null; });
    setElapsed(0);
    setClipped(false);
    setState('idle');
  }, []);

  // stop the mic if the component goes away mid-recording
  useEffect(() => () => { void teardown(); }, [teardown]);

  return { state, elapsed, take, error, mic, clipped, start, stop, discard };
}
