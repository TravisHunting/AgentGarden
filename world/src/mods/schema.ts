// Mod manifest format and validation. A mod is a folder in mods/ containing
// mod.json and, optionally, script.js. See docs/MODDING.md.

import { Checker, ID_HINT, ID_PATTERN } from '../util/check.ts';
import { RULE_BOUNDS } from '../game/content.ts';
import type { CreatureDef, Rules, SpeciesDef, WeatherDef } from '../game/types.ts';

export interface SpriteDef {
  w: number;
  h: number;
  palette: Record<string, string>; // single character → #rrggbb; '.' is always transparent
  frames: string[][]; // frames[i][row] = string of w palette characters
  fps?: number; // animation speed; 0 = static
  mode?: 'animate' | 'stages'; // 'stages': species pick a frame by growth stage
}

export interface SoundNote {
  freq: number; // Hz
  dur: number; // seconds
  vol?: number; // 0..1
}

export interface SoundDef {
  wave: 'sine' | 'square' | 'triangle' | 'sawtooth' | 'noise';
  notes: SoundNote[];
  slide?: number; // pitch glide in Hz over each note
}

export interface ModManifest {
  id: string;
  name: string;
  version: number;
  description: string;
  author?: string;
  enabled: boolean;
  priority?: number; // load order; higher loads later (wins conflicts)
  species?: Omit<SpeciesDef, 'source'>[];
  creatures?: Omit<CreatureDef, 'source'>[];
  weather?: Omit<WeatherDef, 'source'>[];
  rules?: Partial<Rules>;
  remove?: { species?: string[]; creatures?: string[]; weather?: string[] };
  sprites?: Record<string, SpriteDef>;
  sounds?: Record<string, SoundDef>;
  disabledReason?: string;
}

export const MANIFEST_FIELDS = [
  'id',
  'name',
  'version',
  'description',
  'author',
  'enabled',
  'priority',
  'species',
  'creatures',
  'weather',
  'rules',
  'remove',
  'sprites',
  'sounds',
  'disabledReason',
] as const;

const SHAPES = ['bush', 'flower', 'root', 'vine', 'tree', 'grass', 'mushroom', 'crystal'] as const;
const BEHAVIOURS = ['wander', 'pollinator', 'pest', 'sprinkler', 'gardener', 'sleeper'] as const;
const CREATURE_SHAPES = ['bug', 'bird', 'blob', 'critter', 'snail', 'ghost'] as const;
const PARTICLES = ['none', 'rain', 'snow', 'petals', 'sparkles', 'leaves', 'fog', 'embers'] as const;
const WAVES = ['sine', 'square', 'triangle', 'sawtooth', 'noise'] as const;

export const MAX_SCRIPT_BYTES = 24_000;
const MAX_MANIFEST_BYTES = 200_000;

