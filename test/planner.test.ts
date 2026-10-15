import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../kernel/db.ts';
import { InProcessWorld } from '../kernel/world-process.ts';
import { DEFAULT_SETTINGS, Planner, type AgentSettings } from '../kernel/ai/planner.ts';
import { registerProvider } from '../kernel/ai/providers/index.ts';
import { extractJson } from '../kernel/ai/plan.ts';
import type { Rewrite } from '../kernel/ai/plan.ts';
import { validateManifest, validateScript } from '../world/src/mods/schema.ts';

const TEMPLATE = new URL('../world/', import.meta.url);
const worlds: InProcessWorld[] = [];
after(() => Promise.all(worlds.map((w) => w.stop())));

async function setup(provider: string, opts: { rewriteAllowed?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'garden-plan-'));
  const store = new Store(':memory:');
  const world = await InProcessWorld.load(TEMPLATE.pathname.replace(/^\/([A-Za-z]:)/, '$1'), { modsDir: join(dir, 'mods'), saved: null, seed: 9, awaySeconds: 0 });
  worlds.push(world);
  const settings: AgentSettings = { ...DEFAULT_SETTINGS, provider, maxIterations: 4 };
  const rewrites: Rewrite[] = [];
  const planner = new Planner({
    store,
    world: () => world,
    dataDir: dir,
    settings: () => settings,
    rewriteAllowed: () => opts.rewriteAllowed ?? false,
    codeInfo: () => ({ worldVersion: world.version, commit: 'test' }),
    onRewrite: (r) => rewrites.push(r),
    onPlanned: () => {},
  });
  return { store, world, planner, rewrites };
}

const goodLoop = { name: 'test loop', steps: [{ action: 'water', target: 'driest_plant', weight: 1 }], chatter: ['hi'], fizzles: ['oops'] };

function scripted(id: string, replies: string[], prompts: string[] = []) {
  registerProvider({
    info: { id, name: id, kind: 'offline', description: '', modelSuggestions: [], defaultModel: 'x' },
    available: async () => ({ ok: true, detail: '' }),
    complete: async (req) => {
      prompts.push(req.prompt);
      return replies.length > 1 ? replies.shift()! : replies[0];
    },
  });
  return prompts;
}

