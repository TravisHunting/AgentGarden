// Kernel shell: the live connection, status line, mailbox, journal, the shed
// (world code history), settings and the floating-bar mode. The garden view
// itself is the world's client module, mounted into #stage.

import { enterPip, exitPip, pipSupported } from './pip.ts';
import type { ClientHost, KernelStatus, WorldClient } from '../contract.ts';

// ---------------------------------------------------------------- setup

const app = document.getElementById('app')!;
// Look elements up inside #app first: in picture-in-picture mode #app lives in another document.
const $ = <T extends HTMLElement = HTMLElement>(id: string) => (app.querySelector<T>(`#${CSS.escape(id)}`) ?? document.getElementById(id)) as T;
const stage = $('stage');
const toasts = $('toasts');
const statusEl = $('status');
const banner = $('world-banner');

interface WorldInfo {
  commit: string;
  version: string;
  healthy: boolean;
  lastError: string | null;
  probationUntil: number | null;
  rewritesAvailable: boolean;
}

let status: KernelStatus | null = null;
let worldInfo: WorldInfo | null = null;
let activity = '';
let host: Window = window; // the window currently hosting #app (main or PiP)
let connected = false;
let client: WorldClient | null = null;
let mountedCommit = '';
let mounting: Promise<void> | null = null;
let lastState: unknown = null;
let lastContent: unknown = null;

async function api<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { error?: string }).error ?? `HTTP ${res.status}`);
  return data as T;
}

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
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return new Date(ms).toLocaleDateString();
}

