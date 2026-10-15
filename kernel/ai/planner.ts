// The planning run: build context → ask the agent → validate (kernel sections
// here, world sections over the contract) → re-request only what failed →
// apply → journal. Plus the debounced scheduler that triggers it.

import { join } from 'node:path';
import type { Store } from '../db.ts';
import type { AgentOpts, SectionSpec, ValidateResult } from '../contract.ts';
import type { WorldHandle } from '../world-process.ts';
import { buildKernelContext } from './context.ts';
import { extractJson, kernelSections, validateKernelSection, KERNEL_LIMITS, type Rewrite } from './plan.ts';
import { repairPrompt, systemPrompt, taskPrompt } from './prompt.ts';
import { getProvider } from './providers/index.ts';

export interface AgentSettings {
  provider: string;
  model: string;
  debounceMinutes: number;
  maxIterations: number;
  timeoutSeconds: number;
  command?: string;
  baseUrl?: string;
  gardenerName: string;
  codeRewrites: boolean;
  workshopRounds: number;
  workshopTimeoutMinutes: number;
  probationMinutes: number;
}

export const DEFAULT_SETTINGS: AgentSettings = {
  provider: 'offline',
  model: '',
  debounceMinutes: 2,
  maxIterations: 4,
  timeoutSeconds: 240,
  gardenerName: 'Fern',
  codeRewrites: true,
  workshopRounds: 3,
  workshopTimeoutMinutes: 20,
  probationMinutes: 10,
};

export const DEFAULT_DESIRES = ['to grow something nobody has ever seen before', 'to finally befriend the snail'];

export interface Attempt {
  iteration: number;
  requested: string[];
  errors: string[];
}

export interface PlannerDeps {
  store: Store;
  world: () => WorldHandle;
  dataDir: string;
  settings: () => AgentSettings;
  /** Whether a code rewrite may be requested right now (settings, provider support, workshop idle). */
  rewriteAllowed: () => boolean;
  codeInfo: () => { worldVersion: string; commit: string };
  onRewrite: (rewrite: Rewrite, journalId: number) => void;
  onPlanned: (journalId: number) => void;
}

export class Planner {
  running = false;
  lastError: string | null = null;
  private deps: PlannerDeps;

  constructor(deps: PlannerDeps) {
    this.deps = deps;
  }

  async run(trigger: string): Promise<number | null> {
    if (this.running) return null;
    this.running = true;
    try {
      return await this.plan(trigger);
    } finally {
      this.running = false;
    }
  }

