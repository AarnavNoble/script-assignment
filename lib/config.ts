// Read config per call (not at import) so tests and the time-scaled simulation can change it.
function num(name: string, fallback: number): number {
  const v = process.env[name];
  const n = v === undefined || v === '' ? NaN : Number(v);
  return Number.isFinite(n) ? n : fallback;
}

export const config = {
  leaseSeconds: () => num('LEASE_SECONDS', 600),
  heartbeatSeconds: () => num('HEARTBEAT_SECONDS', 30),
  jobIntervalSeconds: () => num('JOB_INTERVAL_SECONDS', 300),
  forecastWindowSeconds: () => num('FORECAST_WINDOW_SECONDS', 3600),
  lowPoolAlertHours: () => num('LOW_POOL_ALERT_HOURS', 2),
  orphanAgeSeconds: () => num('ORPHAN_AGE_SECONDS', 3600),
  maxUploadBytes: () => num('MAX_UPLOAD_BYTES', 50 * 1024 * 1024),
  uploadUrlSeconds: () => num('UPLOAD_URL_SECONDS', 900),
  // soft release: a released lease ends this many seconds later unless a still-open client heartbeats it
  releaseGraceSeconds: () => num('RELEASE_GRACE_SECONDS', 1.5 * num('HEARTBEAT_SECONDS', 30)),
  // sample rates QA accepts (the recorder produces 48 kHz); anything else is a wrong-format take
  acceptedSampleRates: () => (process.env.ACCEPTED_SAMPLE_RATES ?? '48000').split(',').map(Number).filter((n) => n > 0),
  // claim order: 'fresh_first' (default: never-held scripts before expired leases, so a stalled contributor
  // can still submit late; see results/experiments.md) or 'lowest_id' (expired leases re-taken first)
  claimOrder: () => (process.env.CLAIM_ORDER === 'lowest_id' ? 'lowest_id' : 'fresh_first') as 'lowest_id' | 'fresh_first',
  // pay rate per approved hour of audio, in cents
  payCentsPerHour: () => num('PAY_CENTS_PER_HOUR', 500),
  // script check (lib/transcribe.ts): whisper.cpp server base URL, e.g. http://127.0.0.1:8178.
  // Unset or empty = the check is off and QA behaves exactly as before.
  whisperUrl: () => (process.env.WHISPER_URL ?? '').replace(/\/+$/, ''),
  // per attempt; one retry after a failure. A 3-min take on ggml-small takes a few seconds.
  whisperTimeoutMs: () => num('WHISPER_TIMEOUT_MS', 30000),
  // Whisper's temperature fallback (server-side) for the first decode; see lib/transcribe.ts. Off by
  // default (0): it multiplied time per take ~5x on languages Whisper-small handles badly (Bengali)
  // and the script check only needs a rough match. See results/script-check.md.
  whisperTemperatureInc: () => num('WHISPER_TEMPERATURE_INC', 0),
};
