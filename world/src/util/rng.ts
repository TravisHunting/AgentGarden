// Deterministic, serialisable PRNG (mulberry32). The whole simulation draws from
// one of these so that a given state + seed always plays out the same way.

export class Rng {
  state: number;

  constructor(seed: number) {
    this.state = seed >>> 0;
  }

  next(): number {
    let t = (this.state = (this.state + 0x6d2b79f5) >>> 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  int(minInclusive: number, maxInclusive: number): number {
    return minInclusive + Math.floor(this.next() * (maxInclusive - minInclusive + 1));
  }

  chance(p: number): boolean {
    return this.next() < p;
  }

  pick<T>(items: readonly T[]): T | undefined {
    if (items.length === 0) return undefined;
    return items[Math.floor(this.next() * items.length)];
  }

  weighted<T extends { weight?: number }>(items: readonly T[]): T | undefined {
    const total = items.reduce((s, i) => s + Math.max(0, i.weight ?? 1), 0);
    if (total <= 0) return undefined;
    let r = this.next() * total;
    for (const item of items) {
      r -= Math.max(0, item.weight ?? 1);
      if (r < 0) return item;
    }
    return items[items.length - 1];
  }
}

export function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