function clock(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function toast(text: string, ms = 3500): void {
  const el = h('div', { class: 'toast' }, text);
  toasts.append(el);
  while (toasts.children.length > 3) toasts.firstElementChild!.remove();
  setTimeout(() => el.classList.add('fade'), ms);
  setTimeout(() => el.remove(), ms + 600);
}

// ---------------------------------------------------------------- world client

const clientHost: ClientHost = {
  stage,
  toolbar: $('toolbar'),
  topActions: $('world-actions'),
  overlay: $('overlay'),
  rpc: (method, params) => api('POST', '/api/world/rpc', { method, params: params ?? null }),
  toast,
  openMailbox: () => openPanel('mail'),
  window: () => host,
  setActivity: (text) => {
    activity = String(text).slice(0, 80);
    renderStatus();
  },
};

function showBanner(text: string | null, revert = false): void {
  banner.hidden = !text;
  if (!text) return;
  banner.replaceChildren(h('span', {}, text));
  if (revert) banner.append(h('button', { class: 'btn ghost', onclick: () => openPanel('world') }, 'Open the shed'));
}

async function mountWorld(commit: string): Promise<void> {
  if (commit === mountedCommit && client) return;
  // Tear down the old client and its stylesheet.
  try {
    client?.unmount();
  } catch (e) {
    console.error('world client unmount failed', e);
  }
  client = null;
  for (const id of ['stage', 'toolbar', 'world-actions', 'overlay']) $(id).replaceChildren();
  activity = '';
  for (const doc of new Set([document, host.document])) doc.querySelectorAll('link[data-world-css]').forEach((l) => l.remove());
  mountedCommit = commit;
  const base = `/world/${commit}/web/`;
  for (const doc of new Set([document, host.document])) {
    doc.head.append(h('link', { rel: 'stylesheet', href: `${base}world.css`, 'data-world-css': '1' }));
  }
  try {
    const mod = (await import(`${base}client.ts`)) as { mount?: (host: ClientHost) => WorldClient };
    if (typeof mod.mount !== 'function') throw new Error('web/client.ts does not export mount()');
    client = mod.mount(clientHost);
    if (lastContent) client.onContent(lastContent);
    if (lastState) client.onState(lastState);
    if (status) client.onStatus(status);
    client.resize();
    showBanner(null);
  } catch (e) {
    console.error(e);
    showBanner(`The garden's display code failed to load (${(e as Error).message}).`, true);
  }
}

function ensureMounted(): void {
  if (!worldInfo?.commit || worldInfo.commit === mountedCommit) return;
  const target = worldInfo.commit;
  mounting = (mounting ?? Promise.resolve()).then(() => mountWorld(target));
}

function forward(fn: (c: WorldClient) => void): void {
  if (!client) return;
  try {
    fn(client);
  } catch (e) {
    console.error('world client error', e);
  }
}

// ---------------------------------------------------------------- live stream

function connect(): void {
  const es = new EventSource('/api/stream');
  es.addEventListener('open', () => {
    connected = true;
    renderStatus();
  });
  es.addEventListener('error', () => {
    connected = false;
    renderStatus();
  });
  es.addEventListener('world', (e) => {
    const prev = worldInfo?.commit;
    worldInfo = JSON.parse((e as MessageEvent).data);
    if (prev && prev !== worldInfo!.commit) toast('🔨 The garden is running new code.', 5000);
    if (!worldInfo!.healthy && worldInfo!.lastError) showBanner('The garden stopped working and is being restarted…');
    else if (client) showBanner(null);
    ensureMounted();
    if (!$('panel-world').hidden) void loadWorld();
    renderStatus();
  });
  es.addEventListener('content', (e) => {
    lastContent = JSON.parse((e as MessageEvent).data);
    forward((c) => c.onContent(lastContent));
  });
  es.addEventListener('state', (e) => {
    lastState = JSON.parse((e as MessageEvent).data);
    forward((c) => c.onState(lastState));
  });
  es.addEventListener('event', (e) => {
    const ev = JSON.parse((e as MessageEvent).data);
    forward((c) => c.onEvent(ev));
  });
  es.addEventListener('status', (e) => {
    status = JSON.parse((e as MessageEvent).data);
    const badge = $('mail-badge');
    badge.hidden = !status?.unreadLetters;
    badge.textContent = String(status?.unreadLetters ?? 0);
    forward((c) => c.onStatus(status!));
    renderStatus();
  });
  es.addEventListener('journal', () => {
    if (!$('panel-journal').hidden) void loadJournal();
    if (!$('panel-mail').hidden) void loadLetters();
    if (!$('panel-world').hidden) void loadWorld();
  });
  es.addEventListener('rewrite', () => {
    if (!$('panel-world').hidden) void loadWorld();
  });
}

// ---------------------------------------------------------------- status line

const PHASES: Record<string, string> = {
  queued: 'heading to the shed',
  editing: 'tinkering in the shed',
  gating: 'testing the new code',
  swapping: 'installing the new code',
};

function renderStatus(): void {
  if (!connected) {
    statusEl.textContent = status ? '⚠️ Lost the garden server — reconnecting…' : '🌱 Connecting…';
    return;
  }
  const name = status?.gardenerName ?? 'The gardener';
  let text: string;
  if (status?.workshop) text = `🔨 ${name} is ${PHASES[status.workshop.phase] ?? 'in the shed'}…`;
  else if (status?.thinking) text = `💭 ${name} is thinking…`;
  else if (status?.nextRunAt) {
    const left = status.nextRunAt - Date.now();
    text = left > 0 ? `🌿 ${name}${activity ? `: ${activity}` : ''} · reads your doings in ${clock(left)}` : `🌿 ${name} is about to think…`;
  } else text = `🌿 ${name}${activity ? `: ${activity}` : ''}`;
  if (status?.world.probationUntil && status.world.probationUntil > Date.now()) text += ` · 🧪 new code ${clock(status.world.probationUntil - Date.now())}`;
  if (status?.lastError) text = `⚠️ ${text}`;
  statusEl.textContent = text;
  statusEl.title = status?.lastError ? `Last AI error: ${status.lastError}` : `${status?.provider ?? ''} ${status?.model ?? ''}`;
}
setInterval(renderStatus, 1000);

// ---------------------------------------------------------------- layout

function layout(): void {
  forward((c) => c.resize());
}
new ResizeObserver(layout).observe(stage);
window.addEventListener('resize', layout);

// ---------------------------------------------------------------- panels

const panels = ['mail', 'journal', 'world', 'settings', 'welcome', 'wish'] as const;
type PanelName = (typeof panels)[number];

function closePanels(): void {
  for (const p of panels) $(`panel-${p}`).hidden = true;
}

function openPanel(name: PanelName): void {
  const el = $(`panel-${name}`);
  const wasOpen = !el.hidden;
  closePanels();
  if (wasOpen) return;
  el.hidden = false;
  if (name === 'mail') void loadLetters();
  if (name === 'journal') void loadJournal();
  if (name === 'world') void loadWorld();
  if (name === 'settings') void loadSettings();
}

for (const p of ['mail', 'journal', 'world', 'settings'] as const) $(`btn-${p}`).addEventListener('click', () => openPanel(p));
$('btn-help').addEventListener('click', () => openPanel('welcome'));
app.addEventListener('click', (e) => {
  if ((e.target as HTMLElement).closest('[data-close]')) closePanels();
});
function onKey(e: KeyboardEvent): void {
  if (e.key === 'Escape') closePanels();
}
document.addEventListener('keydown', onKey);

// Mail -------------------------------------------------------------

interface Letter {
  id: number;
  sender: 'player' | 'agent';
  text: string;
  created_at: number;
  read_at: number | null;
}

async function loadLetters(): Promise<void> {
  const letters = await api<Letter[]>('GET', '/api/letters');
  const name = status?.gardenerName ?? 'your gardener';
  $('letters').replaceChildren(
    ...letters.map((l) =>
      h(
        'li',
        { class: `${l.sender}${l.sender === 'agent' && !l.read_at ? ' unread' : ''}` },
        h('span', { class: 'meta' }, `${l.sender === 'agent' ? `From ${name}` : 'You wrote'} · ${ago(l.created_at)}`),
        l.text,
      ),
    ),
  );
  for (const l of letters) if (l.sender === 'agent' && !l.read_at) void api('POST', `/api/letters/${l.id}/read`);
}

$('letter-send').addEventListener('click', async () => {
  const ta = $<HTMLTextAreaElement>('letter-text');
  const text = ta.value.trim();
  if (!text) return;
  try {
    await api('POST', '/api/letters', { text });
    ta.value = '';
    toast('📮 Letter posted. The flag is up!');
    await loadLetters();
  } catch (e) {
    toast((e as Error).message);
  }
});

// Journal -----------------------------------------------------------

interface JournalEntry {
  id: number;
  created_at: number;
  trigger: string;
  provider: string;
  model: string;
  status: string;
  iterations: number;
  summary: string;
  detail: {
    plan?: Record<string, unknown>;
    worldNotes?: string[];
    applyError?: string | null;
    attempts?: { iteration: number; requested: string[]; errors: string[] }[];
    fallback?: string[];
    rewrite?: { request: string; why: string } | null;
    error?: string;
    request?: string;
    reason?: string;
  };
}

const KERNEL_KEYS = new Set(['summary', 'letter', 'memories', 'forget', 'desires', 'rewrite']);

async function loadJournal(): Promise<void> {
  const entries = await api<JournalEntry[]>('GET', '/api/journal');
  if (!entries.length) {
    $('journal').replaceChildren(h('li', {}, 'Nothing written yet. Do something in the garden, or leave a letter, then wander off for a bit.'));
    return;
  }
  $('journal').replaceChildren(
    ...entries.map((j) => {
      const d = j.detail;
      const parts: string[] = [];
      const plan = d.plan ?? {};
      if (d.rewrite) parts.push(`Asked the shed for: ${d.rewrite.request}\n  (why: ${d.rewrite.why})`);
      if (d.request) parts.push(`Shed project: ${d.request}`);
      if (Array.isArray(plan.memories) && plan.memories.length) parts.push(`Remembered:\n${(plan.memories as string[]).map((m) => `  • ${m}`).join('\n')}`);
      if (plan.letter) parts.push('Left you a letter.');
      if (d.worldNotes?.length) parts.push(`In the garden:\n${d.worldNotes.map((n) => `  • ${n}`).join('\n')}`);
      if (d.applyError) parts.push(`The garden refused the plan: ${d.applyError}`);
      const errs = (d.attempts ?? []).filter((a) => a.errors.length);
      if (errs.length) parts.push(`Self-corrections:\n${errs.map((a) => `  #${a.iteration} (${a.requested.join(', ')}):\n${a.errors.map((e) => `    – ${e}`).join('\n')}`).join('\n')}`);
      if (d.fallback?.length) parts.push(`Fallbacks: ${d.fallback.join('; ')}`);
      if (d.error) parts.push(`Error: ${d.error}`);
      const worldPlan = Object.fromEntries(Object.entries(plan).filter(([k]) => !KERNEL_KEYS.has(k)));
      if (Object.keys(worldPlan).length) parts.push(`Plan:\n${JSON.stringify(worldPlan, null, 1)}`);
      return h(
        'li',
        {},
        h(
          'span',
          { class: 'meta' },
          `${ago(j.created_at)} · ${j.trigger}${j.provider !== 'kernel' ? ` · ${j.provider}/${j.model}` : ''}`,
          h('span', { class: `chip ${j.status}` }, j.status),
          j.iterations > 1 ? h('span', { class: 'chip' }, `${j.iterations} tries`) : null,
        ),
        j.summary,
        parts.length ? h('details', {}, h('summary', {}, 'Details'), h('pre', {}, parts.join('\n\n'))) : null,
      );
    }),
  );
}

// The shed ----------------------------------------------------------

interface RewriteRow {
  id: number;
  created_at: number;
  request: string;
  why: string;
  status: string;
  rounds: number;
  summary: string;
  commit_sha: string | null;
  diff: string;
  log: { round: number; summary: string; gates: { name: string; ok: boolean; ms: number; output: string }[] }[];
}

interface Commit {
  sha: string;
  at: number;
  subject: string;
}

async function loadWorld(): Promise<void> {
  const [history, rewrites] = await Promise.all([
    api<{ current: string; lastGood: string[]; commits: Commit[] }>('GET', '/api/world/history'),
    api<RewriteRow[]>('GET', '/api/rewrites'),
  ]);
  const w = worldInfo;
  $('world-summary').textContent = w
    ? `Running version ${w.commit.slice(0, 8)} (data v${w.version})${w.healthy ? '' : ' — currently restarting'}${
        w.probationUntil && w.probationUntil > Date.now() ? ` · on probation for ${clock(w.probationUntil - Date.now())}` : ''
      }${w.rewritesAvailable ? '' : ' · git was not found, so code rewrites are disabled'}`
    : '';
  $('rewrites').replaceChildren(
    ...(rewrites.length
      ? rewrites.map((r) => {
          const gateLog = r.log
            .map((l) => `Attempt ${l.round}${l.summary ? `: ${l.summary}` : ''}\n${l.gates.map((g) => `  ${g.ok ? '✔' : '✘'} ${g.name} (${g.ms}ms)${g.ok ? '' : `\n${g.output.split('\n').map((x) => `      ${x}`).join('\n')}`}`).join('\n')}`)
            .join('\n\n');
          return h(
            'li',
            {},
            h('span', { class: 'meta' }, `${ago(r.created_at)}`, h('span', { class: `chip ${r.status === 'live' ? 'ok' : r.status === 'failed' || r.status === 'rolled-back' ? 'error' : 'repaired'}` }, r.status), r.rounds > 1 ? h('span', { class: 'chip' }, `${r.rounds} attempts`) : null),
            h('strong', {}, r.request),
            r.summary ? h('div', {}, r.summary) : null,
            gateLog ? h('details', {}, h('summary', {}, 'Checks'), h('pre', {}, gateLog)) : null,
            r.diff ? h('details', {}, h('summary', {}, 'Code changes'), h('pre', { class: 'diff' }, r.diff)) : null,
          );
        })
      : [h('li', {}, 'No shed projects yet. Write your gardener a letter asking for something mods could never do.')]),
  );
  $('commits').replaceChildren(
    ...history.commits.map((c) => {
      const isLive = c.sha === history.current;
      const good = history.lastGood.includes(c.sha);
      const diffBox = h('pre', { class: 'diff', hidden: true });
      return h(
        'li',
        {},
        h('span', { class: `sha${isLive ? ' live' : ''}` }, c.sha.slice(0, 8)),
        h('span', {}, `${c.subject}`),
        h('span', { class: 'muted' }, `${ago(c.at)}${isLive ? ' · live' : ''}${good ? ' · known good' : ''}`),
        h(
          'button',
          {
            class: 'btn ghost',
            onclick: async () => {
              if (diffBox.hidden) {
                const d = await api<{ stat: string; patch: string }>('GET', `/api/world/diff/${c.sha}`);
                diffBox.textContent = `${d.stat}\n${d.patch}`;
              }
              diffBox.hidden = !diffBox.hidden;
            },
          },
          'Diff',
        ),
        isLive
          ? null
          : h(
              'button',
              {
                class: 'btn ghost',
                onclick: async () => {
                  if (!host.confirm(`Make version ${c.sha.slice(0, 8)} the garden's code again? (Recorded as a new version; nothing is lost.)`)) return;
                  try {
                    await api('POST', '/api/world/revert', { sha: c.sha });
                    toast('⏪ Reverted.');
                  } catch (e) {
                    toast((e as Error).message, 6000);
                  }
                  await loadWorld();
                },
              },
              'Revert to this',
            ),
        diffBox,
      );
    }),
  );
}

$('btn-reset-world').addEventListener('click', async () => {
  if (!host.confirm("Replace the garden's code with the original version? Your garden itself is kept, and every past version stays in the history.")) return;
  try {
    await api('POST', '/api/world/reset');
    toast('🌱 The garden is running the original code.');
  } catch (e) {
    toast((e as Error).message, 6000);
  }
  await loadWorld();
});

// Settings -----------------------------------------------------------

interface ProviderInfo {
  id: string;
  name: string;
  kind: string;
  description: string;
  modelSuggestions: string[];
  defaultModel: string;
  configHint?: string;
  canEdit: boolean;
}

let providers: ProviderInfo[] = [];
const form = $<HTMLFormElement>('settings-form');
const NUMERIC = ['debounceMinutes', 'maxIterations', 'timeoutSeconds', 'workshopRounds', 'workshopTimeoutMinutes', 'probationMinutes'];

async function loadSettings(): Promise<void> {
  const data = await api<{ settings: Record<string, unknown>; providers: ProviderInfo[] }>('GET', '/api/settings');
  providers = data.providers;
  const sel = $<HTMLSelectElement>('provider');
  sel.replaceChildren(...providers.map((p) => h('option', { value: p.id }, `${p.name}${p.canEdit ? '' : ' (no code rewrites)'}`)));
  for (const [k, v] of Object.entries(data.settings)) {
    const input = form.elements.namedItem(k) as HTMLInputElement | null;
    if (!input) continue;
    if (input.type === 'checkbox') input.checked = v === true;
    else input.value = v === undefined || v === null ? '' : String(v);
  }
  describeProvider();
}

function describeProvider(): void {
  const p = providers.find((x) => x.id === $<HTMLSelectElement>('provider').value);
  if (!p) return;
  $('provider-desc').textContent = `${p.description} ${p.configHint ?? ''}`;
  $('model-list').replaceChildren(...p.modelSuggestions.map((m) => h('option', { value: m })));
  const model = $<HTMLInputElement>('model');
  model.placeholder = p.defaultModel ? `default: ${p.defaultModel}` : p.kind === 'cli' ? "blank = the CLI's own default" : p.kind === 'offline' ? 'not needed' : 'model name';
  void api<{ models: string[] }>('GET', `/api/providers/${p.id}/models`)
    .then(({ models }) => {
      if ($<HTMLSelectElement>('provider').value === p.id) $('model-list').replaceChildren(...models.map((m) => h('option', { value: m })));
    })
    .catch(() => {});
}

$('provider').addEventListener('change', () => {
  describeProvider();
  const p = providers.find((x) => x.id === $<HTMLSelectElement>('provider').value);
  $<HTMLInputElement>('model').value = p?.defaultModel ?? '';
});

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const body: Record<string, unknown> = {};
  for (const el of [...form.elements] as HTMLInputElement[]) {
    if (!el.name) continue;
    if (el.type === 'checkbox') body[el.name] = el.checked;
    else body[el.name] = NUMERIC.includes(el.name) ? Number(el.value) : el.value.trim();
  }
  try {
    await api('PUT', '/api/settings', body);
    $('settings-result').textContent = 'Saved.';
  } catch (err) {
    $('settings-result').textContent = (err as Error).message;
  }
});

