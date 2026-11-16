// Small seeded RNG (mulberry32) so runs are reproducible from a seed.

export type Rng = {
  next(): number; // [0, 1)
  uniform(a: number, b: number): number;
  int(n: number): number; // [0, n)
  normal(): number;
  lognormal(median: number, sigma: number): number;
  exp(mean: number): number;
  pick<T>(items: readonly T[]): T;
  weighted<K extends string>(weights: Record<K, number>): K;
};

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Derive an independent stream, e.g. one per session index, so a session's draws don't depend on timing. */
export function deriveSeed(seed: number, stream: number): number {
  let h = (seed ^ 0x9e3779b9) >>> 0;
  h = Math.imul(h ^ (stream + 0x85ebca6b), 0xc2b2ae35) >>> 0;
  h ^= h >>> 16;
  return h >>> 0;
}

export function makeRng(seed: number): Rng {
  const next = mulberry32(seed);
  const r: Rng = {
    next,
    uniform: (a, b) => a + (b - a) * next(),
    int: (n) => Math.floor(next() * n),
    normal: () => {
      // Box-Muller
      const u = 1 - next();
      const v = next();
      return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
    },
    lognormal: (median, sigma) => median * Math.exp(sigma * r.normal()),
    exp: (mean) => -mean * Math.log(1 - next()),
    pick: (items) => items[Math.floor(next() * items.length)],
    weighted: (weights) => {
      const keys = Object.keys(weights) as (keyof typeof weights)[];
      const total = keys.reduce((s, k) => s + weights[k], 0);
      let x = next() * total;
      for (const k of keys) {
        x -= weights[k];
        if (x < 0) return k;
      }
      return keys[keys.length - 1];
    },
  };
  return r;
}