export function validateManifest(m: unknown, path = '$'): { manifest?: ModManifest; errors: string[] } {
  const c = new Checker();
  if (!c.obj(m, path, MANIFEST_FIELDS)) return { errors: c.errors };
  if (JSON.stringify(m).length > MAX_MANIFEST_BYTES) c.fail(path, `manifest is too large (max ${MAX_MANIFEST_BYTES} bytes)`);
  c.str(m.id, `${path}.id`, { pattern: ID_PATTERN, patternHint: ID_HINT });
  c.str(m.name, `${path}.name`, { min: 1, max: 60 });
  c.num(m.version, `${path}.version`, { int: true, min: 1, max: 100000 });
  c.str(m.description, `${path}.description`, { max: 600 });
  if (m.author !== undefined) c.str(m.author, `${path}.author`, { max: 60 });
  c.bool(m.enabled, `${path}.enabled`);
  if (m.priority !== undefined) c.num(m.priority, `${path}.priority`, { int: true, min: -100, max: 100 });
  if (m.disabledReason !== undefined) c.str(m.disabledReason, `${path}.disabledReason`, { max: 400 });

  const sprites = m.sprites;
  const spriteIds = new Set<string>();
  if (sprites !== undefined && c.obj(sprites, `${path}.sprites`)) {
    const entries = Object.entries(sprites);
    if (entries.length > 24) c.fail(`${path}.sprites`, 'at most 24 sprites per mod');
    for (const [id, s] of entries) {
      if (c.str(id, `${path}.sprites key`, { pattern: ID_PATTERN, patternHint: ID_HINT })) spriteIds.add(id);
      checkSprite(c, s, `${path}.sprites.${id}`);
    }
  }
  const soundIds = new Set<string>();
  if (m.sounds !== undefined && c.obj(m.sounds, `${path}.sounds`)) {
    const entries = Object.entries(m.sounds);
    if (entries.length > 24) c.fail(`${path}.sounds`, 'at most 24 sounds per mod');
    for (const [id, s] of entries) {
      if (c.str(id, `${path}.sounds key`, { pattern: ID_PATTERN, patternHint: ID_HINT })) soundIds.add(id);
      checkSound(c, s, `${path}.sounds.${id}`);
    }
  }

  if (m.species !== undefined && c.arr(m.species, `${path}.species`, { max: 24 })) {
    m.species.forEach((s, i) => checkSpecies(c, s, `${path}.species[${i}]`));
  }
  if (m.creatures !== undefined && c.arr(m.creatures, `${path}.creatures`, { max: 16 })) {
    m.creatures.forEach((s, i) => checkCreature(c, s, `${path}.creatures[${i}]`));
  }
  if (m.weather !== undefined && c.arr(m.weather, `${path}.weather`, { max: 16 })) {
    m.weather.forEach((s, i) => checkWeather(c, s, `${path}.weather[${i}]`));
  }
  if (m.rules !== undefined && c.obj(m.rules, `${path}.rules`, Object.keys(RULE_BOUNDS))) {
    for (const [k, v] of Object.entries(m.rules)) {
      const b = RULE_BOUNDS[k as keyof Rules];
      if (b) c.num(v, `${path}.rules.${k}`, { min: b[0], max: b[1] });
    }
  }
  if (m.remove !== undefined && c.obj(m.remove, `${path}.remove`, ['species', 'creatures', 'weather'])) {
    for (const [k, v] of Object.entries(m.remove)) {
      if (c.arr(v, `${path}.remove.${k}`, { max: 30 })) v.forEach((id, i) => c.str(id, `${path}.remove.${k}[${i}]`, { pattern: ID_PATTERN }));
    }
  }
  return c.ok ? { manifest: m as unknown as ModManifest, errors: [] } : { errors: c.errors };
}

function checkSprite(c: Checker, s: unknown, path: string): void {
  if (!c.obj(s, path, ['w', 'h', 'palette', 'frames', 'fps', 'mode'])) return;
  const wOk = c.num(s.w, `${path}.w`, { int: true, min: 4, max: 32 });
  const hOk = c.num(s.h, `${path}.h`, { int: true, min: 4, max: 32 });
  if (s.fps !== undefined) c.num(s.fps, `${path}.fps`, { min: 0, max: 24 });
  if (s.mode !== undefined) c.str(s.mode, `${path}.mode`, { oneOf: ['animate', 'stages'] });
  const palette = new Set<string>(['.']);
  if (c.obj(s.palette, `${path}.palette`)) {
    const keys = Object.keys(s.palette);
    if (keys.length > 16) c.fail(`${path}.palette`, 'at most 16 colours');
    for (const [k, v] of Object.entries(s.palette)) {
      if (k.length !== 1 || k === '.') c.fail(`${path}.palette`, `key "${k}" must be a single character other than "."`);
      else palette.add(k);
      c.color(v, `${path}.palette.${k}`);
    }
  }
  if (!c.arr(s.frames, `${path}.frames`, { min: 1, max: 8 }) || !wOk || !hOk) return;
  s.frames.forEach((f, fi) => {
    // Report a wrong row count *and* keep checking the rows, so one repair round surfaces every problem.
    if (!c.arr(f, `${path}.frames[${fi}]`)) return;
    if (f.length !== s.h) c.fail(`${path}.frames[${fi}]`, `must have exactly ${s.h} rows (got ${f.length})`);
    f.forEach((row, ri) => {
      const rp = `${path}.frames[${fi}][${ri}]`;
      if (!c.str(row, rp)) return;
      if (row.length !== s.w) c.fail(rp, `row must be exactly ${s.w} characters (got ${row.length})`);
      const bad = [...row].find((ch) => !palette.has(ch));
      if (bad !== undefined) c.fail(rp, `uses "${bad}" which is not in the palette (use "." for transparent)`);
    });
  });
}