$('btn-test').addEventListener('click', async () => {
  $('settings-result').textContent = 'Testing… (save first if you changed anything)';
  try {
    const r = await api<{ ok: boolean; detail: string }>('POST', '/api/agent/test');
    $('settings-result').textContent = `${r.ok ? '✔' : '✘'} ${r.detail}`;
  } catch (err) {
    $('settings-result').textContent = (err as Error).message;
  }
});

$('btn-think').addEventListener('click', async () => {
  const r = await api<{ started: boolean; reason?: string }>('POST', '/api/agent/think');
  $('settings-result').textContent = r.started ? 'Thinking… results land in the journal.' : (r.reason ?? '');
});

// ---------------------------------------------------------------- PiP

$('btn-pip').title = pipSupported() ? 'Float on top of other windows' : 'Open as a compact window (always-on-top needs Chrome/Edge 116+)';
$('btn-pip').addEventListener('click', async () => {
  if (host !== window) {
    exitPip();
    return;
  }
  await enterPip(app, $('launcher'), {
    onEnter(win) {
      host = win;
      win.document.addEventListener('keydown', onKey);
      win.addEventListener('resize', layout);
      // Re-mount so the world client binds to the new window (animation frames, input).
      const commit = mountedCommit;
      mountedCommit = '';
      void mountWorld(commit);
    },
    onExit() {
      host = window;
      const commit = mountedCommit;
      mountedCommit = '';
      void mountWorld(commit);
    },
  });
});
$('restore').addEventListener('click', exitPip);

