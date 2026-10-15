// Kernel entry point. Wires persistence, the live world (supervised child
// process), the planner, the workshop and the HTTP/SSE server. The kernel never
// looks inside the world's state: it stores snapshots and forwards streams.

import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { mkdirSync, realpathSync } from 'node:fs';
import { Store } from './db.ts';
import { App, HttpError } from './http.ts';
import { Checker } from './check.ts';
import { DEFAULT_SETTINGS, Planner, Scheduler, type AgentSettings } from './ai/planner.ts';
import { getProvider, listProviders } from './ai/providers/index.ts';
import { MODEL_PATTERN } from './ai/providers/types.ts';
import type { KernelStatus, RpcResult } from './contract.ts';
import { WorldRepo } from './world-repo.ts';
import { Supervisor } from './supervisor.ts';
import { Workshop } from './workshop.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = resolve(process.env.GARDEN_DATA ?? join(root, 'data'));
mkdirSync(dataDir, { recursive: true });
const modsDir = resolve(process.env.GARDEN_MODS ?? join(root, 'mods'));
mkdirSync(modsDir, { recursive: true });
const port = Number(process.env.PORT ?? 4747);

const store = new Store(join(dataDir, 'garden.db'));
const settings = (): AgentSettings => {
  const s = { ...DEFAULT_SETTINGS, ...(store.get<Partial<AgentSettings>>('settings') ?? {}) };
  if (s.provider === 'mock') s.provider = 'offline'; // renamed
  return s;
};
const app = new App(join(root, 'kernel', 'web'));
const gitAvailable = await WorldRepo.available();
const repo = new WorldRepo(join(realpathSync.native(dataDir), 'world'), join(root, 'world'), join(root, 'kernel', 'contract.ts'));

// ---------------------------------------------------------------- status

let swapping = false;
let lastStatus = '';
function status(): KernelStatus {
  const s = settings();
  return {
    thinking: planner.running,
    pending: scheduler.pendingCount(),
    nextRunAt: scheduler.nextRunAt(),
    lastError: planner.lastError,
    unreadLetters: store.unreadAgentLetters(),
    provider: s.provider,
    model: s.model,
    gardenerName: s.gardenerName,
    workshop: workshop.current ? { phase: workshop.current.phase, request: workshop.current.request } : null,
    world: { commit: supervisor.commit, version: supervisor.version, healthy: supervisor.healthy, probationUntil: supervisor.probation?.until ?? null },
  };
}
function broadcastStatus(): void {
  const s = status();
  const json = JSON.stringify(s);
  if (json !== lastStatus) {
    lastStatus = json;
    app.broadcast('status', s);
  }
}

// ---------------------------------------------------------------- world

const supervisor = new Supervisor({
  store,
  repo,
  modsDir,
  probationMinutes: () => settings().probationMinutes,
  onState: (s) => app.broadcast('state', s),
  onEvent: (e) => app.clients && app.broadcast('event', e),
  onContent: (c) => app.broadcast('content', c),
  onWorldChanged: () => {
    app.broadcast('world', worldInfo());
    broadcastStatus();
  },
  onRolledBack: ({ from, to, reason, rewriteId }) => {
    if (rewriteId) store.updateRewrite(rewriteId, { status: 'rolled-back' });
    store.addJournal({
      trigger: 'rollback',
      provider: 'kernel',
      model: '',
      status: 'error',
      iterations: 0,
      summary: `The garden's code was rolled back from ${from.slice(0, 8)} to ${to.slice(0, 8)}: ${reason}.`,
      detail: JSON.stringify({ from, to, reason, rewriteId }),
    });
    app.broadcast('journal', {});
    setTimeout(() => void supervisor.world?.call('notify', 'workshop', { phase: 'rolled-back' }).catch(() => {}), 1500);
  },
  log: (t) => console.log(t),
});

