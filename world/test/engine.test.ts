import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Garden, LONELY_AFTER_S, createGardenState } from '../src/game/engine.ts';
import { LONELY_LINES, WAITING_LOOP } from '../src/game/content.ts';
import { buildRegistry } from '../src/game/registry.ts';
import { Rng } from '../src/util/rng.ts';
import type { GameEvent } from '../src/game/types.ts';

function fresh(seed = 42) {
  const registry = buildRegistry();
  const garden = new Garden(createGardenState(seed, registry), registry);
  return { garden, registry };
}

test('rng is deterministic and resumable', () => {
  const a = new Rng(7);
  const seq = [a.next(), a.next()];
  const b = new Rng(7);
  assert.deepEqual([b.next(), b.next()], seq);
  const c = new Rng(a.state);
  assert.equal(c.next(), a.next());
});

test('simulation is deterministic for a given seed', () => {
  const a = fresh(1).garden;
  const b = fresh(1).garden;
  a.simulate(3600, 1);
  b.simulate(3600, 1);
  assert.deepEqual(a.state, b.state);
});

test('player actions respect preconditions', () => {
  const { garden } = fresh();
  garden.state.tiles.forEach((t) => ((t.plant = null), (t.tilled = false)));
  assert.equal(garden.apply({ type: 'plant', x: 0, y: 5, species: 'carrot' }, 'player').ok, false);
  assert.equal(garden.apply({ type: 'till', x: 0, y: 5 }, 'player').ok, true);
  assert.equal(garden.apply({ type: 'plant', x: 0, y: 5, species: 'nope' }, 'player').ok, false);
  assert.equal(garden.apply({ type: 'plant', x: 0, y: 5, species: 'carrot' }, 'player').ok, true);
  assert.equal(garden.apply({ type: 'harvest', x: 0, y: 5 }, 'player').reason, 'it is not ripe yet');
  const { x, y } = garden.state.mailbox;
  assert.equal(garden.apply({ type: 'till', x, y }, 'player').reason, 'that is the mailbox');
  assert.equal(garden.apply({ type: 'cut', x: 0, y: 5 }, 'player').ok, true);
  assert.equal(garden.tile(0, 5).plant, null);
});

test('avatar fizzles when the player cuts the plant it planned to water', () => {
  const { garden } = fresh();
  garden.state.tiles.forEach((t) => (t.plant = null));
  garden.tile(0, 9).tilled = true;
  garden.tile(0, 9).plant = garden.newPlant('carrot');
  garden.state.avatar.x = 5;
  garden.state.avatar.y = 0;
  garden.setPlan([{ type: 'water', x: 0, y: 9, fizzle: 'MY CARROT!' }], garden.state.avatar.loop);
  const events: GameEvent[] = [];
  garden.onEvent((e) => events.push(e));
  garden.tick(0.5); // starts walking
  garden.apply({ type: 'cut', x: 0, y: 9 }, 'player');
  garden.simulate(20, 0.25);
  const fizzle = events.find((e) => e.kind === 'fizzle');
  assert.ok(fizzle, 'expected a fizzle event');
  assert.equal(fizzle.kind === 'fizzle' && fizzle.text, 'MY CARROT!');
  assert.equal(fizzle.kind === 'fizzle' && fizzle.reason, 'the plant is gone');
});

test('queued actions run before the loop and succeed', () => {
  const { garden } = fresh();
  garden.state.tiles.forEach((t) => (t.plant = null));
  garden.setPlan(
    [
      { type: 'till', x: 2, y: 2 },
      { type: 'plant', x: 2, y: 2, species: 'sunflower' },
      { type: 'say', text: 'Grow!' },
    ],
    garden.state.avatar.loop,
  );
  const said: string[] = [];
  garden.onEvent((e) => e.kind === 'bubble' && said.push(e.text));
  garden.simulate(30, 0.25);
  assert.equal(garden.tile(2, 2).plant?.species, 'sunflower');
  assert.ok(said.includes('Grow!'));
});

test('plants dry out and die without water, then the loop cuts them', () => {
  const { garden } = fresh();
  garden.state.avatar.loop = { name: 'cutter', steps: [{ action: 'cut', target: 'dead_plant', weight: 1 }], chatter: [], fizzles: [] };
  garden.state.tiles.forEach((t) => ((t.plant = null), (t.moisture = 0)));
  garden.tile(1, 1).tilled = true;
  garden.tile(1, 1).plant = garden.newPlant('tomato');
  garden.simulate(60 * 60, 1);
  assert.equal(garden.tile(1, 1).plant, null);
});

test('loop selectors resolve to valid targets', () => {
  const { garden } = fresh(3);
  for (let i = 0; i < 50; i++) {
    const a = garden.resolveLoopStep();
    assert.equal(garden.check(a) === null || a.type === 'walk' || a.type === 'wait', true, JSON.stringify(a));
  }
});

test('a new garden is a bare lawn and the gardener waits for a wish', () => {
  const { garden } = fresh(11);
  assert.ok(garden.state.tiles.every((t) => !t.tilled && !t.plant));
  assert.equal(garden.state.avatar.loop.name, WAITING_LOOP.name);
  assert.equal(garden.playerIdleSeconds(), Infinity);
  const said: string[] = [];
  garden.onEvent((e) => e.kind === 'bubble' && said.push(e.text));
  garden.simulate(30 * 60, 1);
  assert.ok(garden.state.tiles.every((t) => !t.tilled && !t.plant), 'the waiting gardener does not dig on its own');
  assert.ok(said.some((l) => WAITING_LOOP.chatter.includes(l)), said.join(' | '));
});

test('after a long silence the gardener laments the empty mailbox', () => {
  const { garden } = fresh(12);
  garden.notePlayer();
  const said: string[] = [];
  garden.onEvent((e) => e.kind === 'bubble' && said.push(e.text));
  garden.simulate(LONELY_AFTER_S - 60, 1);
  assert.ok(!said.some((l) => LONELY_LINES.includes(l)), 'not lonely yet');
  garden.simulate(2 * 3600, 1);
  assert.ok(said.some((l) => LONELY_LINES.includes(l)), said.join(' | '));
  garden.notePlayer();
  assert.equal(garden.playerIdleSeconds(), 0);
});

test('the routine loop may carry its own lonely lines', () => {
  const { garden } = fresh(13);
  garden.state.avatar.loop = { ...WAITING_LOOP, chatter: ['chat'], lonely: ['Write to me, you scoundrel!'] };
  garden.notePlayer();
  const said: string[] = [];
  garden.onEvent((e) => e.kind === 'bubble' && said.push(e.text));
  garden.simulate(3 * 3600, 1);
  assert.ok(said.includes('Write to me, you scoundrel!'));
  assert.ok(!said.some((l) => LONELY_LINES.includes(l)));
});
