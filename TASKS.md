# Agent Garden — Task Tracker

Status legend: `[ ]` todo · `[~]` in progress · `[x]` done · `[-]` deferred

Architecture decisions (see `docs/ARCHITECTURE.md` for detail):
- Zero-dependency Node 24 server written in TypeScript (native type stripping), `node:sqlite` for persistence.
- Server is authoritative: the garden simulation, avatar executor, AI scheduler and mod loader all run
  server-side so the garden keeps living (and the AI keeps planning) when the browser is closed.
- Browser client (canvas, served by the same server, TS stripped on the fly) with a Document
  Picture-in-Picture "floating bar" mode.
- AI is BYO-agent through a provider interface; CLI providers (Claude Code, Codex) first, HTTP
  inference providers pluggable.

## T1 Project foundation
- [x] T1.1 Decompose requirements into tasks (this file)
- [x] T1.2 git init, package.json, tsconfig, .gitignore, README
- [x] T1.3 Seeded deterministic RNG utility

## T2 Persistence (SQLite)
- [x] T2.1 Schema: kv (settings/state), events, letters, journal, memories, mod_history
- [x] T2.2 Repository helpers (settings, letters, events, journal, memories)
- [x] T2.3 Periodic garden snapshot + restore with offline catch-up

## T3 Garden simulation engine
- [x] T3.1 Data model: grid tiles, soil, plants, creatures, weather, avatar, rules
- [x] T3.2 Base content: species, weather types, default rules, default routine loop
- [x] T3.3 Deterministic tick: growth, moisture, health/wilting, weather changes, creature behaviours
- [x] T3.4 Shared action set (till, plant, water, fertilize, cut, harvest, walk, wait, say, emote)
      with preconditions, used by both player and avatar
- [x] T3.5 Avatar executor: queued actions with walking/durations
- [x] T3.6 Routine loop: weighted, selector-based, seeded semi-random steps that stay valid as the
      garden changes
- [x] T3.7 Conflict handling: failed preconditions → comic "fizzle" + humorous bubble
- [x] T3.8 Speech bubbles schedule (AI-authored lines surfaced periodically)

## T4 AI integration
- [x] T4.1 Provider interface (id, availability check, model suggestions, complete())
- [x] T4.2 Claude Code CLI provider (`claude -p`)
- [x] T4.3 Codex CLI provider (`codex exec`)
- [x] T4.4 HTTP providers: Anthropic Messages API, OpenAI-compatible (future-proofing)
- [x] T4.5 Mock provider (offline/demo/tests)
- [x] T4.6 Context builder: garden state, player events, letters, history, memories, mods, desires
- [x] T4.7 Plan schema + validator with precise JSON-path errors
- [x] T4.8 Iterative repair loop: accept valid sections, re-request only failing ones, narrowing
      until valid; sanitize fallback after max attempts
- [x] T4.9 Debounced scheduler (minutes): fire after player goes quiet, in background
- [x] T4.10 Persist journal (reasoning summary, choices, iterations) + agent memories + hidden desires
- [x] T4.11 Agent letters to the mailbox

## T5 Mod system
- [x] T5.1 Mod manifest format (species, creatures, weather, rules overrides, sprites, sounds, script)
- [x] T5.2 Mod validator (bounds, ids, sprite/sound formats, size limits)
- [x] T5.3 Loader: scan `mods/`, merge registries in load order, hot reload
- [x] T5.4 Sandboxed script hooks (node:vm, timeouts, narrow API, auto-disable on error)
- [x] T5.5 Mod ops from AI (create/update/enable/disable/delete→trash), only when letters arrive
- [x] T5.6 Mod history log

## T6 Web client
- [x] T6.1 HTTP server: static files, TS stripping, JSON API, SSE stream
- [x] T6.2 Canvas renderer: soil, procedural plants, pixel-art sprites, avatar, creatures, weather FX
- [x] T6.3 Speech bubbles + fizzle animation
- [x] T6.4 Player tools (till/plant/water/fertilize/cut/harvest) with seed picker
- [x] T6.5 Mailbox: write letters, read agent letters
- [x] T6.6 Journal viewer (AI reasoning history), mods viewer
- [x] T6.7 Settings: provider, model, debounce, test connection, "think now"
- [x] T6.8 WebAudio synth for base + mod sound effects
- [x] T6.9 Document Picture-in-Picture floating bar (with graceful fallback)