function worldInfo() {
  return {
    commit: supervisor.commit,
    version: supervisor.version,
    healthy: supervisor.healthy,
    lastError: supervisor.lastError,
    probationUntil: supervisor.probation?.until ?? null,
    rewritesAvailable: gitAvailable,
  };
}

function world() {
  if (!supervisor.world) throw new HttpError(503, 'the world is restarting');
  return supervisor.world;
}

// ---------------------------------------------------------------- agent + workshop

const workshop = new Workshop({
  store,
  repo,
  supervisor,
  dataDir,
  modsDir,
  settings,
  quiesce: async () => {
    swapping = true;
    while (planner.running) await new Promise((r) => setTimeout(r, 250));
    return () => {
      swapping = false;
    };
  },
  onPhase: (phase, partial) => {
    const rw = store.rewrite(partial.id) ?? partial;
    app.broadcast('rewrite', { id: rw.id, phase });
    broadcastStatus();
    if (phase === 'live' || phase === 'failed') {
      const s = settings();
      store.addJournal({
        trigger: 'workshop',
        provider: s.provider,
        model: s.model || '(default)',
        status: phase === 'live' ? 'ok' : 'error',
        iterations: rw.rounds,
        summary:
          phase === 'live'
            ? rw.summary || 'I rebuilt part of the garden in the shed.'
            : `My shed project failed and nothing changed: ${(rw.summary || 'it did not pass the checks').slice(0, 600)}`,
        detail: JSON.stringify({ rewriteId: rw.id, request: rw.request, status: phase, commit: rw.commit_sha }),
      });
      app.broadcast('journal', {});
      void supervisor.world?.call('notify', 'workshop', { phase }).catch(() => {});
    }
  },
});

const planner = new Planner({
  store,
  world,
  dataDir,
  settings,
  rewriteAllowed: () => gitAvailable && settings().codeRewrites && Workshop.supportsEdit(settings().provider) && !workshop.busy,
  codeInfo: () => ({ worldVersion: supervisor.version, commit: supervisor.commit }),
  onRewrite: (rewrite, journalId) => {
    const row = store.addRewrite(rewrite.request, rewrite.why, journalId);
    if (workshop.start(row)) void supervisor.world?.call('notify', 'workshop', { phase: 'start', request: rewrite.request }).catch(() => {});
    broadcastStatus();
  },
  onPlanned: () => {
    void supervisor.save();
    app.broadcast('journal', {});
    broadcastStatus();
  },
});
const scheduler = new Scheduler(planner, store, settings, () => swapping || !supervisor.world);

// ---------------------------------------------------------------- start

await supervisor.start();
scheduler.start();
setInterval(broadcastStatus, 1000);
setInterval(() => void supervisor.save(), 15_000);

function playerActivity(kind: string, summary: string): void {
  store.addEvent(kind, { summary });
  scheduler.noteActivity();
  broadcastStatus();
}

// ---------------------------------------------------------------- HTTP: static + SSE

// World client code is served from the LIVE world repo; the commit segment only busts caches.
app.mount(/^\/world\/[0-9a-f]{4,40}\/(.+)$/, () => repo.repoDir, /^(web|src)\/[\w./-]+\.(ts|css|json|png|svg|js)$/);

app.onConnect = (res) => {
  app.send(res, 'world', worldInfo());
  app.send(res, 'status', status());
  if (supervisor.lastContent) app.send(res, 'content', supervisor.lastContent);
  if (supervisor.lastState) app.send(res, 'state', supervisor.lastState);
};

// ---------------------------------------------------------------- HTTP: API

app.on('GET', '/api/status', () => status());
app.on('GET', '/api/world', () => worldInfo());

app.on('POST', '/api/world/rpc', async (_req, body) => {
  const b = (body ?? {}) as { method?: unknown; params?: unknown };
  if (typeof b.method !== 'string' || !/^[\w.-]{1,60}$/.test(b.method)) throw new HttpError(400, 'method must be a short name');
  let r: RpcResult;
  try {
    r = await world().call<RpcResult>('rpc', b.method, b.params ?? null);
  } catch (e) {
    if (e instanceof HttpError) throw e;
    throw new HttpError(400, (e as Error).message.split('\n')[0]);
  }
  if (r?.activity && typeof r.activity.kind === 'string') playerActivity(r.activity.kind.slice(0, 40), String(r.activity.summary ?? '').slice(0, 300));
  return r?.result ?? null;
});

