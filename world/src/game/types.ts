// Core data model shared by the simulation, the AI planner and the mod system.
// Everything in GardenState is plain JSON so it can be snapshotted to SQLite and
// streamed to the browser as-is.

export interface Rules {
  growthRate: number; // global growth multiplier
  evaporationPerMinute: number; // moisture lost from every tile per minute
  wiltThreshold: number; // moisture below which plants lose health
  drownThreshold: number; // moisture above which plants lose health
  avatarSpeed: number; // tiles per second
  actionSeconds: number; // how long a garden action takes the avatar
  weatherChangeMinutes: number; // mean minutes between weather changes
  maxCreatures: number;
  chatterSeconds: number; // minimum seconds between idle chatter bubbles
  waterAmount: number; // moisture added per watering
}

export type PlantShape = 'bush' | 'flower' | 'root' | 'vine' | 'tree' | 'grass' | 'mushroom' | 'crystal';

export interface SpeciesDef {
  id: string;
  name: string;
  description?: string;
  growMinutes: number; // seed → ripe at growthRate 1 in ideal moisture
  thirstPerMinute: number; // moisture the plant drinks per minute
  idealMoisture: [number, number];
  shape: PlantShape;
  colors: { stem: string; leaf: string; bloom: string };
  sprite?: string; // optional sprite id; frames are picked by growth stage
  regrows: boolean; // stays after harvest and grows back from 'young'
  glow?: boolean;
  seedCost?: number; // reserved for future economy
  source: string; // 'base' or the id of the mod that defined it
}

export type CreatureBehaviour = 'wander' | 'pollinator' | 'pest' | 'sprinkler' | 'gardener' | 'sleeper';
export type CreatureShape = 'bug' | 'bird' | 'blob' | 'critter' | 'snail' | 'ghost';

export interface CreatureDef {
  id: string;
  name: string;
  description?: string;
  behaviour: CreatureBehaviour;
  shape: CreatureShape;
  colors: { body: string; accent: string };
  sprite?: string;
  speed: number; // tiles per second
  spawnPerHour: number; // expected spawns per hour while below maxCount
  maxCount: number;
  lifeMinutes: number;
  sound?: string;
  source: string;
}

export type Particles = 'none' | 'rain' | 'snow' | 'petals' | 'sparkles' | 'leaves' | 'fog' | 'embers';

export interface WeatherDef {
  id: string;
  name: string;
  description?: string;
  moisturePerMinute: number; // added to every tile (negative dries)
  growthMultiplier: number;
  particles: Particles;
  tint: string | null; // CSS colour laid over the scene
  weight: number; // relative chance of being picked naturally
  minMinutes: number;
  maxMinutes: number;
  sound?: string;
  source: string;
}

export interface Plant {
  uid: number;
  species: string;
  growth: number; // 0..1, 1 = ripe
  health: number; // 0..100, 0 = dead
  plantedAt: number;
  harvests: number;
  mutation?: { hue?: number; scale?: number; label?: string };
}

export interface Tile {
  tilled: boolean;
  moisture: number; // 0..100
  fertility: number; // 0..100
  plant: Plant | null;
}

export interface Creature {
  uid: number;
  def: string;
  x: number;
  y: number;
  tx: number;
  ty: number;
  bornAt: number;
}

// ----- Actions -----------------------------------------------------------

export type TileActionType = 'till' | 'water' | 'fertilize' | 'plant' | 'cut' | 'harvest';
export type Emote = 'happy' | 'sad' | 'confused' | 'love' | 'sleepy' | 'angry' | 'surprised' | 'proud';
export const EMOTES: readonly Emote[] = ['happy', 'sad', 'confused', 'love', 'sleepy', 'angry', 'surprised', 'proud'];
export const TILE_ACTIONS: readonly TileActionType[] = ['till', 'water', 'fertilize', 'plant', 'cut', 'harvest'];

export interface ActionCommon {
  say?: string; // spoken when the avatar starts this action
  fizzle?: string; // spoken if this action turns out to be impossible
}

