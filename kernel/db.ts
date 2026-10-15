// SQLite persistence via Node's built-in node:sqlite (no native dependencies).

import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export interface LetterRow {
  id: number;
  sender: 'player' | 'agent';
  text: string;
  created_at: number;
  read_at: number | null;
  plan_id: number | null; // the planning run that consumed this player letter
}

export interface PlayerEventRow {
  id: number;
  created_at: number;
  kind: string;
  detail: string; // JSON
  plan_id: number | null;
}

export interface JournalRow {
  id: number;
  created_at: number;
  trigger: string;
  provider: string;
  model: string;
  status: 'ok' | 'repaired' | 'fallback' | 'error';
  iterations: number;
  summary: string;
  detail: string; // JSON: plan, errors per iteration, mod ops
}

export type RewriteStatus = 'queued' | 'editing' | 'gating' | 'swapping' | 'live' | 'failed' | 'rolled-back' | 'superseded';

export interface RewriteRow {
  id: number;
  created_at: number;
  updated_at: number;
  request: string;
  why: string;
  status: RewriteStatus;
  base_commit: string | null;
  commit_sha: string | null;
  rounds: number;
  summary: string; // the agent's own description of what it changed
  log: string; // JSON: per-round gate results
  diff: string; // unified diff (truncated)
  plan_id: number | null;
}

