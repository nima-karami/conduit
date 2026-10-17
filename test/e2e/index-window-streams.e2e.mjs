/**
 * The TS source index streams per window (search-scope review r3).
 *
 * SF-B: every window holds its own TS project, so each is streamed its own index from chunk 0,
 * which carries the tsconfig. With one shared "already sent" set and seq, a second window on the
 * same folder, and a reloaded renderer, were streamed chunks numbered past 0: no tsconfig, so
 * their compiler options stayed monaco's defaults. The tsconfig's `paths` entry is the marker.
 *
 * SF-A: a window that closes while its first build is parked (`__conduitHold` 'index') must
 * leave no index state behind once the build resumes; one left behind is re-synced on every repo
 * change, to nobody. A full build with seeds awaits again after that hold, reading the seeds'
 * import closure, so a window that closes during those reads ('closure') must leave none either
 * (search-scope review r4 SF-A).
 */

import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  answerQuitAsks,
  assert,
  closeApp,
  openSession,
  removeDir,
  runScenario,
  tapBridge,
} from './harness.mjs';

/** The session-open index waits 1.5 s, then streams. */
const BUDGET_MS = 30000;
/** How long a resumed build of a two-file folder is given to (wrongly) store its state. */
const SETTLE_MS = 3000;
const MARKER = '@sr3marker/*';

const slash = (p) => p.replace(/\\/g, '/');
const hold = (app, at) => app.evaluate((_, a) => global.__conduitHold.hold(a), at);
const release = (app, at) => app.evaluate((_, a) => global.__conduitHold.release(a), at);
const indexState = (app) => app.evaluate(() => global.__conduitHold.indexState());
const windowIds = (app) => app.evaluate((e) => e.BrowserWindow.getAllWindows().map((w) => w.id));

async function waitHeld(app, at, what) {
  const deadline = Date.now() + BUDGET_MS;
  while (Date.now() < deadline) {
    if ((await app.evaluate((_, a) => global.__conduitHold.heldCount(a), at)) > 0) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert(false, what);
}

/** The window's TS project holds `suffix` and its compiler options came from the tsconfig. */
async function waitIndexed(page, suffix, what) {
  try {
    await page.waitForFunction(
      ({ suffix, marker }) => {
        const ts = window.monaco?.languages.typescript.typescriptDefaults;
        if (!ts) return false;
        const libs = Object.keys(ts.getExtraLibs()).map((k) => k.replace(/\\/g, '/'));
        return libs.some((k) => k.endsWith(suffix)) && !!ts.getCompilerOptions().paths?.[marker];
      },
      { suffix, marker: MARKER },
      { timeout: BUDGET_MS },
    );
  } catch (e) {
    if (e?.name !== 'TimeoutError') throw e;
    const seen = await page.evaluate(() => {
      const ts = window.monaco?.languages.typescript.typescriptDefaults;
      return {
        libs: Object.keys(ts?.getExtraLibs() ?? {}).length,
        paths: ts?.getCompilerOptions().paths ?? null,
      };
    });
    assert(false, `${what} (saw ${JSON.stringify(seen)})`);
  }
}

async function openWindow(app, page) {
  const before = await windowIds(app);
  const next = app.waitForEvent('window', { timeout: BUDGET_MS });
  await page.evaluate(() => window.agentDeck.post({ type: 'win:new' }));
  const opened = await next;
  await opened.waitForLoadState('domcontentloaded');
  await opened.waitForFunction(() => !!window.agentDeck, null, { timeout: BUDGET_MS });
  const id = (await windowIds(app)).find((w) => !before.includes(w));
  assert(typeof id === 'number', 'the new window has an id');
  return { page: opened, id };
}

function makeFolder(parent, name) {
  const dir = join(parent, name);
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(
    join(dir, 'tsconfig.json'),
    JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { [MARKER]: ['src/*'] } } }),
  );
  writeFileSync(join(dir, 'src', 'a.ts'), 'export const a = 1;\n');
  writeFileSync(join(dir, 'src', 'b.ts'), "import { a } from './a';\nexport const b = a;\n");
  return dir;
}

/** Close a window and wait until it is gone. */
async function closeWindow(app, id, what) {
  await answerQuitAsks(app, { proceed: true });
  await app.evaluate((e, w) => e.BrowserWindow.fromId(w)?.close(), id);
  const closeBy = Date.now() + BUDGET_MS;
  while ((await windowIds(app)).includes(id)) {
    assert(Date.now() < closeBy, what);
    await new Promise((r) => setTimeout(r, 100));
  }
}

