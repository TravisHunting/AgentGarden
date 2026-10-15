# Architecture

Agent Garden is split into an immutable **kernel** and an agent-rewritable **world**. The full
design and its rationale are in [DESIGN-kernel-world.md](DESIGN-kernel-world.md); this page is the
map.

```
 browser                                   kernel (Node 24, never edited by the agent)
 ┌───────────────────────────────┐  SSE  ┌────────────────────────────────────────────────┐
 │ kernel/web/shell.ts           │◀──────│ main.ts      HTTP API, SSE, wiring             │
 │  mailbox · journal · shed ·   │ JSON  │ ai/planner   context → agent → validate →      │
 │  settings · PiP               │──────▶│              repair → apply → journal          │
 │ ┌───────────────────────────┐ │       │ workshop     rewrite request → agent edits     │
 │ │ /world/<commit>/web/      │ │       │ gates        static · tsc · tests · soak       │
 │ │   client.ts  mount(host)  │ │       │ supervisor   live world, swap, probation,      │
 │ │   (rendering, tools, …)   │ │       │              crash restarts, rollback          │
 │ └───────────────────────────┘ │       │ world-repo   git: data/world/repo (+ staging)  │
 └───────────────────────────────┘       │ db.ts        SQLite                            │
                                         └───────────────┬────────────────────────────────┘
                                                IPC      │ fork --permission
                                         ┌───────────────▼────────────────────────────────┐
                                         │ world-host.ts → data/world/repo/src/index.ts    │
                                         │ the world: simulation, mods, agent sections,   │
                                         │ offline gardener (may only write mods/)        │
                                         └────────────────────────────────────────────────┘
```

## Kernel ↔ world contract

`kernel/contract.ts` (copied into every world as `src/contract.ts`, read-only) defines:

- **World module** — `apiVersion`, `version` (the save format), `createWorld(init)`.
- **World** — `tick`, `snapshot`, `publicState`, `content`, `rpc`, `notify`, and `agent.*`:
  `sections` (which plan keys the world owns), `guide` (prompt text for them), `context`,
  `validate` (path-addressed errors; may partially accept), `fallback`, `apply`, `offlinePlan`.
- **Client** — `web/client.ts` exports `mount(host)`; the shell gives it a stage, toolbar, top
  actions, an overlay for panels, `rpc`, `toast`, `openMailbox`, `window()` and `setActivity`.
- **IPC protocol** for the sandboxed child.

The kernel never inspects world state: it stores `snapshot()`s and forwards streams.

## Planning (kernel/ai)

Kernel sections: `summary`, `letter`, `memories`, `forget`, `desires`, and `rewrite` (only when a
player letter arrived, rewrites are enabled, and the provider can edit code). World sections come
from `agent.sections()` (the template world: `queue`, `loop`, `mods`). Each section is validated
independently — kernel ones locally, world ones over IPC — and only failing sections are
re-requested, with their errors. Leftovers after the last iteration go to `agent.fallback()`.
The offline provider asks the world for `agent.offlinePlan()`.

A scheduler fires the run once the player has been quiet for `debounceMinutes`.

## Code rewrites (kernel/workshop, gates, supervisor)

1. An accepted `rewrite` creates a row in `rewrites` and starts the workshop.
2. `world-repo` creates a detached git worktree (`data/world/staging`) at the live commit.
3. The provider's `edit()` runs as a coding agent in that folder (Codex `-s workspace-write`,
   Claude `--permission-mode acceptEdits`, or the offline demo edit).
4. Gates: static checks (contract untouched, entry points exist, browser files strip cleanly) →
   `tsc --noEmit` strict → the world's tests under the permission model → a soak that loads the
   **real save** and a fresh garden in a sandboxed process and simulates game hours.
   Failures go back to the agent for up to `workshopRounds` attempts.
5. Pass → commit, fast-forward live, snapshot the save, start the new world, stop the old one.
   The shell sees a `world` event and remounts `/world/<commit>/web/client.ts` in place (PiP
   survives).
6. **Probation** (`probationMinutes`, persisted): a crash or hang rolls back to the previous commit
   and the pre-swap save. Outside probation, crashes restart the world; 3 crashes in 5 minutes roll
   back to the newest known-good commit.

The player can open **the shed** (🔨) to read every project, its gate results and diff, view any
version's diff, revert to it (as a new commit), or reset to the template.

## Isolation

The world runs under `--permission`: read its own folder and the mods folder, write only the mods
folder, no child processes, no workers. World tests run under the same flags. Node 24 cannot
restrict network access; the host deletes `fetch`/`WebSocket` globals as a speed bump only. The
HTTP server binds to 127.0.0.1 and checks `Host` and `Origin`.

## Persistence (SQLite via node:sqlite)

| table / key | contents |
| --- | --- |
| `kv.garden` | `{version, state}` world snapshot (every 15 s, before swaps) |
| `kv.world.lastGood`, `kv.world.probation` | rollback targets, current probation |
| `player_events` | activity reported by the world's `rpc` results |
| `letters` | both directions |
| `journal` | planning runs, shed results, rollbacks |
| `rewrites` | request, status, rounds, gate log, diff, commit |
| `memories` | the agent's long-term notes |

The world's own declarative mods live in `mods/` with their history in `mods/.history.jsonl`.
