// A tiny structural validator that produces precise, path-addressed error
// messages. Those messages are fed straight back to the AI during repair
// iterations, so they are written to be actionable by a model.

export class Checker {
  errors: string[] = [];

  fail(path: string, msg: string): false {
    this.errors.push(`${path}: ${msg}`);
    return false;
  }

  get ok(): boolean {
    return this.errors.length === 0;
  }

  obj(v: unknown, path: string, allowed?: readonly string[]): v is Record<string, unknown> {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) return this.fail(path, `must be an object (got ${kind(v)})`);
    if (allowed) {
      for (const k of Object.keys(v)) {
        if (!allowed.includes(k)) this.fail(`${path}.${k}`, `unknown field; allowed fields are ${allowed.join(', ')}`);
      }
    }
    return true;
  }

  arr(v: unknown, path: string, opts: { min?: number; max?: number } = {}): v is unknown[] {
    if (!Array.isArray(v)) return this.fail(path, `must be an array (got ${kind(v)})`);
    if (opts.min !== undefined && v.length < opts.min) return this.fail(path, `must have at least ${opts.min} item(s)`);
    if (opts.max !== undefined && v.length > opts.max) return this.fail(path, `must have at most ${opts.max} items (got ${v.length})`);
    return true;
  }

  str(
    v: unknown,
    path: string,
    opts: { min?: number; max?: number; pattern?: RegExp; patternHint?: string; oneOf?: readonly string[] } = {},
  ): v is string {
    if (typeof v !== 'string') return this.fail(path, `must be a string (got ${kind(v)})`);
    if (opts.oneOf && !opts.oneOf.includes(v)) return this.fail(path, `must be one of ${opts.oneOf.join(', ')} (got "${clip(v)}")`);
    if (opts.min !== undefined && v.trim().length < opts.min) return this.fail(path, `must be at least ${opts.min} characters`);
    if (opts.max !== undefined && v.length > opts.max) return this.fail(path, `must be at most ${opts.max} characters (got ${v.length})`);
    if (opts.pattern && !opts.pattern.test(v)) return this.fail(path, `must match ${opts.patternHint ?? opts.pattern} (got "${clip(v)}")`);
    return true;
  }

  num(v: unknown, path: string, opts: { min?: number; max?: number; int?: boolean } = {}): v is number {
    if (typeof v !== 'number' || !Number.isFinite(v)) return this.fail(path, `must be a number (got ${kind(v)})`);
    if (opts.int && !Number.isInteger(v)) return this.fail(path, `must be an integer (got ${v})`);
    const lo = opts.min ?? -Infinity;
    const hi = opts.max ?? Infinity;
    if (v < lo || v > hi) return this.fail(path, `must be between ${lo} and ${hi} (got ${v})`);
    return true;
  }

  bool(v: unknown, path: string): v is boolean {
    return typeof v === 'boolean' ? true : this.fail(path, `must be true or false (got ${kind(v)})`);
  }

  color(v: unknown, path: string): v is string {
    return this.str(v, path, { pattern: /^#[0-9a-fA-F]{6}$/, patternHint: 'a #rrggbb hex colour' });
  }
}

export function kind(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (typeof v === 'string') return `string "${clip(v)}"`;
  if (typeof v === 'number') return `number ${v}`;
  return typeof v;
}

function clip(s: string): string {
  return s.length > 40 ? `${s.slice(0, 37)}...` : s;
}

export const ID_PATTERN = /^[a-z][a-z0-9_-]{1,39}$/;
export const ID_HINT = 'a lowercase id like "moon-carrot" (2-40 chars: a-z, 0-9, _ or -)';