export interface MemoryRow {
  id: number;
  created_at: number;
  text: string;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS letters (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sender TEXT NOT NULL CHECK (sender IN ('player','agent')),
  text TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  read_at INTEGER,
  plan_id INTEGER
);
CREATE TABLE IF NOT EXISTS player_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at INTEGER NOT NULL,
  kind TEXT NOT NULL,
  detail TEXT NOT NULL,
  plan_id INTEGER
);
CREATE TABLE IF NOT EXISTS journal (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at INTEGER NOT NULL,
  trigger TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  status TEXT NOT NULL,
  iterations INTEGER NOT NULL,
  summary TEXT NOT NULL,
  detail TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS memories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at INTEGER NOT NULL,
  text TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS mod_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at INTEGER NOT NULL,
  mod_id TEXT NOT NULL,
  op TEXT NOT NULL,
  note TEXT NOT NULL,
  plan_id INTEGER
);
CREATE TABLE IF NOT EXISTS rewrites (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  request TEXT NOT NULL,
  why TEXT NOT NULL,
  status TEXT NOT NULL,
  base_commit TEXT,
  commit_sha TEXT,
  rounds INTEGER NOT NULL DEFAULT 0,
  summary TEXT NOT NULL DEFAULT '',
  log TEXT NOT NULL DEFAULT '[]',
  diff TEXT NOT NULL DEFAULT '',
  plan_id INTEGER
);
CREATE INDEX IF NOT EXISTS idx_events_plan ON player_events(plan_id);
CREATE INDEX IF NOT EXISTS idx_letters_plan ON letters(plan_id);
`;

export class Store {
  db: DatabaseSync;

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec(SCHEMA);
  }

  close(): void {
    this.db.close();
  }

  // ---------------------------------------------------------------- kv

  get<T>(key: string): T | undefined {
    const row = this.db.prepare('SELECT value FROM kv WHERE key = ?').get(key) as { value: string } | undefined;
    return row ? (JSON.parse(row.value) as T) : undefined;
  }

  set(key: string, value: unknown): void {
    this.db
      .prepare('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(key, JSON.stringify(value));
  }

  // ---------------------------------------------------------------- letters

  addLetter(sender: LetterRow['sender'], text: string): LetterRow {
    const now = Date.now();
    const r = this.db.prepare('INSERT INTO letters (sender, text, created_at) VALUES (?, ?, ?)').run(sender, text, now);
    return { id: Number(r.lastInsertRowid), sender, text, created_at: now, read_at: null, plan_id: null };
  }

  letters(limit = 100): LetterRow[] {
    return this.db.prepare('SELECT * FROM letters ORDER BY id DESC LIMIT ?').all(limit) as unknown as LetterRow[];
  }

  pendingPlayerLetters(): LetterRow[] {
    return this.db
      .prepare("SELECT * FROM letters WHERE sender = 'player' AND plan_id IS NULL ORDER BY id")
      .all() as unknown as LetterRow[];
  }

  markLetterRead(id: number): void {
    this.db.prepare('UPDATE letters SET read_at = ? WHERE id = ? AND read_at IS NULL').run(Date.now(), id);
  }

  unreadAgentLetters(): number {
    const r = this.db.prepare("SELECT COUNT(*) AS n FROM letters WHERE sender = 'agent' AND read_at IS NULL").get() as {
      n: number;
    };
    return Number(r.n);
  }

  // ---------------------------------------------------------------- player events

  addEvent(kind: string, detail: unknown): void {
    this.db
      .prepare('INSERT INTO player_events (created_at, kind, detail) VALUES (?, ?, ?)')
      .run(Date.now(), kind, JSON.stringify(detail));
  }

  pendingEvents(): PlayerEventRow[] {
    return this.db.prepare('SELECT * FROM player_events WHERE plan_id IS NULL ORDER BY id').all() as unknown as PlayerEventRow[];
  }

  /** Marks everything up to (and including) the given ids as consumed by a planning run. */
  consume(planId: number, eventIds: number[], letterIds: number[]): void {
    const ev = this.db.prepare('UPDATE player_events SET plan_id = ? WHERE id = ?');
    const le = this.db.prepare('UPDATE letters SET plan_id = ? WHERE id = ?');
    this.db.exec('BEGIN');
    try {
      for (const id of eventIds) ev.run(planId, id);
      for (const id of letterIds) le.run(planId, id);
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  // ---------------------------------------------------------------- journal

  addJournal(row: Omit<JournalRow, 'id' | 'created_at'>): number {
    const r = this.db
      .prepare(
        'INSERT INTO journal (created_at, trigger, provider, model, status, iterations, summary, detail) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(Date.now(), row.trigger, row.provider, row.model, row.status, row.iterations, row.summary, row.detail);
    return Number(r.lastInsertRowid);
  }

  journal(limit = 50): JournalRow[] {
    return this.db.prepare('SELECT * FROM journal ORDER BY id DESC LIMIT ?').all(limit) as unknown as JournalRow[];
  }

  // ---------------------------------------------------------------- memories

  addMemory(text: string): void {
    this.db.prepare('INSERT INTO memories (created_at, text) VALUES (?, ?)').run(Date.now(), text);
  }

  memories(limit = 40): MemoryRow[] {
    return (this.db.prepare('SELECT * FROM memories ORDER BY id DESC LIMIT ?').all(limit) as unknown as MemoryRow[]).reverse();
  }

  forgetMemories(ids: number[]): void {
    const st = this.db.prepare('DELETE FROM memories WHERE id = ?');
    for (const id of ids) st.run(id);
  }

  // ---------------------------------------------------------------- rewrites

  addRewrite(request: string, why: string, planId: number | null): RewriteRow {
    const now = Date.now();
    const r = this.db
      .prepare("INSERT INTO rewrites (created_at, updated_at, request, why, status, plan_id) VALUES (?, ?, ?, ?, 'queued', ?)")
      .run(now, now, request, why, planId);
    return this.rewrite(Number(r.lastInsertRowid))!;
  }

  updateRewrite(id: number, patch: Partial<Omit<RewriteRow, 'id' | 'created_at'>>): void {
    const keys = Object.keys(patch) as (keyof typeof patch)[];
    if (!keys.length) return;
    const sets = keys.map((k) => `${k} = ?`).join(', ');
    this.db.prepare(`UPDATE rewrites SET ${sets}, updated_at = ? WHERE id = ?`).run(...keys.map((k) => patch[k] as never), Date.now(), id);
  }

  rewrite(id: number): RewriteRow | undefined {
    return this.db.prepare('SELECT * FROM rewrites WHERE id = ?').get(id) as unknown as RewriteRow | undefined;
  }

  rewrites(limit = 50): RewriteRow[] {
    return this.db.prepare('SELECT * FROM rewrites ORDER BY id DESC LIMIT ?').all(limit) as unknown as RewriteRow[];
  }
}
