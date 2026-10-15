# Modding the garden

> This page covers **declarative mods** — the quick, data-only way the gardener (or you) changes the
> template world. For changes mods can't express, the gardener rewrites the world's code itself
> (see [ARCHITECTURE.md](ARCHITECTURE.md#code-rewrites-kernelworkshop-gates-supervisor)). Because
> the mod system is part of the world, a rewritten world may extend or replace it.

Mods are folders inside `mods/` (or `$GARDEN_MODS`). Your AI gardener writes them when you send it
letters, but you can write or edit them by hand too — the server hot-reloads on change. Invalid
mods are listed with their errors in the 🧬 panel and are not loaded.

```
mods/
  moon-garden/
    mod.json     required manifest
    script.js    optional hooks
```

A full example lives in [examples/moon-garden](examples/moon-garden). Copy it into `mods/` to try it.

## mod.json

| field | type | notes |
| --- | --- | --- |
| `id` | string | must equal the folder name; `a-z0-9_-`, 2–40 chars |
| `name`, `description`, `author` | string | |
| `version` | int ≥ 1 | bump on update |
| `enabled` | bool | |
| `priority` | int −100..100 | load order; higher wins id conflicts |
| `species[]` | | add or override plants (same id as a base plant overrides it) |
| `creatures[]` | | add or override creatures |
| `weather[]` | | add or override weather |
| `rules` | | global rule overrides, clamped to safe bounds |
| `remove` | `{species?, creatures?, weather?}` | ids to remove |
| `sprites` | `{id: Sprite}` | pixel art; ids are global |
| `sounds` | `{id: Sound}` | synthesised sound effects; ids are global |

### Species

```json
{ "id": "moon-carrot", "name": "Moon Carrot", "growMinutes": 60, "thirstPerMinute": 0.3,
  "idealMoisture": [30, 70], "shape": "root", "regrows": false, "glow": true,
  "colors": { "stem": "#334455", "leaf": "#8899ff", "bloom": "#ddeeff" }, "sprite": "moon-carrot" }
```

`shape`: `bush | flower | root | vine | tree | grass | mushroom | crystal` (procedural drawing).
`glow` plants light up at night. `sprite` (optional) replaces procedural drawing.

### Creatures

`behaviour`: `wander`, `pollinator` (speeds growth), `pest` (nibbles health), `sprinkler` (waters
soil), `gardener` (waters the driest plant), `sleeper` (mostly stays put).
`shape`: `bug | bird | blob | critter | snail | ghost`. Plus `speed`, `spawnPerHour`, `maxCount`,
`lifeMinutes`, `colors {body, accent}`, optional `sprite`, `sound` (played on spawn).

### Weather

`moisturePerMinute` (−10..10), `growthMultiplier` (0..10), `particles` (`none rain snow petals
sparkles leaves fog embers`), `tint` (`null`, `#rrggbb` or `rgba(r,g,b,a)`), `weight`,
`minMinutes`, `maxMinutes`, optional `sound`.

### Rules

| rule | bounds | default |
| --- | --- | --- |
| growthRate | 0.05–20 | 1 |
| evaporationPerMinute | 0–20 | 1.2 |
| wiltThreshold | 0–60 | 15 |
| drownThreshold | 40–100 | 95 |
| avatarSpeed | 0.2–8 | 1.6 |
| actionSeconds | 0.5–20 | 2.5 |
| weatherChangeMinutes | 2–600 | 45 |
| maxCreatures | 0–30 | 6 |
| chatterSeconds | 15–3600 | 90 |
| waterAmount | 5–100 | 40 |

### Sprites

```json
"moon-carrot": { "w": 8, "h": 8, "fps": 0, "mode": "stages",
  "palette": { "a": "#aabbff", "b": "#ffffff" },
  "frames": [ ["........", "...", "..."] ] }
```

Up to 32×32, 8 frames, 16 palette colours. `.` is transparent. `mode: "stages"` makes plants pick
a frame by growth; otherwise frames animate at `fps`. A sprite with id **`avatar`** reskins the
gardener.

### Sounds

```json
"twinkle": { "wave": "sine", "notes": [{ "freq": 880, "dur": 0.1, "vol": 0.5 }], "slide": 0 }
```

`wave`: `sine square triangle sawtooth noise` (noise uses `freq` as a band-pass centre). Notes play
in sequence, max 4 s total. Base sound ids you can override: `water till plant fertilize cut
harvest fizzle chime rain`.

## script.js

Define any of `function onLoad(api)`, `function onTick(api, dt)` (≈ once per simulated second) and
`function onEvent(api, event)`. Each call has a ~50 ms budget; 3 failures switch the mod off and
record why (your gardener sees that next time it is allowed to edit mods).

You may not reference `require`, `import`, `process`, `globalThis`, `Function`, `eval`,
`constructor`, `prototype`, timers or `fetch`.

```
api.time, api.width, api.height, api.modId
api.weather()                  current weather id
api.random()                   deterministic 0..1
api.log(msg)
api.getTile(x, y)              {tilled, moisture, fertility, plant} | null
api.plants()                   [{x, y, species, growth, health}]
api.creatures(), api.species()
api.setMoisture(x, y, v)       0..100
api.setFertility(x, y, v)      0..100
api.mutatePlant(x, y, {growth?, health?, species?, hue?, scale?, label?})
api.plant(x, y, species)       api.removePlant(x, y)
api.spawnCreature(id, x?, y?)  api.setWeather(id, minutes?)
api.say(text)                  at most once per 30 s per mod
api.playSound(id)
api.getStore() / api.setStore(obj)   persistent JSON, 8 KB
```

Events: `{kind: 'action'|'plant'|'weather'|'creature'|'bubble'|'fizzle'|'mod', t, ...}`.

> `node:vm` is not a hard sandbox. Only run mods you (or your own agent) wrote.