// ---------------------------------------------------------------- go

// ---------------------------------------------------------------- onboarding

interface Onboarding {
  welcomed: boolean;
  firstWish: { text: string; at: number } | null;
}

const WISH_IDEAS = [
  'A cottage garden overflowing with flowers',
  'Vegetables for a good soup',
  'Something strange that glows at night',
  'A calm herb garden that smells nice',
  'Surprise me!',
];

$('wish-ideas').replaceChildren(
  ...WISH_IDEAS.map((idea) =>
    h('button', { type: 'button', onclick: () => (($<HTMLTextAreaElement>('wish-text').value = idea), $('wish-text').focus()) }, idea),
  ),
);

async function loadOnboarding(): Promise<Onboarding | null> {
  try {
    return await api<Onboarding>('GET', '/api/onboarding');
  } catch {
    return null;
  }
}

$('btn-welcome-done').addEventListener('click', async () => {
  await api('POST', '/api/onboarding/welcomed').catch(() => {});
  closePanels();
  const o = await loadOnboarding();
  if (o && !o.firstWish) openPanel('wish');
});

$('wish-send').addEventListener('click', async () => {
  const ta = $<HTMLTextAreaElement>('wish-text');
  const text = ta.value.trim();
  if (!text) {
    ta.focus();
    return;
  }
  try {
    await api('POST', '/api/letters', { text, firstWish: true });
    ta.value = '';
    closePanels();
    toast('📮 Wish posted! Watch the garden…', 5000);
  } catch (e) {
    toast((e as Error).message);
  }
});

function renderGardenerName(): void {
  const name = status?.gardenerName;
  if (!name) return;
  for (const el of app.querySelectorAll('.gardener-name')) el.textContent = name;
}
setInterval(renderGardenerName, 2000);

void loadOnboarding().then((o) => {
  if (!o) return;
  if (!o.welcomed) openPanel('welcome');
  else if (!o.firstWish) openPanel('wish');
});

connect();