function checkSound(c: Checker, s: unknown, path: string): void {
  if (!c.obj(s, path, ['wave', 'notes', 'slide'])) return;
  c.str(s.wave, `${path}.wave`, { oneOf: WAVES });
  if (s.slide !== undefined) c.num(s.slide, `${path}.slide`, { min: -4000, max: 4000 });
  if (!c.arr(s.notes, `${path}.notes`, { min: 1, max: 32 })) return;
  let total = 0;
  s.notes.forEach((n, i) => {
    const p = `${path}.notes[${i}]`;
    if (!c.obj(n, p, ['freq', 'dur', 'vol'])) return;
    c.num(n.freq, `${p}.freq`, { min: 20, max: 8000 });
    if (c.num(n.dur, `${p}.dur`, { min: 0.01, max: 2 })) total += n.dur as number;
    if (n.vol !== undefined) c.num(n.vol, `${p}.vol`, { min: 0, max: 1 });
  });
  if (total > 4) c.fail(`${path}.notes`, `sound is too long (${total.toFixed(2)}s, max 4s)`);
}

function checkCommon(c: Checker, s: Record<string, unknown>, path: string): void {
  c.str(s.id, `${path}.id`, { pattern: ID_PATTERN, patternHint: ID_HINT });
  c.str(s.name, `${path}.name`, { min: 1, max: 40 });
  if (s.description !== undefined) c.str(s.description, `${path}.description`, { max: 300 });
  if (s.sprite !== undefined) c.str(s.sprite, `${path}.sprite`, { pattern: ID_PATTERN, patternHint: 'the id of a sprite' });
  if (s.sound !== undefined) c.str(s.sound, `${path}.sound`, { pattern: ID_PATTERN, patternHint: 'the id of a sound' });
}

export function checkSpecies(c: Checker, s: unknown, path: string): void {
  if (
    !c.obj(s, path, [
      'id',
      'name',
      'description',
      'growMinutes',
      'thirstPerMinute',
      'idealMoisture',
      'shape',
      'colors',
      'sprite',
      'regrows',
      'glow',
      'seedCost',
    ])
  )
    return;
  checkCommon(c, s, path);
  c.num(s.growMinutes, `${path}.growMinutes`, { min: 1, max: 10080 });
  c.num(s.thirstPerMinute, `${path}.thirstPerMinute`, { min: 0, max: 10 });
  if (c.arr(s.idealMoisture, `${path}.idealMoisture`, { min: 2, max: 2 })) {
    const [lo, hi] = s.idealMoisture;
    if (c.num(lo, `${path}.idealMoisture[0]`, { min: 0, max: 100 }) && c.num(hi, `${path}.idealMoisture[1]`, { min: 0, max: 100 }) && lo > hi) {
      c.fail(`${path}.idealMoisture`, 'low bound must not exceed high bound');
    }
  }
  c.str(s.shape, `${path}.shape`, { oneOf: SHAPES });
  if (c.obj(s.colors, `${path}.colors`, ['stem', 'leaf', 'bloom'])) {
    c.color(s.colors.stem, `${path}.colors.stem`);
    c.color(s.colors.leaf, `${path}.colors.leaf`);
    c.color(s.colors.bloom, `${path}.colors.bloom`);
  }
  c.bool(s.regrows, `${path}.regrows`);
  if (s.glow !== undefined) c.bool(s.glow, `${path}.glow`);
  if (s.seedCost !== undefined) c.num(s.seedCost, `${path}.seedCost`, { min: 0, max: 1000 });
}

