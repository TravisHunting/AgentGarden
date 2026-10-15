// Owns the live world process: starts it, saves it, swaps in new code, keeps a
// new version on probation, restarts it after crashes, and rolls back.

import type { Store } from './db.ts';
import type { SavedWorld } from './contract.ts';
import { WorldProcess, type WorldExit } from './world-process.ts';
import type { WorldRepo } from './world-repo.ts';

export interface SupervisorDeps {
  store: Store;
  repo: WorldRepo;
  modsDir: string;
  probationMinutes: () => number;
  onState(state: unknown): void;
  onEvent(event: unknown): void;
  onContent(content: unknown): void;
  /** Code or health changed (new commit, rollback, crash, recovery). */
  onWorldChanged(): void;
  onRolledBack(info: { from: string; to: string; reason: string; rewriteId: number | null }): void;
  log(text: string): void;
}

interface Probation {
  until: number;
  prevCommit: string;
  preSwap: SavedWorld | null;
  rewriteId: number | null;
}

const CRASH_WINDOW_MS = 5 * 60_000;
const CRASH_LIMIT = 3;

export class Supervisor {
  world: WorldProcess | null = null;
  commit = '';
  version = '';
  healthy = false;
  lastError: string | null = null;
  probation: Probation | null = null;
  lastContent: unknown = null;
  lastState: unknown = null;
  private crashes: number[] = [];
  private probationTimer?: NodeJS.Timeout;
  private busy: Promise<unknown> = Promise.resolve();
  private deps: SupervisorDeps;

  constructor(deps: SupervisorDeps) {
    this.deps = deps;
  }

