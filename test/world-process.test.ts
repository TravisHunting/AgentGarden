import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WorldProcess, type WorldExit } from '../kernel/world-process.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** A minimal world whose behaviour is injected as source snippets. */
function tinyWorld(snippets: { init?: string; tick?: string; rpc?: string }): { worldDir: string; modsDir: string } {
  const base = mkdtempSync(join(tmpdir(), 'tiny-world-'));
  const worldDir = join(base, 'world');
  const modsDir = join(base, 'mods');
  mkdirSync(join(worldDir, 'src'), { recursive: true });
  mkdirSync(modsDir);
  writeFileSync(
    join(worldDir, 'src', 'index.ts'),
    `import { readFileSync, writeFileSync } from 'node:fs';
export const apiVersion = 1;
export const version = 't1';
export function createWorld(init: any) {
  let n = 0;
  ${snippets.init ?? ''}
  return {
    tick(dt: number) { n++; ${snippets.tick ?? ''} },
    snapshot: () => ({ version, state: { n } }),
    publicState: () => ({ n }),
    content: () => ({}),
    rpc(method: string, params: any) { ${snippets.rpc ?? 'return { result: method };'} },
    agent: { sections: () => [], guide: () => '', context: () => ({}), validate: () => ({ errors: [] }), apply: () => ({ notes: [] }) },
  };
}
`,
  );
  return { worldDir, modsDir };
}

test('the template world runs in the sandbox: init, rpc, soak, state stream', async () => {
  const mods = mkdtempSync(join(tmpdir(), 'wp-mods-'));
  const wp = await WorldProcess.start({ worldDir: join(ROOT, 'world'), modsDir: mods, saved: null, seed: 3, awaySeconds: 0, clock: true });
  try {
    assert.equal(wp.version, '1');
    const r = await wp.call<{ result: { ok: boolean }; activity: { summary: string } }>('rpc', 'action', { action: { type: 'till', x: 0, y: 8 } });
    assert.equal(r.result.ok, true);
    assert.equal(r.activity.summary, 'till (0,8)');
    const soak = await wp.soak(7200, 5);
    assert.ok(soak.snapshotBytes > 1000);
    const state = await new Promise((res) => wp.once('state', res));
    assert.ok(state);
  } finally {
    await wp.stop();
  }
});

test('the sandbox blocks reads outside the world, writes outside mods, and child processes', async () => {
  const secret = join(mkdtempSync(join(tmpdir(), 'secret-')), 'secret.txt');
  writeFileSync(secret, 'shh');
  const { worldDir, modsDir } = tinyWorld({
    rpc: `
      const out: Record<string, string> = {};
      const attempt = (k: string, f: () => unknown) => { try { f(); out[k] = 'ALLOWED'; } catch (e: any) { out[k] = e.code ?? String(e); } };
      attempt('readSecret', () => readFileSync(${JSON.stringify(secret)}));
      attempt('writeOutside', () => writeFileSync(${JSON.stringify(secret + '.x')}, 'x'));
      attempt('writeMods', () => writeFileSync(init.modsDir + '/ok.txt', 'x'));
      attempt('spawn', () => (process as any).getBuiltinModule('node:child_process').execSync('echo hi'));
      attempt('fetch', () => { if (typeof (globalThis as any).fetch !== 'undefined') throw new Error('present'); });
      return { result: out };`,
  });
  const wp = await WorldProcess.start({ worldDir, modsDir, saved: null, seed: 1, awaySeconds: 0, clock: false });
  try {
    const out = await wp.call<{ result: Record<string, string> }>('rpc', 'probe', {});
    assert.equal(out.result.readSecret, 'ERR_ACCESS_DENIED');
    assert.equal(out.result.writeOutside, 'ERR_ACCESS_DENIED');
    assert.equal(out.result.writeMods, 'ALLOWED');
    assert.equal(out.result.spawn, 'ERR_ACCESS_DENIED');
    assert.equal(out.result.fetch, 'ALLOWED', 'fetch global removed');
  } finally {
    await wp.stop();
  }
});

test('world errors come back as rejected calls; crashes and hangs are reported', async () => {
  const thrower = tinyWorld({ rpc: `if (method === 'boom') setTimeout(() => { throw new Error('kaboom'); }, 10); if (method === 'bad') throw new Error('nope'); return { result: 1 };` });
  const wp = await WorldProcess.start({ ...thrower, saved: null, seed: 1, awaySeconds: 0, clock: true });
  await assert.rejects(wp.call('rpc', 'bad', {}), /nope/);
  const exit = new Promise<WorldExit>((res) => wp.once('exit', res));
  await wp.call('rpc', 'boom', {});
  const e = await exit;
  assert.equal(e.reason, 'crash');
  assert.match(e.stderr, /kaboom/);

  const hanger = tinyWorld({ tick: `if (n > 8) { while (true) {} }` });
  const wp2 = await WorldProcess.start({ ...hanger, saved: null, seed: 1, awaySeconds: 0, clock: true }, 1500);
  const e2 = await new Promise<WorldExit>((res) => wp2.once('exit', res));
  assert.equal(e2.reason, 'hung');
});

test('a world with the wrong apiVersion is refused', async () => {
  const w = tinyWorld({});
  writeFileSync(join(w.worldDir, 'src', 'index.ts'), 'export const apiVersion = 99; export const version = "x"; export function createWorld() { return {}; }');
  await assert.rejects(WorldProcess.start({ ...w, saved: null, seed: 1, awaySeconds: 0, clock: false }), /apiVersion is 99/);
});
