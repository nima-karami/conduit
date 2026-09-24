/**
 * mf-model end-to-end proof (docs/plans/2026-09-23-mf-model.plan.md), one phase per slice.
 * Every phase shares one userData dir and runs in order; a later slice appends its phase to
 * PHASES and may rely on the state an earlier phase left behind.
 *
 *   migration (Slice 2): a pre-multi-folder sessions.json (entries carry only `projectPath`)
 *     migrates to v1 + `home` + `projectPath` mirror, projects.json v1 and a byte-exact
 *     sessions.pre-mf.bak.json; a relaunch re-migrates nothing; an entry an older build wrote
 *     (no `home`) joins its folder's existing project.
 *   ops (Slice 3): session:addRoot / openRepo roots / home-missing / project create-assign-delete
 *     over the wire, writes allowed inside an attached root only; then a relaunch whose
 *     projects.json is a directory (unreadable) keeps projectIds and refuses project:create.
 *   repos (Slice 4): home and attached repos carry their tag/folder; a home inside a repo lists
 *     the enclosing repo tagged home and still shows that repo's changes.
 *   watch (Slice 5): a write under an attached root reaches ONE fsChanged naming it; a write
 *     under home costs exactly one renderer requestProject (B3).
 */
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assert, launchApp, makeLog, openSession, shutdownApp } from './harness.mjs';

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

/** Post `msg` from the renderer and resolve with the first reply of `types` carrying its requestId. */
function request(page, msg, types) {
  return page.evaluate(
    ({ msg, types }) =>
      new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          off();
          reject(new Error(`no ${types.join('|')} reply to ${msg.type}`));
        }, 15000);
        const off = window.agentDeck.subscribe((m) => {
          if (!types.includes(m.type) || m.requestId !== msg.requestId) return;
          clearTimeout(timer);
          off();
          resolve(m);
        });
        window.agentDeck.post(msg);
      }),
    { msg, types },
  );
}

/** Wait until the page predicate `pred(arg)` (it reads `window.__mfmState`) holds. */
async function waitState(page, pred, arg, what) {
  const ok = await page.waitForFunction(pred, arg, { timeout: 15000 }).then(
    () => true,
    () => false,
  );
  assert(ok, `timed out waiting for state: ${what}`);
}

const sessionIn = (state, id) => state.sessions.find((s) => s.id === id);

const git = (cwd, ...args) =>
  execFileSync(
    'git',
    [
      '-c',
      'user.name=e2e',
      '-c',
      'user.email=e2e@example.invalid',
      '-c',
      'commit.gpgsign=false',
      ...args,
    ],
    { cwd, stdio: 'ignore' },
  );
