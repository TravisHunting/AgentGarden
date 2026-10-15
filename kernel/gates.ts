// Gates a staged world must pass before it may replace the live one:
// static checks → typecheck → the world's own tests → soak against the real save.

import { execFile } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { SavedWorld } from './contract.ts';
import { WorldProcess } from './world-process.ts';

const KERNEL_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const MAX_FILE_BYTES = 256 * 1024;
const OUTPUT_TAIL = 6000;

export interface GateResult {
  name: 'static' | 'typecheck' | 'tests' | 'soak';
  ok: boolean;
  ms: number;
  output: string;
}

export interface GateReport {
  ok: boolean;
  results: GateResult[];
  /** Compact failure text for the agent. */
  feedback: string;
}

export interface GateOptions {
  dir: string; // staged world
  workDir: string; // scratch space for the gates (outside the world)
  changed: string[]; // paths changed relative to the base
  contractIntact: () => boolean;
  restoreContract: () => void;
  liveSave: SavedWorld | null;
  liveModsDir: string;
  seed: number;
  testTimeoutMs?: number;
  soakSeconds?: number;
}

function tail(s: string): string {
  return s.length > OUTPUT_TAIL ? `…${s.slice(-OUTPUT_TAIL)}` : s;
}

function run(cmd: string, args: string[], opts: { cwd: string; timeoutMs: number; env?: NodeJS.ProcessEnv }): Promise<{ code: number; output: string }> {
  return new Promise((resolve) => {
    execFile(cmd, args, { cwd: opts.cwd, timeout: opts.timeoutMs, maxBuffer: 16 * 1024 * 1024, windowsHide: true, env: opts.env ?? process.env }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as { code?: unknown }).code === 'number' ? ((err as { code: number }).code) : 1) : 0;
      const killed = err && (err as { killed?: boolean }).killed ? `\n(killed after ${opts.timeoutMs / 1000}s)` : '';
      resolve({ code, output: `${stdout}${stderr}${killed}` });
    });
  });
}

function listFiles(dir: string, under: string): string[] {
  const root = join(dir, under);
  if (!existsSync(root)) return [];
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out.push(p);
    }
  };
  walk(root);
  return out;
}

export async function staticGate(o: GateOptions): Promise<GateResult> {
  const t0 = Date.now();
  const problems: string[] = [];
  const notes: string[] = [];
  if (!o.contractIntact()) {
    o.restoreContract();
    notes.push('src/contract.ts is owned by the kernel; your edits to it were reverted.');
  }
  for (const p of o.changed) {
    if (p.startsWith('..') || p.includes(':')) problems.push(`${p}: outside the world`);
    const full = join(o.dir, p);
    if (existsSync(full) && statSync(full).isFile() && statSync(full).size > MAX_FILE_BYTES) problems.push(`${p}: larger than ${MAX_FILE_BYTES / 1024} KB`);
  }
  if (!existsSync(join(o.dir, 'src', 'index.ts'))) problems.push('src/index.ts is missing (it must export apiVersion, version and createWorld)');
  const client = join(o.dir, 'web', 'client.ts');
  if (!existsSync(client)) problems.push('web/client.ts is missing (it must export mount(host))');
  else if (!/export\s+(async\s+)?function\s+mount\b|export\s+const\s+mount\b/.test(readFileSync(client, 'utf8'))) {
    problems.push('web/client.ts must export a function named mount(host: ClientHost): WorldClient');
  }
  for (const f of listFiles(o.dir, 'web').filter((f) => f.endsWith('.ts'))) {
    try {
      stripTypeScriptTypes(readFileSync(f, 'utf8'), { mode: 'strip' });
    } catch (e) {
      problems.push(`${f.slice(o.dir.length + 1)}: browsers receive type-stripped code and this file cannot be stripped: ${(e as Error).message.split('\n')[0]} (avoid enums, namespaces and parameter properties)`);
    }
  }
  return { name: 'static', ok: problems.length === 0, ms: Date.now() - t0, output: [...notes, ...problems].join('\n') || 'ok' };
}

