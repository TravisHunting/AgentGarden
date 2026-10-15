// The offline gardener: a rule-based stand-in for a real agent. It produces a
// sensible, deterministic plan — handy for demos, tests and for playing
// without any AI configured. Owned by the world because it knows the garden.

import { hashString } from '../util/rng.ts';
import type { AgentOpts, KernelAgentContext } from '../contract.ts';
import type { WorldContext } from './context.ts';

const STOP = new Set(['the', 'and', 'please', 'could', 'would', 'some', 'with', 'that', 'this', 'your', 'have', 'from', 'want', 'like', 'more', 'garden', 'dear', 'grow', 'code', 'rewrite', 'shed', 'could', 'should', 'something', 'something', 'make', 'lots', 'thing', 'things', 'thanks', 'just', 'really']);

function keyword(text: string, gardenerName: string): string {
  // Ignore bracketed asides such as the "(My first wish, answering ...)" preamble.
  const words = text.replace(/\([^)]*\)/g, ' ').toLowerCase().match(/[a-z]{4,12}/g) ?? [];
  const name = gardenerName.toLowerCase();
  return words.find((w) => !STOP.has(w) && w !== name) ?? 'wish';
}

function colour(seed: number, shift: number): string {
  const h = (seed + shift * 97) % 360;
  // HSL → hex, fixed saturation/lightness.
  const s = 0.65;
  const l = 0.55;
  const f = (n: number) => {
    const k = (n + h / 30) % 12;
    const c = l - s * Math.min(l, 1 - l) * Math.max(-1, Math.min(k - 3, 9 - k, 1));
    return Math.round(c * 255)
      .toString(16)
      .padStart(2, '0');
  };
  return `#${f(0)}${f(8)}${f(4)}`;
}

