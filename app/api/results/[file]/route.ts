import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

// Serves the charts the experiments wrote to results/ (a fixed allowlist, no path input reaches the disk).
const CHARTS = new Set(['lease_tradeoff.png', 'pool_over_time.png', 'forecast.png', 'script-check.png']);

export async function GET(_req: Request, ctx: { params: Promise<{ file: string }> }) {
  const { file } = await ctx.params;
  if (!CHARTS.has(file)) return new Response('not found', { status: 404 });
  const bytes = await readFile(join(process.cwd(), 'results', file));
  return new Response(new Uint8Array(bytes), { headers: { 'content-type': 'image/png', 'cache-control': 'no-cache' } });
}
