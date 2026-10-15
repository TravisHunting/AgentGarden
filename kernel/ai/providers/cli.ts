// Providers that shell out to an agent CLI the user already has signed in, so
// the game rides on their existing Claude or ChatGPT subscription.

import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { type AgentProvider, type CompletionRequest, type EditRequest, MODEL_PATTERN, type ProviderSettings } from './types.ts';

const isWindows = process.platform === 'win32';
const SAFE_ARG = /^[A-Za-z0-9._:/\\\-[\]@=]+$/;
const SAFE_COMMAND = /^[A-Za-z0-9._:/\\\- ()]+$/;

export interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/**
 * Runs a command with the prompt on stdin. On Windows npm-installed CLIs are
 * .cmd shims which need a shell, so every argument is restricted to a safe
 * character set and the (untrusted) prompt only ever travels over stdin.
 */
export function runCommand(
  command: string,
  args: string[],
  opts: { stdin?: string; cwd?: string; timeoutMs: number; signal?: AbortSignal; env?: NodeJS.ProcessEnv },
): Promise<RunResult> {
  if (!SAFE_COMMAND.test(command)) return Promise.reject(new Error(`unsafe command path: ${command}`));
  for (const a of args) if (!SAFE_ARG.test(a)) return Promise.reject(new Error(`unsafe argument: ${a}`));
  return new Promise((resolve, reject) => {
    // Arguments are whitelisted above, so joining them for the Windows shell is safe.
    const child = isWindows
      ? spawn([command.includes(' ') ? `"${command}"` : command, ...args].join(' '), { cwd: opts.cwd, shell: true, windowsHide: true, env: opts.env ?? process.env })
      : spawn(command, args, { cwd: opts.cwd, windowsHide: true, env: opts.env ?? process.env });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`${command} timed out after ${Math.round(opts.timeoutMs / 1000)}s`));
    }, opts.timeoutMs);
    opts.signal?.addEventListener('abort', () => child.kill(), { once: true });
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
    child.stdin.on('error', () => {});
    child.stdin.end(opts.stdin ?? '');
  });
}

/**
 * Codex's Windows sandbox cannot launch Microsoft Store app aliases (e.g. a Store-installed
 * pwsh.exe under ...\Microsoft\WindowsApps fails with error 1920), which leaves the agent
 * without a shell. Hiding those PATH entries makes it fall back to System32 PowerShell.
 */
export function sandboxFriendlyEnv(): NodeJS.ProcessEnv {
  if (!isWindows) return process.env;
  const env = { ...process.env };
  const key = Object.keys(env).find((k) => k.toLowerCase() === 'path');
  if (key) env[key] = (env[key] ?? '').split(';').filter((p) => !/\\Microsoft\\WindowsApps\\?$/i.test(p)).join(';');
  return env;
}

function checkModel(model: string): void {
  if (!MODEL_PATTERN.test(model)) throw new Error(`invalid model name: ${model}`);
}

function combined(req: CompletionRequest): string {
  return `${req.system}\n\n---\n\n${req.prompt}`;
}

async function versionCheck(command: string, settings: ProviderSettings): Promise<{ ok: boolean; detail: string }> {
  try {
    mkdirSync(settings.workDir, { recursive: true });
    const r = await runCommand(command, ['--version'], { timeoutMs: 15000, cwd: settings.workDir });
    const out = (r.stdout || r.stderr).trim().split('\n')[0];
    return r.code === 0 ? { ok: true, detail: out } : { ok: false, detail: out || `exit code ${r.code}` };
  } catch (e) {
    return { ok: false, detail: (e as Error).message };
  }
}

export const claudeCli: AgentProvider = {
  info: {
    id: 'claude-cli',
    name: 'Claude Code CLI',
    kind: 'cli',
    description: 'Uses your signed-in `claude` CLI (Claude subscription or API key) in headless print mode.',
    modelSuggestions: ['haiku', 'sonnet', 'opus'],
    defaultModel: 'haiku',
    configHint: 'Install Claude Code and run `claude` once to sign in.',
  },
  available: (s) => versionCheck(s.command || 'claude', s),
  edit: (req, s) => claudeEdit(req, s),
  async complete(req, s) {
    checkModel(s.model);
    mkdirSync(s.workDir, { recursive: true });
    const r = await runCommand(s.command || 'claude', ['-p', '--model', s.model, '--output-format', 'json'], {
      stdin: combined(req),
      cwd: s.workDir,
      timeoutMs: s.timeoutSeconds * 1000,
      signal: req.signal,
    });
    if (r.code !== 0) throw new Error(`claude exited with ${r.code}: ${(r.stderr || r.stdout).slice(0, 500)}`);
    try {
      const wrapper = JSON.parse(r.stdout);
      if (wrapper.is_error) throw new Error(String(wrapper.result ?? 'claude reported an error'));
      if (typeof wrapper.result === 'string') return wrapper.result;
    } catch (e) {
      if (!(e instanceof SyntaxError)) throw e;
    }
    return r.stdout;
  },
};

