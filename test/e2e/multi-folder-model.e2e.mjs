/**
 * mf-model end-to-end proof (docs/plans/2026-09-23-mf-model.plan.md), one phase per slice.
 * Every phase shares one userData dir and runs in order; a later slice appends its phase to
 * PHASES and may rely on the state an earlier phase left behind.
 *
 *   migration (Slice 2): a pre-multi-folder sessions.json (entries carry only `projectPath`)
 *     migrates to v1 + `home` + `projectPath` mirror, projects.json v1 and a byte-exact
 *     sessions.pre-mf.bak.json; a relaunch re-migrates nothing; an entry an older build wrote
 *     (no `home`) joins its folder's existing project.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assert, launchApp, makeLog, shutdownApp } from './harness.mjs';

const NAME = 'multi-folder-model';
const log = makeLog(NAME);

if (process.platform !== 'win32') {
  console.log(`[${NAME}] SKIP — suite is Windows-only (non-win32 platform)`);
  process.exit(0);
}

const userDataDir = mkdtempSync(join(tmpdir(), 'conduit-mfm-'));
const work = mkdtempSync(join(tmpdir(), 'conduit-mfm-work-'));
const dirA = join(work, 'A');
const dirB = join(work, 'B');
mkdirSync(dirA);
mkdirSync(dirB);

const file = (name) => join(userDataDir, name);
const readJson = (name) => JSON.parse(readFileSync(file(name), 'utf8'));
const backupEquals = (bytes) =>
  existsSync(file('sessions.pre-mf.bak.json')) &&
  readFileSync(file('sessions.pre-mf.bak.json')).equals(bytes);

/** Launch on the shared userData, wait for the first `state`, run `fn`, always shut down. */
async function withApp(fn) {
  const { app, page } = await launchApp({ userDataDir });
  try {
    await page.evaluate(() => {
      window.__mfmState = null;
      window.agentDeck.subscribe((m) => {
        if (m.type === 'state') window.__mfmState = { projects: m.projects, sessions: m.sessions };
      });
      window.agentDeck.post({ type: 'ready' });
    });
    await page.waitForFunction(() => window.__mfmState !== null, null, { timeout: 20000 });
    return await fn({ app, page, state: () => page.evaluate(() => window.__mfmState) });
  } finally {
    await shutdownApp(app, page);
  }
}

const seedEntry = (id, projectPath) => ({
  id,
  name: id,
  agentId: 'shell:cmd',
  projectPath,
  status: 'running',
  createdAt: 1000,
  lastActiveAt: 1000,
});

/** Every entry is v1 + mirror + roots, carrying the id of the project named for its folder. */
function assertMigratedSessions(projects, expectedHomes) {
  const blob = readJson('sessions.json');
  assert(blob.version === 1, `sessions.json version 1 (got ${blob.version})`);
  const idFor = (name) => projects.find((p) => p.name === name)?.id;
  for (const [id, { home, project }] of Object.entries(expectedHomes)) {
    const e = blob.sessions.find((s) => s.id === id);
    assert(e, `sessions.json keeps session ${id}`);
    assert(e.home === home, `${id}: home ${JSON.stringify(e.home)} === ${JSON.stringify(home)}`);
    assert(e.projectPath === e.home, `${id}: projectPath mirror equals home`);
    assert(Array.isArray(e.roots) && e.roots.length === 0, `${id}: roots is []`);
    assert(e.projectId === idFor(project), `${id}: projectId is project ${project}'s id`);
  }
}

const PHASES = [
  {
    name: 'migration',
    async run() {
      const variantA = `${dirA.replace(/\\/g, '/').toLowerCase()}/`;
      const seed = JSON.stringify({
        version: 1,
        sessions: [
          seedEntry('mfm-a1', dirA),
          seedEntry('mfm-a2', variantA),
          seedEntry('mfm-b', dirB),
        ],
      });
      writeFileSync(file('sessions.json'), seed);
      const seedBytes = readFileSync(file('sessions.json'));
      const expected = {
        'mfm-a1': { home: dirA, project: 'A' },
        'mfm-a2': { home: variantA, project: 'A' },
        'mfm-b': { home: dirB, project: 'B' },
      };

      const first = await withApp(async ({ state }) => {
        const s = await state();
        assert(
          s.projects?.length === 2,
          `state.projects has 2 entries (got ${s.projects?.length})`,
        );
        return s.projects;
      });
      assert(backupEquals(seedBytes), 'sessions.pre-mf.bak.json equals the seed byte-for-byte');
      const projects = readJson('projects.json');
      assert(projects.version === 1, `projects.json version 1 (got ${projects.version})`);
      assert(
        JSON.stringify(projects.projects.map((p) => [p.name, p.order])) === '[["A",0],["B",1]]',
        `projects.json has A, B in order (got ${JSON.stringify(projects.projects)})`,
      );
      assert(
        JSON.stringify(first.map((p) => p.id)) ===
          JSON.stringify(projects.projects.map((p) => p.id)),
        'state.projects matches projects.json',
      );
      assertMigratedSessions(projects.projects, expected);
      log('launch 1: migrated', JSON.stringify(projects.projects));

      await withApp(async ({ state }) => {
        const s = await state();
        assert(
          s.projects?.length === 2,
          `relaunch: state.projects still 2 (got ${s.projects?.length})`,
        );
      });
      assert(backupEquals(seedBytes), 'relaunch: backup bytes unchanged');
      const again = readJson('projects.json').projects;
      assert(
        JSON.stringify(again) === JSON.stringify(projects.projects),
        `relaunch: projects unchanged (got ${JSON.stringify(again)})`,
      );
      assertMigratedSessions(projects.projects, expected);
      log('launch 2: nothing re-migrated');

      // An older build loads the mirror, and a session IT adds has only `projectPath`.
      const blob = readJson('sessions.json');
      blob.sessions.push(seedEntry('mfm-older', dirB));
      writeFileSync(file('sessions.json'), JSON.stringify(blob));
      await withApp(async ({ state }) => {
        const s = await state();
        assert(
          s.projects?.length === 2,
          `downgrade: state.projects still 2 (got ${s.projects?.length})`,
        );
      });
      const afterDowngrade = readJson('projects.json').projects;
      assert(
        JSON.stringify(afterDowngrade) === JSON.stringify(projects.projects),
        `downgrade: projects unchanged (got ${JSON.stringify(afterDowngrade)})`,
      );
      assertMigratedSessions(projects.projects, {
        ...expected,
        'mfm-older': { home: dirB, project: 'B' },
      });
      assert(backupEquals(seedBytes), 'downgrade: the first backup is never overwritten');
      log('launch 3: older-build entry joined project B');
    },
  },
];

let code = 0;
for (const phase of PHASES) {
  try {
    await phase.run();
    log(`phase ${phase.name}: PASS`);
  } catch (e) {
    if (e?.name === 'AssertionError') {
      log(`phase ${phase.name}: FAIL ✗`, e.message);
      code = 1;
    } else {
      console.error(`[${NAME}] phase ${phase.name} ERROR:`, e?.stack || e);
      code = 2;
    }
    break;
  }
}
if (code === 0) log('PASS ✓');
process.exit(code);
