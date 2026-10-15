// The world's part of the agent context: what the garden looks like right now.

import type { Garden } from '../game/engine.ts';
import type { Action, GameEvent } from '../game/types.ts';
import type { ModManager } from '../mods/manager.ts';
import type { AgentOpts } from '../contract.ts';

export interface WorldContext {
  you: { currentLoop: string; queuedActionsLeft: number; position: { x: number; y: number } };
  garden: {
    width: number;
    height: number;
    mailbox: { x: number; y: number };
    weather: { id: string; name: string; minutesLeft: number };
    rules: Record<string, number>;
    legend: string;
    grid: string[];
    plants: { x: number; y: number; species: string; growth: number; health: number; moisture: number; label?: string }[];
    emptyTilled: { x: number; y: number }[];
    creatures: { def: string; x: number; y: number }[];
    inventory: Record<string, number>;
  };
  happenings: string[];
  content: {
    species: { id: string; name: string; source: string; growMinutes: number; idealMoisture: [number, number] }[];
    creatures: { id: string; name: string; behaviour: string; source: string }[];
    weather: { id: string; name: string; source: string }[];
  };
  mods: { id: string; name?: string; enabled: boolean; version?: number; description?: string; disabledReason?: string; errors: string[]; manifest?: unknown; script?: string }[];
}

export function describeAction(a: Action): string {
  switch (a.type) {
    case 'plant':
      return `plant ${a.species} at (${a.x},${a.y})`;
    case 'say':
      return `say "${a.text}"`;
    case 'emote':
      return `emote ${a.emote}`;
    case 'wait':
      return `wait ${a.seconds}s`;
    default:
      return `${a.type} (${a.x},${a.y})`;
  }
}

function describeEvent(e: GameEvent): string | null {
  switch (e.kind) {
    case 'fizzle':
      return `Your "${describeAction(e.action)}" failed (${e.reason}); you said "${e.text}"`;
    case 'plant':
      return `${e.species} at (${e.x},${e.y}) ${e.event === 'died' ? 'died' : 'became ripe'}`;
    case 'weather':
      return `weather changed to ${e.weather}`;
    case 'creature':
      return `a ${e.creature} ${e.event === 'spawn' ? 'arrived' : 'left'}`;
    case 'mod':
      return `mod: ${e.text}`;
    default:
      return null;
  }
}

export function worldContext(garden: Garden, mods: ModManager, opts: AgentOpts): WorldContext {
  const s = garden.state;
  const reg = garden.registry;
  const grid: string[] = [];
  const plants: WorldContext['garden']['plants'] = [];
  const emptyTilled: { x: number; y: number }[] = [];
  for (let y = 0; y < s.height; y++) {
    let row = '';
    for (let x = 0; x < s.width; x++) {
      const t = garden.tile(x, y);
      if (garden.isMailbox(x, y)) row += 'M';
      else if (t.plant) {
        row += t.plant.health <= 0 ? 'x' : t.plant.growth >= 1 ? '*' : 'p';
        plants.push({
          x,
          y,
          species: t.plant.species,
          growth: Math.round(t.plant.growth * 100),
          health: Math.round(t.plant.health),
          moisture: Math.round(t.moisture),
          ...(t.plant.mutation?.label ? { label: t.plant.mutation.label } : {}),
        });
      } else if (t.tilled) {
        row += '~';
        emptyTilled.push({ x, y });
      } else row += '.';
    }
    grid.push(row);
  }
  const weather = reg.weather.get(s.weather.id);
  return {
    you: {
      currentLoop: s.avatar.loop.name,
      queuedActionsLeft: s.avatar.queue.length,
      position: { x: Math.round(s.avatar.x), y: Math.round(s.avatar.y) },
    },
    garden: {
      width: s.width,
      height: s.height,
      mailbox: s.mailbox,
      weather: { id: s.weather.id, name: weather?.name ?? s.weather.id, minutesLeft: Math.max(0, Math.round((s.weather.until - s.time) / 60)) },
      rules: { ...reg.rules },
      legend: '. grass (untilled), ~ tilled empty soil, p growing plant, * ripe plant, x dead plant, M mailbox. Row 0 is the top.',
      grid,
      plants,
      emptyTilled,
      creatures: s.creatures.map((c) => ({ def: c.def, x: Math.round(c.x), y: Math.round(c.y) })),
      inventory: s.inventory,
    },
    happenings: garden.recent
      .filter((e) => e.kind !== 'action' && e.kind !== 'sound' && e.kind !== 'bubble')
      .slice(-40)
      .map(describeEvent)
      .filter((x): x is string => !!x),
    content: {
      species: [...reg.species.values()].map((sp) => ({ id: sp.id, name: sp.name, source: sp.source, growMinutes: sp.growMinutes, idealMoisture: sp.idealMoisture })),
      creatures: [...reg.creatures.values()].map((c) => ({ id: c.id, name: c.name, behaviour: c.behaviour, source: c.source })),
      weather: [...reg.weather.values()].map((w) => ({ id: w.id, name: w.name, source: w.source })),
    },
    mods: mods.describe().map((m) => ({
      id: m.id,
      name: m.name,
      enabled: m.enabled,
      version: m.version,
      description: m.description,
      disabledReason: m.disabledReason,
      errors: m.errors,
      // Full sources only when the agent is allowed to edit mods (keeps routine prompts small).
      ...(opts.allowMods ? { manifest: m.manifest, script: m.script } : {}),
    })),
  };
}