const key = (p) => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
const keyed = (r) => ({ root: key(r.root), name: r.name, folder: key(r.folder), tag: r.tag });

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
  {
    name: 'ops',
    async run() {
      const repoR = join(work, 'R');
      mkdirSync(repoR);
      execFileSync('git', ['init'], { cwd: repoR, stdio: 'ignore' });
      const outside = join(work, 'outside');
      mkdirSync(outside);
      const homeC = join(work, 'C');
      mkdirSync(homeC);
      const missingR2 = join(work, 'R2-missing');
      const missingHome = join(work, 'no-such-home');
      const sid = 'mfm-a1';
      let deletedId;

      await withApp(async ({ page, state }) => {
        assert(sessionIn(await state(), sid), `restored session ${sid} is in state`);
        const post = (msg, types) => request(page, msg, types);

        const added = await post(
          { type: 'session:addRoot', sessionId: sid, path: repoR, requestId: 1 },
          ['session:opResult'],
        );
        assert(added.ok === true, `addRoot ok (got ${JSON.stringify(added)})`);
        await waitState(
          page,
          ({ id, r }) => window.__mfmState.sessions.find((s) => s.id === id)?.roots.includes(r),
          { id: sid, r: repoR },
          'roots has R',
        );

        const inside = await page.evaluate(
          (p) => window.agentDeck.writeFile(p, 'inside'),
          join(repoR, 'x.txt'),
        );
        assert(
          inside.ok === true,
          `write inside the attached root ok (got ${JSON.stringify(inside)})`,
        );
        const out = await page.evaluate(
          (p) => window.agentDeck.writeFile(p, 'outside'),
          join(outside, 'y.txt'),
        );
        assert(out.ok === false, `write outside every root refused (got ${JSON.stringify(out)})`);
        assert(!existsSync(join(outside, 'y.txt')), 'refused write left no file');

        const again = await post(
          { type: 'session:addRoot', sessionId: sid, path: repoR, requestId: 2 },
          ['session:opResult'],
        );
        assert(
          again.ok === false && again.reason === 'duplicate',
          `second addRoot → duplicate (got ${JSON.stringify(again)})`,
        );
        log('addRoot ok, write confined, duplicate refused');

        const opened = await post(
          {
            type: 'openRepo',
            path: homeC,
            agentId: 'shell:cmd',
            roots: [missingR2],
            requestId: 3,
          },
          ['openRepo:result'],
        );
        assert(
          typeof opened.sessionId === 'string' && !opened.error,
          `openRepo created a session (got ${JSON.stringify(opened)})`,
        );
        assert(
          Array.isArray(opened.droppedRoots) && opened.droppedRoots.length === 0,
          `droppedRoots empty (got ${JSON.stringify(opened.droppedRoots)})`,
        );
        const newSid = opened.sessionId;
        await waitState(
          page,
          (id) => !!window.__mfmState.sessions.find((s) => s.id === id),
          newSid,
          'new session',
        );
        const created = sessionIn(await state(), newSid);
        assert(
          JSON.stringify(created.roots) === JSON.stringify([missingR2]) &&
            JSON.stringify(created.missingRoots) === JSON.stringify([missingR2]),
          `missing root kept in roots and missingRoots (got ${JSON.stringify(created)})`,
        );

        const countBefore = (await state()).sessions.length;
        const refused = await post(
          { type: 'openRepo', path: missingHome, agentId: 'shell:cmd', requestId: 4 },
          ['openRepo:result'],
        );
        assert(
          refused.error === 'home-missing' && refused.sessionId === undefined,
          `missing home → home-missing (got ${JSON.stringify(refused)})`,
        );
        await page.waitForTimeout(500);
        assert(
          (await state()).sessions.length === countBefore &&
            !(await state()).sessions.some((s) => s.home === missingHome),
          'no session created for a missing home',
        );
        log('openRepo: missing root kept + marked; missing home refused');

        const project = await post(
          { type: 'project:create', name: '  Ops   project ', requestId: 5 },
          ['project:created', 'project:opResult'],
        );
        assert(
          project.type === 'project:created' && typeof project.id === 'string',
          `project:create → project:created (got ${JSON.stringify(project)})`,
        );
        deletedId = project.id;
        await waitState(
          page,
          (id) => window.__mfmState.projects.some((p) => p.id === id && p.name === 'Ops project'),
          project.id,
          'state.projects has the new project',
        );
        const assigned = await post(
          { type: 'session:setProject', sessionId: newSid, projectId: project.id, requestId: 6 },
          ['session:opResult'],
        );
        assert(assigned.ok === true, `setProject ok (got ${JSON.stringify(assigned)})`);
        await waitState(
          page,
          ({ id, p }) => window.__mfmState.sessions.find((s) => s.id === id)?.projectId === p,
          { id: newSid, p: project.id },
          'session carries projectId',
        );

        await page.evaluate(
          (id) => window.agentDeck.post({ type: 'project:delete', id }),
          project.id,
        );
        await waitState(
          page,
          ({ id, p }) => {
            const s = window.__mfmState;
            const cur = s.sessions.find((x) => x.id === id);
            return !s.projects.some((x) => x.id === p) && cur && !('projectId' in cur);
          },
          { id: newSid, p: project.id },
          'project gone and the session standalone',
        );
        const survivor = sessionIn(await state(), newSid);
        assert(survivor.status === 'running', `session still running (got ${survivor.status})`);
        log('project create → assign → delete: session standalone and still running');
      });
      assert(
        !readJson('projects.json').projects.some((p) => p.id === deletedId),
        'projects.json no longer lists the deleted project',
      );

      // Store-blocked relaunch (B2): projects.json is a directory, so its read fails non-ENOENT.
      const goodProjects = readFileSync(file('projects.json'));
      const keptIds = Object.fromEntries(
        readJson('sessions.json').sessions.map((s) => [s.id, s.projectId]),
      );
      rmSync(file('projects.json'));
      mkdirSync(file('projects.json'));
      writeFileSync(join(file('projects.json'), 'marker.txt'), 'keep');
      await withApp(async ({ page, state }) => {
        const s = await state();
        for (const id of ['mfm-a1', 'mfm-b']) {
          assert(
            sessionIn(s, id)?.projectId === keptIds[id] && typeof keptIds[id] === 'string',
            `blocked: ${id} keeps projectId ${keptIds[id]} (got ${sessionIn(s, id)?.projectId})`,
          );
        }
        const r = await request(page, { type: 'project:create', name: 'Nope', requestId: 7 }, [
          'project:created',
          'project:opResult',
        ]);
        assert(
          r.type === 'project:opResult' && r.reason === 'store-unavailable',
          `blocked: project:create → store-unavailable (got ${JSON.stringify(r)})`,
        );
      });
      assert(
        statSync(file('projects.json')).isDirectory(),
        'blocked: projects.json still a directory',
      );
      assert(
        JSON.stringify(readdirSync(file('projects.json'))) === '["marker.txt"]',
        'blocked: the directory is untouched',
      );
      assert(
        readJson('sessions.json').sessions.find((s) => s.id === 'mfm-a1')?.projectId ===
          keptIds['mfm-a1'],
        'blocked: sessions.json keeps the projectId after quit',
      );
      log('store-blocked relaunch: ids kept, create refused, directory untouched');
      rmSync(file('projects.json'), { recursive: true });
      writeFileSync(file('projects.json'), goodProjects);
    },
  },
  {
    name: 'repos',
    async run() {
      const repoH = join(work, 'H');
      mkdirSync(repoH);
      git(repoH, 'init');
      const repoR = join(work, 'R');
      const repoG = join(work, 'G');
      const foo = join(repoG, 'packages', 'foo');
      mkdirSync(foo, { recursive: true });
      writeFileSync(join(repoG, 'x.txt'), 'one\n');
      writeFileSync(join(foo, 'keep.txt'), 'keep\n');
      git(repoG, 'init');
      git(repoG, 'add', '-A');
      git(repoG, 'commit', '-m', 'seed');
      writeFileSync(join(repoG, 'x.txt'), 'two\n');

      await withApp(async ({ page, state }) => {
        const post = (msg, types) => request(page, msg, types);
        const opened = await post(
          { type: 'openRepo', path: repoH, agentId: 'shell:cmd', requestId: 11 },
          ['openRepo:result'],
        );
        assert(typeof opened.sessionId === 'string', `openRepo H (got ${JSON.stringify(opened)})`);
        const sid = opened.sessionId;
        const added = await post(
          { type: 'session:addRoot', sessionId: sid, path: repoR, requestId: 12 },
          ['session:opResult'],
        );
        assert(added.ok === true, `addRoot R (got ${JSON.stringify(added)})`);
        const want = [
          { root: key(repoH), name: '.', folder: key(repoH), tag: 'home' },
          { root: key(repoR), name: '.', folder: key(repoR), tag: 'attached' },
        ];
        await waitState(
          page,
          ({ id, n }) => window.__mfmState.sessions.find((s) => s.id === id)?.repos?.length === n,
          { id: sid, n: want.length },
          'H session lists two repos',
        );
        const got = sessionIn(await state(), sid).repos.map(keyed);
        assert(
          JSON.stringify(got) === JSON.stringify(want),
          `home repo tagged home, attached R tagged attached (got ${JSON.stringify(got)})`,
        );
        log('repos: home + attached tagged');

        const inner = await post(
          { type: 'openRepo', path: foo, agentId: 'shell:cmd', requestId: 13 },
          ['openRepo:result'],
        );
        assert(typeof inner.sessionId === 'string', `openRepo foo (got ${JSON.stringify(inner)})`);
        await waitState(
          page,
          (id) => (window.__mfmState.sessions.find((s) => s.id === id)?.repos?.length ?? 0) > 0,
          inner.sessionId,
          'foo session lists its enclosing repo',
        );
        const s = sessionIn(await state(), inner.sessionId);
        const enclosing = [{ root: key(repoG), name: 'G', folder: key(foo), tag: 'home' }];
        assert(
          JSON.stringify(s.repos.map(keyed)) === JSON.stringify(enclosing),
          `enclosing G tagged home for folder foo (got ${JSON.stringify(s.repos)})`,
        );
        assert(
          key(s.activeRepoRoot ?? '') === key(repoG),
          `G is the active repo (got ${s.activeRepoRoot})`,
        );
        const project = await page.evaluate(
          ({ path, changesRoot }) =>
            new Promise((resolve, reject) => {
              const timer = setTimeout(() => reject(new Error('no project reply')), 15000);
              const off = window.agentDeck.subscribe((m) => {
                if (m.type !== 'project' || m.path !== path) return;
                clearTimeout(timer);
                off();
                resolve(m);
              });
              window.agentDeck.post({ type: 'requestProject', path, changesRoot });
            }),
          { path: s.home, changesRoot: s.activeRepoRoot },
        );
        assert(
          project.changes.some((c) => c.path === 'x.txt'),
          `home = subfolder of a repo still lists that repo's changes (got ${JSON.stringify(project.changes)})`,
        );
        log('repos: home inside G lists G tagged home and its x.txt change');
      });
    },
  },
  {
    name: 'watch',
    async run() {
      const home = join(work, 'W');
      const attached = join(work, 'WR');
      mkdirSync(home);
      mkdirSync(attached);

      await withApp(async ({ app, page }) => {
        // Host-side tap: the renderer's own `post` is bound before the page can wrap it.
        await app.evaluate(({ ipcMain }) => {
          globalThis.__mfmRequestProject = [];
          ipcMain.on('to-host', (_e, m) => {
            if (m?.type === 'requestProject') globalThis.__mfmRequestProject.push(m);
          });
        });
        const requests = () => app.evaluate(() => globalThis.__mfmRequestProject);
        await page.evaluate(() => {
          window.__mfmFs = [];
          window.agentDeck.subscribe((m) => {
            if (m.type === 'fsChanged') window.__mfmFs.push(m);
          });
        });

        const sid = await openSession(page, { path: home });
        const deadline = Date.now() + 15000;
        while (Date.now() < deadline) {
          if ((await requests()).some((m) => m.sessionId === sid)) break;
          await new Promise((r) => setTimeout(r, 100));
        }
        assert(
          (await requests()).some((m) => m.sessionId === sid && key(m.path) === key(home)),
          `watch: the renderer's requestProject carries the active sessionId (got ${JSON.stringify(await requests())})`,
        );

        const added = await request(
          page,
          { type: 'session:addRoot', sessionId: sid, path: attached, requestId: 21 },
          ['session:opResult'],
        );
        assert(added.ok === true, `watch: addRoot WR (got ${JSON.stringify(added)})`);

        await page.evaluate(() => {
          window.__mfmFs = [];
        });
        const writtenAt = Date.now();
        writeFileSync(join(attached, 'new.txt'), 'hi\n');
        const seen = await page
          .waitForFunction(
            (k) =>
              window.__mfmFs.some((m) =>
                m.folders.some(
                  (f) => f.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase() === k,
                ),
              ),
            key(attached),
            { timeout: 2000 },
          )
          .then(
            () => true,
            () => false,
          );
        assert(seen, 'watch: a write under the attached root reaches fsChanged within 2 s');
        log(`watch: attached-root write → fsChanged in ${Date.now() - writtenAt} ms`);
        await new Promise((r) => setTimeout(r, 1500));
        const fires = await page.evaluate(() => window.__mfmFs);
        assert(
          fires.filter((m) => m.folders.some((f) => key(f) === key(attached))).length === 1 &&
            fires.every((m) => m.folders.length > 0 && m.root === m.folders[0]),
          `watch: exactly one fsChanged {root, folders} for one write (got ${JSON.stringify(fires)})`,
        );

        await app.evaluate(() => {
          globalThis.__mfmRequestProject = [];
        });
        await page.evaluate(() => {
          window.__mfmFs = [];
        });
        writeFileSync(join(home, 'x.txt'), 'x\n');
        await page
          .waitForFunction(() => window.__mfmFs.length > 0, null, { timeout: 2000 })
          .catch(() => {});
        await new Promise((r) => setTimeout(r, 1500));
        const homeFires = await page.evaluate(() => window.__mfmFs);
        const posts = await requests();
        assert(
          homeFires.length === 1 && key(homeFires[0].root) === key(home),
          `watch: one fsChanged for a write under home (got ${JSON.stringify(homeFires)})`,
        );
        assert(
          posts.length === 1,
          `watch: one write under cwd = home → exactly one requestProject (got ${JSON.stringify(posts)})`,
        );
        log('watch: one write → one fsChanged → one requestProject');
      });
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