/** For SETTLE_MS, no index state is kept for `dir` or for the closed window `id`. */
async function assertNoStateFor(app, dir, id, what) {
  const key = slash(dir).toLowerCase();
  const settleBy = Date.now() + SETTLE_MS;
  while (Date.now() < settleBy) {
    const leaked = (await indexState(app)).filter(
      (s) => slash(s.root).toLowerCase() === key || s.windows.includes(id),
    );
    assert(leaked.length === 0, `${what}: ${JSON.stringify(leaked)}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

runScenario('index-window-streams', async ({ app, page, log }) => {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'conduit-index-window-streams-')));
  try {
    assert(await app.evaluate(() => !!global.__conduitHold), 'the smoke-only holds are installed');
    const ws = makeFolder(root, 'ws');
    const late = makeFolder(root, 'late');
    const seeded = makeFolder(root, 'seeded');

    // The launch's own session would be the one a reload activates; only ws's may be on screen.
    await tapBridge(page);
    await page.evaluate(() => {
      for (const s of window.__sessions || []) window.agentDeck.post({ type: 'kill', id: s.id });
    });
    await page.waitForFunction(() => (window.__sessions || []).length === 0, null, {
      timeout: BUDGET_MS,
    });

    await openSession(page, { path: slash(ws) });
    await waitIndexed(page, '/ws/src/a.ts', 'window 1 indexes ws with its tsconfig');
    log('window 1: a.ts in, tsconfig applied');

    const second = await openWindow(app, page);
    await openSession(second.page, { path: slash(ws) });
    await waitIndexed(
      second.page,
      '/ws/src/a.ts',
      'a second window on the same folder gets its own chunk 0, with the tsconfig',
    );
    log('window 2: a.ts in, tsconfig applied ✓');

    await page.reload();
    await page.waitForFunction(() => !!window.agentDeck, null, { timeout: BUDGET_MS });
    await waitIndexed(
      page,
      '/ws/src/a.ts',
      'a reloaded renderer is streamed the index again from chunk 0, with the tsconfig',
    );
    log('window 1 reloaded: a.ts in, tsconfig applied ✓');

    // SF-A: a third window opens a folder nothing indexes yet, and closes while that build is
    // parked between its listing and its state.
    await hold(app, 'index');
    const third = await openWindow(app, page);
    await openSession(third.page, { path: slash(late) });
    await waitHeld(app, 'index', "the third window's first index build never reached its hold");
    await closeWindow(app, third.id, 'the third window closes');
    await release(app, 'index');
    log('third window closed while its build was parked; build released');
    await assertNoStateFor(
      app,
      late,
      third.id,
      "a closed window's resumed build stored index state",
    );
    log('no state left for the third window ✓');

    // r4 SF-A: a fourth window's full build with a seed parks while reading the seed's import
    // closure, after the 'index' hold and its liveness check, and the window closes there. The
    // request is the one opening a file in a not-yet-indexed root sends; it is posted directly
    // because the session-open index's own 1.5 s timer would race a real file open to it.
    const fourth = await openWindow(app, page);
    await openSession(fourth.page, { path: slash(seeded) });
    await waitIndexed(fourth.page, '/seeded/src/a.ts', 'window 4 indexes the seeded folder');
    await hold(app, 'closure');
    await fourth.page.evaluate(
      ({ root, seed }) => window.agentDeck.post({ type: 'indexProject', root, seeds: [seed] }),
      { root: slash(seeded), seed: slash(join(seeded, 'src', 'b.ts')) },
    );
    await waitHeld(app, 'closure', "the fourth window's seeded build never read its closure");
    await closeWindow(app, fourth.id, 'the fourth window closes');
    await release(app, 'closure');
    log('fourth window closed while its build read the seed closure; build released');
    await assertNoStateFor(
      app,
      seeded,
      fourth.id,
      "a closed window's build resumed from its closure reads stored index state",
    );
    log('no state left for the fourth window ✓');

    const wsState = (await indexState(app)).find(
      (s) => slash(s.root).toLowerCase() === slash(ws).toLowerCase(),
    );
    assert(
      wsState?.windows.length === 2,
      `ws is still streamed to both live windows (saw ${JSON.stringify(wsState)})`,
    );
    log('no state left for the closed window; ws still streams to windows 1 and 2 ✓');
  } finally {
    await release(app, 'index');
    await release(app, 'closure');
    await closeApp(app, page);
    await removeDir(root);
  }
});
