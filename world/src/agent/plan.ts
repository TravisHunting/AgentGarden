// World-owned plan sections (queue, loop, mods) and their validation.

import { Checker } from '../util/check.ts';
import { EMOTES, ROUTINE_ACTIONS, SELECTORS } from '../game/types.ts';
import type { ModManager, ModOp } from '../mods/manager.ts';
import type { ValidateContext, ValidateResult } from '../contract.ts';

export const LIMITS = {
  queue: 20,
  loopSteps: 12,
  lines: 12,
  lineLength: 100,
  modOps: 3,
};

export interface PlanEnv {
  width: number;
  height: number;
  species: Set<string>;
  mods: ModManager;
}

/** Species that this reply is about to introduce via mods may already be used in the queue/loop. */
export function speciesWithPending(env: PlanEnv, plan: Record<string, unknown>, accepted?: unknown): Set<string> {
  const out = new Set(env.species);
  const ops = [...(Array.isArray(plan.mods) ? plan.mods : []), ...(Array.isArray(accepted) ? accepted : [])];
  for (const op of ops) {
    const species = (op as { manifest?: { species?: { id?: unknown }[] } })?.manifest?.species;
    if (Array.isArray(species)) for (const s of species) if (typeof s?.id === 'string') out.add(s.id);
  }
  return out;
}

export function validateWorldSection(name: string, v: unknown, ctx: ValidateContext, env: PlanEnv): ValidateResult {
  const c = new Checker();
  const p = `$.${name}`;
  const species = speciesWithPending(env, ctx.plan, ctx.acceptedSections.mods);
  switch (name) {
    case 'queue':
      if (c.arr(v, p, { max: LIMITS.queue })) v.forEach((a, i) => checkAction(c, a, `${p}[${i}]`, env, species));
      return { errors: c.errors };
    case 'loop':
      checkLoop(c, v, p, species);
      return { errors: c.errors };
    case 'mods':
      return validateMods(v, ctx, env);
    default:
      return { errors: [`${p}: unknown section`] };
  }
}

/** Mod ops are accepted one by one; valid ones are kept even if siblings fail. */
function validateMods(v: unknown, ctx: ValidateContext, env: PlanEnv): ValidateResult {
  const c = new Checker();
  const accepted: ModOp[] = Array.isArray(ctx.accepted) ? [...(ctx.accepted as ModOp[])] : [];
  if (!c.arr(v, '$.mods', { max: LIMITS.modOps })) return { errors: c.errors, value: accepted };
  if (!ctx.opts.allowMods) {
    if (v.length === 0) return { errors: [], value: [] };
    return { errors: ['$.mods: mods may only be changed after the player leaves a letter; send an empty array'] };
  }
  const key = (op: ModOp) => ('manifest' in op ? op.manifest.id : op.id);
  v.forEach((op, i) => {
    const errs = env.mods.validateOp(op, `$.mods[${i}]`);
    if (errs.length) {
      c.errors.push(...errs);
      return;
    }
    const m = op as ModOp;
    if (!accepted.some((a) => key(a) === key(m)) && accepted.length < LIMITS.modOps) accepted.push(m);
  });
  return {
    errors: c.errors,
    value: accepted,
    note: accepted.length ? `mod operations already accepted (do not resend): ${accepted.map((m) => `${m.op} ${key(m)}`).join(', ')}` : undefined,
  };
}

function checkCoords(c: Checker, a: Record<string, unknown>, path: string, env: PlanEnv): void {
  c.num(a.x, `${path}.x`, { int: true, min: 0, max: env.width - 1 });
  c.num(a.y, `${path}.y`, { int: true, min: 0, max: env.height - 1 });
}

