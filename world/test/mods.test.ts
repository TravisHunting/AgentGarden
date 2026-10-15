import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ModManager, type ModOp } from '../src/mods/manager.ts';
import { ModRuntime } from '../src/mods/runtime.ts';
import { validateManifest, validateScript, type ModManifest } from '../src/mods/schema.ts';
import { buildRegistry } from '../src/game/registry.ts';
import { Garden, createGardenState } from '../src/game/engine.ts';

const moonCarrots: ModManifest = {
  id: 'moon-carrots',
  name: 'Moon Carrots',
  version: 1,
  description: 'Carrots that grow by moonlight.',
  enabled: true,
  species: [
    {
      id: 'moon-carrot',
      name: 'Moon Carrot',
      growMinutes: 20,
      thirstPerMinute: 0.1,
      idealMoisture: [10, 90],
      shape: 'root',
      colors: { stem: '#334455', leaf: '#8899ff', bloom: '#ddeeff' },
      regrows: false,
      glow: true,
      sprite: 'moon-carrot',
    },
  ],
  weather: [
    {
      id: 'moonbeams',
      name: 'Moonbeams',
      moisturePerMinute: 0.2,
      growthMultiplier: 2,
      particles: 'sparkles',
      tint: 'rgba(30,30,90,0.3)',
      weight: 1,
      minMinutes: 5,
      maxMinutes: 10,
    },
  ],
  rules: { growthRate: 1.5 },
  sprites: {
    'moon-carrot': { w: 4, h: 4, palette: { a: '#aabbff' }, frames: [['.aa.', 'aaaa', 'aaaa', '.aa.']], fps: 0 },
  },
  sounds: { twinkle: { wave: 'sine', notes: [{ freq: 880, dur: 0.1 }, { freq: 1320, dur: 0.2, vol: 0.4 }] } },
};

function tempMods() {
  return new ModManager(mkdtempSync(join(tmpdir(), 'garden-mods-')));
}

test('valid manifest passes; errors are path-addressed', () => {
  assert.deepEqual(validateManifest(moonCarrots).errors, []);
  const bad = structuredClone(moonCarrots) as any;
  bad.species[0].shape = 'cube';
  bad.sprites['moon-carrot'].frames[0][1] = 'aaXa';
  bad.rules.growthRate = 999;
  bad.sprites['moon-carrot'].frames.push(['.aa.', 'aZaa']);
  const { errors } = validateManifest(bad);
  assert.ok(errors.some((e) => e.startsWith('$.species[0].shape:')), errors.join('\n'));
  assert.ok(errors.some((e) => e.startsWith('$.sprites.moon-carrot.frames[0][1]:') && e.includes('"X"')));
  assert.ok(errors.some((e) => e.startsWith('$.rules.growthRate:')));
  // A short frame reports its row count AND the bad character inside it.
  assert.ok(errors.some((e) => e === '$.sprites.moon-carrot.frames[1]: must have exactly 4 rows (got 2)'), errors.join('\n'));
  assert.ok(errors.some((e) => e.startsWith('$.sprites.moon-carrot.frames[1][1]:') && e.includes('"Z"')));
});

test('script static checks', () => {
  assert.deepEqual(validateScript('function onTick(api, dt) { api.say("hi") }'), []);
  assert.ok(validateScript('function onTick(api) { process.exit() }')[0].includes('process'));
  assert.ok(validateScript('const x = 1')[0].includes('must define'));
});

test('manager applies ops, layers registry, trashes deletes', () => {
  const mm = tempMods();
  const results = mm.apply([{ op: 'create', manifest: moonCarrots, note: 'because the player asked for magic' }]);
  assert.equal(results[0].ok, true, JSON.stringify(results));
  const reg = buildRegistry(mm.layers());
  assert.equal(reg.species.get('moon-carrot')?.source, 'moon-carrots');
  assert.equal(reg.rules.growthRate, 1.5);
  assert.ok(mm.assets().sounds.twinkle);

  const dup = mm.apply([{ op: 'create', manifest: moonCarrots, note: 'again' }]);
  assert.equal(dup[0].ok, false);
  assert.ok(dup[0].errors![0].includes('already exists'));

  mm.apply([{ op: 'disable', id: 'moon-carrots', note: 'too powerful' }]);
  assert.equal(buildRegistry(mm.layers()).species.has('moon-carrot'), false);

  mm.apply([{ op: 'delete', id: 'moon-carrots', note: 'gone' } as ModOp]);
  assert.equal(existsSync(join(mm.dir, 'moon-carrots')), false);
  assert.equal(mm.mods.length, 0);
});

test('runtime runs hooks and auto-disables failing scripts', () => {
  const registry = buildRegistry();
  const garden = new Garden(createGardenState(5, registry), registry);
  const rt = new ModRuntime(garden);
  const failures: string[] = [];
  rt.onFailure = (id, err) => failures.push(`${id}: ${err}`);
  rt.load([
    {
      modId: 'drizzle',
      source: `function onTick(api, dt) {
        const s = api.getStore(); s.n = (s.n || 0) + 1; api.setStore(s);
        api.setMoisture(0, 0, 77);
      }`,
    },
    { modId: 'broken', source: 'function onTick(api) { api.nope() }' },
    { modId: 'spinner', source: 'function onTick(api) { while (true) {} }' },
  ]);
  garden.simulate(5, 1);
  assert.equal(garden.tile(0, 0).moisture > 70, true);
  assert.ok((garden.state.modStore.drizzle as any).n >= 4);
  assert.ok(failures.some((f) => f.startsWith('broken')));
  assert.ok(failures.some((f) => f.startsWith('spinner')));
});

