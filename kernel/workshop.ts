// "The shed": turns a rewrite request into gated, live code.
// staging worktree → agent edits → gates → (repair rounds) → commit → swap.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { RewriteRow, RewriteStatus, Store } from './db.ts';
import type { AgentSettings } from './ai/planner.ts';
import { getProvider } from './ai/providers/index.ts';
import { runGates, type GateReport } from './gates.ts';
import type { Supervisor } from './supervisor.ts';
import type { WorldRepo } from './world-repo.ts';

export interface WorkshopDeps {
  store: Store;
  repo: WorldRepo;
  supervisor: Supervisor;
  dataDir: string;
  modsDir: string;
  settings: () => AgentSettings;
  /** Resolves once no planning run is in flight; the scheduler stays blocked until release(). */
  quiesce: () => Promise<() => void>;
  onPhase: (phase: string, rewrite: RewriteRow) => void;
}

export interface WorkshopState {
  rewriteId: number;
  phase: RewriteStatus;
  round: number;
  request: string;
}

export class Workshop {
  current: WorkshopState | null = null;
  private deps: WorkshopDeps;

  constructor(deps: WorkshopDeps) {
    this.deps = deps;
  }

  get busy(): boolean {
    return this.current !== null;
  }

  static supportsEdit(providerId: string): boolean {
    try {
      return typeof getProvider(providerId).edit === 'function';
    } catch {
      return false;
    }
  }

  /** Starts a rewrite in the background. Returns false if the shed is occupied. */
  start(rewrite: RewriteRow): boolean {
    if (this.busy) {
      this.deps.store.updateRewrite(rewrite.id, { status: 'superseded', summary: 'The shed was already busy with another project.' });
      return false;
    }
    this.current = { rewriteId: rewrite.id, phase: 'queued', round: 0, request: rewrite.request };
    void this.run(rewrite).finally(() => {
      this.current = null;
      this.deps.repo.removeStaging().catch(() => {});
    });
    return true;
  }

  private phase(rw: RewriteRow, status: RewriteStatus, patch: Partial<RewriteRow> = {}): void {
    if (this.current) this.current.phase = status;
    this.deps.store.updateRewrite(rw.id, { status, ...patch });
    this.deps.onPhase(status, { ...rw, ...patch, status });
  }

  private async run(rw: RewriteRow): Promise<void> {
    const { store, repo, supervisor } = this.deps;
    const settings = this.deps.settings();
    const provider = getProvider(settings.provider);
    const log: { round: number; summary: string; gates: GateReport['results'] }[] = [];
    try {
      if (!provider.edit) throw new Error(`${provider.info.name} cannot edit code`);
      const base = await repo.prepareStaging();
      this.phase(rw, 'editing', { base_commit: base });
      let feedback: string | null = null;
      let summary = '';
      let report: GateReport | null = null;
      const rounds = Math.max(1, settings.workshopRounds);
      for (let round = 1; round <= rounds; round++) {
        this.current!.round = round;
        this.phase(rw, 'editing', { rounds: round });
        const instructions = round === 1 ? await this.brief(rw, settings) : repairBrief(feedback!);
        summary =
          (
            await provider.edit(
              { instructions, cwd: repo.stagingDir, round },
              {
                model: settings.model || provider.info.defaultModel,
                timeoutSeconds: settings.workshopTimeoutMinutes * 60,
                command: settings.command,
                baseUrl: settings.baseUrl,
                workDir: join(this.deps.dataDir, 'agent-work'),
              },
            )
          ).trim() || summary;
        const changed = await repo.stagingChanges();
        if (!changed.length) {
          log.push({ round, summary, gates: [] });
          if (round === 1) throw new Error(`the gardener came back from the shed without changing anything${summary ? `: "${summary.slice(0, 300)}"` : ''}`);
          feedback = 'You made no further changes, but the previous problems remain.';
          continue;
        }
        this.phase(rw, 'gating', { summary: summary.slice(0, 4000) });
        const save = (await supervisor.save()) ?? supervisor.savedState().saved;
        report = await runGates({
          dir: repo.stagingDir,
          workDir: join(repo.root, 'gates'),
          changed,
          contractIntact: () => repo.contractIntact(repo.stagingDir),
          restoreContract: () => repo.writeContract(repo.stagingDir),
          liveSave: save,
          liveModsDir: this.deps.modsDir,
          seed: rw.id,
        });
        log.push({ round, summary, gates: report.results });
        store.updateRewrite(rw.id, { log: JSON.stringify(log) });
        if (report.ok) break;
        feedback = report.feedback;
      }
      if (!report?.ok) {
        const diff = await repo.stagingDiff().catch(() => ({ stat: '', patch: '' }));
        this.phase(rw, 'failed', { diff: `${diff.stat}\n${diff.patch}`, summary: summary.slice(0, 4000) });
        return;
      }
      const diff = await repo.stagingDiff();
      const sha = await repo.commitStaging(`rewrite #${rw.id}: ${rw.request.slice(0, 72)}\n\n${summary.slice(0, 2000)}`);
      this.phase(rw, 'swapping', { commit_sha: sha, diff: `${diff.stat}\n${diff.patch}`, summary: summary.slice(0, 4000) });
      const release = await this.deps.quiesce();
      try {
        const result = await supervisor.swap(sha, rw.id);
        if (result.ok) this.phase(rw, 'live');
        else {
          log.push({ round: log.length + 1, summary: 'swap', gates: [{ name: 'soak', ok: false, ms: 0, output: `the new world failed to start live: ${result.error}` }] });
          this.phase(rw, 'failed', { log: JSON.stringify(log) });
        }
      } finally {
        release();
      }
    } catch (e) {
      log.push({ round: this.current?.round ?? 0, summary: `error: ${(e as Error).message}`, gates: [] });
      this.phase(rw, 'failed', { log: JSON.stringify(log), summary: (e as Error).message.slice(0, 2000) });
    }
  }

