// AudioWorklet: captures raw PCM from the mic, mono, and posts it to the page in ~43 ms blocks
// (2048 frames at 48 kHz) together with the block's peak and RMS for the level meter.
// The page concatenates the blocks and encodes 16-bit WAV (components/wav.ts).
class WavCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.block = 2048;
    this.buf = new Float32Array(this.block);
    this.n = 0;
    this.peak = 0;
    this.sumSq = 0;
    this.running = true;
    this.port.onmessage = (e) => {
      if (e.data === 'stop') {
        this.flush();
        this.running = false;
        this.port.postMessage({ type: 'stopped' });
      }
    };
  }

  process(inputs) {
    if (!this.running) return false;
    const input = inputs[0];
    if (!input || input.length === 0) return true; // no input connected yet
    const chans = input.length;
    const frames = input[0].length;
    for (let i = 0; i < frames; i++) {
      // downmix to mono by averaging channels (usually there's only one)
      let s = 0;
      for (let c = 0; c < chans; c++) s += input[c][i];
      s /= chans;
      this.buf[this.n++] = s;
      const a = s < 0 ? -s : s;
      if (a > this.peak) this.peak = a;
      this.sumSq += s * s;
      if (this.n === this.block) this.flush();
    }
    return true;
  }

  flush() {
    if (this.n === 0) return;
    const samples = this.buf.slice(0, this.n);
    const rms = Math.sqrt(this.sumSq / this.n);
    this.port.postMessage({ type: 'chunk', samples, peak: this.peak, rms }, [samples.buffer]);
    this.n = 0;
    this.peak = 0;
    this.sumSq = 0;
  }
}

registerProcessor('wav-capture', WavCapture);
