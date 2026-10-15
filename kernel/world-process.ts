// Kernel side of a world: spawns the sandboxed child, speaks the IPC protocol,
// and watches for crashes and hangs. Also provides an in-process adapter with
// the same interface for tests.

import { fork, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Callable, HostMessage, HostRequest, SavedWorld, World, WorldModule } from './contract.ts';

const HOST = join(dirname(fileURLToPath(import.meta.url)), 'world-host.ts');

export interface WorldStartOptions {
  worldDir: string; // contains src/index.ts
  modsDir: string;
  saved: SavedWorld | null;
  seed: number;
  awaySeconds: number;
  clock: boolean; // run the tick loop and stream state (false for gates)
}

/** What the kernel needs from a world, whether it runs in a child process or in-process. */
export interface WorldHandle extends EventEmitter {
  version: string;
  call<T = unknown>(method: Callable, ...args: unknown[]): Promise<T>;
  stop(): Promise<void>;
}

export interface WorldExit {
  code: number | null;
  signal: string | null;
  reason: 'crash' | 'hung';
  stderr: string;
}

/**
 * Events: 'state' (state), 'event' (event), 'content', 'log' (text), 'exit' (WorldExit) — the
 * last only for unexpected exits.
 */
export class WorldProcess extends EventEmitter implements WorldHandle {
  version = '';
  private child: ChildProcess | null = null;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  private stopping = false;
  private lastSeen = Date.now();
  private watchdog?: NodeJS.Timeout;
  private stderr = '';

  static async start(opts: WorldStartOptions, hangMs = 10_000): Promise<WorldProcess> {
    const wp = new WorldProcess();
    await wp.launch(opts, hangMs);
    return wp;
  }

  private async launch(opts: WorldStartOptions, hangMs: number): Promise<void> {
    const worldDir = realpathSync.native(opts.worldDir);
    const modsDir = realpathSync.native(opts.modsDir);
    const hostDir = dirname(realpathSync.native(HOST));
    this.child = fork(join(hostDir, 'world-host.ts'), [], {
      execArgv: [
        '--disable-warning=ExperimentalWarning',
        '--permission',
        `--allow-fs-read=${join(hostDir, 'world-host.ts')}`,
        `--allow-fs-read=${worldDir}`,
        `--allow-fs-read=${modsDir}`,
        `--allow-fs-write=${modsDir}`,
      ],
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      cwd: modsDir,
    });
    this.child.stdout?.on('data', (d) => this.emit('log', String(d)));
    this.child.stderr?.on('data', (d) => {
      this.stderr = (this.stderr + String(d)).slice(-8000);
      this.emit('log', String(d));
    });
    this.child.on('message', (m: HostMessage) => this.onMessage(m));
    this.child.on('exit', (code, signal) => this.onExit(code, signal, 'crash'));
    try {
      const info = await this.request<{ version: string }>({ op: 'init', worldEntry: join(worldDir, 'src', 'index.ts'), init: { saved: opts.saved, seed: opts.seed, awaySeconds: opts.awaySeconds, modsDir } }, 30_000);
      this.version = info.version;
      if (opts.clock) await this.request({ op: 'start', tickMs: 250, stateMs: 500 });
    } catch (e) {
      // Never leave a half-started world behind.
      this.stopping = true;
      this.child?.kill();
      throw e;
    }
    if (opts.clock) {
      this.watchdog = setInterval(() => {
        if (Date.now() - this.lastSeen > hangMs) this.kill('hung');
      }, 1000);
    }
  }

  private onMessage(m: HostMessage): void {
    this.lastSeen = Date.now();
    switch (m.type) {
      case 'reply': {
        const p = this.pending.get(m.id);
        if (!p) return;
        this.pending.delete(m.id);
        clearTimeout(p.timer);
        if (m.ok) p.resolve(m.result);
        else p.reject(new Error(m.error));
        return;
      }
      case 'state':
        this.emit('state', m.state);
        return;
      case 'event':
        this.emit('event', m.event);
        return;
      case 'content':
        this.emit('content');
        return;
      case 'log':
        this.emit('log', m.text);
        return;
    }
  }