## T7 Quality
- [x] T7.1 Unit tests: rng, engine actions/conflicts, loop resolution, validator, repair loop, mods
- [x] T7.2 End-to-end smoke run with mock provider
- [x] T7.3 Docs: README usage, ARCHITECTURE, MODDING guide

## T8 Kernel / world split with agent-rewritable code (see docs/DESIGN-kernel-world.md)
- [x] T8.1 Design document
- [x] T8.2 Contract (`kernel/contract.ts`) + IPC protocol
- [x] T8.3 Template world in `world/` (engine, mods, agent sections, offline gardener, client)
- [x] T8.4 Sandboxed world process (permission model) with crash/hang detection
- [x] T8.5 Generic planner (kernel sections + world sections over the contract, `rewrite` section)
- [x] T8.6 World git repo, staging worktree, revert, reset to template
- [x] T8.7 Gates: static, typecheck, sandboxed world tests, soak on the real save
- [x] T8.8 Workshop (agent edit ⇄ gates rounds) and provider `edit()` for Claude/Codex/offline
- [x] T8.9 Supervisor: swap, persisted probation, rollback, restart policy
- [x] T8.10 Shell UI (mounts world client, hot-swaps on new commit) + the shed panel
- [x] T8.11 Tests: sandbox, planner over the real template world, workshop fail→fix→live, probation rollback
- [x] T8.12 Live run of a code rewrite through a real agent CLI (Codex gpt-5.6-luna, 2026-10-15)
  - Letter asking for a "bell" tool → plan valid first try (21 s) with a concrete `rewrite` brief.
  - First attempt failed safely: Codex's Windows sandbox couldn't launch the Store-installed
    `pwsh.exe` alias (error 1920), so the agent had no shell and changed nothing. Fixed by hiding
    `...\Microsoft\WindowsApps` from PATH for Codex edits (falls back to System32 PowerShell).
  - Second attempt: live in round 1 (~90 s). 8 files, +102/−8: new `bell` action (engine, types,
    planner guide + validation, new `farmable_tile` selector), sound, ripple effect, toolbar button,
    aria-pressed on tools, and its own test. All gates passed; verified in the running app.

## T9 Onboarding and nudges
- [x] T9.1 Fix panels in picture-in-picture mode (shell looked elements up in the wrong document)
- [x] T9.2 Welcome message on first load (server-side flag; ❔ reopens it)
- [x] T9.3 Bare starting garden; "waiting for your first wish" routine
- [x] T9.4 First-wish prompt ("What kind of garden should I grow?"), answered immediately
- [x] T9.5 Lonely bubbles and mailbox peeks after 30 min without actions or letters (agent-overridable `loop.lonely`)
- [x] T9.6 Offline gardener digs and plants a first bed for a bare garden

## Deferred / future
- [-] "Sign in with Claude/ChatGPT" OAuth — requires registering apps with vendors; out of scope.
- [-] Native always-on-top shell (Electron/Tauri) if Document PiP proves insufficient.

## Verification log
- 16 unit/integration tests (`npm test`): determinism, preconditions, fizzle-on-conflict, loop selectors,
  manifest/script validation, mod ops + trash, script sandbox auto-disable, JSON extraction,
  repair-loop narrowing, fallback salvage, letter-gated mods (mock provider).
- `npm run typecheck` clean.
- Manual: server + client rendered in headless Edge; player actions, letter → mod → reply letter
  round-trip with the offline provider; Codex CLI availability probe succeeded.
- Live Codex run (gpt-5.6-luna, ChatGPT plan, 2026-10-15): letter → valid plan on the first attempt
  (~17s), created mod `moonlit-companions` (mooncap + starling moss + glowworm), wrote a reply letter,
  memories and desires. Seeded-broken repair test: attempt 1 had 3 errors (queue, loop, mods); attempt 2
  asked only for those three sections and Codex fixed all of them → `repaired` in 2 iterations.
- Bugs found by the live run and fixed: Codex `-o` path rejected when it contained `~`; recursive
  fs.watch on an 8.3 short path crashed the server (libuv assertion); `luna` is not a valid model id
  (real id `gpt-5.6-luna`) → Codex now uses its own default when the model is blank, and the settings
  page lists models discovered from `codex debug models`; sprite validator hid in-row errors when a
  frame had the wrong row count.
- Not yet verified: Claude Code CLI provider (not installed here); Document PiP in a headed browser.