export async function typecheckGate(o: GateOptions): Promise<GateResult> {
  const t0 = Date.now();
  const tsc = join(KERNEL_ROOT, 'node_modules', 'typescript', 'bin', 'tsc');
  if (!existsSync(tsc)) return { name: 'typecheck', ok: true, ms: 0, output: 'skipped: typescript is not installed (run npm install)' };
  const fwd = (p: string) => p.replace(/\\/g, '/');
  const config = join(o.workDir, 'tsconfig.gate.json');
  writeFileSync(
    config,
    JSON.stringify(
      {
        compilerOptions: {
          target: 'es2023',
          // Independent of any package.json the world may (not) have: worlds are always ES modules.
          module: 'esnext',
          moduleResolution: 'bundler',
          lib: ['es2023', 'dom', 'dom.iterable'],
          types: ['node'],
          typeRoots: [fwd(join(KERNEL_ROOT, 'node_modules', '@types'))],
          strict: true,
          noEmit: true,
          allowImportingTsExtensions: true,
          erasableSyntaxOnly: true,
          verbatimModuleSyntax: true,
          skipLibCheck: true,
        },
        include: [`${fwd(o.dir)}/src/**/*.ts`, `${fwd(o.dir)}/web/**/*.ts`, `${fwd(o.dir)}/test/**/*.ts`],
      },
      null,
      1,
    ),
  );
  const r = await run(process.execPath, [tsc, '-p', config, '--pretty', 'false'], { cwd: o.dir, timeoutMs: 120_000 });
  const output = r.output.replaceAll(o.dir + (process.platform === 'win32' ? '\\' : '/'), '').replaceAll(fwd(o.dir) + '/', '');
  return { name: 'typecheck', ok: r.code === 0, ms: Date.now() - t0, output: tail(output.trim() || 'ok') };
}

export async function testGate(o: GateOptions): Promise<GateResult> {
  const t0 = Date.now();
  const tests = listFiles(o.dir, 'test').filter((f) => f.endsWith('.test.ts'));
  if (!tests.length) return { name: 'tests', ok: true, ms: 0, output: 'no tests found (consider adding some in test/*.test.ts)' };
  // World tests are agent-written code: run them under the same permission model as the world,
  // in-process (no isolation subprocesses), with a private temp directory.
  const tmp = realpathSync.native(mkdtempSync(join(o.workDir, 'tmp-')));
  const dir = realpathSync.native(o.dir);
  const env = { ...process.env, TEMP: tmp, TMP: tmp, TMPDIR: tmp };
  const r = await run(
    process.execPath,
    [
      '--disable-warning=ExperimentalWarning',
      '--permission',
      `--allow-fs-read=${dir}`,
      `--allow-fs-read=${tmp}`,
      `--allow-fs-write=${tmp}`,
      '--test',
      '--test-isolation=none',
      '--test-reporter=spec',
      'test/**/*.test.ts',
    ],
    { cwd: dir, timeoutMs: o.testTimeoutMs ?? 300_000, env },
  );
  rmSync(tmp, { recursive: true, force: true });
  return { name: 'tests', ok: r.code === 0, ms: Date.now() - t0, output: tail(r.output.trim()) };
}

export async function soakGate(o: GateOptions): Promise<GateResult> {
  const t0 = Date.now();
  const lines: string[] = [];
  const seconds = o.soakSeconds ?? 2 * 3600;
  // The soak runs against copies: the live save and a scratch copy of the live mods.
  const mods = join(o.workDir, 'soak-mods');
  rmSync(mods, { recursive: true, force: true });
  if (existsSync(o.liveModsDir)) cpSync(o.liveModsDir, mods, { recursive: true });
  else mkdirSync(mods, { recursive: true });
  for (const [label, saved] of [
    ['your current garden', o.liveSave],
    ['a brand new garden', null],
  ] as const) {
    let wp: WorldProcess | null = null;
    const logs: string[] = [];
    try {
      wp = await WorldProcess.start({ worldDir: o.dir, modsDir: mods, saved, seed: o.seed, awaySeconds: 0, clock: false });
      wp.on('log', (t: string) => logs.push(t));
      const r = await wp.soak(saved ? seconds : seconds / 4, 5, 90_000);
      lines.push(`${label}: simulated ${Math.round((saved ? seconds : seconds / 4) / 60)} game-minutes in ${r.ms}ms (snapshot ${r.snapshotBytes} bytes)`);
    } catch (e) {
      lines.push(`${label}: FAILED — ${(e as Error).message}`);
      if (logs.length) lines.push(`world output:\n${logs.join('').slice(-2000)}`);
      await wp?.stop().catch(() => {});
      return { name: 'soak', ok: false, ms: Date.now() - t0, output: tail(lines.join('\n')) };
    }
    await wp.stop();
  }
  return { name: 'soak', ok: true, ms: Date.now() - t0, output: lines.join('\n') };
}

export async function runGates(o: GateOptions): Promise<GateReport> {
  mkdirSync(o.workDir, { recursive: true });
  const results: GateResult[] = [];
  for (const gate of [staticGate, typecheckGate, testGate, soakGate]) {
    const r = await gate(o);
    results.push(r);
    if (!r.ok) {
      return { ok: false, results, feedback: `The "${r.name}" gate failed:\n${r.output}` };
    }
  }
  return { ok: true, results, feedback: 'all gates passed' };
}