export function offlinePlan(kctx: KernelAgentContext, wctx: WorldContext, _opts: AgentOpts): Record<string, unknown> {
    const g = wctx.garden;
    const queue: unknown[] = [];
    const plants = g.plants;
    for (const p of plants.filter((p) => p.health <= 0).slice(0, 2)) queue.push({ type: 'cut', x: p.x, y: p.y, fizzle: 'It was already gone? Spooky.' });
    for (const p of plants.filter((p) => p.growth >= 100 && p.health > 0).slice(0, 2)) queue.push({ type: 'harvest', x: p.x, y: p.y, say: 'Harvest time!' });
    for (const p of [...plants].filter((p) => p.health > 0).sort((a, b) => a.moisture - b.moisture).slice(0, 3)) {
      if (p.moisture < 45) queue.push({ type: 'water', x: p.x, y: p.y, fizzle: `Where did my ${p.species} go?!` });
    }
    const actions = kctx.player.activity;
    const letters = kctx.player.letters;
    if (actions.total > 0) queue.push({ type: 'say', text: `I saw you ${actions.summary}. Noted.` });
    queue.push({ type: 'emote', emote: letters.length ? 'love' : 'happy' });

    const plan: Record<string, unknown> = {
      summary: `Checked on ${plants.length} plants under ${g.weather.name.toLowerCase()} skies. ${
        actions.total ? `The player was busy (${actions.summary}).` : 'Quiet day.'
      } ${letters.length ? `They left ${letters.length} letter(s), which I read twice.` : ''}`.trim(),
      queue,
      loop: {
        name: 'offline pottering',
        steps: [
          { action: 'water', target: 'driest_plant', weight: 5 },
          { action: 'harvest', target: 'ripe_plant', weight: 4 },
          { action: 'cut', target: 'dead_plant', weight: 3 },
          { action: 'plant', target: 'empty_tilled', species: 'any', weight: 2 },
          { action: 'admire', target: 'random_plant', weight: 2 },
          { action: 'wander', target: 'random_tile', weight: 1 },
          { action: 'rest', weight: 1 },
        ],
        chatter: ['Just me and the worms.', 'Photosynthesis is a team sport.', 'I wonder what the player is up to.'],
        fizzles: ['Who moved my plant?!', 'I meant to do that.', 'The garden is gaslighting me.'],
      },
      letter: null,
      memories: [],
      forget: [],
      rewrite: null,
      desires: kctx.you.desires.length ? kctx.you.desires : ['to grow something nobody has seen before'],
      mods: [],
    };

    if (letters.length) {
      const text = letters.map((l) => l.text).join(' ');
      const word = keyword(text, kctx.you.name);
      const seed = hashString(text);
      const id = `wish-${word}`.slice(0, 40);
      plan.letter = `Dear gardener-friend, your letter about "${word}" made my leaves curl with joy. I have done something about it. Go and look! — ${kctx.you.name}`;
      plan.memories = [`The player wrote to me about "${word}".`];
      const exists = wctx.mods.some((m) => m.id === id);
      plan.mods = [
        {
          op: exists ? 'update' : 'create',
          note: `The player mentioned "${word}", so I grew it.`,
          manifest: {
            id,
            name: `Wish: ${word}`,
            version: (wctx.mods.find((m) => m.id === id)?.version ?? 0) + 1,
            description: `A plant conjured from a letter about ${word}.`,
            author: kctx.you.name,
            enabled: true,
            species: [
              {
                id: `${word}-bloom`.slice(0, 40),
                name: `${word[0].toUpperCase()}${word.slice(1)} Bloom`,
                growMinutes: 30,
                thirstPerMinute: 0.3,
                idealMoisture: [25, 80],
                shape: (['flower', 'bush', 'crystal', 'mushroom'] as const)[seed % 4],
                colors: { stem: colour(seed, 1), leaf: colour(seed, 2), bloom: colour(seed, 3) },
                regrows: true,
                glow: seed % 2 === 0,
              },
            ],
            sounds: { chime: { wave: 'triangle', notes: [{ freq: 660, dur: 0.08 }, { freq: 990, dur: 0.12 }, { freq: 1320, dur: 0.2, vol: 0.4 }] } },
          },
        },
      ];
      // Ask the workshop for a code rewrite when the player talks about code.
      if (kctx.code.rewritesAllowed && /\b(code|rewrite|reprogram|shed)\b/i.test(text)) {
        plan.rewrite = { request: `Add a new plant inspired by the player's letter about "${word}".`, why: 'They asked me to change how the garden works.' };
      }
      const wishSpecies = `${word}-bloom`.slice(0, 40);
      if (g.plants.length + g.emptyTilled.length < 6) {
        // A bare garden: dig a first bed in the middle and plant the wish alongside a few classics.
        const bed: { x: number; y: number }[] = [];
        const cx = Math.floor(g.width / 2) - 2;
        const cy = Math.floor(g.height / 2) - 1;
        for (let y = cy; y < cy + 2; y++) for (let x = cx; x < cx + 4; x++) if (!(x === g.mailbox.x && y === g.mailbox.y)) bed.push({ x, y });
        const classics = ['sunflower', 'carrot', 'lavender', 'clover'].filter((id) => wctx.content.species.some((s) => s.id === id));
        const firstBed: unknown[] = [{ type: 'say', text: 'Right! Let us dig a proper bed.' }];
        for (const t of bed) firstBed.push({ type: 'till', x: t.x, y: t.y });
        bed.forEach((t, i) => {
          const species = i % 2 === 0 ? wishSpecies : (classics[(i >> 1) % Math.max(1, classics.length)] ?? wishSpecies);
          firstBed.push({ type: 'plant', x: t.x, y: t.y, species, ...(i === 0 ? { say: 'A little something from your letter...' } : {}) });
        });
        plan.queue = [...firstBed, { type: 'emote', emote: 'proud' }];
        plan.loop = { ...(plan.loop as Record<string, unknown>), name: 'tending the new bed' };
      } else {
        const empty = g.emptyTilled[0];
        if (empty) (plan.queue as unknown[]).unshift({ type: 'plant', x: empty.x, y: empty.y, species: wishSpecies, say: 'A little something from your letter...' });
      }
    }
    return plan;
}
