// Builds the live content registry: base content first, then each enabled mod
// in load order. Later definitions with the same id override earlier ones.

import { BASE_CREATURES, BASE_RULES, BASE_SPECIES, BASE_WEATHER, RULE_BOUNDS } from './content.ts';
import type { CreatureDef, Registry, Rules, SpeciesDef, WeatherDef } from './types.ts';

export interface ContentLayer {
  source: string;
  species?: Omit<SpeciesDef, 'source'>[];
  creatures?: Omit<CreatureDef, 'source'>[];
  weather?: Omit<WeatherDef, 'source'>[];
  rules?: Partial<Rules>;
  removeSpecies?: string[];
  removeCreatures?: string[];
  removeWeather?: string[];
}

export function buildRegistry(layers: ContentLayer[] = []): Registry {
  const species = new Map<string, SpeciesDef>(BASE_SPECIES.map((s) => [s.id, s]));
  const creatures = new Map<string, CreatureDef>(BASE_CREATURES.map((c) => [c.id, c]));
  const weather = new Map<string, WeatherDef>(BASE_WEATHER.map((w) => [w.id, w]));
  const rules: Rules = { ...BASE_RULES };

  for (const layer of layers) {
    for (const s of layer.species ?? []) species.set(s.id, { ...s, source: layer.source });
    for (const c of layer.creatures ?? []) creatures.set(c.id, { ...c, source: layer.source });
    for (const w of layer.weather ?? []) weather.set(w.id, { ...w, source: layer.source });
    for (const id of layer.removeSpecies ?? []) species.delete(id);
    for (const id of layer.removeCreatures ?? []) creatures.delete(id);
    for (const id of layer.removeWeather ?? []) weather.delete(id);
    for (const [k, v] of Object.entries(layer.rules ?? {}) as [keyof Rules, number][]) {
      const bounds = RULE_BOUNDS[k];
      if (bounds && typeof v === 'number' && Number.isFinite(v)) rules[k] = Math.min(bounds[1], Math.max(bounds[0], v));
    }
  }
  // The garden always needs at least one weather and one species to function.
  if (weather.size === 0) weather.set('sunny', BASE_WEATHER[0]);
  if (species.size === 0) species.set('clover', BASE_SPECIES.find((s) => s.id === 'clover')!);
  return { species, creatures, weather, rules };
}

export function registryToJSON(r: Registry) {
  return {
    species: [...r.species.values()],
    creatures: [...r.creatures.values()],
    weather: [...r.weather.values()],
    rules: r.rules,
  };
}
