# Design: Kernel / World split with agent-rewritable world code

Status: **implemented** (see "Implementation checklist" at the end) · Author: Claude · 2026-10-15

## 1. Goal

Let the player's local agent rewrite the *actual game code* — rules, entities, rendering, UI,
sounds, the mod system itself — not just declarative mod files, without the garden being one bad
edit away from death.

## 2. Principles

1. **Immutable kernel, mutable world.** A small kernel (persistence, AI loop, providers, HTTP, the
   supervisor) is never edited by the agent. Everything that makes the game *the game* lives in the
   world, which the agent may rewrite freely.
2. **Nothing goes live unproven.** Code changes are made in a staging copy and must pass gates
   against the player's real save before they replace the running world.
3. **Every change is reversible.** The world is a git repository. Every live version is a commit;
   rollback is `reset` to the last known-good commit plus the save snapshot taken before the swap.
4. **Crashes are contained.** The world runs in a child process under Node's permission model. If
   it crashes or hangs, the kernel keeps serving, restarts it, and rolls back if a new version is to
   blame.
5. **The contract is the only coupling.** Kernel ↔ world talk through a versioned contract
   (`kernel/contract.ts`), over IPC in production and in-process in tests.

## 3. Layout

```
kernel/                      immutable (ships with the app)
  main.ts                    entry: wiring, HTTP routes, clock-less (the world owns time)
  contract.ts                World contract types + protocol messages (copied into worlds)
  world-host.ts              runs INSIDE the world child process; drives tick/IPC
  world-process.ts           kernel side: spawn, RPC, heartbeat, restart policy
  world-repo.ts              git: seed from template, staging worktree, commit, ff, reset, log/diff
  gates.ts                   typecheck, world tests, soak against the real save
  supervisor.ts              live world lifecycle: swap, probation, rollback
  workshop.ts                agentic code-edit loop (agent ⇄ gates)
  db.ts http.ts check.ts
  ai/                        generic planner, kernel prompt/context, providers
  web/                       shell UI: SSE, mailbox, journal, world history, settings, PiP
world/                       the *template* world (seed for each player's world repo)
  src/index.ts               exports apiVersion, version, createWorld()
  src/contract.ts            copy of kernel/contract.ts (overwritten by the kernel; read-only)
  src/game/ src/mods/ src/agent/ src/util/
  web/client.ts              exports mount(host) — renders & handles input in the shell's stage
  web/render.ts audio.ts world.css
  test/                      world tests (these are also gates)
data/                        per-player runtime data (gitignored)
  garden.db
  world/repo/                the player's world: git repo, main = live
  world/staging/             git worktree used by the workshop
  world/mods/                declarative mods (written by the world process)
```

## 4. The World contract (API version 1)

```ts
interface WorldModule { apiVersion: 1; version: string; createWorld(init: WorldInit): World | Promise<World> }

interface WorldInit {
  saved: { version: string; state: unknown } | null;  // last snapshot (world must migrate older versions)
  seed: number;
  awaySeconds: number;           // real time since the snapshot (catch-up)
  modsDir: string;               // only writable path
  emit(msg: WorldEmit): void;    // { type: 'event', event } | { type: 'content' } | { type: 'log', text }
}

interface World {
  tick(dt: number): void;                    // host calls ~4×/s with real dt
  snapshot(): { version: string; state: unknown };
  publicState(): unknown;                    // streamed to the client ~2×/s
  content(): unknown;                        // streamed to the client on change
  rpc(method: string, params: unknown): Promise<RpcResult> | RpcResult;   // player-facing calls
  notify?(kind: string, data: unknown): void;  // 'letter', 'workshop', ...
  agent: {
    sections(o: AgentOpts): SectionSpec[];   // world-owned plan sections
    guide(o: AgentOpts): string;             // prompt text for those sections
    context(): unknown;                      // world part of the agent context
    validate(section, value, ctx): { errors: string[]; value?: unknown; note?: string };
    fallback?(section, lastValue, plan): unknown | undefined;
    apply(plan: Record<string, unknown>, o: AgentOpts): Promise<{ notes: string[] }> | { notes: string[] };
    offlinePlan?(ctx: unknown, o: AgentOpts): Record<string, unknown>;   // the "no AI" gardener
  };
  dispose?(): void;
}
interface RpcResult { result: unknown; activity?: { kind: string; summary: string } }
interface AgentOpts { allowMods: boolean }
```

