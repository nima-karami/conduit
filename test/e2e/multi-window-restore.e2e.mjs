/**
 * Multi-window Slice C (part 2) — LAYOUT PERSISTENCE across restart, real-runtime.
 *
 * Two launches sharing ONE userData dir prove the locked Slice C restore (overrides Slice A
 * D-4 "restore collapses to one window"):
 *   Launch 1: a session A in the primary window; win:new → window-2 (resized so a bounds
 *     round-trip is observable); a session B in window-2. Then QUIT (app.close) so
 *     before-quit persists windows.json with the final layout.
 *   Launch 2 (same userData): assert TWO windows restored — window-1 owns A (stale),
 *     window-2 owns B (stale), NOT collapsed into one window; window-2's bounds ≈ saved.
 *
 * The no-layout fallback (first launch with no windows.json → single window) is implicitly
 * covered by launch 1 starting clean.
 *
 * Windows only. KNOWN flake: Playwright app.close() teardown may time out — fine IF the
 * assertions printed PASS first. Evidence under .autoloop/evidence/.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assert, loadPlaywright, makeLog, REPO } from './harness.mjs';

const log = makeLog('multi-window-restore');
const require = createRequire(import.meta.url);

if (process.platform !== 'win32') {
  console.log('[multi-window-restore] SKIP — suite is Windows-only');
  process.exit(0);
}

const here = dirname(fileURLToPath(import.meta.url));
const EVIDENCE = join(here, '..', '..', '.autoloop', 'evidence');
mkdirSync(EVIDENCE, { recursive: true });
const shot = (page, name) =>
  page.screenshot({ path: join(EVIDENCE, name) }).catch(() => {
    /* hidden window screenshot is best-effort */
  });

const { _electron } = loadPlaywright();
const electronPath = require('electron');

/** Launch the real app against an explicit (shared) userData dir. */
async function launch(userDataDir) {
  const app = await _electron.launch({
    executablePath: electronPath,
    args: [`--user-data-dir=${userDataDir}`, REPO],
    cwd: REPO,
  });
  const page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  await page.waitForFunction(() => !!window.agentDeck, null, { timeout: 20000 });
  return { app, page };
}

/** Tap a window's bridge: latest owned-session list + own windowId. Idempotent. */
async function tap(page) {
  await page.evaluate(() => {
    if (window.__mwrTapped) return;
    window.__mwrTapped = true;
    window.__sessions = [];
    window.__winId = null;
    window.agentDeck.subscribe((m) => {
      if (m.type === 'state') {
        window.__sessions = m.sessions || [];
        if (typeof m.windowId === 'number') window.__winId = m.windowId;
      }
    });
    window.agentDeck.post({ type: 'ready' });
  });
}

const sessionsOf = (page) =>
  page.evaluate(() => (window.__sessions || []).map((s) => ({ id: s.id, status: s.status })));

/** Open a session in THIS window; resolve its new session id. */
async function openSessionIn(page, { path, agentId = 'shell:cmd' }) {
  await tap(page);
  const before = await page.evaluate(() => (window.__sessions || []).map((s) => s.id));
  await page.evaluate(
    ({ p, a }) => window.agentDeck.post({ type: 'openRepo', path: p, agentId: a }),
    { p: path.replace(/\\/g, '/'), a: agentId },
  );
  await page.waitForSelector('.termpane', { state: 'attached', timeout: 25000 });
  return page
    .waitForFunction(
      (ids) => {
        const cur = (window.__sessions || []).map((s) => s.id);
        return cur.find((id) => !ids.includes(id)) || null;
      },
      before,
      { timeout: 20000 },
    )
    .then((h) => h.jsonValue());
}

/**
 * Force-kill Electron processes whose command line references THIS run's userData dir — the
 * launch-1 children that app.close() failed to reap. Scoped to userDataDir so it never touches
 * an unrelated Electron app. Best-effort (PowerShell/CIM on Windows only).
 */
function killStrayElectrons() {
  try {
    spawnSync(
      'powershell',
      [
        '-NoProfile',
        '-Command',
        `Get-CimInstance Win32_Process -Filter "Name='electron.exe'" | Where-Object { $_.CommandLine -like '*${userDataDir.replace(/'/g, "''")}*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`,
      ],
      { stdio: 'ignore', timeout: 15000 },
    );
  } catch {
    /* best-effort */
  }
}

const userDataDir = mkdtempSync(join(tmpdir(), 'conduit-mwr-'));
log('shared userData =', userDataDir);

let app1 = null;
let app2 = null;
const WIN2_BOUNDS = { x: 1100, y: 80, width: 1000, height: 640 };

