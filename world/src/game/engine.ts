// The deterministic garden simulation. All randomness flows through the seeded
// Rng whose state lives inside GardenState, so snapshots resume identically.

import { Rng } from '../util/rng.ts';
import { LONELY_LINES, WAITING_LOOP } from './content.ts';
import type {
  Action,
  ActiveTask,
  Creature,
  CreatureDef,
  GameEvent,
  GardenState,
  Plant,
  Registry,
  RoutineLoop,
  RoutineStep,
  Selector,
  Tile,
} from './types.ts';

/** Internal annotation: the plant a queued action was aimed at when it was planned. */
export type PlannedAction = Action & { expectPlant?: number };

export interface ActionResult {
  ok: boolean;
  reason?: string;
}

export interface EngineHooks {
  onTick?(dt: number): void;
  onEvent?(e: GameEvent): void;
}

const MAX_RECENT_EVENTS = 300;
/** After this long without player actions or letters, the gardener starts dropping hints. */
export const LONELY_AFTER_S = 30 * 60;
const FIZZLE_SECONDS = 2.5;
const SPOKEN_SECONDS = 2;

export function createGardenState(seed: number, registry: Registry, width = 6, height = 10): GardenState {
  const rng = new Rng(seed);
  const tiles: Tile[] = [];
  for (let i = 0; i < width * height; i++) {
    tiles.push({ tilled: false, moisture: 40 + rng.int(0, 20), fertility: 50 + rng.int(0, 20), plant: null });
  }
  const state: GardenState = {
    version: 1,
    width,
    height,
    time: 0,
    rngState: 0,
    nextUid: 1,
    tiles,
    creatures: [],
    weather: { id: registry.weather.has('sunny') ? 'sunny' : [...registry.weather.keys()][0], until: 30 * 60 },
    avatar: {
      x: Math.floor(width / 2),
      y: Math.floor(height / 2),
      facing: 1,
      mode: 'idle',
      task: null,
      queue: [],
      loop: structuredClone(WAITING_LOOP),
      emote: null,
      emoteUntil: 0,
      lastChatterAt: 0,
    },
    mailbox: { x: width - 1, y: 0 },
    inventory: {},
    modStore: {},
    lastPlayerAt: null,
  };
  // A new garden is a bare lawn: nothing is dug or planted until the player says what they'd like.
  state.rngState = rng.state;
  return state;
}

export class Garden {
  state: GardenState;
  registry: Registry;
  recent: GameEvent[] = [];
  hooks: EngineHooks = {};
  private rng: Rng;
  private listeners = new Set<(e: GameEvent) => void>();

  constructor(state: GardenState, registry: Registry) {
    this.state = state;
    this.registry = registry;
    this.rng = new Rng(state.rngState);
  }

  // ---------------------------------------------------------------- utilities

