# 🌱 Agent Garden

An idle gardening game that lives on the side of your screen, tended by **your own AI agent**.

A little pixel gardener potters about watering, harvesting and muttering in speech bubbles. You can
step in at any time and garden alongside them — till, plant, water, fertilize, harvest, cut — or drop
a **letter in the mailbox**. A couple of minutes after you go quiet, everything you did (and wrote) is
handed to your AI agent in the background. It plans the gardener's next moves, writes their lines,
maybe leaves you a reply... and, if you sent a letter, may **reprogram the garden itself** by writing
mods: new species, creatures, weather, rules, pixel-art sprites, sound effects and scripts.

If you cut down the carrot your gardener was walking over to water, expect a comic fizzle.

When mods aren't enough, the gardener goes to **the shed** and rewrites the garden's actual source
code. The game is split into a small kernel the agent never touches and a *world* (rules, entities,
rendering, UI) that it may rewrite freely. New code only goes live after it passes a type check,
the world's tests and a simulation against your real save; it then stays on probation, and any
crash rolls it back. Every version is kept in git, and you can read the diffs or revert from the
🔨 panel.

## Quick start

Requires **Node.js 24+** and **git** (for code rewrites). TypeScript runs natively; the only
packages are `typescript` and `@types/node`, used by the type-check gate.

```bash
npm install
```

```bash
npm start
```

Open http://localhost:4747 in Chrome or Edge, then press 📌 to float the garden as an
always-on-top bar (Document Picture-in-Picture). Other browsers get a compact popup window.

The garden starts with an **offline gardener** (no AI). Open ⚙️ Settings to pick an agent:

| Provider | What it uses | Setup |
| --- | --- | --- |
| Claude Code CLI | your `claude` login (Claude subscription or API key) | install Claude Code and sign in once |
| Codex CLI | your `codex` login (ChatGPT plan or API key) | install Codex and `codex login` |
| Anthropic API | Messages API | set `ANTHROPIC_API_KEY` before `npm start` |
| OpenAI-compatible | any `/v1/chat/completions` (OpenAI, OpenRouter, Ollama, LM Studio) | set base URL; optional `OPENAI_API_KEY` |
| Offline gardener | built-in rules, no AI | — |

Pick a model (e.g. `haiku` for Claude; leave it blank for Codex to use your Codex default, or pick
one from the list it discovers), press **Test connection**, then **Save**. Code rewrites need a
provider that can edit files: Claude Code CLI, Codex CLI, or the offline gardener (whose "rewrites"
are a small demo edit). Turn them off with *Let the gardener rewrite the garden's code*.
**Think now** forces a planning run instead of waiting for the debounce.

## Playing

A new garden is a bare lawn. On first launch you get a short welcome (reopen it with ❔), then
your gardener asks **"What kind of garden should I grow?"**. Your answer is posted as your first
letter and answered straight away. Leave the garden alone for half an hour or so and your gardener
starts to miss you, and says so.

- **Tools** (keys 1–7): look, till, plant (choose a seed), water, fertilize, harvest, cut.
- **Mailbox** ✉️ (or click the mailbox tile): write letters; read your gardener's replies.
- **Journal** 📓: the gardener's reasoning for every planning run — what it noticed, decided, remembered,
  which mods it touched, and any self-corrections it needed to make valid output.
- **Mods** 🧬: everything in `mods/`, with history. Toggle mods on/off; edit them by hand (hot reload).
- **The shed** 🔨: code-rewrite projects with their checks and diffs, every version of the world's
  code, *Revert to this*, and *Reset to original*. Your garden (the save) is kept across all of these.

The garden keeps growing while the browser is closed (the server simulates), and catches up on
time the server itself was off (up to 3 days).

## Configuration

| Env var | Default | |
| --- | --- | --- |
| `PORT` | `4747` | HTTP port (bound to 127.0.0.1 only) |
| `GARDEN_DATA` | `./data` | SQLite database, the world's git repo (`data/world/repo`), agent scratch dir |
| `GARDEN_MODS` | `./mods` | mods folder |

## Development

```bash
npm test          # kernel + world tests (node:test)
npm run typecheck # tsc --noEmit
npm run dev       # restart on server changes
```

The template world lives in `world/`; each player's world is a git repo seeded from it on first run.

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md), [docs/DESIGN-kernel-world.md](docs/DESIGN-kernel-world.md),
[docs/MODDING.md](docs/MODDING.md) and
[TASKS.md](TASKS.md) (the task tracker this project was built from).
