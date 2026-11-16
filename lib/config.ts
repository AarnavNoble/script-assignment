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
  // pay rate per approved hour of audio, in cents
  payCentsPerHour: () => num('PAY_CENTS_PER_HOUR', 500),
};