  onEvent(fn: (e: GameEvent) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Distributes a new event without the time stamp, which is added here. */
  emit(e: DistributiveOmit<GameEvent, 't'>): void {
    const ev = { ...e, t: this.state.time } as GameEvent;
    this.recent.push(ev);
    if (this.recent.length > MAX_RECENT_EVENTS) this.recent.splice(0, this.recent.length - MAX_RECENT_EVENTS);
    for (const fn of this.listeners) fn(ev);
    try {
      this.hooks.onEvent?.(ev);
    } catch {
      // Mod runtime handles its own failures; never let it break the sim.
    }
  }

  random(): number {
    const v = this.rng.next();
    this.state.rngState = this.rng.state;
    return v;
  }

  get rngRef(): Rng {
    return this.rng;
  }

  inBounds(x: number, y: number): boolean {
    return Number.isInteger(x) && Number.isInteger(y) && x >= 0 && y >= 0 && x < this.state.width && y < this.state.height;
  }

  tile(x: number, y: number): Tile {
    return this.state.tiles[y * this.state.width + x];
  }

  isMailbox(x: number, y: number): boolean {
    return x === this.state.mailbox.x && y === this.state.mailbox.y;
  }

  say(text: string): void {
    const clean = text.trim().slice(0, 140);
    if (clean) this.emit({ kind: 'bubble', text: clean, who: 'avatar' });
  }

  sound(name: string): void {
    this.emit({ kind: 'sound', sound: name });
  }

  // ---------------------------------------------------------------- actions

  /** Returns why an action cannot be performed right now, or null if it can. */
  check(action: PlannedAction): string | null {
    switch (action.type) {
      case 'wait':
      case 'say':
      case 'emote':
        return null;
      case 'walk':
        return this.inBounds(action.x, action.y) ? null : 'that spot is outside the garden';
    }
    if (!this.inBounds(action.x, action.y)) return 'that spot is outside the garden';
    if (this.isMailbox(action.x, action.y)) return 'that is the mailbox';
    const tile = this.tile(action.x, action.y);
    const plant = tile.plant;
    if (action.expectPlant !== undefined && plant?.uid !== action.expectPlant) {
      return plant ? 'a different plant is here now' : 'the plant is gone';
    }
    switch (action.type) {
      case 'till':
        return plant ? 'there is a plant in the way' : null;
      case 'water':
        return null;
      case 'fertilize':
        return tile.tilled ? null : 'the soil is not tilled';
      case 'plant':
        if (!this.registry.species.has(action.species)) return `nobody has heard of "${action.species}" seeds`;
        if (!tile.tilled) return 'the soil is not tilled';
        return plant ? 'something is already growing here' : null;
      case 'cut':
        return plant ? null : 'there is nothing to cut';
      case 'harvest':
        if (!plant) return 'there is nothing to harvest';
        if (plant.health <= 0) return 'it is dead, not ripe';
        return plant.growth >= 1 ? null : 'it is not ripe yet';
    }
  }

  /** Performs an action immediately (used by the player, and by the avatar once work finishes). */
  apply(action: PlannedAction, actor: 'player' | 'avatar' | 'mod'): ActionResult {
    const reason = this.check(action);
    if (reason) {
      this.emit({ kind: 'action', actor, action: stripInternal(action), ok: false, reason });
      return { ok: false, reason };
    }
    switch (action.type) {
      case 'say':
        this.say(action.text);
        break;
      case 'emote':
        this.state.avatar.emote = action.emote;
        this.state.avatar.emoteUntil = this.state.time + 4;
        break;
      case 'walk':
      case 'wait':
        break;
      default: {
        const tile = this.tile(action.x, action.y);
        switch (action.type) {
          case 'till':
            tile.tilled = true;
            break;
          case 'water':
            tile.moisture = Math.min(100, tile.moisture + this.registry.rules.waterAmount);
            break;
          case 'fertilize':
            tile.fertility = Math.min(100, tile.fertility + 30);
            break;
          case 'plant':
            tile.plant = this.newPlant(action.species);
            break;
          case 'cut':
            tile.plant = null;
            break;
          case 'harvest': {
            const plant = tile.plant!;
            const def = this.registry.species.get(plant.species);
            this.state.inventory[plant.species] = (this.state.inventory[plant.species] ?? 0) + 1;
            if (def?.regrows) {
              plant.growth = 0.45;
              plant.harvests++;
            } else {
              tile.plant = null;
            }
            break;
          }
        }
        this.sound(action.type);
      }
    }
    this.emit({ kind: 'action', actor, action: stripInternal(action), ok: true });
    return { ok: true };
  }

  newPlant(species: string): Plant {
    return { uid: this.state.nextUid++, species, growth: 0, health: 100, plantedAt: this.state.time, harvests: 0 };
  }

  /** Installs a freshly planned queue and loop, replacing whatever the avatar was doing. */
  setPlan(queue: Action[], loop: RoutineLoop): void {
    const av = this.state.avatar;
    av.queue = queue.map((a) => this.annotate(a));
    av.loop = loop;
    av.task = null;
    av.mode = 'idle';
  }

  private annotate(a: Action): PlannedAction {
    if ((a.type === 'water' || a.type === 'fertilize' || a.type === 'cut' || a.type === 'harvest') && this.inBounds(a.x, a.y)) {
      const plant = this.tile(a.x, a.y).plant;
      if (plant) return { ...a, expectPlant: plant.uid };
    }
    return { ...a };
  }

  // ---------------------------------------------------------------- simulation

  tick(dt: number): void {
    this.state.time += dt;
    this.tickWeather();
    this.tickTiles(dt);
    this.tickCreatures(dt);
    this.tickAvatar(dt);
    try {
      this.hooks.onTick?.(dt);
    } catch {
      // see emit()
    }
    this.state.rngState = this.rng.state;
  }

  /** Fast-forwards the garden, e.g. to catch up on time the server was not running. */
  simulate(seconds: number, step = 5): void {
    let left = seconds;
    while (left > 0) {
      const dt = Math.min(step, left);
      this.tick(dt);
      left -= dt;
    }
  }

  setWeather(id: string, minutes?: number): boolean {
    const def = this.registry.weather.get(id);
    if (!def) return false;
    const mins = minutes ?? def.minMinutes + this.random() * Math.max(0, def.maxMinutes - def.minMinutes);
    this.state.weather = { id, until: this.state.time + mins * 60 };
    this.emit({ kind: 'weather', weather: id });
    if (def.sound) this.sound(def.sound);
    return true;
  }

  private tickWeather(): void {
    const w = this.state.weather;
    if (this.registry.weather.has(w.id) && this.state.time < w.until) return;
    const options = [...this.registry.weather.values()];
    const next = this.rng.weighted(options.filter((o) => o.id !== w.id)) ?? options[0];
    if (next) this.setWeather(next.id);
  }

  private tickTiles(dt: number): void {
    const rules = this.registry.rules;
    const weather = this.registry.weather.get(this.state.weather.id);
    const minutes = dt / 60;
    const { width } = this.state;
    this.state.tiles.forEach((tile, i) => {
      let delta = (weather?.moisturePerMinute ?? 0) - rules.evaporationPerMinute * 0.5;
      const plant = tile.plant;
      const def = plant ? this.registry.species.get(plant.species) : undefined;
      if (plant && plant.health > 0 && def) delta -= def.thirstPerMinute;
      tile.moisture = clamp(tile.moisture + delta * minutes, 0, 100);
      if (!plant || plant.health <= 0) return;
      if (!def) {
        // Its species was removed (e.g. a mod was disabled): it slowly withers.
        plant.health = Math.max(0, plant.health - 2 * minutes);
        return;
      }
      if (tile.moisture < rules.wiltThreshold) plant.health -= 2.5 * minutes;
      else if (tile.moisture > rules.drownThreshold) plant.health -= 1.2 * minutes;
      else plant.health += 1 * minutes;
      plant.health = clamp(plant.health, 0, 100);
      if (plant.health <= 0) {
        this.emit({ kind: 'plant', event: 'died', x: i % width, y: Math.floor(i / width), species: plant.species });
        return;
      }
      if (plant.growth < 1) {
        const [lo, hi] = def.idealMoisture;
        const moistureFactor = tile.moisture >= lo && tile.moisture <= hi ? 1 : 0.4;
        const fertilityFactor = 0.75 + tile.fertility / 200;
        const rate =
          (minutes / Math.max(1, def.growMinutes)) *
          rules.growthRate *
          (weather?.growthMultiplier ?? 1) *
          moistureFactor *
          fertilityFactor;
        plant.growth = Math.min(1, plant.growth + rate);
        tile.fertility = Math.max(0, tile.fertility - 0.05 * minutes);
        if (plant.growth >= 1) {
          this.emit({ kind: 'plant', event: 'ripe', x: i % width, y: Math.floor(i / width), species: plant.species });
        }
      }
    });
  }

  // ---------------------------------------------------------------- creatures

  spawnCreature(defId: string, x?: number, y?: number): Creature | null {
    const def = this.registry.creatures.get(defId);
    if (!def) return null;
    const { width, height } = this.state;
    const sx = x ?? (this.rng.chance(0.5) ? 0 : width - 1);
    const sy = y ?? this.rng.int(0, height - 1);
    const c: Creature = { uid: this.state.nextUid++, def: defId, x: sx, y: sy, tx: sx, ty: sy, bornAt: this.state.time };
    this.state.creatures.push(c);
    this.emit({ kind: 'creature', creature: defId, event: 'spawn' });
    if (def.sound) this.sound(def.sound);
    return c;
  }

  private tickCreatures(dt: number): void {
    const rules = this.registry.rules;
    // Spawning
    for (const def of this.registry.creatures.values()) {
      if (this.state.creatures.length >= rules.maxCreatures) break;
      const count = this.state.creatures.filter((c) => c.def === def.id).length;
      if (count < def.maxCount && this.rng.chance((def.spawnPerHour * dt) / 3600)) this.spawnCreature(def.id);
    }
    // Movement and behaviour
    this.state.creatures = this.state.creatures.filter((c) => {
      const def = this.registry.creatures.get(c.def);
      if (!def || this.state.time - c.bornAt > def.lifeMinutes * 60) {
        this.emit({ kind: 'creature', creature: c.def, event: 'leave' });
        return false;
      }
      const arrived = moveTowards(c, c.tx, c.ty, def.speed * dt);
      if (arrived) {
        this.creatureArrive(c, def);
        this.pickCreatureTarget(c, def);
      }
      return true;
    });
  }

  private creatureArrive(c: Creature, def: CreatureDef): void {
    const x = Math.round(c.x);
    const y = Math.round(c.y);
    if (!this.inBounds(x, y)) return;
    const tile = this.tile(x, y);
    const plant = tile.plant;
    switch (def.behaviour) {
      case 'pollinator':
        if (plant && plant.health > 0) plant.growth = Math.min(1, plant.growth + 0.02);
        break;
      case 'pest':
        if (plant && plant.health > 0) plant.health = Math.max(0, plant.health - 6);
        break;
      case 'sprinkler':
        tile.moisture = Math.min(100, tile.moisture + 15);
        break;
      case 'gardener':
        if (plant && plant.health > 0) tile.moisture = Math.min(100, tile.moisture + 10);
        break;
    }
  }

  private pickCreatureTarget(c: Creature, def: CreatureDef): void {
    const { width, height } = this.state;
    const plants = this.plantCoords((p) => p.health > 0);
    let target: { x: number; y: number } | undefined;
    switch (def.behaviour) {
      case 'pollinator':
      case 'pest':
        target = this.rng.pick(plants);
        break;
      case 'gardener':
        target = this.driest(plants);
        break;
      case 'sleeper':
        if (this.rng.chance(0.8)) target = { x: c.x, y: c.y };
        break;
    }
    target ??= { x: this.rng.int(0, width - 1), y: this.rng.int(0, height - 1) };
    c.tx = target.x;
    c.ty = target.y;
  }

  // ---------------------------------------------------------------- avatar

  private tickAvatar(dt: number): void {
    const av = this.state.avatar;
    if (av.emote && this.state.time >= av.emoteUntil) av.emote = null;
    if (!av.task) {
      const next = av.queue.shift();
      if (next) {
        av.task = this.startTask(next, 'queue');
      } else {
        const fromLoop = this.resolveLoopStep();
        av.task = this.startTask(fromLoop, 'loop');
        this.maybeChatter();
      }
    }
    const task = av.task!;
    if (task.phase === 'walk') {
      const dest = actionTile(task.action);
      if (dest) {
        const dx = dest.x - av.x;
        if (Math.abs(dx) > 0.01) av.facing = dx > 0 ? 1 : -1;
        const arrived = moveTowards(av, dest.x, dest.y, this.registry.rules.avatarSpeed * dt);
        av.mode = 'walking';
        if (!arrived) return;
      }
      this.beginWork(task);
      return;
    }
    task.remaining -= dt;
    if (task.remaining > 0) return;
    if (av.mode !== 'fizzling') {
      const result = this.apply(task.action, 'avatar');
      if (!result.ok) {
        // Something changed during the work itself (a mod, a creature): still comedic.
        this.fizzle(task, result.reason ?? 'it just did not work');
        return;
      }
    }
    av.task = null;
    av.mode = 'idle';
  }

  private startTask(action: PlannedAction, origin: ActiveTask['origin']): ActiveTask {
    return { action, origin, phase: 'walk', remaining: 0 };
  }

  private beginWork(task: ActiveTask): void {
    const av = this.state.avatar;
    const reason = this.check(task.action);
    if (reason) {
      this.fizzle(task, reason);
      return;
    }
    task.phase = 'work';
    const a = task.action;
    if (a.say) this.say(a.say);
    switch (a.type) {
      case 'wait':
        task.remaining = Math.max(0, a.seconds);
        av.mode = 'resting';
        break;
      case 'walk':
        task.remaining = 0;
        av.mode = 'idle';
        break;
      case 'say':
      case 'emote':
        task.remaining = SPOKEN_SECONDS;
        av.mode = 'idle';
        break;
      default:
        task.remaining = this.registry.rules.actionSeconds;
        av.mode = 'working';
    }
  }

  private fizzle(task: ActiveTask, reason: string): void {
    const av = this.state.avatar;
    const line = task.action.fizzle?.trim() || this.rng.pick(av.loop.fizzles) || 'Wha—?';
    task.phase = 'work';
    task.remaining = FIZZLE_SECONDS;
    av.mode = 'fizzling';
    av.emote = 'confused';
    av.emoteUntil = this.state.time + FIZZLE_SECONDS + 1;
    this.emit({ kind: 'fizzle', text: line.slice(0, 140), action: stripInternal(task.action), reason });
    this.sound('fizzle');
  }

  /** Records that the player just did something (an action or a letter). */
  notePlayer(): void {
    this.state.lastPlayerAt = this.state.time;
  }

  /** Simulated seconds since the player last acted or wrote; Infinity if they never have. */
  playerIdleSeconds(): number {
    const t = this.state.lastPlayerAt;
    return t === null || t === undefined ? Infinity : this.state.time - t;
  }

  private maybeChatter(): void {
    const av = this.state.avatar;
    const idle = this.playerIdleSeconds();
    const neverMet = idle === Infinity;
    const lonely = !neverMet && idle > LONELY_AFTER_S;
    // A little chattier while trying to coax the player into doing something.
    const gap = this.registry.rules.chatterSeconds * (lonely || neverMet ? 0.6 : 1);
    if (this.state.time - av.lastChatterAt < gap) return;
    if (!this.rng.chance(0.35)) return;
    av.lastChatterAt = this.state.time;
    if (lonely && this.rng.chance(0.6)) {
      const line = this.rng.pick(av.loop.lonely?.length ? av.loop.lonely : LONELY_LINES)!;
      const spot = this.select('mailbox');
      if (spot && this.rng.chance(0.4)) {
        // Wander over and peek in the mailbox, hopefully.
        av.queue.push({ type: 'walk', x: spot.x, y: spot.y, say: line }, { type: 'emote', emote: 'sad' });
      } else this.say(line);
      return;
    }
    const line = this.rng.pick(av.loop.chatter);
    if (line) this.say(line);
  }

  /** Turns one weighted, selector-based routine step into a concrete action. */
  resolveLoopStep(): PlannedAction {
    const steps = this.state.avatar.loop.steps;
    for (let attempt = 0; attempt < 6; attempt++) {
      const step = this.rng.weighted(steps);
      if (!step) break;
      const action = this.resolveStep(step);
      if (action) return action;
    }
    return { type: 'wait', seconds: 3 + this.rng.int(0, 5) };
  }

  resolveStep(step: RoutineStep): PlannedAction | null {
    const say = step.say;
    switch (step.action) {
      case 'rest':
        return { type: 'wait', seconds: 4 + this.rng.int(0, 8), say };
      case 'say': {
        const text = say ?? this.rng.pick(this.state.avatar.loop.chatter);
        return text ? { type: 'say', text } : null;
      }
    }
    const spot = this.select(step.target ?? defaultSelector(step.action));
    if (!spot) return null;
    switch (step.action) {
      case 'wander':
        return { type: 'walk', x: spot.x, y: spot.y, say };
      case 'admire':
        // Walk over, then emote at it.
        this.state.avatar.queue.unshift({ type: 'emote', emote: this.rng.pick(['love', 'happy', 'proud'] as const)! });
        return { type: 'walk', x: spot.x, y: spot.y, say };
      case 'plant': {
        let species = step.species;
        if (!species || species === 'any' || !this.registry.species.has(species)) {
          species = this.rng.pick([...this.registry.species.keys()]);
        }
        if (!species) return null;
        return { type: 'plant', x: spot.x, y: spot.y, species, say };
      }
      default: {
        const action: PlannedAction = { type: step.action, x: spot.x, y: spot.y, say };
        const plant = this.tile(spot.x, spot.y).plant;
        if (plant) action.expectPlant = plant.uid;
        return action;
      }
    }
  }

  select(selector: Selector): { x: number; y: number } | null {
    const rules = this.registry.rules;
    const all = this.allCoords().filter((c) => !this.isMailbox(c.x, c.y));
    const alive = this.plantCoords((p) => p.health > 0);
    switch (selector) {
      case 'driest_plant':
        return this.driest(alive.filter((c) => this.tile(c.x, c.y).moisture < rules.wiltThreshold + 35)) ?? null;
      case 'random_plant':
        return this.rng.pick(alive) ?? null;
      case 'wilting_plant':
        return this.rng.pick(alive.filter((c) => this.tile(c.x, c.y).plant!.health < 60 || this.tile(c.x, c.y).moisture < rules.wiltThreshold)) ?? null;
      case 'ripe_plant':
        return this.rng.pick(alive.filter((c) => this.tile(c.x, c.y).plant!.growth >= 1)) ?? null;
      case 'dead_plant':
        return this.rng.pick(this.plantCoords((p) => p.health <= 0)) ?? null;
      case 'youngest_plant': {
        let best: { x: number; y: number } | null = null;
        for (const c of alive) if (!best || this.tile(c.x, c.y).plant!.growth < this.tile(best.x, best.y).plant!.growth) best = c;
        return best;
      }
      case 'empty_tilled':
        return this.rng.pick(all.filter((c) => this.tile(c.x, c.y).tilled && !this.tile(c.x, c.y).plant)) ?? null;
      case 'untilled':
        return this.rng.pick(all.filter((c) => !this.tile(c.x, c.y).tilled && !this.tile(c.x, c.y).plant)) ?? null;
      case 'random_tile':
        return this.rng.pick(all) ?? null;
      case 'mailbox': {
        const { x, y } = this.state.mailbox;
        return { x: x > 0 ? x - 1 : x + 1, y };
      }
    }
  }

  private allCoords(): { x: number; y: number }[] {
    const out = [];
    for (let y = 0; y < this.state.height; y++) for (let x = 0; x < this.state.width; x++) out.push({ x, y });
    return out;
  }

  private plantCoords(pred: (p: Plant) => boolean): { x: number; y: number }[] {
    return this.allCoords().filter((c) => {
      const p = this.tile(c.x, c.y).plant;
      return p !== null && pred(p);
    });
  }

  private driest(coords: { x: number; y: number }[]): { x: number; y: number } | undefined {
    let best: { x: number; y: number } | undefined;
    for (const c of coords) if (!best || this.tile(c.x, c.y).moisture < this.tile(best.x, best.y).moisture) best = c;
    return best;
  }
}

// ---------------------------------------------------------------- helpers

type DistributiveOmit<T, K extends keyof any> = T extends unknown ? Omit<T, K> : never;

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

function defaultSelector(action: RoutineStep['action']): Selector {
  switch (action) {
    case 'water':
      return 'driest_plant';
    case 'harvest':
      return 'ripe_plant';
    case 'cut':
      return 'dead_plant';
    case 'till':
      return 'untilled';
    case 'plant':
    case 'fertilize':
      return 'empty_tilled';
    case 'admire':
      return 'random_plant';
    default:
      return 'random_tile';
  }
}

function actionTile(a: Action): { x: number; y: number } | null {
  return 'x' in a ? { x: a.x, y: a.y } : null;
}

function moveTowards(p: { x: number; y: number }, tx: number, ty: number, dist: number): boolean {
  const dx = tx - p.x;
  const dy = ty - p.y;
  const d = Math.hypot(dx, dy);
  if (d <= dist || d < 1e-6) {
    p.x = tx;
    p.y = ty;
    return true;
  }
  p.x += (dx / d) * dist;
  p.y += (dy / d) * dist;
  return false;
}

export function stripInternal(a: PlannedAction): Action {
  const { expectPlant: _drop, ...rest } = a;
  return rest as Action;
}
