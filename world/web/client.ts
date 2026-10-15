// World client: draws the garden into the kernel shell and handles garden
// input. Exported mount(host) is the contract with the shell (src/contract.ts).

import { Renderer, type Content } from './render.ts';
import { Synth } from './audio.ts';
import type { ClientHost, KernelStatus, WorldClient } from '../src/contract.ts';
import type { Action, GameEvent, GardenState } from '../src/game/types.ts';

const TOOLS = [
  ['inspect', '👀', 'Look'],
  ['till', '⛏️', 'Till soil'],
  ['plant', '🌱', 'Plant seeds'],
  ['water', '💧', 'Water'],
  ['fertilize', '🧪', 'Fertilize'],
  ['harvest', '🧺', 'Harvest'],
  ['cut', '✂️', 'Cut / remove'],
] as const;

function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Record<string, unknown> = {}, ...children: (Node | string | null | undefined | false)[]) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') el.className = String(v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v as EventListener);
    else if (v !== undefined && v !== null && v !== false) el.setAttribute(k, String(v));
  }
  for (const c of children) if (c !== null && c !== undefined && c !== false) el.append(c);
  return el;
}

function ago(ms: number): string {
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  return `${Math.round(s / 3600)} h ago`;
}

export function mount(host: ClientHost): WorldClient {
  const win = host.window();
  const doc = host.stage.ownerDocument;

  // ---------------------------------------------------------------- DOM
  const canvas = h('canvas', { id: 'garden' }) as HTMLCanvasElement;
  const bubbles = h('div', { id: 'bubbles' });
  host.stage.append(canvas, bubbles);

  const toolButtons = TOOLS.map(([id, icon, title]) => h('button', { class: `tool${id === 'inspect' ? ' active' : ''}`, 'data-tool': id, title }, icon));
  const tools = h('div', { class: 'tools', role: 'toolbar', 'aria-label': 'Garden tools' }, ...toolButtons);
  const seedSelect = h('select', { id: 'seed', title: 'Seed to plant', hidden: true }) as HTMLSelectElement;
  const info = h('div', { class: 'info' }, 'Click a tile to look at it.');
  host.toolbar.append(tools, seedSelect, info);

  const soundBtn = h('button', { class: 'icon-btn', title: 'Sound on/off' });
  const modsBtn = h('button', { class: 'icon-btn', title: 'Mods' }, '🧬');
  host.topActions.append(modsBtn, soundBtn);

  const modsList = h('ul', { class: 'mods' });
  const modsHistory = h('ul', { class: 'history' });
  const modsDir = h('p', { class: 'muted' });
  const modsPanel = h(
    'section',
    { class: 'panel', hidden: true },
    h('header', {}, h('h2', {}, '🧬 Mods'), h('button', { class: 'close', onclick: () => (modsPanel.hidden = true) }, '✕')),
    h('div', { class: 'panel-body' }, modsDir, modsList, h('h3', {}, 'History'), modsHistory),
  );
  host.overlay.append(modsPanel);

  // ---------------------------------------------------------------- state
  const renderer = new Renderer(canvas);
  const synth = new Synth();
  let content: Content | null = null;
  let state: GardenState | null = null;
  let status: KernelStatus | null = null;
  let tool = 'inspect';
  let lastHover: { x: number; y: number } | null = null;
  let disposed = false;
  let lastActivity = '';

  interface Bubble {
    el: HTMLElement;
    until: number;
  }
  let activeBubbles: Bubble[] = [];

  function showBubble(text: string, fizzle = false): void {
    for (const b of activeBubbles) b.until = Math.min(b.until, performance.now() + 300);
    const el = h('div', { class: `bubble${fizzle ? ' fizzle' : ''}` }, text);
    bubbles.append(el);
    activeBubbles.push({ el, until: performance.now() + Math.min(9000, 2500 + text.length * 60) });
  }

  function positionBubbles(now: number): void {
    if (!activeBubbles.length) return;
    const anchor = renderer.avatarAnchor();
    const cr = canvas.getBoundingClientRect();
    const sr = host.stage.getBoundingClientRect();
    const left = cr.left - sr.left + anchor.x;
    const top = cr.top - sr.top + anchor.y - 10;
    activeBubbles = activeBubbles.filter((b) => {
      b.el.style.left = `${Math.max(70, Math.min(sr.width - 70, left))}px`;
      b.el.style.top = `${Math.max(30, top)}px`;
      if (now > b.until) {
        b.el.classList.add('fade');
        setTimeout(() => b.el.remove(), 400);
        return false;
      }
      return true;
    });
  }

  function setTool(t: string): void {
    tool = t;
    for (const b of toolButtons) b.classList.toggle('active', b.dataset.tool === t);
    seedSelect.hidden = t !== 'plant';
  }

  function fillSeeds(): void {
    if (!content) return;
    const prev = seedSelect.value;
    seedSelect.replaceChildren(...content.species.map((s) => h('option', { value: s.id }, `${s.name}${s.source !== 'base' ? ' ✨' : ''}`)));
    if (content.species.some((s) => s.id === prev)) seedSelect.value = prev;
  }

  function describeTile(x: number, y: number): string {
    if (!state) return '';
    if (x === state.mailbox.x && y === state.mailbox.y) return `📬 The mailbox${status?.unreadLetters ? ` — ${status.unreadLetters} unread letter(s)!` : ''}`;
    const t = state.tiles[y * state.width + x];
    const soil = `soil ${Math.round(t.moisture)}% wet, ${Math.round(t.fertility)}% rich`;
    if (t.plant) {
      const def = renderer.speciesDef(t.plant.species);
      const name = t.plant.mutation?.label ? `${t.plant.mutation.label} ${def?.name ?? t.plant.species}` : (def?.name ?? t.plant.species);
      if (t.plant.health <= 0) return `🥀 A dead ${name} · ${soil}`;
      const g = Math.round(t.plant.growth * 100);
      return `${g >= 100 ? '✨ Ripe' : `🌱 ${g}% grown`} ${name} · health ${Math.round(t.plant.health)} · ${soil}`;
    }
    return t.tilled ? `🟫 Tilled, empty · ${soil}` : `🌿 Grass · ${soil}`;
  }

  function updateInfo(): void {
    if (lastHover) info.textContent = describeTile(lastHover.x, lastHover.y);
  }

  function renderSoundButton(): void {
    soundBtn.textContent = synth.muted ? '🔇' : '🔊';
  }

  async function loadMods(): Promise<void> {
    const data = (await host.rpc('mods.list')) as {
      dir: string;
      mods: { id: string; name?: string; enabled: boolean; version?: number; description?: string; disabledReason?: string; hasScript: boolean; errors: string[]; manifest?: unknown }[];
      history: { created_at: number; mod_id: string; op: string; note: string }[];
    };
    modsDir.textContent = `Mods are quick, declarative changes your gardener makes after letters. They live in ${data.dir} and hot-reload if you edit them.`;
    modsList.replaceChildren(
      ...(data.mods.length
        ? data.mods.map((m) =>
            h(
              'li',
              {},
              h(
                'div',
                { class: 'head' },
                h('strong', {}, `${m.name ?? m.id}${m.version ? ` v${m.version}` : ''}${m.hasScript ? ' 📜' : ''}`),
                m.manifest
                  ? h(
                      'button',
                      {
                        class: 'btn ghost',
                        onclick: async () => {
                          await host.rpc('mods.toggle', { id: m.id, enabled: !m.enabled });
                          await loadMods();
                        },
                      },
                      m.enabled ? 'Disable' : 'Enable',
                    )
                  : null,
              ),
              m.description ? h('div', {}, m.description) : null,
              m.disabledReason ? h('div', { class: 'errors' }, `Switched off: ${m.disabledReason}`) : null,
              m.errors.length ? h('div', { class: 'errors' }, m.errors.join('\n')) : null,
              m.manifest ? h('details', {}, h('summary', {}, 'Manifest'), h('pre', {}, JSON.stringify(m.manifest, null, 1))) : null,
            ),
          )
        : [h('li', {}, 'No mods yet. Write your gardener a letter — perhaps ask for something impossible.')]),
    );
    modsHistory.replaceChildren(...data.history.map((r) => h('li', {}, h('span', { class: 'muted' }, `${ago(r.created_at)} · `), `${r.op} ${r.mod_id}: ${r.note}`)));
  }

  // ---------------------------------------------------------------- input
  tools.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>('.tool');
    if (b?.dataset.tool) setTool(b.dataset.tool);
  });
  soundBtn.addEventListener('click', () => {
    synth.unlock();
    synth.setMuted(!synth.muted);
    renderSoundButton();
  });
  modsBtn.addEventListener('click', () => {
    modsPanel.hidden = !modsPanel.hidden;
    if (!modsPanel.hidden) void loadMods();
  });
  canvas.addEventListener('pointermove', (e) => {
    const tile = renderer.tileAt(e.clientX, e.clientY);
    renderer.hover = tile;
    lastHover = tile;
    updateInfo();
  });
  canvas.addEventListener('pointerleave', () => (renderer.hover = null));
  const unlock = () => synth.unlock();
  host.stage.addEventListener('pointerdown', unlock);
  host.toolbar.addEventListener('pointerdown', unlock);
  canvas.addEventListener('click', async (e) => {
    const tile = renderer.tileAt(e.clientX, e.clientY);
    if (!tile || !state) return;
    lastHover = tile;
    if (tile.x === state.mailbox.x && tile.y === state.mailbox.y) {
      host.openMailbox();
      return;
    }
    if (tool === 'inspect') {
      updateInfo();
      return;
    }
    const action = (tool === 'plant' ? { type: 'plant', ...tile, species: seedSelect.value } : { type: tool, ...tile }) as Action;
    try {
      await host.rpc('action', { action });
    } catch (err) {
      host.toast((err as Error).message);
    }
  });
  const onKey = (e: KeyboardEvent) => {
    if ((e.target as HTMLElement).closest?.('input, textarea, select')) return;
    const n = Number(e.key);
    if (n >= 1 && n <= TOOLS.length) setTool(TOOLS[n - 1][0]);
  };
  doc.addEventListener('keydown', onKey);
  renderSoundButton();

  // ---------------------------------------------------------------- frame loop
  const frame = (now: number) => {
    if (disposed) return;
    renderer.draw(now);
    positionBubbles(now);
    win.requestAnimationFrame(frame);
  };
  win.requestAnimationFrame(frame);

  const resize = () => {
    const r = host.stage.getBoundingClientRect();
    renderer.resize(r.width - 12, r.height - 12, win.devicePixelRatio || 1);
  };

  // ---------------------------------------------------------------- handle
  return {
    onState(s) {
      const first = !state;
      state = s as GardenState;
      renderer.setState(state);
      if (first) resize();
      updateInfo();
      const act = state.avatar.loop.name;
      if (act !== lastActivity) {
        lastActivity = act;
        host.setActivity(act);
      }
    },
    onContent(c) {
      content = c as Content;
      renderer.setContent(content);
      synth.setModSounds(content.sounds as never);
      fillSeeds();
    },
    onStatus(s) {
      status = s;
      renderer.mailFlag = s.unreadLetters > 0;
    },
    onEvent(raw) {
      const e = raw as GameEvent;
      switch (e.kind) {
        case 'bubble':
          showBubble(e.text);
          break;
        case 'fizzle':
          showBubble(e.text, true);
          renderer.fizzle();
          break;
        case 'sound':
          synth.play(e.sound);
          break;
        case 'action':
          if (e.ok && 'x' in e.action && e.action.type !== 'walk') renderer.effect(e.action.type, e.action.x, e.action.y);
          if (!e.ok && e.actor === 'player') host.toast(`Can't do that: ${e.reason}`);
          break;
        case 'mod':
          host.toast(`🧬 ${e.text}`, 6000);
          if (!modsPanel.hidden) void loadMods();
          break;
        case 'weather':
          host.toast(`The weather turns ${renderer.weatherDef(e.weather)?.name.toLowerCase() ?? e.weather}.`);
          break;
        case 'creature':
          if (e.event === 'spawn' && content?.creatures.find((c) => c.id === e.creature)?.source !== 'base') {
            host.toast(`A ${content?.creatures.find((c) => c.id === e.creature)?.name ?? e.creature} appears!`);
          }
          break;
      }
    },
    resize,
    unmount() {
      disposed = true;
      doc.removeEventListener('keydown', onKey);
      host.stage.removeEventListener('pointerdown', unlock);
      host.toolbar.removeEventListener('pointerdown', unlock);
    },
  };
}