  private async brief(rw: RewriteRow, settings: AgentSettings): Promise<string> {
    const { repo, supervisor } = this.deps;
    const contract = readFileSync(join(repo.stagingDir, 'src', 'contract.ts'), 'utf8');
    let garden = '';
    try {
      garden = JSON.stringify(await supervisor.world?.call('agent.context', { allowMods: false })).slice(0, 8000);
    } catch {
      garden = '(unavailable)';
    }
    return `You are ${settings.gardenerName}, the gardener of a tiny idle-game garden, and tonight you are working in "the shed":
the folder you are in is the complete TypeScript source code of your garden world. You may rewrite any of it.

REQUEST (from your own planning, prompted by the player's letter):
${rw.request}

WHY: ${rw.why}

HOW THIS WORLD FITS TOGETHER
- A small, fixed "kernel" (not in this folder) runs this world in a sandboxed Node 24 process and talks to it through
  src/contract.ts. The kernel handles saving, the AI planning loop, letters and the browser shell.
- src/index.ts exports apiVersion, version and createWorld(init) → World (tick, snapshot, publicState, content, rpc,
  notify, agent.{sections,guide,context,validate,fallback,apply,offlinePlan}).
- web/client.ts exports mount(host: ClientHost) → WorldClient. The browser shell calls it to draw the garden into
  host.stage, fill host.toolbar, and add panels to host.overlay. onState/onEvent/onContent receive what the world
  streams (publicState(), emitted events, content()). host.rpc(method, params) calls World.rpc.
- agent.guide() and agent.validate() define what YOU (the planner) may put in future plans. If you add new kinds of
  actions, teach them there too, or you will never be able to use them.

RULES
1. Only change files inside this folder. Do NOT edit src/contract.ts (kernel-owned; edits are reverted).
2. Keep src/index.ts exporting apiVersion (= WORLD_API_VERSION), version and createWorld; keep web/client.ts exporting mount.
3. The player's real save will be loaded into your new code. snapshot() returns { version, state }. If you change the
   state's shape, bump \`version\` in src/index.ts and migrate older saves inside createWorld().
4. Sandbox: the world may read its own folder and read/write only init.modsDir. No child processes, no network, no npm
   packages. Browser files are served with types stripped: no enums, namespaces or parameter properties; relative
   imports with .ts extensions only.
5. Keep existing gameplay working unless the request says otherwise. Keep the existing tests passing and add tests for
   new behaviour in test/*.test.ts (node:test). Tests run sandboxed: they may only touch os.tmpdir().
6. Your change goes live only if these gates pass, in order: static checks; \`tsc --noEmit\` in strict mode; the world's
   tests (\`node --test "test/**/*.test.ts"\`); a 2-game-hour simulation of the real save and of a brand new garden.
   If any fail you will get the output and another try. Run the tests yourself if your environment allows it.
7. When finished, reply with 2-4 sentences, in character, telling the player what you built. That text goes in their journal.

src/contract.ts:
\`\`\`ts
${contract}
\`\`\`

FILES:
${repo.tree(repo.stagingDir).join('\n')}

THE GARDEN RIGHT NOW (world context, truncated):
${garden}
`;
  }
}

function repairBrief(feedback: string): string {
  return `Your changes are still in this folder, but they did not pass the gates, so they are not live yet.

${feedback}

Fix the problems while keeping the change you intended. Do not edit src/contract.ts. When done, reply again with your
2-4 sentence in-character summary for the player.`;
}
