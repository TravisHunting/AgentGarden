// The kernel's half of the agent context: letters, activity, memory, journal
// and code history. The world's half is nested under "world".

import type { LetterRow, PlayerEventRow, Store } from '../db.ts';
import type { KernelAgentContext } from '../contract.ts';

export function buildKernelContext(opts: {
  store: Store;
  name: string;
  desires: string[];
  events: PlayerEventRow[];
  letters: LetterRow[];
  lastPlanAt: number | null;
  code: { worldVersion: string; commit: string; rewritesAllowed: boolean };
}): KernelAgentContext {
  const { store } = opts;
  const now = Date.now();
  const minsAgo = (t: number) => Math.round((now - t) / 60000);
  const counts: Record<string, number> = {};
  const recent: string[] = [];
  for (const ev of opts.events) {
    counts[ev.kind] = (counts[ev.kind] ?? 0) + 1;
    let summary = ev.kind;
    try {
      summary = (JSON.parse(ev.detail) as { summary?: string }).summary ?? ev.kind;
    } catch {
      // keep kind
    }
    recent.push(`${minsAgo(ev.created_at)}m ago: ${summary}`);
  }
  return {
    now: new Date(now).toISOString(),
    playerLocalTime: new Date(now).toLocaleString(),
    you: { name: opts.name, desires: opts.desires },
    player: {
      minutesSinceLastPlan: opts.lastPlanAt ? minsAgo(opts.lastPlanAt) : null,
      letters: opts.letters.map((l) => ({ id: l.id, text: l.text, minutesAgo: minsAgo(l.created_at) })),
      activity: {
        total: opts.events.length,
        summary:
          Object.entries(counts)
            .map(([k, n]) => `${k} ×${n}`)
            .join(', ') || 'nothing',
        recent: recent.slice(-25),
      },
    },
    correspondence: store
      .letters(10)
      .reverse()
      .map((l) => ({ from: l.sender === 'player' ? 'player' : 'you', text: l.text.slice(0, 400), minutesAgo: minsAgo(l.created_at) })),
    memories: store.memories(40).map((m) => ({ id: m.id, text: m.text })),
    recentJournal: store
      .journal(5)
      .reverse()
      .map((j) => ({ minutesAgo: minsAgo(j.created_at), summary: j.summary.slice(0, 500) })),
    code: {
      ...opts.code,
      recentRewrites: store.rewrites(5).map((r) => ({ request: r.request.slice(0, 300), status: r.status, minutesAgo: minsAgo(r.created_at) })),
    },
  };
}
