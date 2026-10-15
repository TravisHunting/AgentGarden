// Runs mod scripts against the garden through a narrow API.
//
// Scripts execute inside node:vm contexts with a per-call timeout. node:vm is
// NOT a hard security boundary; it keeps well-behaved (and accidentally buggy)
// agent-written code contained, while the static checks in schema.ts reject
// obvious escape hatches. The code itself comes from the user's own local agent.

import vm from 'node:vm';
import type { Garden } from '../game/engine.ts';
import type { GameEvent } from '../game/types.ts';

const CALL_TIMEOUT_MS = 50;
const TICK_INTERVAL_S = 1;
const MAX_ERRORS = 3;
const MAX_STORE_BYTES = 8_000;
const SAY_COOLDOWN_S = 30;

interface ScriptInstance {
  modId: string;
  context: vm.Context;
  caller: vm.Script;
  hooks: { onTick: boolean; onEvent: boolean };
  errors: number;
  lastSayAt: number;
}

export class ModRuntime {
  private instances: ScriptInstance[] = [];
  private garden: Garden;
  private acc = 0;
  private inEvent = false;
  onFailure: (modId: string, error: string) => void = () => {};

  constructor(garden: Garden) {
    this.garden = garden;
    garden.hooks = {
      onTick: (dt) => this.tick(dt),
      onEvent: (e) => this.event(e),
    };
  }

  load(scripts: { modId: string; source: string }[]): void {
    this.instances = [];
    for (const { modId, source } of scripts) {
      const context = vm.createContext(Object.create(null), { codeGeneration: { strings: false, wasm: false } });
      try {
        new vm.Script(source, { filename: `mods/${modId}/script.js` }).runInContext(context, { timeout: CALL_TIMEOUT_MS * 4 });
        const has = (name: string) => vm.runInContext(`typeof ${name} === 'function'`, context) === true;
        const inst: ScriptInstance = {
          modId,
          context,
          caller: new vm.Script('__hook(__api, __arg)'),
          hooks: { onTick: has('onTick'), onEvent: has('onEvent') },
          errors: 0,
          lastSayAt: -Infinity,
        };
        this.instances.push(inst);
        if (has('onLoad')) this.call(inst, 'onLoad', undefined);
      } catch (e) {
        this.onFailure(modId, `script failed to load: ${(e as Error).message}`);
      }
    }
  }

  private tick(dt: number): void {
    this.acc += dt;
    if (this.acc < TICK_INTERVAL_S) return;
    const elapsed = this.acc;
    this.acc = 0;
    for (const inst of this.instances) if (inst.hooks.onTick) this.call(inst, 'onTick', elapsed);
  }

  private event(e: GameEvent): void {
    // Events raised by scripts themselves are not re-delivered (prevents loops).
    if (this.inEvent || e.kind === 'sound') return;
    this.inEvent = true;
    try {
      for (const inst of this.instances) if (inst.hooks.onEvent) this.call(inst, 'onEvent', structuredClone(e));
    } finally {
      this.inEvent = false;
    }
  }

  private call(inst: ScriptInstance, hook: string, arg: unknown): void {
    if (inst.errors >= MAX_ERRORS) return;
    const ctx = inst.context as Record<string, unknown>;
    ctx.__hook = vm.runInContext(hook, inst.context);
    ctx.__api = this.api(inst);
    ctx.__arg = arg;
    try {
      inst.caller.runInContext(inst.context, { timeout: CALL_TIMEOUT_MS });
    } catch (e) {
      inst.errors++;
      if (inst.errors >= MAX_ERRORS) {
        this.instances = this.instances.filter((i) => i !== inst);
        this.onFailure(inst.modId, `${hook} kept failing: ${(e as Error).message}`);
      }
    }
  }