- `validate` may return a partially accepted `value` alongside errors (e.g. 2 of 3 mod ops valid);
  the kernel keeps it and passes it back as `ctx.accepted` next round — this preserves item-level
  narrowing generically.
- Player activity worth telling the agent about is declared by the world via `RpcResult.activity`;
  the kernel stores it and starts the debounce.
- The kernel never inspects world state; it only stores snapshots and forwards streams.

### IPC protocol (`kernel/contract.ts`)

kernel → host: `{id, op: 'init'|'call'|'soak'|'start'|'stop', ...}`; host → kernel: replies
`{id, ok, result|error}`, plus `{type: 'state'}` (2 Hz, doubles as heartbeat), `{type: 'event'}`,
`{type: 'content'}`, `{type: 'log'}`. `call` names a dotted method on the World (`agent.validate`).

## 5. Process isolation

World child is `fork`ed with:
`--permission --allow-fs-read=<worldDir> --allow-fs-read=<kernel/world-host.ts dir> --allow-fs-read=<modsDir> --allow-fs-write=<modsDir>`.
Verified on Node 24/Windows: other reads/writes and child processes are denied. **Network cannot be
restricted** by Node 24's permission model; the host removes `fetch`/`WebSocket` globals as a
speed bump only. Documented residual risk.

Health: no `state` message for 10 s ⇒ hung ⇒ kill. Unexpected exit ⇒ crash.
Restart policy: restart from the last saved snapshot; 3 crashes within 5 min ⇒ treat the current
commit as bad ⇒ rollback (§7).

## 6. Planning run (generic)

Sections = kernel sections + `world.agent.sections()`.

| kernel section | notes |
| --- | --- |
| `summary` (required) | journal text |
| `letter` | reply to the player |
| `memories`, `forget`, `desires` | long-term memory |
| `rewrite` | `{ request, why } \| null` — ask the workshop to change the world's code. Only allowed when a player letter arrived, rewrites are enabled, and the provider supports editing. |

System prompt = kernel persona/contract + `world.agent.guide()`. Context = kernel context (letters,
activity, memories, journal, code history) + `world: world.agent.context()`. The repair loop is
unchanged in spirit: accepted sections freeze, only failing sections are re-requested; world sections
are validated over IPC. After max iterations: `world.agent.fallback()` salvages, else omitted.
Apply: kernel sections locally, world sections via `world.agent.apply()`; then, if `rewrite` was
accepted, the workshop starts in the background. The offline provider calls `world.agent.offlinePlan`.

## 7. Code rewrites: workshop → gates → swap → probation

```
rewrite request ─▶ staging worktree @ live HEAD (contract.ts refreshed)
      ▲                         │ agent edits (Codex -s workspace-write / Claude acceptEdits)
      │ gate output (≤ N rounds)▼
      └──── fail ◀── GATES: 1 static  2 typecheck  3 world tests  4 soak on real save
                                │ pass
                                ▼
            commit in staging → ff live branch → snapshot save → start NEW world process
            (init with saved state + migrate) → ok? stop old → LIVE (probation T min)
                                │ crash/hang during probation, or start failure
                                ▼
            ROLLBACK: reset live to previous good commit, restart with pre-swap snapshot
```

Gates (each with timeouts; output tail fed back to the agent):
1. **Static**: changed paths stay inside the world; `src/contract.ts` unchanged (restored if
   touched); no file > 256 KB; `src/index.ts` exists.
2. **Typecheck**: `tsc --noEmit` with a kernel-owned tsconfig (strict, DOM + node types) over
   `src/**` and `web/**`.