  /** Serialises lifecycle operations (swap, rollback, restart). */
  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.busy.then(fn, fn);
    this.busy = next.catch(() => {});
    return next;
  }

  async start(): Promise<void> {
    this.commit = await this.deps.repo.ensure();
    if (!this.lastGood().length) this.markGood(this.commit);
    const pending = this.deps.store.get<(Probation & { commit: string }) | null>('world.probation');
    const { saved, away } = this.savedState();
    try {
      await this.launch(saved, away);
      if (pending && pending.commit === this.commit) {
        if (pending.until > Date.now()) this.startProbation(pending);
        else this.markGood(this.commit);
      }
    } catch (e) {
      if (pending && pending.commit === this.commit) this.probation = pending;
      // The live code can't even start: fall back to the newest good commit that can.
      this.deps.log(`[world] failed to start ${this.commit.slice(0, 8)}: ${(e as Error).message}`);
      await this.rollback(`the world failed to start: ${(e as Error).message.split('\n')[0]}`);
    }
  }

  // ---------------------------------------------------------------- persistence

  savedState(): { saved: SavedWorld | null; away: number } {
    let saved = this.deps.store.get<SavedWorld | Record<string, unknown>>('garden') ?? null;
    // Saves from before the kernel/world split were the raw state.
    if (saved && !('state' in saved && 'version' in saved)) saved = { version: '1', state: saved };
    const savedAt = this.deps.store.get<number>('savedAt');
    return { saved: saved as SavedWorld | null, away: saved && savedAt ? Math.max(0, (Date.now() - savedAt) / 1000) : 0 };
  }

  async save(): Promise<SavedWorld | null> {
    if (!this.world?.running) return null;
    try {
      const snap = await this.world.call<SavedWorld>('snapshot');
      this.deps.store.set('garden', snap);
      this.deps.store.set('savedAt', Date.now());
      return snap;
    } catch (e) {
      this.deps.log(`[world] snapshot failed: ${(e as Error).message.split('\n')[0]}`);
      return null;
    }
  }

  lastGood(): string[] {
    return this.deps.store.get<string[]>('world.lastGood') ?? [];
  }

  private markGood(sha: string): void {
    const list = this.lastGood().filter((s) => s !== sha);
    list.unshift(sha);
    this.deps.store.set('world.lastGood', list.slice(0, 20));
  }

  // ---------------------------------------------------------------- lifecycle

  private async launch(saved: SavedWorld | null, away: number): Promise<void> {
    const wp = await WorldProcess.start({
      worldDir: this.deps.repo.repoDir,
      modsDir: this.deps.modsDir,
      saved,
      seed: Math.floor(Math.random() * 2 ** 31),
      awaySeconds: away,
      clock: true,
    });
    this.attach(wp);
    const old = this.world;
    this.world = wp;
    this.version = wp.version;
    this.healthy = true;
    this.lastError = null;
    if (old && old !== wp) {
      old.removeAllListeners();
      await old.stop();
    }
    await this.refreshContent();
    this.deps.onWorldChanged();
  }

  private attach(wp: WorldProcess): void {
    wp.on('state', (s) => {
      if (wp !== this.world) return;
      this.lastState = s;
      this.deps.onState(s);
    });
    wp.on('event', (e) => wp === this.world && this.deps.onEvent(e));
    wp.on('content', () => wp === this.world && void this.refreshContent());
    wp.on('log', (t: string) => this.deps.log(`[world] ${t.trimEnd()}`));
    wp.on('exit', (exit: WorldExit) => void this.onExit(wp, exit));
  }

  private async refreshContent(): Promise<void> {
    try {
      this.lastContent = await this.world!.call('content');
      this.deps.onContent(this.lastContent);
    } catch (e) {
      this.deps.log(`[world] content() failed: ${(e as Error).message.split('\n')[0]}`);
    }
  }

  private async onExit(wp: WorldProcess, exit: WorldExit): Promise<void> {
    if (wp !== this.world) return;
    this.world = null;
    this.healthy = false;
    this.lastError = `world ${exit.reason === 'hung' ? 'stopped responding' : 'crashed'} (code ${exit.code})\n${exit.stderr.slice(-1500)}`;
    this.deps.log(`[world] ${this.lastError}`);
    this.deps.onWorldChanged();
    await this.exclusive(async () => {
      if (this.probation && Date.now() < this.probation.until) {
        await this.rollbackNow(`the new code ${exit.reason === 'hung' ? 'froze' : 'crashed'} while on probation`);
        return;
      }
      this.crashes = [...this.crashes.filter((t) => Date.now() - t < CRASH_WINDOW_MS), Date.now()];
      if (this.crashes.length >= CRASH_LIMIT) {
        this.crashes = [];
        await this.rollbackNow(`the world crashed ${CRASH_LIMIT} times in ${CRASH_WINDOW_MS / 60000} minutes`);
        return;
      }
      const { saved, away } = this.savedState();
      try {
        await this.launch(saved, away);
      } catch (e) {
        await this.rollbackNow(`the world could not restart: ${(e as Error).message.split('\n')[0]}`);
      }
    });
  }

  /** Puts a gated commit live. Returns false (and leaves the old world running) if it won't start. */
  swap(sha: string, rewriteId: number | null): Promise<{ ok: boolean; error?: string }> {
    return this.exclusive(async () => {
      const pre = (await this.save()) ?? this.savedState().saved;
      const prev = this.commit;
      await this.deps.repo.fastForward(sha);
      try {
        await this.launch(pre, 0);
      } catch (e) {
        await this.deps.repo.resetTo(prev);
        return { ok: false, error: (e as Error).message };
      }
      this.commit = sha;
      this.startProbation({ until: Date.now() + this.deps.probationMinutes() * 60_000, prevCommit: prev, preSwap: pre, rewriteId });
      this.deps.onWorldChanged();
      return { ok: true };
    });
  }

  private startProbation(p: Probation): void {
    clearTimeout(this.probationTimer);
    this.setProbation(p);
    this.probationTimer = setTimeout(() => {
      if (this.probation === p && this.healthy) {
        this.markGood(this.commit);
        this.setProbation(null);
        this.deps.onWorldChanged();
      }
    }, Math.max(0, p.until - Date.now()));
  }

  /** Probation survives kernel restarts (with the pre-swap save needed to roll back). */
  private setProbation(p: Probation | null): void {
    this.probation = p;
    this.deps.store.set('world.probation', p ? { ...p, commit: this.commit } : null);
  }

  rollback(reason: string): Promise<void> {
    return this.exclusive(() => this.rollbackNow(reason));
  }

  private async rollbackNow(reason: string): Promise<void> {
    const from = this.commit;
    const p = this.probation;
    clearTimeout(this.probationTimer);
    this.setProbation(null);
    const target = p?.prevCommit ?? this.lastGood().find((s) => s !== from);
    if (!target) {
      this.deps.log(`[world] cannot roll back (${reason}): no earlier good version`);
      return;
    }
    await this.deps.repo.resetTo(target);
    this.commit = target;
    const saved = p?.preSwap ?? this.savedState().saved;
    this.deps.onRolledBack({ from, to: target, reason, rewriteId: p?.rewriteId ?? null });
    try {
      await this.launch(saved, 0);
      this.markGood(target);
    } catch (e) {
      this.deps.log(`[world] rollback target ${target.slice(0, 8)} also failed: ${(e as Error).message.split('\n')[0]}`);
      this.healthy = false;
      this.deps.onWorldChanged();
    }
  }

  /** Player-initiated: make an older version (or the template) the live code, as a new commit. */
  replaceCode(how: { revertTo: string } | { template: true }): Promise<{ ok: boolean; error?: string }> {
    return this.exclusive(async () => {
      const pre = (await this.save()) ?? this.savedState().saved;
      const prev = this.commit;
      const sha =
        'revertTo' in how
          ? await this.deps.repo.revertTo(how.revertTo, `revert to ${how.revertTo.slice(0, 8)} (requested by the player)`)
          : await this.deps.repo.resetToTemplate();
      try {
        await this.launch(pre, 0);
      } catch (e) {
        await this.deps.repo.resetTo(prev);
        await this.launch(pre, 0).catch(() => {});
        return { ok: false, error: (e as Error).message };
      }
      this.commit = sha;
      this.startProbation({ until: Date.now() + this.deps.probationMinutes() * 60_000, prevCommit: prev, preSwap: pre, rewriteId: null });
      this.deps.onWorldChanged();
      return { ok: true };
    });
  }

  async stop(): Promise<void> {
    clearTimeout(this.probationTimer);
    await this.save();
    const w = this.world;
    this.world = null;
    w?.removeAllListeners();
    await w?.stop();
  }
}
