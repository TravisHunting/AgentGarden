// Kernel-owned plan sections and JSON extraction. World sections (queue, loop,
// mods, ...) are declared and validated by the world over the contract.

import { Checker } from '../check.ts';

export const KERNEL_LIMITS = {
  letterLength: 600,
  memories: 5,
  desires: 5,
  rewriteLength: 1200,
};

export interface KernelSectionSpec {
  name: string;
  required: boolean;
}

export function kernelSections(opts: { allowRewrite: boolean }): KernelSectionSpec[] {
  return [
    { name: 'summary', required: true },
    { name: 'letter', required: false },
    { name: 'memories', required: false },
    { name: 'forget', required: false },
    { name: 'desires', required: false },
    ...(opts.allowRewrite ? [{ name: 'rewrite', required: false }] : []),
  ];
}

export interface Rewrite {
  request: string;
  why: string;
}

export function validateKernelSection(name: string, v: unknown, ctx: { memoryIds: Set<number>; allowRewrite: boolean }): string[] {
  const c = new Checker();
  const p = `$.${name}`;
  switch (name) {
    case 'summary':
      c.str(v, p, { min: 1, max: 1500 });
      break;
    case 'letter':
      if (v !== null) c.str(v, p, { min: 1, max: KERNEL_LIMITS.letterLength });
      break;
    case 'memories':
    case 'desires':
      if (c.arr(v, p, { max: name === 'memories' ? KERNEL_LIMITS.memories : KERNEL_LIMITS.desires })) {
        v.forEach((m, i) => c.str(m, `${p}[${i}]`, { min: 1, max: 200 }));
      }
      break;
    case 'forget':
      if (c.arr(v, p, { max: 20 })) {
        v.forEach((id, i) => {
          if (c.num(id, `${p}[${i}]`, { int: true }) && !ctx.memoryIds.has(id)) c.fail(`${p}[${i}]`, `no memory with id ${id}`);
        });
      }
      break;
    case 'rewrite':
      if (v === null) break;
      if (!ctx.allowRewrite) {
        c.fail(p, 'code rewrites are not available right now; send null');
        break;
      }
      if (c.obj(v, p, ['request', 'why'])) {
        c.str(v.request, `${p}.request`, { min: 10, max: KERNEL_LIMITS.rewriteLength });
        c.str(v.why, `${p}.why`, { min: 1, max: 400 });
      }
      break;
    default:
      c.fail(p, 'unknown section');
  }
  return c.errors;
}

/** Pulls the first JSON object out of a model response (tolerates prose and code fences). */
export function extractJson(text: string): Record<string, unknown> {
  const trimmed = text.trim();
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
  const candidates = [trimmed, fence?.[1]?.trim()].filter((s): s is string => !!s);
  for (const cand of candidates) {
    try {
      const v = JSON.parse(cand);
      if (v && typeof v === 'object' && !Array.isArray(v)) return v;
    } catch {
      // fall through
    }
  }
  // Scan for a balanced top-level object.
  const start = trimmed.indexOf('{');
  if (start >= 0) {
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let i = start; i < trimmed.length; i++) {
      const ch = trimmed[i];
      if (inStr) {
        if (esc) esc = false;
        else if (ch === '\\') esc = true;
        else if (ch === '"') inStr = false;
        continue;
      }
      if (ch === '"') inStr = true;
      else if (ch === '{') depth++;
      else if (ch === '}' && --depth === 0) {
        const v = JSON.parse(trimmed.slice(start, i + 1));
        if (v && typeof v === 'object' && !Array.isArray(v)) return v;
        break;
      }
    }
  }
  throw new Error('no JSON object found in the response');
}