app.on('GET', '/api/world/history', async () => ({
  current: supervisor.commit,
  lastGood: supervisor.lastGood(),
  commits: gitAvailable ? await repo.log(40) : [],
}));
app.on('GET', '/api/world/diff/:sha', async (_req, _b, [sha]) => {
  if (!/^[0-9a-f]{7,40}$/.test(sha)) throw new HttpError(400, 'bad commit');
  try {
    return await repo.diff(`${sha}~1`, sha);
  } catch {
    return { stat: '(first version)', patch: '' };
  }
});
app.on('POST', '/api/world/revert', async (_req, body) => {
  const sha = (body as { sha?: unknown })?.sha;
  if (typeof sha !== 'string' || !/^[0-9a-f]{7,40}$/.test(sha)) throw new HttpError(400, 'bad commit');
  if (workshop.busy) throw new HttpError(409, 'the gardener is busy in the shed');
  const r = await supervisor.replaceCode({ revertTo: sha });
  if (!r.ok) throw new HttpError(500, `that version would not start: ${r.error?.split('\n')[0]}`);
  return worldInfo();
});
app.on('POST', '/api/world/reset', async () => {
  if (workshop.busy) throw new HttpError(409, 'the gardener is busy in the shed');
  const r = await supervisor.replaceCode({ template: true });
  if (!r.ok) throw new HttpError(500, `the template would not start: ${r.error?.split('\n')[0]}`);
  return worldInfo();
});
app.on('GET', '/api/rewrites', () => store.rewrites(50).map((r) => ({ ...r, log: JSON.parse(r.log) })));

app.on('GET', '/api/letters', () => store.letters(200));
interface Onboarding {
  welcomed: boolean;
  firstWish: { text: string; at: number } | null;
}
const onboarding = (): Onboarding => ({ welcomed: false, firstWish: null, ...(store.get<Partial<Onboarding>>('onboarding') ?? {}) });

app.on('GET', '/api/onboarding', () => onboarding());
app.on('POST', '/api/onboarding/welcomed', () => {
  store.set('onboarding', { ...onboarding(), welcomed: true });
  return onboarding();
});

app.on('POST', '/api/letters', async (_req, body) => {
  const b = (body ?? {}) as { text?: unknown; firstWish?: unknown };
  const c = new Checker();
  c.str(b.text, 'text', { min: 1, max: 2000 });
  if (!c.ok) throw new HttpError(400, c.errors.join('; '));
  const text = (b.text as string).trim();
  const isFirstWish = b.firstWish === true && !onboarding().firstWish;
  const letter = store.addLetter('player', isFirstWish ? `(My first wish, answering "What kind of garden should I grow?") ${text}` : text);
  // Whatever the player writes first counts as their first wish, so the prompt stops appearing.
  if (!onboarding().firstWish) store.set('onboarding', { ...onboarding(), firstWish: { text, at: Date.now() } });
  scheduler.noteActivity();
  await supervisor.world?.call('notify', 'letter', { id: letter.id }).catch(() => {});
  // The first wish is answered straight away rather than after the usual quiet period.
  if (isFirstWish && !planner.running) void scheduler.trigger('the player made their first wish').then(broadcastStatus);
  broadcastStatus();
  return letter;
});
app.on('POST', '/api/letters/:id/read', (_req, _b, [id]) => {
  store.markLetterRead(Number(id));
  broadcastStatus();
  return { ok: true };
});

app.on('GET', '/api/journal', () => store.journal(100).map((j) => ({ ...j, detail: JSON.parse(j.detail) })));
app.on('GET', '/api/memories', () => ({ memories: store.memories(100) }));