export function checkCreature(c: Checker, s: unknown, path: string): void {
  if (
    !c.obj(s, path, ['id', 'name', 'description', 'behaviour', 'shape', 'colors', 'sprite', 'speed', 'spawnPerHour', 'maxCount', 'lifeMinutes', 'sound'])
  )
    return;
  checkCommon(c, s, path);
  c.str(s.behaviour, `${path}.behaviour`, { oneOf: BEHAVIOURS });
  c.str(s.shape, `${path}.shape`, { oneOf: CREATURE_SHAPES });
  if (c.obj(s.colors, `${path}.colors`, ['body', 'accent'])) {
    c.color(s.colors.body, `${path}.colors.body`);
    c.color(s.colors.accent, `${path}.colors.accent`);
  }
  c.num(s.speed, `${path}.speed`, { min: 0, max: 6 });
  c.num(s.spawnPerHour, `${path}.spawnPerHour`, { min: 0, max: 60 });
  c.num(s.maxCount, `${path}.maxCount`, { int: true, min: 0, max: 10 });
  c.num(s.lifeMinutes, `${path}.lifeMinutes`, { min: 0.5, max: 1440 });
}

export function checkWeather(c: Checker, s: unknown, path: string): void {
  if (
    !c.obj(s, path, [
      'id',
      'name',
      'description',
      'moisturePerMinute',
      'growthMultiplier',
      'particles',
      'tint',
      'weight',
      'minMinutes',
      'maxMinutes',
      'sound',
    ])
  )
    return;
  checkCommon(c, s, path);
  c.num(s.moisturePerMinute, `${path}.moisturePerMinute`, { min: -10, max: 10 });
  c.num(s.growthMultiplier, `${path}.growthMultiplier`, { min: 0, max: 10 });
  c.str(s.particles, `${path}.particles`, { oneOf: PARTICLES });
  if (s.tint !== null) {
    c.str(s.tint, `${path}.tint`, {
      pattern: /^(#[0-9a-fA-F]{6}|rgba\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*(0|1|0?\.\d+)\s*\))$/,
      patternHint: 'null, "#rrggbb" or "rgba(r,g,b,a)"',
    });
  }
  c.num(s.weight, `${path}.weight`, { min: 0, max: 100 });
  const minOk = c.num(s.minMinutes, `${path}.minMinutes`, { min: 1, max: 1440 });
  const maxOk = c.num(s.maxMinutes, `${path}.maxMinutes`, { min: 1, max: 1440 });
  if (minOk && maxOk && (s.minMinutes as number) > (s.maxMinutes as number)) c.fail(`${path}.minMinutes`, 'must not exceed maxMinutes');
}

// Defence in depth only: node:vm is not a security boundary (see docs/MODDING.md).
const FORBIDDEN = /\b(require|import|process|globalThis|global|Function|eval|constructor|__proto__|prototype|Reflect|Proxy|WebAssembly|setTimeout|setInterval|fetch|Atomics|SharedArrayBuffer)\b/;

export function validateScript(src: unknown, path = '$.script'): string[] {
  const c = new Checker();
  if (!c.str(src, path, { max: MAX_SCRIPT_BYTES })) return c.errors;
  const m = FORBIDDEN.exec(src);
  if (m) c.fail(path, `may not reference "${m[1]}"; use only the api object passed to the hooks`);
  if (!/\bfunction\s+(onTick|onEvent|onLoad)\b/.test(src)) {
    c.fail(path, 'must define at least one of: function onLoad(api), function onTick(api, dt), function onEvent(api, event)');
  }
  return c.errors;
}