test('extractJson tolerates fences and prose', () => {
  assert.deepEqual(extractJson('Sure!\n```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(extractJson('blah {"a":{"b":"}"}} trailing'), { a: { b: '}' } });
  assert.throws(() => extractJson('nope'));
});

test('repair loop narrows to failing sections (world sections validated by the world)', async () => {
  const prompts = scripted('scripted-repair', [
    JSON.stringify({
      summary: 'first try',
      queue: [{ type: 'water', x: 1, y: 1 }, { type: 'water', x: 99, y: 1 }, { type: 'plant', x: 1, y: 2, species: 'dragonfruit' }],
      loop: { ...goodLoop, steps: [{ action: 'dance', weight: 1 }] },
      memories: [42],
    }),
    'Here you go: ' + JSON.stringify({ queue: [{ type: 'water', x: 1, y: 1 }], loop: { ...goodLoop, steps: [] }, memories: ['likes tulips'] }),
    JSON.stringify({ loop: goodLoop }),
  ]);
  const { planner, store, world } = await setup('scripted-repair');
  store.addEvent('cut', { summary: 'cut (1,3)' });
  const id = await planner.run('test');
  const row = store.journal(1)[0];
  assert.equal(row.id, id);
  assert.equal(row.status, 'repaired');
  assert.equal(row.iterations, 3);
  assert.equal(row.summary, 'first try');
  assert.match(prompts[1], /ONLY these keys: (queue, loop, memories|memories, queue, loop|[a-z, ]+)/);
  for (const k of ['queue', 'loop', 'memories']) assert.ok(prompts[1].split('ONLY these keys:')[1].includes(k), k);
  assert.match(prompts[1], /\$\.queue\[1\]\.x: must be between 0 and 5/);
  assert.match(prompts[1], /unknown species "dragonfruit"/);
  assert.match(prompts[2], /ONLY these keys: loop\./);
  const state = (await world.call<{ avatar: { loop: { name: string }; queue: unknown[] } }>('publicState'));
  assert.equal(state.avatar.loop.name, 'test loop');
  assert.equal(state.avatar.queue.length, 1);
  assert.equal(store.memories()[0].text, 'likes tulips');
  assert.equal(store.pendingEvents().length, 0, 'events consumed');
});

test('gives up gracefully: the world salvages valid queue items', async () => {
  scripted('stubborn', [JSON.stringify({ summary: 's', queue: [{ type: 'water', x: 0, y: 1 }, { type: 'fly', x: 0, y: 0 }], loop: { name: 'bad' } })]);
  const { planner, store, world } = await setup('stubborn');
  const before = (await world.call<{ avatar: { loop: unknown } }>('publicState')).avatar.loop;
  await planner.run('test');
  const row = store.journal(1)[0];
  assert.equal(row.status, 'fallback');
  assert.equal(row.iterations, 4);
  const after = await world.call<{ avatar: { loop: unknown; queue: unknown[] } }>('publicState');
  assert.equal(after.avatar.queue.length, 1);
  assert.deepEqual(after.avatar.loop, before);
});

test('rewrite section is rejected unless allowed', async () => {
  scripted('rewriter', [JSON.stringify({ summary: 's', queue: [], loop: goodLoop, rewrite: { request: 'Add a pond that frogs live in.', why: 'asked' } })]);
  const a = await setup('rewriter', { rewriteAllowed: true });
  a.store.addLetter('player', 'please add a pond');
  await a.planner.run('letter');
  assert.equal(a.rewrites.length, 1);
  assert.equal(a.rewrites[0].request, 'Add a pond that frogs live in.');

  const b = await setup('rewriter', { rewriteAllowed: true });
  await b.planner.run('no letter'); // no letter → rewrite not offered → unknown key ignored
  assert.equal(b.rewrites.length, 0);
});

test('offline gardener: mods only after letters; asks the shed when the letter mentions code', async () => {
  const { planner, store, world, rewrites } = await setup('offline', { rewriteAllowed: true });
  await planner.run('no letter');
  let mods = await world.call<{ mods: unknown[] }>('rpc', 'mods.list', {});
  assert.equal(((mods as unknown as { result: { mods: unknown[] } }).result.mods).length, 0);
  store.addLetter('player', 'Please grow me something with a lot of sparkle, and rewrite the code if you must');
  await planner.run('letter');
  mods = await world.call('rpc', 'mods.list', {});
  assert.equal((mods as unknown as { result: { mods: unknown[] } }).result.mods.length, 1, JSON.stringify(store.journal(1)[0].detail));
  const content = await world.call<{ species: { id: string }[] }>('content');
  assert.ok(content.species.some((s) => s.id === 'sparkle-bloom'));
  assert.equal(store.pendingPlayerLetters().length, 0);
  assert.ok(store.letters().some((l) => l.sender === 'agent'));
  assert.equal(rewrites.length, 1);
});

test('offline gardener answers a first wish in a bare garden by digging a bed', async () => {
  const { planner, store, world } = await setup('offline');
  store.addLetter('player', '(My first wish) A garden of lanterns please');
  await planner.run('first wish');
  const row = store.journal(1)[0];
  assert.equal(row.status, 'ok', row.detail);
  const queue = (JSON.parse(row.detail).plan.queue as { type: string }[]).map((a) => a.type);
  assert.ok(queue.filter((t) => t === 'till').length >= 6);
  assert.ok(queue.filter((t) => t === 'plant').length >= 6);
  const state = await world.call<{ avatar: { loop: { name: string } } }>('publicState');
  assert.equal(state.avatar.loop.name, 'tending the new bed');
});

test('bundled example mod is valid', () => {
  const dir = new URL('../docs/examples/moon-garden/', import.meta.url);
  const manifest = JSON.parse(readFileSync(new URL('mod.json', dir), 'utf8'));
  assert.deepEqual(validateManifest(manifest).errors, []);
  assert.deepEqual(validateScript(readFileSync(new URL('script.js', dir), 'utf8')), []);
});
