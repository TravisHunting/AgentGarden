import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store, type RewriteStatus } from '../kernel/db.ts';
import { WorldRepo } from '../kernel/world-repo.ts';
import { Supervisor } from '../kernel/supervisor.ts';
import { Workshop } from '../kernel/workshop.ts';
import { DEFAULT_SETTINGS, type AgentSettings } from '../kernel/ai/planner.ts';
import { registerProvider } from '../kernel/ai/providers/index.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MARKER = '// @offline-workshop:species';

type Edit = (cwd: string) => string;
const edits: Edit[] = [];
const instructions: string[] = [];
registerProvider({
  info: { id: 'scripted-edit', name: 'scripted', kind: 'offline', description: '', modelSuggestions: [], defaultModel: '' },
  available: async () => ({ ok: true, detail: '' }),
  complete: async () => '{}',
  edit: async (req) => {
    instructions.push(req.instructions);
    const next = edits.shift();
    if (!next) throw new Error('no scripted edit left');
    return next(req.cwd);
  },
});

function patch(cwd: string, file: string, fn: (src: string) => string): void {
  const p = join(cwd, file);
  writeFileSync(p, fn(readFileSync(p, 'utf8')));
}

const species = `{
    id: 'shed-test-bloom',
    name: 'Shed Test Bloom',
    growMinutes: 30,
    thirstPerMinute: 0.3,
    idealMoisture: [25, 80],
    shape: 'crystal',
    colors: { stem: '#334455', leaf: '#55aa77', bloom: '#ffcc00' },
    regrows: true,
    source: base,
  },
  ${MARKER}`;

const base = mkdtempSync(join(tmpdir(), 'garden-shed-'));
const store = new Store(':memory:');
const modsDir = join(base, 'mods');
mkdirSync(modsDir);
const repo = new WorldRepo(join(base, 'world'), join(ROOT, 'world'), join(ROOT, 'kernel', 'contract.ts'));
const settings: AgentSettings = { ...DEFAULT_SETTINGS, provider: 'scripted-edit', workshopRounds: 3, probationMinutes: 5 };
const rolledBack: number[] = [];
let lastContent: { species?: { id: string }[] } = {};
const supervisor = new Supervisor({
  store,
  repo,
  modsDir,
  probationMinutes: () => settings.probationMinutes,
  onState: () => {},
  onEvent: () => {},
  onContent: (c) => (lastContent = c as typeof lastContent),
  onWorldChanged: () => {},
  onRolledBack: ({ rewriteId }) => {
    if (rewriteId) {
      rolledBack.push(rewriteId);
      store.updateRewrite(rewriteId, { status: 'rolled-back' });
    }
  },
  log: () => {},
});
const workshop = new Workshop({
  store,
  repo,
  supervisor,
  dataDir: base,
  modsDir,
  settings: () => settings,
  quiesce: async () => () => {},
  onPhase: () => {},
});
after(() => supervisor.stop());

async function until(pred: () => boolean, ms = 180_000): Promise<void> {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > ms) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 200));
  }
}

const terminal: RewriteStatus[] = ['live', 'failed', 'rolled-back', 'superseded'];

test('workshop: gate failure is fed back, the fix goes live', { timeout: 300_000 }, async () => {
  await supervisor.start();
  const genesis = supervisor.commit;
  assert.ok(genesis);

  edits.push(
    (cwd) => {
      patch(cwd, 'src/game/content.ts', (s) => `${s}\nexport const oops: number = 'not a number';\n`);
      return 'I added a plant. Probably.';
    },
    (cwd) => {
      patch(cwd, 'src/game/content.ts', (s) => s.replace("\nexport const oops: number = 'not a number';\n", '\n').replace(MARKER, species));
      return 'I built a Shed Test Bloom out of spare crystals.';
    },
  );
  const rw = store.addRewrite('Add a crystal plant called the Shed Test Bloom.', 'testing', null);
  assert.equal(workshop.start(rw), true);
  await until(() => terminal.includes(store.rewrite(rw.id)!.status));

  const done = store.rewrite(rw.id)!;
  assert.equal(done.status, 'live', done.log);
  assert.equal(done.rounds, 2);
  const log = JSON.parse(done.log) as { gates: { name: string; ok: boolean; output: string }[] }[];
  const failed = log[0].gates.find((g) => !g.ok)!;
  assert.equal(failed.name, 'typecheck');
  assert.match(failed.output, /not assignable to type 'number'/);
  assert.match(instructions[1], /did not pass the gates/);
  assert.match(instructions[1], /typecheck/);
  assert.match(instructions[0], /src\/contract\.ts/);
  assert.notEqual(supervisor.commit, genesis);
  assert.equal(done.commit_sha, supervisor.commit);
  assert.match(done.diff, /shed-test-bloom/);
  await until(() => !!lastContent.species?.some((s) => s.id === 'shed-test-bloom'), 10_000);
  assert.ok(supervisor.probation, 'new code is on probation');
});

test('workshop: code that crashes while on probation is rolled back', { timeout: 300_000 }, async () => {
  const good = supervisor.commit;
  edits.push((cwd) => {
    patch(cwd, 'src/index.ts', (s) =>
      s.replace("      case 'mods.list': {", "      case 'explode':\n        setTimeout(() => {\n          throw new Error('the shed exploded');\n        }, 20);\n        return { result: 'tick tick' };\n      case 'mods.list': {"),
    );
    return 'I added a big red button.';
  });
  const rw = store.addRewrite('Add a big red button that does something exciting.', 'testing', null);
  workshop.start(rw);
  await until(() => terminal.includes(store.rewrite(rw.id)!.status));
  assert.equal(store.rewrite(rw.id)!.status, 'live');
  const bad = supervisor.commit;
  assert.notEqual(bad, good);

  await supervisor.world!.call('rpc', 'explode', {});
  await until(() => supervisor.commit === good && supervisor.healthy, 30_000);
  assert.deepEqual(rolledBack, [rw.id]);
  assert.equal(store.rewrite(rw.id)!.status, 'rolled-back');
  assert.equal(supervisor.probation, null);
  // The rolled-back world still has the first rewrite's plant.
  const content = await supervisor.world!.call<{ species: { id: string }[] }>('content');
  assert.ok(content.species.some((s) => s.id === 'shed-test-bloom'));
});

test('workshop: an edit that changes nothing fails cleanly', { timeout: 60_000 }, async () => {
  const before = supervisor.commit;
  edits.push(() => 'I sat in the shed and had a think.');
  const rw = store.addRewrite('Do something very subtle to the clouds.', 'testing', null);
  workshop.start(rw);
  await until(() => terminal.includes(store.rewrite(rw.id)!.status));
  assert.equal(store.rewrite(rw.id)!.status, 'failed');
  assert.match(store.rewrite(rw.id)!.summary, /without changing anything/);
  assert.equal(supervisor.commit, before);
});