async function claudeEdit(req: EditRequest, s: ProviderSettings): Promise<string> {
  if (s.model) checkModel(s.model);
  const r = await runCommand(
    s.command || 'claude',
    ['-p', '--permission-mode', 'acceptEdits', '--output-format', 'json', ...(s.model ? ['--model', s.model] : [])],
    { stdin: req.instructions, cwd: req.cwd, timeoutMs: s.timeoutSeconds * 1000, signal: req.signal },
  );
  if (r.code !== 0) throw new Error(`claude exited with ${r.code}: ${(r.stderr || r.stdout).slice(-800)}`);
  try {
    const wrapper = JSON.parse(r.stdout);
    if (typeof wrapper.result === 'string') return wrapper.result;
  } catch {
    // plain text
  }
  return r.stdout;
}

export const codexCli: AgentProvider = {
  info: {
    id: 'codex-cli',
    name: 'Codex CLI',
    kind: 'cli',
    description: 'Uses your signed-in `codex` CLI (ChatGPT plan or API key) via `codex exec`, sandboxed read-only.',
    modelSuggestions: [],
    defaultModel: '',
    configHint: 'Install the Codex CLI and run `codex login` once. Leave the model blank to use your Codex default (~/.codex/config.toml); not every model is available on ChatGPT plans.',
  },
  available: (s) => versionCheck(s.command || 'codex', s),
  async listModels(s) {
    mkdirSync(s.workDir, { recursive: true });
    const r = await runCommand(s.command || 'codex', ['debug', 'models'], { timeoutMs: 20000, cwd: s.workDir });
    if (r.code !== 0) return [];
    try {
      const data = JSON.parse(r.stdout) as { models?: { slug?: string; visibility?: string }[] };
      return (data.models ?? []).filter((m) => m.visibility === 'list' && typeof m.slug === 'string').map((m) => m.slug!);
    } catch {
      return [];
    }
  },
  async edit(req, s) {
    if (s.model) checkModel(s.model);
    // The last message goes next to (not inside) the staging world so it never ends up in the diff.
    const outName = `codex-edit-${randomUUID()}.txt`;
    const outFile = join(req.cwd, '..', outName);
    try {
      const r = await runCommand(
        s.command || 'codex',
        ['exec', '--skip-git-repo-check', '--ephemeral', '--color', 'never', '-s', 'workspace-write', ...(s.model ? ['-m', s.model] : []), '-o', `../${outName}`, '-'],
        { stdin: req.instructions, cwd: req.cwd, timeoutMs: s.timeoutSeconds * 1000, signal: req.signal, env: sandboxFriendlyEnv() },
      );
      if (r.code !== 0) throw new Error(`codex exited with ${r.code}: ${(r.stderr || r.stdout).slice(-800)}`);
      try {
        return readFileSync(outFile, 'utf8');
      } catch {
        return r.stdout.slice(-4000);
      }
    } finally {
      rmSync(outFile, { force: true });
    }
  },
  async complete(req, s) {
    if (s.model) checkModel(s.model);
    mkdirSync(s.workDir, { recursive: true });
    // Relative to cwd, so the argument stays within the safe character set
    // whatever the work directory's path looks like (spaces, 8.3 "~" names...).
    const outName = `codex-${randomUUID()}.txt`;
    const outFile = join(s.workDir, outName);
    try {
      const r = await runCommand(
        s.command || 'codex',
        // No model → Codex uses whatever the user configured in ~/.codex/config.toml.
        ['exec', '--skip-git-repo-check', '--ephemeral', '--color', 'never', '-s', 'read-only', ...(s.model ? ['-m', s.model] : []), '-o', outName, '-'],
        { stdin: combined(req), cwd: s.workDir, timeoutMs: s.timeoutSeconds * 1000, signal: req.signal },
      );
      if (r.code !== 0) throw new Error(`codex exited with ${r.code}: ${(r.stderr || r.stdout).slice(-500)}`);
      try {
        return readFileSync(outFile, 'utf8');
      } catch {
        return r.stdout;
      }
    } finally {
      rmSync(outFile, { force: true });
    }
  },
};
