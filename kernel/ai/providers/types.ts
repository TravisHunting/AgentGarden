// The provider interface. Anything that can turn a prompt into text can drive
// the gardener: local agent CLIs today, inference APIs, or something else later.

export interface ProviderSettings {
  model: string;
  timeoutSeconds: number;
  command?: string; // override for CLI executables
  baseUrl?: string; // for HTTP providers
  workDir: string; // scratch directory CLIs run in
}

export interface CompletionRequest {
  system: string;
  prompt: string;
  /** Structured context, for providers that don't need text. */
  context?: unknown;
  /** Produces a plan without AI (the world's offline gardener). */
  offline?: () => Promise<unknown>;
  signal?: AbortSignal;
}

export interface EditRequest {
  instructions: string;
  cwd: string; // the only directory the agent should modify
  round: number; // 1 for the first attempt, then repair rounds
  signal?: AbortSignal;
}

export interface ProviderInfo {
  id: string;
  name: string;
  kind: 'cli' | 'http' | 'offline';
  description: string;
  modelSuggestions: string[];
  defaultModel: string;
  configHint?: string;
}

export interface AgentProvider {
  info: ProviderInfo;
  available(settings: ProviderSettings): Promise<{ ok: boolean; detail: string }>;
  complete(req: CompletionRequest, settings: ProviderSettings): Promise<string>;
  /**
   * Optional: run as a coding agent with write access to `req.cwd` (the staging world).
   * Returns the agent's closing message, used as the change summary.
   */
  edit?(req: EditRequest, settings: ProviderSettings & { timeoutSeconds: number }): Promise<string>;
  /** Optional: models this provider can actually use right now (e.g. from the CLI's catalogue). */
  listModels?(settings: ProviderSettings): Promise<string[]>;
}

export const MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/\-[\]@]{0,79}$/;
