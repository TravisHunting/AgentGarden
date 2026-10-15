// The player's world is a git repository (data/world/repo, branch main = live).
// The workshop edits a detached worktree (data/world/staging) of the same repo.

import { execFile } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const IDENTITY = ['-c', 'user.name=Agent Garden', '-c', 'user.email=garden@localhost', '-c', 'commit.gpgsign=false', '-c', 'core.autocrlf=false'];

export interface CommitInfo {
  sha: string;
  at: number;
  subject: string;
  body: string;
}

export class WorldRepo {
  readonly root: string;
  readonly repoDir: string;
  readonly stagingDir: string;
  private templateDir: string;
  private contractSource: string;

  constructor(root: string, templateDir: string, contractFile: string) {
    this.root = root;
    this.repoDir = join(root, 'repo');
    this.stagingDir = join(root, 'staging');
    this.templateDir = templateDir;
    this.contractSource = readFileSync(contractFile, 'utf8');
  }

  async git(cwd: string, ...args: string[]): Promise<string> {
    const { stdout } = await exec('git', [...IDENTITY, ...args], { cwd, maxBuffer: 32 * 1024 * 1024, windowsHide: true });
    return stdout;
  }

  static async available(): Promise<boolean> {
    try {
      await exec('git', ['--version'], { windowsHide: true });
      return true;
    } catch {
      return false;
    }
  }

  /** Seeds the repo from the template on first run; keeps the kernel contract current. */
  async ensure(): Promise<string> {
    mkdirSync(this.root, { recursive: true });
    if (!existsSync(join(this.repoDir, '.git'))) {
      rmSync(this.repoDir, { recursive: true, force: true });
      this.copyTemplate(this.repoDir);
      this.writeContract(this.repoDir);
      await this.git(this.repoDir, 'init', '-q', '-b', 'main');
      await this.git(this.repoDir, 'add', '-A');
      await this.git(this.repoDir, 'commit', '-q', '-m', 'genesis: seeded from the template world');
    } else {
      // Recover from an interrupted swap/rollback: the working tree must equal HEAD.
      await this.git(this.repoDir, 'reset', '-q', '--hard', 'HEAD');
      if (this.writeContract(this.repoDir)) {
        await this.git(this.repoDir, 'add', 'src/contract.ts');
        await this.git(this.repoDir, 'commit', '-q', '-m', 'kernel: refresh src/contract.ts');
      }
    }
    return this.head();
  }

  private copyTemplate(dest: string): void {
    cpSync(this.templateDir, dest, {
      recursive: true,
      filter: (src) => !/[\\/](node_modules|\.git)([\\/]|$)/.test(src.slice(this.templateDir.length)),
    });
  }

  /** Writes the kernel's contract into a world; returns true if it changed. */
  writeContract(dir: string): boolean {
    const file = join(dir, 'src', 'contract.ts');
    const current = existsSync(file) ? readFileSync(file, 'utf8') : null;
    if (current === this.contractSource) return false;
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(file, this.contractSource);
    return true;
  }

  contractIntact(dir: string): boolean {
    const file = join(dir, 'src', 'contract.ts');
    return existsSync(file) && readFileSync(file, 'utf8') === this.contractSource;
  }

  async head(dir = this.repoDir): Promise<string> {
    return (await this.git(dir, 'rev-parse', 'HEAD')).trim();
  }

  async log(n = 30): Promise<CommitInfo[]> {
    const out = await this.git(this.repoDir, 'log', `-n${n}`, '--format=%H%x1f%at%x1f%s%x1f%b%x1e');
    return out
      .split('\x1e')
      .map((r) => r.trim())
      .filter(Boolean)
      .map((r) => {
        const [sha, at, subject, body] = r.split('\x1f');
        return { sha, at: Number(at) * 1000, subject, body: body ?? '' };
      });
  }

  async diff(from: string, to: string, maxBytes = 200_000): Promise<{ stat: string; patch: string }> {
    const stat = await this.git(this.repoDir, 'diff', '--stat', from, to);
    const patch = await this.git(this.repoDir, 'diff', from, to);
    return { stat, patch: patch.length > maxBytes ? `${patch.slice(0, maxBytes)}\n… (truncated)` : patch };
  }

  // ---------------------------------------------------------------- staging

  async prepareStaging(): Promise<string> {
    await this.removeStaging();
    await this.git(this.repoDir, 'worktree', 'add', '-q', '--detach', this.stagingDir, 'HEAD');
    this.writeContract(this.stagingDir);
    return this.head(this.stagingDir);
  }

  async removeStaging(): Promise<void> {
    if (existsSync(this.stagingDir)) {
      try {
        await this.git(this.repoDir, 'worktree', 'remove', '--force', this.stagingDir);
      } catch {
        rmSync(this.stagingDir, { recursive: true, force: true });
      }
    }
    await this.git(this.repoDir, 'worktree', 'prune');
  }

  /** Paths changed in staging relative to its base (including untracked files). */
  async stagingChanges(): Promise<string[]> {
    const out = await this.git(this.stagingDir, 'status', '--porcelain', '-uall');
    return out
      .split('\n')
      .filter(Boolean)
      .map((l) => l.slice(3).replace(/^"|"$/g, '').split(' -> ').pop()!);
  }

  async stagingDiff(maxBytes = 200_000): Promise<{ stat: string; patch: string }> {
    await this.git(this.stagingDir, 'add', '-A');
    const stat = await this.git(this.stagingDir, 'diff', '--cached', '--stat');
    const patch = await this.git(this.stagingDir, 'diff', '--cached');
    return { stat, patch: patch.length > maxBytes ? `${patch.slice(0, maxBytes)}\n… (truncated)` : patch };
  }

  async commitStaging(message: string): Promise<string> {
    await this.git(this.stagingDir, 'add', '-A');
    await this.git(this.stagingDir, 'commit', '-q', '-m', message);
    return this.head(this.stagingDir);
  }

  async fastForward(sha: string): Promise<void> {
    await this.git(this.repoDir, 'merge', '-q', '--ff-only', sha);
  }

  async resetTo(sha: string): Promise<void> {
    await this.git(this.repoDir, 'reset', '-q', '--hard', sha);
  }

  /** Reverts to a past commit as a NEW commit (history is kept). */
  async revertTo(sha: string, message: string): Promise<string> {
    await this.git(this.repoDir, 'read-tree', '-u', '--reset', sha);
    this.writeContract(this.repoDir);
    await this.git(this.repoDir, 'add', '-A');
    await this.git(this.repoDir, 'commit', '-q', '--allow-empty', '-m', message);
    return this.head();
  }

  /** Replaces the world with a fresh copy of the template, as a new commit. */
  async resetToTemplate(): Promise<string> {
    for (const entry of readdirSync(this.repoDir)) {
      if (entry !== '.git') rmSync(join(this.repoDir, entry), { recursive: true, force: true });
    }
    this.copyTemplate(this.repoDir);
    this.writeContract(this.repoDir);
    await this.git(this.repoDir, 'add', '-A');
    await this.git(this.repoDir, 'commit', '-q', '--allow-empty', '-m', 'reset to the template world');
    return this.head();
  }

  /** A short file listing for the workshop prompt. */
  tree(dir: string): string[] {
    const out: string[] = [];
    const walk = (d: string) => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        if (e.name === '.git' || e.name === 'node_modules') continue;
        const p = join(d, e.name);
        if (e.isDirectory()) walk(p);
        else out.push(relative(dir, p).replace(/\\/g, '/'));
      }
    };
    walk(dir);
    return out.sort();
  }
}