  private async plan(trigger: string): Promise<number> {
    const { store } = this.deps;
    const settings = this.deps.settings();
    const world = this.deps.world();
    const provider = getProvider(settings.provider);
    const events = store.pendingEvents();
    const letters = store.pendingPlayerLetters();
    const opts: AgentOpts = { allowMods: letters.length > 0 };
    const allowRewrite = opts.allowMods && this.deps.rewriteAllowed();
    const desires = store.get<string[]>('desires') ?? DEFAULT_DESIRES;
    const lastPlanAt = store.get<number>('lastPlanAt') ?? null;

    const kctx = buildKernelContext({
      store,
      name: settings.gardenerName,
      desires,
      events,
      letters,
      lastPlanAt,
      code: { ...this.deps.codeInfo(), rewritesAllowed: allowRewrite },
    });
    const [worldSections, guide, wctx] = await Promise.all([
      world.call<SectionSpec[]>('agent.sections', opts),
      world.call<string>('agent.guide', opts),
      world.call<unknown>('agent.context', opts),
    ]);
    const kSections = kernelSections({ allowRewrite });
    const kernelNames = new Set(kSections.map((s) => s.name));
    const specs = new Map<string, SectionSpec>([...worldSections, ...kSections].map((s) => [s.name, s]));
    const contextJson = JSON.stringify({ ...kctx, world: wctx });
    const memoryIds = new Set(kctx.memories.map((m) => m.id));
    const system = systemPrompt(settings.gardenerName, { allowMods: opts.allowMods, allowRewrite }, guide);
    const providerSettings = {
      model: settings.model || provider.info.defaultModel,
      timeoutSeconds: settings.timeoutSeconds,
      command: settings.command,
      baseUrl: settings.baseUrl,
      workDir: join(this.deps.dataDir, 'agent-work'),
    };

    const accepted: Record<string, unknown> = {};
    let pending = [...specs.keys()];
    let prompt = taskPrompt(contextJson, pending);
    let lastRaw: Record<string, unknown> | null = null;
    const attempts: Attempt[] = [];

    for (let i = 1; i <= Math.max(1, settings.maxIterations) && pending.length; i++) {
      const attempt: Attempt = { iteration: i, requested: [...pending], errors: [] };
      attempts.push(attempt);
      let text: string;
      try {
        text = await provider.complete(
          { system, prompt, context: { ...kctx, world: wctx }, offline: () => world.call('agent.offlinePlan', kctx, opts) },
          providerSettings,
        );
      } catch (e) {
        this.lastError = (e as Error).message;
        if (i === 1) return this.journalError(trigger, settings, (e as Error).message, attempts);
        attempt.errors.push(`provider error: ${(e as Error).message}`);
        break;
      }
      let parsed: Record<string, unknown>;
      try {
        parsed = extractJson(text);
      } catch (e) {
        attempt.errors.push(`$: your reply was not a JSON object (${(e as Error).message})`);
        lastRaw = null;
        prompt = repairPrompt(contextJson, pending, fullyAccepted(accepted, pending), attempt.errors, null, []);
        continue;
      }
      lastRaw = parsed;
      const stillPending: string[] = [];
      const notes: string[] = [];
      for (const name of pending) {
        const spec = specs.get(name)!;
        if (!(name in parsed)) {
          if (i === 1 && !spec.required) continue; // optional and simply omitted
          attempt.errors.push(`$.${name}: missing`);
          stillPending.push(name);
          continue;
        }
        const value = parsed[name];
        if (kernelNames.has(name)) {
          const errs = validateKernelSection(name, value, { memoryIds, allowRewrite });
          if (errs.length) {
            attempt.errors.push(...errs);
            stillPending.push(name);
          } else accepted[name] = value;
          continue;
        }
        let r: ValidateResult;
        try {
          r = await world.call<ValidateResult>('agent.validate', name, value, { plan: parsed, accepted: accepted[name], acceptedSections: accepted, opts });
        } catch (e) {
          r = { errors: [`$.${name}: the world failed to validate this section (${(e as Error).message.split('\n')[0]})`] };
        }
        if (r.errors.length) {
          attempt.errors.push(...r.errors);
          stillPending.push(name);
          if (r.value !== undefined) accepted[name] = r.value;
          if (r.note) notes.push(r.note);
        } else {
          accepted[name] = r.value !== undefined ? r.value : value;
        }
      }
      pending = stillPending;
      if (pending.length) prompt = repairPrompt(contextJson, pending, fullyAccepted(accepted, pending), attempt.errors, lastRaw, notes);
    }

    // Anything still invalid after the last iteration is salvaged by its owner, or dropped.
    const fallbackNotes: string[] = [];
    for (const name of pending) {
      if (kernelNames.has(name)) {
        if (name === 'summary') accepted.summary = '(The gardener mumbled something unintelligible and got on with it.)';
        else delete accepted[name];
        fallbackNotes.push(`dropped ${name}`);
        continue;
      }
      try {
        const fb = await world.call('agent.fallback', name, lastRaw?.[name] ?? null, lastRaw ?? {});
        if (fb !== null && fb !== undefined) {
          accepted[name] = fb;
          fallbackNotes.push(`salvaged ${name}`);
          continue;
        }
      } catch {
        // world has no fallback
      }
      if (accepted[name] !== undefined) fallbackNotes.push(`kept the accepted part of ${name}`);
      else fallbackNotes.push(`dropped ${name}`);
    }

    // ---- apply
    const letter = typeof accepted.letter === 'string' ? accepted.letter : null;
    if (letter) {
      store.addLetter('agent', letter);
      await world.call('notify', 'letter-agent', {}).catch(() => {});
    }
    store.forgetMemories((accepted.forget as number[] | undefined) ?? []);
    for (const m of (accepted.memories as string[] | undefined) ?? []) store.addMemory(m);
    if (Array.isArray(accepted.desires)) store.set('desires', (accepted.desires as string[]).slice(0, KERNEL_LIMITS.desires));

    const worldPlan = Object.fromEntries(Object.entries(accepted).filter(([k]) => !kernelNames.has(k)));
    let worldNotes: string[] = [];
    let applyError: string | null = null;
    try {
      worldNotes = (await world.call<{ notes: string[] }>('agent.apply', worldPlan, opts)).notes ?? [];
    } catch (e) {
      applyError = (e as Error).message.split('\n')[0];
    }

    const status = applyError ? 'error' : pending.length ? 'fallback' : attempts.length > 1 ? 'repaired' : 'ok';
    const rewrite = (accepted.rewrite as Rewrite | null | undefined) ?? null;
    const journalId = store.addJournal({
      trigger,
      provider: settings.provider,
      model: providerSettings.model || '(default)',
      status,
      iterations: attempts.length,
      summary: String(accepted.summary ?? ''),
      detail: JSON.stringify({
        plan: accepted,
        worldNotes,
        applyError,
        attempts,
        fallback: fallbackNotes,
        rewrite,
        consumed: { events: events.length, letters: letters.length },
      }),
    });
    store.consume(
      journalId,
      events.map((e) => e.id),
      letters.map((l) => l.id),
    );
    store.set('lastPlanAt', Date.now());
    this.lastError = applyError;
    if (rewrite) this.deps.onRewrite(rewrite, journalId);
    this.deps.onPlanned(journalId);
    return journalId;
  }