  private onExit(code: number | null, signal: NodeJS.Signals | null, reason: WorldExit['reason']): void {
    clearInterval(this.watchdog);
    const err = new Error(`world process exited (${reason}, code ${code}, signal ${signal})\n${this.stderr.slice(-2000)}`);
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
    const child = this.child;
    this.child = null;
    if (!this.stopping && child) this.emit('exit', { code, signal, reason, stderr: this.stderr } satisfies WorldExit);
  }

  private kill(reason: WorldExit['reason']): void {
    const child = this.child;
    if (!child) return;
    child.removeAllListeners('exit');
    child.on('exit', (code, signal) => this.onExit(code, signal, reason));
    child.kill();
  }

  private request<T>(req: DistributiveOmit<HostRequest, 'id'>, timeoutMs = 15_000): Promise<T> {
    const child = this.child;
    if (!child?.connected) return Promise.reject(new Error('world process is not running'));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`world did not answer ${req.op}${'method' in req ? ` ${req.method}` : ''} within ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      child.send({ ...req, id } as HostRequest);
    });
  }

  call<T = unknown>(method: Callable, ...args: unknown[]): Promise<T> {
    return this.request<T>({ op: 'call', method, args }, method === 'agent.apply' ? 60_000 : 15_000);
  }

  soak(seconds: number, step: number, timeoutMs = 60_000): Promise<{ ms: number; snapshotBytes: number }> {
    return this.request({ op: 'soak', seconds, step }, timeoutMs);
  }

  get running(): boolean {
    return !!this.child;
  }

  async stop(): Promise<void> {
    this.stopping = true;
    clearInterval(this.watchdog);
    const child = this.child;
    if (!child) return;
    const exited = new Promise<void>((r) => child.once('exit', () => r()));
    try {
      await this.request({ op: 'stop' }, 3000);
    } catch {
      // fall through to kill
    }
    const timer = setTimeout(() => child.kill(), 3000);
    await exited;
    clearTimeout(timer);
  }
}

/** Same interface, but the world runs in this process (tests, tooling). No isolation. */
export class InProcessWorld extends EventEmitter implements WorldHandle {
  version: string;
  world: World;

  private constructor(version: string, world: World) {
    super();
    this.version = version;
    this.world = world;
  }

  static async load(worldDir: string, opts: Omit<WorldStartOptions, 'worldDir' | 'clock'>): Promise<InProcessWorld> {
    const mod = (await import(new URL(`file:///${join(realpathSync.native(worldDir), 'src', 'index.ts').replace(/\\/g, '/')}`).href)) as WorldModule;
    let self: InProcessWorld | null = null;
    const world = await mod.createWorld({
      saved: opts.saved,
      seed: opts.seed,
      awaySeconds: opts.awaySeconds,
      modsDir: opts.modsDir,
      emit: (m) => {
        if (m.type === 'event') self?.emit('event', m.event);
        else if (m.type === 'content') self?.emit('content');
        else self?.emit('log', m.text);
      },
    });
    self = new InProcessWorld(mod.version, world);
    return self;
  }

  async call<T = unknown>(method: Callable, ...args: unknown[]): Promise<T> {
    const parts = method.split('.');
    let self: unknown = this.world;
    let target: unknown = this.world;
    for (const p of parts) {
      self = target;
      target = (target as Record<string, unknown>)[p];
    }
    if (typeof target !== 'function') throw new Error(`world does not implement ${method}()`);
    // Round-trip through JSON like the IPC channel would.
    const result = await (target as (...a: unknown[]) => unknown).apply(self, JSON.parse(JSON.stringify(args)));
    return (result === undefined ? null : JSON.parse(JSON.stringify(result))) as T;
  }

  async stop(): Promise<void> {
    this.world.dispose?.();
  }
}

type DistributiveOmit<T, K extends keyof any> = T extends unknown ? Omit<T, K> : never;