const SETTING_KEYS = [
  'provider',
  'model',
  'debounceMinutes',
  'maxIterations',
  'timeoutSeconds',
  'command',
  'baseUrl',
  'gardenerName',
  'codeRewrites',
  'workshopRounds',
  'workshopTimeoutMinutes',
  'probationMinutes',
];
app.on('GET', '/api/settings', () => ({
  settings: settings(),
  providers: listProviders().map((p) => ({ ...p.info, canEdit: typeof p.edit === 'function' })),
  gitAvailable,
}));
app.on('PUT', '/api/settings', (_req, body) => {
  const next = { ...settings(), ...(body as object) } as AgentSettings;
  const c = new Checker();
  c.obj(next, '$', SETTING_KEYS);
  c.str(next.provider, '$.provider', { oneOf: listProviders().map((p) => p.info.id) });
  if (next.model) c.str(next.model, '$.model', { pattern: MODEL_PATTERN, patternHint: 'a model name' });
  c.num(next.debounceMinutes, '$.debounceMinutes', { min: 0.25, max: 240 });
  c.num(next.maxIterations, '$.maxIterations', { int: true, min: 1, max: 8 });
  c.num(next.timeoutSeconds, '$.timeoutSeconds', { min: 20, max: 1800 });
  if (next.command) c.str(next.command, '$.command', { pattern: /^[A-Za-z0-9._:/\\\- ()]+$/, patternHint: 'an executable path' });
  if (next.baseUrl) c.str(next.baseUrl, '$.baseUrl', { pattern: /^https?:\/\/[^\s]+$/, patternHint: 'an http(s) URL' });
  c.str(next.gardenerName, '$.gardenerName', { min: 1, max: 24 });
  c.bool(next.codeRewrites, '$.codeRewrites');
  c.num(next.workshopRounds, '$.workshopRounds', { int: true, min: 1, max: 6 });
  c.num(next.workshopTimeoutMinutes, '$.workshopTimeoutMinutes', { min: 2, max: 120 });
  c.num(next.probationMinutes, '$.probationMinutes', { min: 0.5, max: 1440 });
  if (!c.ok) throw new HttpError(400, c.errors.join('; '));
  store.set('settings', next);
  broadcastStatus();
  return next;
});
function providerSettings(id: string) {
  const s = settings();
  const p = getProvider(id);
  return {
    model: (s.provider === id ? s.model : '') || p.info.defaultModel,
    timeoutSeconds: s.timeoutSeconds,
    command: s.provider === id ? s.command : undefined,
    baseUrl: s.baseUrl,
    workDir: join(dataDir, 'agent-work'),
  };
}
app.on('GET', '/api/providers/:id/models', async (_req, _b, [id]) => {
  const p = listProviders().find((x) => x.info.id === id);
  if (!p) throw new HttpError(404, 'unknown provider');
  let discovered: string[] = [];
  try {
    discovered = (await p.listModels?.(providerSettings(id))) ?? [];
  } catch {
    // discovery is best-effort
  }
  return { models: [...new Set([...discovered, ...p.info.modelSuggestions])] };
});
app.on('POST', '/api/agent/test', async () => getProvider(settings().provider).available(providerSettings(settings().provider)));
app.on('POST', '/api/agent/think', () => {
  if (planner.running) return { started: false, reason: 'already thinking' };
  if (!supervisor.world) return { started: false, reason: 'the world is restarting' };
  void scheduler.trigger('the player asked me to think now').then(broadcastStatus);
  queueMicrotask(broadcastStatus);
  return { started: true };
});

await app.listen(port);
console.log(`Agent Garden is growing at http://localhost:${port}  (data: ${dataDir}, mods: ${modsDir}${gitAvailable ? '' : ', git not found: code rewrites disabled'})`);

async function shutdown(): Promise<void> {
  scheduler.stop();
  await supervisor.stop().catch(() => {});
  store.close();
  process.exit(0);
}
process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
