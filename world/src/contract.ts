// The Kernel ↔ World contract (API version 1).
//
// This file is owned by the kernel. A copy is written into every world as
// src/contract.ts and is overwritten before each workshop session, so worlds
// must treat it as read-only. Keep it dependency-free and type-only except for
// the constants at the bottom.

export const WORLD_API_VERSION = 1;

// ---------------------------------------------------------------- world module

export interface WorldModule {
  apiVersion: number; // must equal WORLD_API_VERSION
  version: string; // the world's own data version; bump when the saved state shape changes
  createWorld(init: WorldInit): World | Promise<World>;
}

export interface SavedWorld {
  version: string;
  state: unknown;
}

export interface WorldInit {
  /** Last snapshot, possibly from an older world version: migrate it. Null for a brand new garden. */
  saved: SavedWorld | null;
  seed: number;
  /** Real seconds since the snapshot was taken (catch-up time). */
  awaySeconds: number;
  /** The only directory the world may write to. */
  modsDir: string;
  emit(msg: WorldEmit): void;
}

export type WorldEmit =
  | { type: 'event'; event: unknown } // forwarded to clients immediately
  | { type: 'content' } // content changed; kernel will call content() and broadcast
  | { type: 'log'; text: string };

export interface RpcResult {
  result: unknown;
  /** Something the player did that the agent should hear about (starts the debounce). */
  activity?: { kind: string; summary: string };
}

export interface AgentOpts {
  /** True when the player left a letter since the last planning run. */
  allowMods: boolean;
}

export interface SectionSpec {
  name: string;
  required: boolean;
}

export interface ValidateContext {
  /** The whole parsed reply of this iteration (for cross-section references). */
  plan: Record<string, unknown>;
  /** A partially accepted value of THIS section from earlier iterations, if any. */
  accepted?: unknown;
  /** Every section value accepted so far (fully or partially), by section name. */
  acceptedSections: Record<string, unknown>;
  opts: AgentOpts;
}

export interface ValidateResult {
  errors: string[];
  /** The value to keep (fully or partially accepted). Defaults to the input when errors is empty. */
  value?: unknown;
  /** Shown to the agent in the repair prompt, e.g. "2 mod ops already accepted: a, b". */
  note?: string;
}

export interface WorldAgent {
  sections(opts: AgentOpts): SectionSpec[];
  guide(opts: AgentOpts): string;
  context(opts: AgentOpts): unknown;
  validate(section: string, value: unknown, ctx: ValidateContext): ValidateResult;
  fallback?(section: string, lastValue: unknown, plan: Record<string, unknown>): unknown;
  apply(plan: Record<string, unknown>, opts: AgentOpts): { notes: string[] } | Promise<{ notes: string[] }>;
  /** Plan produced without any AI (the "offline gardener"). Receives the kernel context. */
  offlinePlan?(kernelContext: KernelAgentContext, opts: AgentOpts): Record<string, unknown>;
}

export interface World {
  tick(dt: number): void;
  snapshot(): SavedWorld;
  publicState(): unknown;
  content(): unknown;
  rpc(method: string, params: unknown): RpcResult | Promise<RpcResult>;
  notify?(kind: 'letter' | 'workshop' | string, data: unknown): void;
  agent: WorldAgent;
  dispose?(): void;
}

// ---------------------------------------------------------------- kernel context (what the world can rely on)

/** The kernel's half of the agent context; passed to offlinePlan and nested around world.agent.context(). */
export interface KernelAgentContext {
  now: string;
  playerLocalTime: string;
  you: { name: string; desires: string[] };
  player: {
    minutesSinceLastPlan: number | null;
    letters: { id: number; text: string; minutesAgo: number }[];
    activity: { total: number; summary: string; recent: string[] };
  };
  correspondence: { from: 'player' | 'you'; text: string; minutesAgo: number }[];
  memories: { id: number; text: string }[];
  recentJournal: { minutesAgo: number; summary: string }[];
  code: {
    worldVersion: string;
    commit: string;
    rewritesAllowed: boolean;
    recentRewrites: { request: string; status: string; minutesAgo: number }[];
  };
}

// ---------------------------------------------------------------- client module (world/web/client.ts)

export interface ClientHost {
  stage: HTMLElement; // where the garden is drawn
  toolbar: HTMLElement; // bottom bar the world fills with its tools
  topActions: HTMLElement; // extra buttons in the top bar
  overlay: HTMLElement; // container for the world's own panels
  rpc(method: string, params?: unknown): Promise<unknown>;
  toast(text: string, ms?: number): void;
  openMailbox(): void;
  window(): Window; // the window currently hosting the app (main or picture-in-picture)
  /** Short description of what the gardener is doing, shown in the shell's status line. */
  setActivity(text: string): void;
}

export interface KernelStatus {
  thinking: boolean;
  pending: number;
  nextRunAt: number | null;
  lastError: string | null;
  unreadLetters: number;
  provider: string;
  model: string;
  gardenerName: string;
  workshop: { phase: string; request: string } | null;
  world: { commit: string; version: string; healthy: boolean; probationUntil: number | null };
}

export interface WorldClient {
  onState(state: unknown): void;
  onEvent(event: unknown): void;
  onContent(content: unknown): void;
  onStatus(status: KernelStatus): void;
  resize(): void;
  unmount(): void;
}

// ---------------------------------------------------------------- IPC protocol (kernel ↔ world-host)

export type HostRequest =
  | { id: number; op: 'init'; worldEntry: string; init: Omit<WorldInit, 'emit'> }
  | { id: number; op: 'call'; method: string; args: unknown[] }
  | { id: number; op: 'soak'; seconds: number; step: number }
  | { id: number; op: 'start'; tickMs: number; stateMs: number }
  | { id: number; op: 'stop' };

export type HostMessage =
  | { type: 'reply'; id: number; ok: true; result: unknown }
  | { type: 'reply'; id: number; ok: false; error: string }
  | { type: 'state'; state: unknown }
  | { type: 'event'; event: unknown }
  | { type: 'content' }
  | { type: 'log'; text: string };

/** Methods the kernel may invoke via op 'call' (dotted paths on the World object). */
export const CALLABLE = [
  'snapshot',
  'publicState',
  'content',
  'rpc',
  'notify',
  'agent.sections',
  'agent.guide',
  'agent.context',
  'agent.validate',
  'agent.fallback',
  'agent.apply',
  'agent.offlinePlan',
] as const;
export type Callable = (typeof CALLABLE)[number];
