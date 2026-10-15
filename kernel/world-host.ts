// Runs INSIDE the world child process (under Node's permission model). Loads
// the world module, drives its clock and answers kernel requests over IPC.
// Must not import anything outside this file: the child may only read this
// file's directory, the world directory and the mods directory.

import { pathToFileURL } from 'node:url';
import type { HostMessage, HostRequest, World, WorldModule } from './contract.ts';

const API_VERSION = 1;

// Speed bumps only — Node 24's permission model cannot restrict network access.
for (const name of ['fetch', 'WebSocket', 'EventSource']) {
  try {
    delete (globalThis as Record<string, unknown>)[name];
  } catch {
    // non-configurable in some builds
  }
}

let world: World | null = null;
let ticker: NodeJS.Timeout | undefined;
let streamer: NodeJS.Timeout | undefined;

function send(msg: HostMessage): void {
  process.send?.(msg);
}

function reply(id: number, fn: () => unknown): void {
  Promise.resolve()
    .then(fn)
    .then(
      (result) => send({ type: 'reply', id, ok: true, result: result === undefined ? null : result }),
      (e: unknown) => send({ type: 'reply', id, ok: false, error: e instanceof Error ? `${e.message}\n${e.stack ?? ''}`.slice(0, 4000) : String(e) }),
    );
}

function need(): World {
  if (!world) throw new Error('world not initialised');
  return world;
}

function resolve(path: string): { fn: (...a: unknown[]) => unknown; self: unknown } {
  const parts = path.split('.');
  let self: unknown = need();
  let target: unknown = self;
  for (const p of parts) {
    self = target;
    target = (target as Record<string, unknown> | undefined)?.[p];
  }
  if (typeof target !== 'function') throw new Error(`world does not implement ${path}()`);
  return { fn: target as (...a: unknown[]) => unknown, self };
}

async function init(req: Extract<HostRequest, { op: 'init' }>): Promise<unknown> {
  const mod = (await import(pathToFileURL(req.worldEntry).href)) as Partial<WorldModule>;
  if (mod.apiVersion !== API_VERSION) throw new Error(`world apiVersion is ${String(mod.apiVersion)}, kernel needs ${API_VERSION}`);
  if (typeof mod.createWorld !== 'function') throw new Error('world does not export createWorld()');
  if (typeof mod.version !== 'string') throw new Error('world does not export a string version');
  world = await mod.createWorld({
    ...req.init,
    emit: (m) => {
      if (m.type === 'event') send({ type: 'event', event: m.event });
      else if (m.type === 'content') send({ type: 'content' });
      else if (m.type === 'log') send({ type: 'log', text: String(m.text).slice(0, 2000) });
    },
  });
  for (const k of ['tick', 'snapshot', 'publicState', 'content', 'rpc'] as const) {
    if (typeof world[k] !== 'function') throw new Error(`world is missing ${k}()`);
  }
  return { version: mod.version };
}

function soak(seconds: number, step: number): unknown {
  const w = need();
  const t0 = Date.now();
  for (let t = 0; t < seconds; t += step) w.tick(step);
  const snap = w.snapshot();
  const json = JSON.stringify(snap);
  JSON.parse(json);
  JSON.stringify(w.publicState());
  JSON.stringify(w.content());
  for (const allowMods of [false, true]) {
    const opts = { allowMods };
    const sections = w.agent.sections(opts);
    if (!Array.isArray(sections)) throw new Error('agent.sections() must return an array');
    if (typeof w.agent.guide(opts) !== 'string') throw new Error('agent.guide() must return a string');
    JSON.stringify(w.agent.context(opts));
  }
  return { ms: Date.now() - t0, snapshotBytes: json.length };
}

function start(tickMs: number, stateMs: number): void {
  const w = need();
  let last = Date.now();
  ticker = setInterval(() => {
    const now = Date.now();
    const dt = Math.min(5, (now - last) / 1000);
    last = now;
    w.tick(dt);
  }, tickMs);
  streamer = setInterval(() => send({ type: 'state', state: w.publicState() }), stateMs);
  send({ type: 'state', state: w.publicState() });
}

process.on('message', (req: HostRequest) => {
  switch (req.op) {
    case 'init':
      return reply(req.id, () => init(req));
    case 'call':
      return reply(req.id, () => {
        const { fn, self } = resolve(req.method);
        return fn.apply(self, req.args);
      });
    case 'soak':
      return reply(req.id, () => soak(req.seconds, req.step));
    case 'start':
      return reply(req.id, () => start(req.tickMs, req.stateMs));
    case 'stop':
      clearInterval(ticker);
      clearInterval(streamer);
      try {
        world?.dispose?.();
      } catch {
        // shutting down anyway
      }
      send({ type: 'reply', id: req.id, ok: true, result: null });
      setTimeout(() => process.exit(0), 50);
      return;
  }
});

process.on('disconnect', () => process.exit(0));
