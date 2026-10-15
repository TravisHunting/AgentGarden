// Discovers, validates and (re)loads mods from the mods/ folder, and applies
// mod operations requested by the AI.

import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, watch, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Checker, ID_HINT, ID_PATTERN } from '../util/check.ts';
import type { ContentLayer } from '../game/registry.ts';
import { type ModManifest, type SoundDef, type SpriteDef, validateManifest, validateScript } from './schema.ts';

export interface LoadedMod {
  id: string; // folder name
  manifest?: ModManifest;
  script?: string;
  errors: string[];
}

export type ModOp =
  | { op: 'create' | 'update'; manifest: ModManifest; script?: string | null; note: string }
  | { op: 'enable' | 'disable' | 'delete'; id: string; note: string };

export interface ModOpResult {
  op: string;
  id: string;
  ok: boolean;
  note: string;
  errors?: string[];
}

const MANIFEST = 'mod.json';
const SCRIPT = 'script.js';

export class ModManager {
  dir: string;
  mods: LoadedMod[] = [];
  private watcher?: ReturnType<typeof watch>;
  private reloadTimer?: NodeJS.Timeout;
  private suppressWatchUntil = 0;

  constructor(dir: string) {
    mkdirSync(dir, { recursive: true });
    // Canonical long path: on Windows, watching an 8.3 short path (C:\Users\NAME~1\...)
    // trips a fatal libuv assertion when change events arrive with long names.
    this.dir = realpathSync.native(dir);
  }

