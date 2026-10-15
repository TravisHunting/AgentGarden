// World entry point: implements the kernel contract (src/contract.ts).
// Everything in this world folder may be rewritten by the gardener agent —
// as long as this module keeps exporting apiVersion, version and createWorld.

import { appendFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { WORLD_API_VERSION, type AgentOpts, type RpcResult, type World, type WorldInit } from './contract.ts';
import { Garden, createGardenState } from './game/engine.ts';
import { buildRegistry, registryToJSON } from './game/registry.ts';
import type { Action, GardenState, RoutineLoop } from './game/types.ts';
import { ModManager, type ModOp } from './mods/manager.ts';
import { ModRuntime } from './mods/runtime.ts';
import { Checker } from './util/check.ts';
import { checkAction, salvageQueue, validateWorldSection, type PlanEnv } from './agent/plan.ts';
import { worldGuide } from './agent/guide.ts';
import { worldContext } from './agent/context.ts';
import { offlinePlan } from './agent/offline.ts';
import { describeAction } from './agent/context.ts';

export const apiVersion = WORLD_API_VERSION;
/** Bump when GardenState's shape changes, and migrate older saves in createWorld. */
export const version = '1';

const MAX_CATCH_UP_S = 3 * 24 * 3600;
const HISTORY_FILE = '.history.jsonl';

export function createWorld(init: WorldInit): World {
  const mods = new ModManager(init.modsDir);
  mods.load();
  let registry = buildRegistry(mods.layers());
  const saved = init.saved && init.saved.version === version ? (init.saved.state as GardenState) : null;
  // Version '1' is the only one so far; future versions migrate older saves here.
  // Saves from before lastPlayerAt existed: assume the player was around at snapshot time.
  if (saved && saved.lastPlayerAt === undefined) saved.lastPlayerAt = saved.time;
  const garden = new Garden(saved ?? createGardenState(init.seed, registry), registry);
  const runtime = new ModRuntime(garden);

  const history = (modId: string, op: string, note: string) => {
    try {
      appendFileSync(join(mods.dir, HISTORY_FILE), `${JSON.stringify({ created_at: Date.now(), mod_id: modId, op, note })}\n`);
    } catch {
      // history is best-effort
    }
  };

  const reloadContent = () => {
    registry = buildRegistry(mods.layers());
    garden.registry = registry;
    runtime.load(mods.scripts());
    init.emit({ type: 'content' });
  };

  runtime.onFailure = (modId, error) => {
    try {
      mods.setEnabled(modId, false, error.slice(0, 400));
    } catch {
      // mod folder vanished
    }
    history(modId, 'auto-disable', error);
    garden.emit({ kind: 'mod', text: `${modId} was switched off after its script misbehaved` });
    mods.load();
    queueMicrotask(reloadContent);
  };
  runtime.load(mods.scripts());
  mods.watch(() => reloadContent());
  garden.onEvent((event) => init.emit({ type: 'event', event }));

  if (saved && init.awaySeconds > 5) garden.simulate(Math.min(MAX_CATCH_UP_S, init.awaySeconds), 5);

  const env = (): PlanEnv => ({ width: garden.state.width, height: garden.state.height, species: new Set(registry.species.keys()), mods });

  const rpc = (method: string, params: unknown): RpcResult => {
    const p = (params ?? {}) as Record<string, unknown>;
    switch (method) {
      case 'action': {
        const c = new Checker();
        checkAction(c, p.action, '$.action', env(), new Set(registry.species.keys()));
        if (!c.ok) throw new Error(c.errors.join('; '));
        const a = p.action as Action;
        if (a.type === 'say' || a.type === 'emote' || a.type === 'wait' || a.type === 'walk') throw new Error('the player tends the garden directly');
        garden.notePlayer();
        const result = garden.apply(a, 'player');
        return { result, activity: { kind: a.type, summary: `${describeAction(a)}${result.ok ? '' : ` (failed: ${result.reason})`}` } };
      }
      case 'mods.list': {
        let hist: unknown[] = [];
        try {
          hist = readFileSync(join(mods.dir, HISTORY_FILE), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)).reverse().slice(0, 100);
        } catch {
          // no history yet
        }
        return { result: { dir: mods.dir, mods: mods.describe().map(({ script, ...m }) => ({ ...m, scriptLength: script?.length ?? 0 })), history: hist } };
      }
      case 'mods.toggle': {
        const id = String(p.id);
        const enable = p.enabled === true;
        if (!mods.mods.some((m) => m.id === id && m.manifest)) throw new Error('no such mod');
        mods.setEnabled(id, enable);
        mods.load();
        history(id, enable ? 'enable' : 'disable', 'toggled by the player');
        garden.notePlayer();
        reloadContent();
        return { result: { ok: true }, activity: { kind: 'mod', summary: `${enable ? 'enabled' : 'disabled'} the mod "${id}"` } };
      }
      default:
        throw new Error(`unknown rpc method "${method}"`);
    }
  };

  return {
    tick: (dt) => garden.tick(dt),
    snapshot: () => ({ version, state: garden.state }),
    publicState: () => garden.state,
    content: () => ({ ...registryToJSON(registry), ...mods.assets() }),
    rpc,
    notify(kind, data) {
      if (kind === 'letter') {
        garden.notePlayer();
        const spot = garden.select('mailbox');
        if (spot) {
          garden.state.avatar.queue.unshift(
            { type: 'walk', x: spot.x, y: spot.y, say: 'Ooh, mail!' },
            { type: 'emote', emote: 'surprised' },
            { type: 'wait', seconds: 2, say: 'I shall ponder this.' },
          );
        }
        garden.sound('chime');
      } else if (kind === 'workshop') {
        const phase = (data as { phase?: string })?.phase;
        const lines: Record<string, string> = {
          start: 'Off to the shed. Do not wait up.',
          failed: 'The shed is on fire. Metaphorically. Never mind!',
          live: 'I have changed the very fabric of this garden.',
          'rolled-back': 'Hm. Let us pretend that never happened.',
        };
        if (phase && lines[phase]) garden.say(lines[phase]);
      } else if (kind === 'letter-agent') {
        garden.sound('chime');
      }
    },
    agent: {
      sections: (opts: AgentOpts) => [
        { name: 'queue', required: true },
        { name: 'loop', required: true },
        { name: 'mods', required: false },
      ],
      guide: (opts) => worldGuide(opts),
      context: (opts) => worldContext(garden, mods, opts),
      validate: (section, value, ctx) => validateWorldSection(section, value, ctx, env()),
      fallback(section, lastValue, plan) {
        if (section === 'queue') return salvageQueue(lastValue, plan, env());
        return undefined; // loop: keep the current one; mods: whatever was accepted
      },
      apply(plan, opts) {
        const notes: string[] = [];
        const ops = (Array.isArray(plan.mods) ? plan.mods : []) as ModOp[];
        if (ops.length && opts.allowMods) {
          for (const r of mods.apply(ops)) {
            history(r.id, r.op, r.ok ? r.note : `FAILED: ${r.errors?.join('; ')}`);
            garden.emit({ kind: 'mod', text: `${r.ok ? '' : 'failed to '}${r.op} ${r.id}: ${r.note}` });
            notes.push(`${r.ok ? '✔' : '✘'} ${r.op} ${r.id}: ${r.note}${r.errors ? ` (${r.errors.join('; ')})` : ''}`);
          }
          reloadContent();
        }
        const loop = (plan.loop as RoutineLoop | undefined) ?? garden.state.avatar.loop;
        if (!plan.loop) notes.push('kept the previous routine loop');
        garden.setPlan((plan.queue as Action[] | undefined) ?? [], loop);
        return { notes };
      },
      offlinePlan: (kctx, opts) => offlinePlan(kctx, worldContext(garden, mods, opts), opts),
    },
    dispose() {
      mods.close();
    },
  };
}
