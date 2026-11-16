// Spawn a Next server for the simulation with its own dist dir, port and env; wait until it answers.
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, createWriteStream } from 'node:fs';
import { join } from 'node:path';

export type ServerMode = 'start' | 'dev' | 'external';

export type ServerHandle = { base: string; mode: ServerMode; stop: () => Promise<void> };

const NEXT_BIN = (root: string) => join(root, 'node_modules', 'next', 'dist', 'bin', 'next');

/** Build into distDir if there is no build there yet (or force). Note: `next build` also edits tsconfig.json / next-env.d.ts. */
export function buildIfNeeded(root: string, distDir: string, force = false): boolean {
  if (!force && existsSync(join(root, distDir, 'BUILD_ID'))) return false;
  console.log(`[sim] building Next into ${distDir} ...`);
  const r = spawnSync(process.execPath, [NEXT_BIN(root), 'build'], {
    cwd: root, env: { ...process.env, NEXT_DIST_DIR: distDir }, stdio: 'inherit',
  });
  if (r.status !== 0) throw new Error(`next build failed (exit ${r.status})`);
  return true;
}

export async function startServer(opts: {
  root: string; port: number; mode: ServerMode; distDir: string; env: Record<string, string>;
  logFile: string; baseUrl?: string; readyTimeoutMs?: number;
}): Promise<ServerHandle> {
  if (opts.mode === 'external') {
    const base = opts.baseUrl ?? `http://localhost:${opts.port}`;
    await waitReady(base, opts.readyTimeoutMs ?? 30000);
    return { base, mode: 'external', stop: async () => {} };
  }
  const base = `http://localhost:${opts.port}`;
  if (await isUp(base)) throw new Error(`something is already listening on ${base}; stop it or use --server external`);
  const args = [NEXT_BIN(opts.root), opts.mode, '-p', String(opts.port)];
  const log = createWriteStream(opts.logFile);
  const child: ChildProcess = spawn(process.execPath, args, {
    cwd: opts.root,
    env: { ...process.env, ...opts.env, NEXT_DIST_DIR: opts.distDir, NODE_ENV: opts.mode === 'dev' ? 'development' : 'production', NEXT_TELEMETRY_DISABLED: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true, // own process group, so we can kill next's workers too
  });
  child.stdout?.pipe(log);
  child.stderr?.pipe(log);
  let exited = false;
  child.on('exit', () => { exited = true; });
  const stop = async () => {
    if (exited) return;
    try { process.kill(-child.pid!, 'SIGTERM'); } catch { /* gone */ }
    const t = Date.now();
    while (!exited && Date.now() - t < 5000) await new Promise((r) => setTimeout(r, 100));
    if (!exited) try { process.kill(-child.pid!, 'SIGKILL'); } catch { /* gone */ }
    log.end();
  };
  const onExit = () => { try { process.kill(-child.pid!, 'SIGKILL'); } catch { /* gone */ } };
  process.once('exit', onExit);
  try {
    await waitReady(base, opts.readyTimeoutMs ?? 120000, () => exited);
  } catch (e) {
    await stop();
    throw e;
  }
  return { base, mode: opts.mode, stop };
}

async function isUp(base: string): Promise<boolean> {
  try {
    const r = await fetch(base + '/api/stats', { signal: AbortSignal.timeout(2000) });
    await r.text();
    return true;
  } catch {
    return false;
  }
}

async function waitReady(base: string, timeoutMs: number, dead: () => boolean = () => false): Promise<void> {
  const t = Date.now();
  while (Date.now() - t < timeoutMs) {
    if (dead()) throw new Error('next server exited during startup (see server log)');
    try {
      const r = await fetch(base + '/api/stats', { signal: AbortSignal.timeout(20000) });
      await r.text();
      if (r.status === 200) return;
    } catch { /* not yet */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`server at ${base} not ready after ${timeoutMs} ms`);
}