3. **World tests**: `node --test` over `test/**/*.test.ts` (5 min cap).
4. **Soak**: spawn the staging world under the same permissions; `init` with the *current live
   snapshot*; simulate 2 game hours in 5 s steps; `snapshot()` must JSON-roundtrip; `publicState`,
   `content`, `agent.sections/guide/context` must succeed; `apiVersion` must be 1.
   Client code must strip cleanly (`stripTypeScriptTypes`) and export `mount` (static check).

Swap only happens if no planning run is in flight (it waits). Each rewrite is recorded in a
`rewrites` table (request, rounds, gate logs, diff, base/new commit, status) and a journal entry.

Agent edit providers: `AgentProvider.edit?(req, settings)` — Claude CLI (`--permission-mode
acceptEdits`, cwd = staging), Codex CLI (`exec -s workspace-write`, cwd = staging), offline provider
(a deterministic edit at a marker comment, for demos/tests). HTTP providers do not support edits.

## 8. Client

Shell (`kernel/web`) owns: SSE, top bar, mailbox, journal, world history (diffs, revert, reset to
template), settings, PiP. It dynamically imports `/world/<commit>/web/client.ts` and calls
`mount(host)`; host = `{ stage, toolbar, overlay, topActions, rpc, toast, openMailbox, window() }`.
Returned handle: `{ onState, onEvent, onContent, onStatus, resize, unmount }`. On a `world` SSE event
(new commit) the shell unmounts and mounts the new client in place — PiP survives. If the client
module fails to load/mount, the shell shows an error banner and offers revert.

## 9. Persistence

`kv.garden = {version, state}` snapshots every 15 s and before swaps; `kv.world.lastGood = [commits]`.
New table `rewrites`. `player_events.detail = {summary, ...}`.

## 10. Settings

`codeRewrites` (default true), `workshopRounds` (3), `workshopTimeoutMinutes` (20),
`probationMinutes` (10), plus existing ones.

## 11. Risks / non-goals

- Network egress from world code is not blocked (Node limitation).
- A malicious world could exhaust CPU; the hang detector bounds it.
- Gates can't prove fun; the journal + diff + one-click revert are the backstop.
- Template upgrades don't auto-merge into a player's forked world; "reset to template" is explicit.

## 12. Implementation checklist

- [x] contract.ts, world-host.ts, world-process.ts (+ in-process adapter)
- [x] world/ template (engine, mods, agent sections, offline plan, client) and world tests
- [x] generic planner + kernel sections incl. `rewrite`
- [x] world-repo.ts, gates.ts, workshop.ts, supervisor.ts (swap, probation, rollback, restarts)
- [x] provider `edit` for Claude/Codex/offline
- [x] shell UI + world client mount + world history panel
- [x] kernel tests: process isolation, planner over real template world, workshop gate-fail→fix→swap, probation rollback

## 13. Implementation notes (deviations and findings)

- Gate typecheck uses `module: esnext` + `moduleResolution: bundler` so it doesn't depend on a
  world `package.json` (nodenext treated world files as CommonJS).
- World tests run with `--test-isolation=none` so the permission flags apply to the tests themselves.
- `ValidateContext.acceptedSections` was added so world sections can see sections accepted in
  earlier repair rounds (e.g. species introduced by already-accepted mod ops).
- `ClientHost.setActivity()` was added so the world can feed the shell's status line.
- Probation is persisted (`kv.world.probation`) so a kernel restart mid-probation keeps it.
- `WorldProcess.start` kills the child if `init` fails (found by tests: it leaked processes).
- Codex edits on Windows: the CLI's sandbox cannot spawn Microsoft Store app aliases (a Store
  `pwsh.exe` fails with error 1920), so the Codex provider strips `...\Microsoft\WindowsApps` from
  PATH when editing; Codex then uses System32 PowerShell.
- Mod history moved into the world (`mods/.history.jsonl`) since mods are a world concept.