  private api(inst: ScriptInstance) {
    const g = this.garden;
    const s = g.state;
    const int = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : NaN);
    const num = (v: unknown, lo: number, hi: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : undefined);
    const tileAt = (x: unknown, y: unknown) => {
      const ix = int(x);
      const iy = int(y);
      return g.inBounds(ix, iy) ? g.tile(ix, iy) : null;
    };
    return Object.freeze({
      modId: inst.modId,
      time: s.time,
      width: s.width,
      height: s.height,
      weather: () => s.weather.id,
      random: () => g.random(),
      log: (msg: unknown) => console.log(`[mod ${inst.modId}]`, String(msg).slice(0, 300)),
      getTile: (x: unknown, y: unknown) => {
        const t = tileAt(x, y);
        return t ? JSON.parse(JSON.stringify(t)) : null;
      },
      plants: () =>
        s.tiles.flatMap((t, i) =>
          t.plant ? [{ x: i % s.width, y: Math.floor(i / s.width), species: t.plant.species, growth: t.plant.growth, health: t.plant.health }] : [],
        ),
      creatures: () => s.creatures.map((c) => ({ def: c.def, x: c.x, y: c.y })),
      species: () => [...g.registry.species.keys()],
      setMoisture: (x: unknown, y: unknown, v: unknown) => {
        const t = tileAt(x, y);
        const n = num(v, 0, 100);
        if (t && n !== undefined) t.moisture = n;
      },
      setFertility: (x: unknown, y: unknown, v: unknown) => {
        const t = tileAt(x, y);
        const n = num(v, 0, 100);
        if (t && n !== undefined) t.fertility = n;
      },
      mutatePlant: (x: unknown, y: unknown, m: unknown) => {
        const t = tileAt(x, y);
        if (!t?.plant || typeof m !== 'object' || m === null) return false;
        const p = t.plant;
        const o = m as Record<string, unknown>;
        const growth = num(o.growth, 0, 1);
        const health = num(o.health, 0, 100);
        if (growth !== undefined) p.growth = growth;
        if (health !== undefined) p.health = health;
        if (typeof o.species === 'string' && g.registry.species.has(o.species)) p.species = o.species;
        const mutation = { ...(p.mutation ?? {}) };
        const hue = num(o.hue, -360, 360);
        const scale = num(o.scale, 0.3, 2.5);
        if (hue !== undefined) mutation.hue = hue;
        if (scale !== undefined) mutation.scale = scale;
        if (typeof o.label === 'string') mutation.label = o.label.slice(0, 40);
        p.mutation = mutation;
        return true;
      },
      plant: (x: unknown, y: unknown, species: unknown) =>
        typeof species === 'string' && g.apply({ type: 'plant', x: int(x), y: int(y), species }, 'mod').ok,
      removePlant: (x: unknown, y: unknown) => g.apply({ type: 'cut', x: int(x), y: int(y) }, 'mod').ok,
      spawnCreature: (id: unknown, x?: unknown, y?: unknown) => {
        if (typeof id !== 'string') return false;
        if (s.creatures.length >= g.registry.rules.maxCreatures) return false;
        const ix = x === undefined ? undefined : num(x, 0, s.width - 1);
        const iy = y === undefined ? undefined : num(y, 0, s.height - 1);
        return g.spawnCreature(id, ix, iy) !== null;
      },
      setWeather: (id: unknown, minutes?: unknown) => typeof id === 'string' && g.setWeather(id, num(minutes, 1, 1440)),
      say: (text: unknown) => {
        if (typeof text !== 'string' || s.time - inst.lastSayAt < SAY_COOLDOWN_S) return false;
        inst.lastSayAt = s.time;
        g.say(text);
        return true;
      },
      playSound: (id: unknown) => {
        if (typeof id === 'string' && /^[a-z][a-z0-9_-]{1,39}$/.test(id)) g.sound(id);
      },
      getStore: () => JSON.parse(JSON.stringify(s.modStore[inst.modId] ?? {})),
      setStore: (v: unknown) => {
        const json = JSON.stringify(v ?? {});
        if (json.length > MAX_STORE_BYTES) throw new Error(`store exceeds ${MAX_STORE_BYTES} bytes`);
        s.modStore[inst.modId] = JSON.parse(json);
      },
    });
  }
}