  private journalError(trigger: string, settings: AgentSettings, message: string, attempts: Attempt[]): number {
    const id = this.deps.store.addJournal({
      trigger,
      provider: settings.provider,
      model: settings.model || '(default)',
      status: 'error',
      iterations: attempts.length,
      summary: `I tried to think, but my thoughts would not come: ${message.slice(0, 300)}`,
      detail: JSON.stringify({ error: message }),
    });
    this.deps.onPlanned(id);
    throw Object.assign(new Error(message), { journalId: id });
  }
}

function fullyAccepted(accepted: Record<string, unknown>, pending: string[]): string[] {
  return Object.keys(accepted).filter((k) => !pending.includes(k));
}

// ---------------------------------------------------------------- scheduler

export class Scheduler {
  lastActivity = 0;
  retryAt = 0;
  private timer?: NodeJS.Timeout;
  private planner: Planner;
  private store: Store;
  private settings: () => AgentSettings;
  private blocked: () => boolean;

  constructor(planner: Planner, store: Store, settings: () => AgentSettings, blocked: () => boolean = () => false) {
    this.planner = planner;
    this.store = store;
    this.settings = settings;
    this.blocked = blocked;
    const newest = store.pendingEvents().at(-1)?.created_at ?? 0;
    const newestLetter = store.pendingPlayerLetters().at(-1)?.created_at ?? 0;
    this.lastActivity = Math.max(newest, newestLetter);
  }

  noteActivity(): void {
    this.lastActivity = Date.now();
  }

  pendingCount(): number {
    return this.store.pendingEvents().length + this.store.pendingPlayerLetters().length;
  }

  /** When the next background planning run will fire, if anything is pending. */
  nextRunAt(): number | null {
    if (this.pendingCount() === 0) return null;
    return Math.max(this.lastActivity + this.settings().debounceMinutes * 60_000, this.retryAt);
  }

  start(intervalMs = 5000): void {
    this.timer = setInterval(() => void this.check(), intervalMs);
  }

  stop(): void {
    clearInterval(this.timer);
  }

  async check(): Promise<void> {
    if (this.planner.running || this.blocked()) return;
    const next = this.nextRunAt();
    if (next === null || Date.now() < next) return;
    await this.trigger('the player went quiet');
  }

  async trigger(reason: string): Promise<number | null> {
    try {
      const id = await this.planner.run(reason);
      this.retryAt = 0;
      return id;
    } catch (e) {
      // Back off so a broken provider doesn't spin; the player can still "think now".
      this.retryAt = Date.now() + 10 * 60_000;
      console.error('[planner]', (e as Error).message);
      return null;
    }
  }
}