  load(): LoadedMod[] {
    const mods: LoadedMod[] = [];
    for (const entry of readdirSync(this.dir, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      mods.push(this.readMod(entry.name));
    }
    this.mods = mods.sort((a, b) => (a.manifest?.priority ?? 0) - (b.manifest?.priority ?? 0) || a.id.localeCompare(b.id));
    return this.mods;
  }

  private readMod(folder: string): LoadedMod {
    const base = join(this.dir, folder);
    const mod: LoadedMod = { id: folder, errors: [] };
    try {
      const raw = JSON.parse(readFileSync(join(base, MANIFEST), 'utf8'));
      const { manifest, errors } = validateManifest(raw);
      mod.errors.push(...errors);
      if (manifest && manifest.id !== folder) mod.errors.push(`$.id: must match its folder name "${folder}"`);
      if (mod.errors.length === 0) mod.manifest = manifest;
    } catch (e) {
      mod.errors.push(`could not read ${MANIFEST}: ${(e as Error).message}`);
    }
    const scriptPath = join(base, SCRIPT);
    if (existsSync(scriptPath)) {
      const src = readFileSync(scriptPath, 'utf8');
      const errs = validateScript(src);
      if (errs.length) mod.errors.push(...errs);
      else mod.script = src;
    }
    return mod;
  }

  active(): (LoadedMod & { manifest: ModManifest })[] {
    return this.mods.filter((m): m is LoadedMod & { manifest: ModManifest } => !!m.manifest && m.manifest.enabled && m.errors.length === 0);
  }

  layers(): ContentLayer[] {
    return this.active().map(({ manifest: m }) => ({
      source: m.id,
      species: m.species,
      creatures: m.creatures,
      weather: m.weather,
      rules: m.rules,
      removeSpecies: m.remove?.species,
      removeCreatures: m.remove?.creatures,
      removeWeather: m.remove?.weather,
    }));
  }

  assets(): { sprites: Record<string, SpriteDef>; sounds: Record<string, SoundDef> } {
    const sprites: Record<string, SpriteDef> = {};
    const sounds: Record<string, SoundDef> = {};
    for (const { manifest } of this.active()) {
      Object.assign(sprites, manifest.sprites ?? {});
      Object.assign(sounds, manifest.sounds ?? {});
    }
    return { sprites, sounds };
  }

  scripts(): { modId: string; source: string }[] {
    return this.active().flatMap((m) => (m.script ? [{ modId: m.id, source: m.script }] : []));
  }

  /** Summary for the AI context and the UI. */
  describe() {
    return this.mods.map((m) => ({
      id: m.id,
      name: m.manifest?.name,
      enabled: m.manifest?.enabled ?? false,
      version: m.manifest?.version,
      description: m.manifest?.description,
      disabledReason: m.manifest?.disabledReason,
      hasScript: !!m.script,
      errors: m.errors,
      manifest: m.manifest,
      script: m.script,
    }));
  }

  // ---------------------------------------------------------------- operations

  /** Validates a single op without touching disk. */
  validateOp(op: unknown, path: string): string[] {
    const c = new Checker();
    if (!c.obj(op, path)) return c.errors;
    if (!c.str(op.op, `${path}.op`, { oneOf: ['create', 'update', 'enable', 'disable', 'delete'] })) return c.errors;
    c.str(op.note, `${path}.note`, { min: 1, max: 400 });
    if (op.op === 'create' || op.op === 'update') {
      c.obj(op, path, ['op', 'manifest', 'script', 'note']);
      const { manifest, errors } = validateManifest(op.manifest, `${path}.manifest`);
      c.errors.push(...errors);
      if (op.script !== undefined && op.script !== null) c.errors.push(...validateScript(op.script, `${path}.script`));
      if (manifest) {
        const exists = existsSync(join(this.dir, manifest.id));
        if (op.op === 'create' && exists) c.fail(`${path}.manifest.id`, `mod "${manifest.id}" already exists; use op "update" or a new id`);
        if (op.op === 'update' && !exists) c.fail(`${path}.manifest.id`, `mod "${manifest.id}" does not exist; use op "create"`);
      }
    } else {
      c.obj(op, path, ['op', 'id', 'note']);
      if (c.str(op.id, `${path}.id`, { pattern: ID_PATTERN, patternHint: ID_HINT }) && !existsSync(join(this.dir, op.id as string))) {
        c.fail(`${path}.id`, `no mod named "${op.id}" exists; existing mods: ${this.mods.map((m) => m.id).join(', ') || '(none)'}`);
      }
    }
    return c.errors;
  }

  apply(ops: ModOp[]): ModOpResult[] {
    this.suppressWatchUntil = Date.now() + 1500;
    const results: ModOpResult[] = [];
    for (const op of ops) {
      const errors = this.validateOp(op, '$');
      const id = 'manifest' in op ? op.manifest.id : op.id;
      if (errors.length) {
        results.push({ op: op.op, id, ok: false, note: op.note, errors });
        continue;
      }
      const base = join(this.dir, id);
      switch (op.op) {
        case 'create':
        case 'update': {
          mkdirSync(base, { recursive: true });
          const manifest = { ...op.manifest };
          delete manifest.disabledReason;
          writeFileSync(join(base, MANIFEST), JSON.stringify(manifest, null, 2));
          if (op.script === null) rmSync(join(base, SCRIPT), { force: true });
          else if (typeof op.script === 'string') writeFileSync(join(base, SCRIPT), op.script);
          break;
        }
        case 'enable':
        case 'disable':
          this.setEnabled(id, op.op === 'enable');
          break;
        case 'delete': {
          // Deleting is reversible: mods go to mods/.trash rather than vanishing.
          const trash = join(this.dir, '.trash');
          mkdirSync(trash, { recursive: true });
          renameSync(base, join(trash, `${id}-${Date.now()}`));
          break;
        }
      }
      results.push({ op: op.op, id, ok: true, note: op.note });
    }
    this.load();
    return results;
  }

  setEnabled(id: string, enabled: boolean, reason?: string): void {
    const file = join(this.dir, id, MANIFEST);
    const raw = JSON.parse(readFileSync(file, 'utf8'));
    raw.enabled = enabled;
    if (reason) raw.disabledReason = reason;
    else delete raw.disabledReason;
    this.suppressWatchUntil = Date.now() + 1500;
    writeFileSync(file, JSON.stringify(raw, null, 2));
  }

  /** Hot reload when someone (a human, or an agent with file access) edits mods/ directly. */
  watch(onChange: () => void): void {
    try {
      this.watcher = watch(this.dir, { recursive: true }, () => {
        if (Date.now() < this.suppressWatchUntil) return;
        clearTimeout(this.reloadTimer);
        this.reloadTimer = setTimeout(() => {
          this.load();
          onChange();
        }, 500);
      });
    } catch {
      // Recursive watching is unsupported on some platforms; hot reload is a nicety.
    }
  }

  close(): void {
    this.watcher?.close();
    clearTimeout(this.reloadTimer);
  }
}
