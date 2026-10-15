// The offline gardener: no AI at all. Planning is delegated to the world's own
// offlinePlan(); "code rewrites" make a small deterministic edit at a marker
// comment so the whole workshop → gates → swap pipeline can be tried for free.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentProvider } from './types.ts';

const MARKER = '// @offline-workshop:species';
const NAMES = ['Shed Fern', 'Midnight Turnip', 'Clockwork Daisy', 'Static Thistle', 'Hum Lily', 'Patchwork Pea'];
const SHAPES = ['flower', 'bush', 'crystal', 'mushroom', 'grass', 'tree'];

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

export const offlineProvider: AgentProvider = {
  info: {
    id: 'offline',
    name: 'Offline gardener (no AI)',
    kind: 'offline',
    description: 'Built-in rules from the world itself. No AI calls; its "code rewrites" add a plant to the world source.',
    modelSuggestions: [],
    defaultModel: '',
  },
  async available() {
    return { ok: true, detail: 'always available' };
  },
  async complete(req) {
    if (!req.offline) throw new Error('the offline gardener needs the world to provide offlinePlan()');
    return JSON.stringify(await req.offline());
  },
  async edit(req) {
    const file = join(req.cwd, 'src', 'game', 'content.ts');
    if (!existsSync(file)) return 'I looked for the seed catalogue (src/game/content.ts) but it was gone. I did nothing.';
    const src = readFileSync(file, 'utf8');
    if (!src.includes(MARKER)) return 'The seed catalogue has no workshop marker any more, so I left it alone.';
    const h = hash(`${req.instructions}#${src.length}`);
    const name = NAMES[h % NAMES.length];
    const id = `${name.toLowerCase().replace(/[^a-z]+/g, '-')}-${(h % 997).toString(36)}`;
    const hue = (n: number) => `#${(((h >>> n) & 0xffffff) | 0x404040).toString(16).padStart(6, '0').slice(-6)}`;
    const entry = `{
    id: '${id}',
    name: '${name}',
    description: 'Built in the shed from a letter.',
    growMinutes: ${20 + (h % 60)},
    thirstPerMinute: 0.3,
    idealMoisture: [25, 80],
    shape: '${SHAPES[h % SHAPES.length]}',
    colors: { stem: '${hue(1)}', leaf: '${hue(5)}', bloom: '${hue(9)}' },
    regrows: true,
    glow: ${h % 2 === 0},
    source: base,
  },
  ${MARKER}`;
    writeFileSync(file, src.replace(MARKER, entry));
    return `I spent the night in the shed and taught the garden a brand new plant: the ${name}.`;
  },
};
