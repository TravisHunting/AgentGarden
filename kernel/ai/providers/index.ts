// Provider registry. Add new providers here.

import { claudeCli, codexCli } from './cli.ts';
import { anthropicApi, openAiCompatible } from './http.ts';
import { offlineProvider } from './offline.ts';
import type { AgentProvider } from './types.ts';

const providers = new Map<string, AgentProvider>();

export function registerProvider(p: AgentProvider): void {
  providers.set(p.info.id, p);
}

for (const p of [offlineProvider, claudeCli, codexCli, anthropicApi, openAiCompatible]) registerProvider(p);

export function getProvider(id: string): AgentProvider {
  const p = providers.get(id);
  if (!p) throw new Error(`unknown provider "${id}"; known: ${[...providers.keys()].join(', ')}`);
  return p;
}

export function listProviders(): AgentProvider[] {
  return [...providers.values()];
}
