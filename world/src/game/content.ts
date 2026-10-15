// Built-in content. Mods layer on top of (and may override) everything here.

import type { CreatureDef, RoutineLoop, Rules, SpeciesDef, WeatherDef } from './types.ts';

export const BASE_RULES: Rules = {
  growthRate: 1,
  evaporationPerMinute: 1.2,
  wiltThreshold: 15,
  drownThreshold: 95,
  avatarSpeed: 1.6,
  actionSeconds: 2.5,
  weatherChangeMinutes: 45,
  maxCreatures: 6,
  chatterSeconds: 90,
  waterAmount: 40,
};

// Hard limits that mods (and therefore the AI) may not push rules beyond.
export const RULE_BOUNDS: Record<keyof Rules, [number, number]> = {
  growthRate: [0.05, 20],
  evaporationPerMinute: [0, 20],
  wiltThreshold: [0, 60],
  drownThreshold: [40, 100],
  avatarSpeed: [0.2, 8],
  actionSeconds: [0.5, 20],
  weatherChangeMinutes: [2, 600],
  maxCreatures: [0, 30],
  chatterSeconds: [15, 3600],
  waterAmount: [5, 100],
};

const base = 'base';

export const BASE_SPECIES: SpeciesDef[] = [
  {
    id: 'carrot',
    name: 'Carrot',
    growMinutes: 90,
    thirstPerMinute: 0.4,
    idealMoisture: [35, 75],
    shape: 'root',
    colors: { stem: '#3f8f3a', leaf: '#5fbf4a', bloom: '#f08a24' },
    regrows: false,
    source: base,
  },
  {
    id: 'sunflower',
    name: 'Sunflower',
    growMinutes: 240,
    thirstPerMinute: 0.6,
    idealMoisture: [30, 70],
    shape: 'flower',
    colors: { stem: '#4c8b2b', leaf: '#6cae3a', bloom: '#ffd23f' },
    regrows: false,
    source: base,
  },
  {
    id: 'tomato',
    name: 'Tomato',
    growMinutes: 180,
    thirstPerMinute: 0.7,
    idealMoisture: [45, 85],
    shape: 'vine',
    colors: { stem: '#3d7a2a', leaf: '#58a541', bloom: '#e5383b' },
    regrows: true,
    source: base,
  },
  {
    id: 'lavender',
    name: 'Lavender',
    growMinutes: 150,
    thirstPerMinute: 0.25,
    idealMoisture: [20, 55],
    shape: 'bush',
    colors: { stem: '#5c7d5a', leaf: '#8fae8b', bloom: '#9b7fd4' },
    regrows: true,
    source: base,
  },
  {
    id: 'pumpkin',
    name: 'Pumpkin',
    growMinutes: 360,
    thirstPerMinute: 0.8,
    idealMoisture: [45, 85],
    shape: 'vine',
    colors: { stem: '#3a6b28', leaf: '#4f9a35', bloom: '#f28c28' },
    regrows: false,
    source: base,
  },
  {
    id: 'clover',
    name: 'Clover',
    growMinutes: 30,
    thirstPerMinute: 0.2,
    idealMoisture: [25, 80],
    shape: 'grass',
    colors: { stem: '#2f7d32', leaf: '#4caf50', bloom: '#f2f2f2' },
    regrows: true,
    source: base,
  },
  // @offline-workshop:species (the offline gardener's demo code rewrites insert species here)
];

export const BASE_CREATURES: CreatureDef[] = [
  {
    id: 'bee',
    name: 'Bee',
    behaviour: 'pollinator',
    shape: 'bug',
    colors: { body: '#f6c90e', accent: '#2b2b2b' },
    speed: 1.2,
    spawnPerHour: 3,
    maxCount: 2,
    lifeMinutes: 20,
    source: base,
  },
  {
    id: 'snail',
    name: 'Snail',
    behaviour: 'pest',
    shape: 'snail',
    colors: { body: '#b48a5a', accent: '#d9c2a5' },
    speed: 0.15,
    spawnPerHour: 0.6,
    maxCount: 1,
    lifeMinutes: 40,
    source: base,
  },
  {
    id: 'robin',
    name: 'Robin',
    behaviour: 'wander',
    shape: 'bird',
    colors: { body: '#7a5230', accent: '#e4572e' },
    speed: 1.8,
    spawnPerHour: 1,
    maxCount: 1,
    lifeMinutes: 10,
    source: base,
  },
];