export type Action = ActionCommon &
  (
    | { type: 'walk'; x: number; y: number }
    | { type: 'till' | 'water' | 'fertilize' | 'cut' | 'harvest'; x: number; y: number }
    | { type: 'plant'; x: number; y: number; species: string }
    | { type: 'wait'; seconds: number }
    | { type: 'say'; text: string }
    | { type: 'emote'; emote: Emote }
  );

// ----- Routine loop ----------------------------------------------------------

export type Selector =
  | 'driest_plant'
  | 'random_plant'
  | 'wilting_plant'
  | 'ripe_plant'
  | 'dead_plant'
  | 'youngest_plant'
  | 'empty_tilled'
  | 'untilled'
  | 'random_tile'
  | 'mailbox';

export const SELECTORS: readonly Selector[] = [
  'driest_plant',
  'random_plant',
  'wilting_plant',
  'ripe_plant',
  'dead_plant',
  'youngest_plant',
  'empty_tilled',
  'untilled',
  'random_tile',
  'mailbox',
];

export type RoutineActionType = TileActionType | 'wander' | 'rest' | 'admire' | 'say';
export const ROUTINE_ACTIONS: readonly RoutineActionType[] = [
  'till',
  'water',
  'fertilize',
  'plant',
  'cut',
  'harvest',
  'wander',
  'rest',
  'admire',
  'say',
];

export interface RoutineStep {
  action: RoutineActionType;
  target?: Selector;
  species?: string; // for 'plant'; 'any' picks a random known species
  weight: number;
  say?: string;
}

export interface RoutineLoop {
  name: string;
  steps: RoutineStep[];
  chatter: string[]; // lines the avatar mutters while looping
  fizzles: string[]; // generic lines used when something goes wrong
  lonely?: string[]; // lines for when the player has been away a long time (no actions, no letters)
}

// ----- Avatar ----------------------------------------------------------------

export type AvatarMode = 'idle' | 'walking' | 'working' | 'fizzling' | 'resting';

export interface ActiveTask {
  action: Action;
  origin: 'queue' | 'loop';
  phase: 'walk' | 'work';
  remaining: number; // seconds left in the work phase
}

export interface Avatar {
  x: number;
  y: number;
  facing: 1 | -1;
  mode: AvatarMode;
  task: ActiveTask | null;
  queue: Action[];
  loop: RoutineLoop;
  emote: Emote | null;
  emoteUntil: number;
  lastChatterAt: number;
}

// ----- Events ------------------------------------------------------------------

export type GameEvent =
  | { t: number; kind: 'bubble'; text: string; who: 'avatar' }
  | { t: number; kind: 'fizzle'; text: string; action: Action; reason: string }
  | { t: number; kind: 'sound'; sound: string }
  | { t: number; kind: 'action'; actor: 'player' | 'avatar' | 'mod'; action: Action; ok: boolean; reason?: string }
  | { t: number; kind: 'weather'; weather: string }
  | { t: number; kind: 'creature'; creature: string; event: 'spawn' | 'leave' }
  | { t: number; kind: 'plant'; event: 'died' | 'ripe'; x: number; y: number; species: string }
  | { t: number; kind: 'mod'; text: string };

// ----- Whole state -------------------------------------------------------------

export interface GardenState {
  version: 1;
  width: number;
  height: number;
  time: number; // simulated seconds since the garden was created
  rngState: number;
  nextUid: number;
  tiles: Tile[]; // row-major, index = y * width + x
  creatures: Creature[];
  weather: { id: string; until: number };
  avatar: Avatar;
  mailbox: { x: number; y: number };
  inventory: Record<string, number>; // harvested produce by species id
  modStore: Record<string, unknown>; // per-mod persistent scratch space
  /** Simulated time of the player's last action or letter; null until they first interact. */
  lastPlayerAt?: number | null;
}

export interface Registry {
  species: Map<string, SpeciesDef>;
  creatures: Map<string, CreatureDef>;
  weather: Map<string, WeatherDef>;
  rules: Rules;
}