try {
  // ════════════════════════════════════════════════════════════════════════════
  // LAUNCH 1 — build a 2-window layout, then QUIT to persist it.
  // ════════════════════════════════════════════════════════════════════════════
  {
    const { app, page: page1 } = await launch(userDataDir);
    app1 = app;
    await tap(page1);

    // A fresh launch auto-opens a session from the REPO launch arg; clear it so the layout we
    // assert over contains exactly A and B.
    await page1.evaluate(() => {
      for (const s of window.__sessions || []) window.agentDeck.post({ type: 'kill', id: s.id });
    });
    await page1
      .waitForFunction(() => (window.__sessions || []).length === 0, null, { timeout: 10000 })
      .catch(() => {});

    const sidA = await openSessionIn(page1, { path: REPO });
    log('launch1: window-1 session A =', sidA);
    assert(sidA, 'Expected a session id for A in window 1');

    // win:new → window-2.
    const win2Promise = app.waitForEvent('window', { timeout: 20000 });
    const idsBefore = await app.evaluate((e) => e.BrowserWindow.getAllWindows().map((w) => w.id));
    await page1.evaluate(() => window.agentDeck.post({ type: 'win:new' }));
    const page2 = await win2Promise;
    await page2.waitForLoadState('domcontentloaded');
    await page2.waitForFunction(() => !!window.agentDeck, null, { timeout: 20000 });
    await tap(page2);
    const win2Id = await app.evaluate(
      (e, before) =>
        e.BrowserWindow.getAllWindows()
          .map((w) => w.id)
          .find((id) => !before.includes(id)),
      idsBefore,
    );
    assert(typeof win2Id === 'number', 'Could not resolve window 2 id');
    log('launch1: window-2 id =', win2Id);

    // Resize window-2 so a bounds round-trip is observable on restore.
    await app.evaluate((e, { id, b }) => e.BrowserWindow.fromId(id)?.setBounds(b), {
      id: win2Id,
      b: WIN2_BOUNDS,
    });
    await page2.waitForTimeout(300);

    const sidB = await openSessionIn(page2, { path: REPO });
    log('launch1: window-2 session B =', sidB);
    assert(sidB && sidB !== sidA, 'Expected a distinct session id for B in window 2');

    // Record the project paths for the post-restore identity check (session ids regenerate?
    // No — restore keeps ids; but assert by id below). Give the persistence debounce + the
    // before-quit snapshot time by quitting cleanly.
    await page2.waitForTimeout(800);

    // Persist the saved ids to disk via a clean QUIT (before-quit writes windows.json).
    global.__mwr_sidA = sidA;
    global.__mwr_sidB = sidB;

    await shot(page1, 'multiwin-c-persist-launch1-w1.png');
    await shot(page2, 'multiwin-c-persist-launch1-w2.png');

    // Quit the whole app so before-quit runs (persistLayout + serializeSessions). Driving
    // app.quit() from the main process is the reliable trigger; app.close() can hang on
    // teardown (the documented flake). Proof the quit ran = windows.json on disk; we then
    // bound app.close() and force-kill any orphaned Electron child before relaunch (the two
    // launches MUST NOT overlap — they share one userData dir + the single-instance lock).
    await app.evaluate((e) => e.app.quit()).catch(() => {});
    const layoutFile = join(userDataDir, 'windows.json');
    const persistDeadline = Date.now() + 15000;
    while (!existsSync(layoutFile) && Date.now() < persistDeadline) {
      await new Promise((r) => setTimeout(r, 250));
    }
    assert(existsSync(layoutFile), 'launch1: before-quit must persist windows.json');
    log('launch1: windows.json persisted by before-quit ✓');
    await Promise.race([app.close().catch(() => {}), new Promise((r) => setTimeout(r, 6000))]);
    app1 = null;
    log('launch1: app quit (layout + sessions persisted)');
  }

  // Force-kill any Electron child the launch-1 app left behind (app.close() teardown flake),
  // else its single-instance lock makes launch 2 quit immediately. Best-effort; matches only
  // electrons launched from THIS repo's node_modules so it can't hit an unrelated app.
  killStrayElectrons();
  // Settle so file handles + the prior Electron process fully release before relaunch.
  await new Promise((r) => setTimeout(r, 3000));

  // ════════════════════════════════════════════════════════════════════════════
  // LAUNCH 2 — same userData: assert the 2-window layout restored (not collapsed).
  // ════════════════════════════════════════════════════════════════════════════
  const sidA = global.__mwr_sidA;
  const sidB = global.__mwr_sidB;
  {
    const { app, page: pageFirst } = await launch(userDataDir);
    app2 = app;

    // Wait until both windows exist (the restore spawns them at launch).
    let winCount = 0;
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      winCount = await app.evaluate((e) => e.BrowserWindow.getAllWindows().length).catch(() => 0);
      if (winCount >= 2) break;
      await new Promise((r) => setTimeout(r, 250));
    }
    assert(
      winCount === 2,
      `RESTORE: expected TWO windows restored (not collapsed), got ${winCount}`,
    );
    log('launch2: restored window count =', winCount, '✓');

    // Tap every restored page and read each window's owned sessions + its own id.
    const pages = app.windows();
    for (const p of pages) {
      await p.waitForLoadState('domcontentloaded').catch(() => {});
      await p.waitForFunction(() => !!window.agentDeck, null, { timeout: 20000 }).catch(() => {});
      await tap(p);
    }
    // Re-send ready so each window's filtered state arrives post-subscribe.
    for (const p of pages) await p.evaluate(() => window.agentDeck.post({ type: 'ready' }));
    await pageFirst.waitForTimeout(700);

    // Find which restored page owns A and which owns B.
    let pageA = null;
    let pageB = null;
    for (const p of pages) {
      const owned = await sessionsOf(p);
      const ids = owned.map((s) => s.id);
      if (ids.includes(sidA)) pageA = { page: p, owned };
      if (ids.includes(sidB)) pageB = { page: p, owned };
    }
    assert(pageA, `RESTORE: no restored window owns session A (${sidA})`);
    assert(pageB, `RESTORE: no restored window owns session B (${sidB})`);
    assert(
      pageA.page !== pageB.page,
      'RESTORE: A and B must be in SEPARATE windows (not collapsed)',
    );

    // Each window owns ONLY its own session (isolation preserved across restore).
    assert(!pageA.owned.some((s) => s.id === sidB), 'RESTORE: window owning A must NOT also own B');
    assert(!pageB.owned.some((s) => s.id === sidA), 'RESTORE: window owning B must NOT also own A');

    // Sessions come back STALE (this feature only adds placement on top of session restore).
    const aRec = pageA.owned.find((s) => s.id === sidA);
    const bRec = pageB.owned.find((s) => s.id === sidB);
    assert(aRec?.status === 'stale', `RESTORE: A should restore as stale, got ${aRec?.status}`);
    assert(bRec?.status === 'stale', `RESTORE: B should restore as stale, got ${bRec?.status}`);
    log('launch2: A in one window (stale), B in the other (stale), isolated ✓');

    // Bounds round-trip: the window owning B should be ≈ the resized WIN2_BOUNDS.
    const win2Id = await pageB.page.evaluate(() => window.__winId);
    const restoredBounds = await app.evaluate(
      (e, id) => e.BrowserWindow.fromId(id)?.getBounds(),
      win2Id,
    );
    log(
      'launch2: window-B bounds =',
      JSON.stringify(restoredBounds),
      'saved =',
      JSON.stringify(WIN2_BOUNDS),
    );
    // DPI scaling / min-size clamping can shift bounds a little; assert "close enough".
    const near = (a, b, tol) => Math.abs(a - b) <= tol;
    assert(
      restoredBounds &&
        near(restoredBounds.x, WIN2_BOUNDS.x, 40) &&
        near(restoredBounds.y, WIN2_BOUNDS.y, 40) &&
        near(restoredBounds.width, WIN2_BOUNDS.width, 60) &&
        near(restoredBounds.height, WIN2_BOUNDS.height, 60),
      `RESTORE: window-B bounds should ≈ the saved bounds`,
    );
    log('launch2: window-B bounds round-tripped ✓');

    await shot(pageA.page, 'multiwin-c-persist-launch2-wA.png');
    await shot(pageB.page, 'multiwin-c-persist-launch2-wB.png');

    log('PASS ✓ multi-window Slice C: layout persisted + restored across restart (2 windows)');
    // Bound the launch-2 close like launch 1: app.close() can hang on teardown (known flake);
    // assertions have all passed, so don't let the teardown turn a PASS into a TIMEOUT exit.
    await Promise.race([app.close().catch(() => {}), new Promise((r) => setTimeout(r, 6000))]);
    app2 = null;
  }

  killStrayElectrons();
  process.exit(0);
} catch (e) {
  const isAssertion = e?.name === 'AssertionError';
  if (isAssertion) log('FAIL ✗', e.message);
  else console.error('[multi-window-restore] ERROR:', e?.message || e);
  process.exit(isAssertion ? 1 : 2);
} finally {
  for (const a of [app1, app2]) {
    try {
      await a?.close();
    } catch {
      /* teardown flake acceptable if assertions already passed */
    }
  }
}