export const BASE_WEATHER: WeatherDef[] = [
  {
    id: 'sunny',
    name: 'Sunny',
    moisturePerMinute: -0.4,
    growthMultiplier: 1.1,
    particles: 'none',
    tint: null,
    weight: 5,
    minMinutes: 20,
    maxMinutes: 90,
    source: base,
  },
  {
    id: 'cloudy',
    name: 'Cloudy',
    moisturePerMinute: 0,
    growthMultiplier: 0.9,
    particles: 'none',
    tint: 'rgba(90,100,120,0.18)',
    weight: 3,
    minMinutes: 15,
    maxMinutes: 60,
    source: base,
  },
  {
    id: 'rain',
    name: 'Rain',
    moisturePerMinute: 2.5,
    growthMultiplier: 1,
    particles: 'rain',
    tint: 'rgba(40,60,110,0.25)',
    weight: 2,
    minMinutes: 5,
    maxMinutes: 30,
    sound: 'rain',
    source: base,
  },
  {
    id: 'breezy',
    name: 'Breezy',
    moisturePerMinute: -0.2,
    growthMultiplier: 1,
    particles: 'leaves',
    tint: null,
    weight: 2,
    minMinutes: 10,
    maxMinutes: 40,
    source: base,
  },
];

export const DEFAULT_LOOP: RoutineLoop = {
  name: 'pottering about',
  steps: [
    { action: 'water', target: 'driest_plant', weight: 5 },
    { action: 'harvest', target: 'ripe_plant', weight: 4 },
    { action: 'cut', target: 'dead_plant', weight: 3 },
    { action: 'till', target: 'untilled', weight: 1 },
    { action: 'plant', target: 'empty_tilled', species: 'any', weight: 2 },
    { action: 'admire', target: 'random_plant', weight: 2 },
    { action: 'wander', target: 'random_tile', weight: 2 },
    { action: 'rest', weight: 1 },
  ],
  chatter: [
    'Lovely day for it.',
    'Grow, my pretties.',
    'I should check the mailbox.',
    'Hm. That one looks thirsty.',
    'Is it me or are the snails getting bolder?',
  ],
  fizzles: [
    'Huh?! It was RIGHT here!',
    'I have been betrayed by the soil.',
    'Well. That plan has wilted.',
    'Nobody saw that. Nobody.',
    '*confused gardener noises*',
  ],
};

/** The routine of a brand-new gardener who doesn't know what to grow yet. */
export const WAITING_LOOP: RoutineLoop = {
  name: 'waiting for your first wish',
  steps: [
    { action: 'wander', target: 'random_tile', weight: 4 },
    { action: 'wander', target: 'mailbox', weight: 2 },
    { action: 'rest', weight: 2 },
    { action: 'say', weight: 1 },
  ],
  chatter: [
    'What kind of garden should I grow? Tell me in a letter!',
    'So much lawn. So many possibilities. Any requests?',
    'I have seeds, a trowel, and absolutely no plan yet.',
    'The mailbox is right there… just saying.',
    'Roses? Radishes? Something that glows? You decide!',
  ],
  fizzles: DEFAULT_LOOP.fizzles,
};

/** Said when the player hasn't done anything or written in a long while. */
export const LONELY_LINES = [
  'The mailbox has been awfully quiet…',
  '*checks the mailbox* …nothing. *sigh*',
  'If you are out there, a letter would make my day.',
  'I could use a new idea. Or a hand with the watering.',
  'Talking to the carrots again. They are poor conversationalists.',
  'Is it something I planted?',
];