export function checkAction(c: Checker, a: unknown, path: string, env: PlanEnv, species: Set<string>): void {
  if (!c.obj(a, path)) return;
  const types = ['walk', 'till', 'water', 'fertilize', 'plant', 'cut', 'harvest', 'wait', 'say', 'emote'];
  if (!c.str(a.type, `${path}.type`, { oneOf: types })) return;
  const common = ['type', 'say', 'fizzle'];
  switch (a.type) {
    case 'walk':
    case 'till':
    case 'water':
    case 'fertilize':
    case 'cut':
    case 'harvest':
      c.obj(a, path, [...common, 'x', 'y']);
      checkCoords(c, a, path, env);
      break;
    case 'plant':
      c.obj(a, path, [...common, 'x', 'y', 'species']);
      checkCoords(c, a, path, env);
      if (c.str(a.species, `${path}.species`) && !species.has(a.species)) {
        c.fail(`${path}.species`, `unknown species "${a.species}"; known: ${[...species].join(', ')}`);
      }
      break;
    case 'wait':
      c.obj(a, path, [...common, 'seconds']);
      c.num(a.seconds, `${path}.seconds`, { min: 0.5, max: 120 });
      break;
    case 'say':
      c.obj(a, path, [...common, 'text']);
      c.str(a.text, `${path}.text`, { min: 1, max: LIMITS.lineLength });
      break;
    case 'emote':
      c.obj(a, path, [...common, 'emote']);
      c.str(a.emote, `${path}.emote`, { oneOf: EMOTES });
      break;
  }
  if (a.say !== undefined) c.str(a.say, `${path}.say`, { min: 1, max: LIMITS.lineLength });
  if (a.fizzle !== undefined) c.str(a.fizzle, `${path}.fizzle`, { min: 1, max: LIMITS.lineLength });
}

function checkLines(c: Checker, v: unknown, path: string, min: number): void {
  if (c.arr(v, path, { min, max: LIMITS.lines })) v.forEach((l, i) => c.str(l, `${path}[${i}]`, { min: 1, max: LIMITS.lineLength }));
}

export function checkLoop(c: Checker, v: unknown, path: string, species: Set<string>): void {
  if (!c.obj(v, path, ['name', 'steps', 'chatter', 'fizzles', 'lonely'])) return;
  if (v.lonely !== undefined) checkLines(c, v.lonely, `${path}.lonely`, 0);
  c.str(v.name, `${path}.name`, { min: 1, max: 60 });
  checkLines(c, v.chatter, `${path}.chatter`, 1);
  checkLines(c, v.fizzles, `${path}.fizzles`, 1);
  if (!c.arr(v.steps, `${path}.steps`, { min: 1, max: LIMITS.loopSteps })) return;
  let total = 0;
  v.steps.forEach((s, i) => {
    const sp = `${path}.steps[${i}]`;
    if (!c.obj(s, sp, ['action', 'target', 'species', 'weight', 'say'])) return;
    c.str(s.action, `${sp}.action`, { oneOf: ROUTINE_ACTIONS });
    if (s.target !== undefined) c.str(s.target, `${sp}.target`, { oneOf: SELECTORS });
    if (c.num(s.weight, `${sp}.weight`, { min: 0, max: 100 })) total += s.weight as number;
    if (s.say !== undefined) c.str(s.say, `${sp}.say`, { min: 1, max: LIMITS.lineLength });
    if (s.species !== undefined) {
      if (s.action !== 'plant') c.fail(`${sp}.species`, 'only allowed when action is "plant"');
      else if (c.str(s.species, `${sp}.species`) && s.species !== 'any' && !species.has(s.species)) {
        c.fail(`${sp}.species`, `unknown species "${s.species}"; use "any" or one of: ${[...species].join(', ')}`);
      }
    }
  });
  if (total <= 0) c.fail(`${path}.steps`, 'at least one step needs a weight above 0');
}

/** After the last repair round: keep the queue's valid actions, drop the rest. */
export function salvageQueue(raw: unknown, plan: Record<string, unknown>, env: PlanEnv): unknown[] {
  const species = speciesWithPending(env, plan);
  return (Array.isArray(raw) ? raw : []).filter((a) => {
    const c = new Checker();
    checkAction(c, a, '$', env, species);
    return c.ok;
  });
}
