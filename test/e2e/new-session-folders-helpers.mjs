/**
 * Shared fixture, driver and page helpers for the new-session-folders scenarios (mf-new-session
 * spec §7). Each scenario gets a fresh fixture: userData seeded with repos.json, and PATH holding a
 * stub dir with `claude.cmd` / `codex.cmd`, System32, and git's directory (the probe's branch
 * comes from real git). The stubs echo their argv, so the terminal shows exactly what
 * `term:start` spawned.
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  assert,
  closeApp,
  finishScenario,
  launchApp,
  makeLog,
  profileDir,
  shutdownApp,
  tapBridge,
} from './harness.mjs';

export const CARD = { id: 'c-rmb', title: 'Move RMB to CI' };

function makeFixture() {
  const root = mkdtempSync(join(tmpdir(), 'mfns-e2e-'));
  const stubDir = join(root, 'bin');
  mkdirSync(stubDir);
  // STUB-RUN names the app launch that spawned the stub: a relaunched session replays the
  // previous launch's output as scrollback, so its STUB-ARGS alone prove nothing (QA F2).
  for (const name of ['claude', 'codex']) {
    writeFileSync(
      join(stubDir, `${name}.cmd`),
      '@echo off\r\necho STUB-RUN:%STUB_RUN%\r\necho STUB-ARGS:%*\r\nping -n 60 127.0.0.1 >nul\r\n',
    );
  }
  const A = join(root, 'room-message-bus');
  const B = join(root, 'bitbucket-ci-image');
  const C = join(root, 'x&y');
  for (const d of [A, B, C]) mkdirSync(d);
  const git = (cwd, ...args) =>
    execFileSync('git', ['-c', 'user.name=e2e', '-c', 'user.email=e2e@x', ...args], { cwd });
  git(A, 'init', '-q', '-b', 'main');
  git(A, 'commit', '-q', '--allow-empty', '-m', 'init');
  mkdirSync(join(A, '.conduit'));
  writeFileSync(
    join(A, '.conduit', 'board.json'),
    JSON.stringify({
      conduit: 1,
      kind: 'board',
      updatedAt: Date.now(),
      data: {
        version: 1,
        cards: [{ ...CARD, notes: '', stage: 'wishlist', createdAt: 1, updatedAt: 1 }],
      },
    }),
  );

  // Recents long enough that a list-bound Browse… would have to be scrolled to (the retired
  // browse-pinned scenario's subject). The host prunes recents whose folder is gone, so each is real.
  const recents = Array.from({ length: 14 }, (_, i) => {
    const path = join(root, `recent-${i}`);
    mkdirSync(path);
    return { path, name: `recent-${i}`, lastOpened: 100 - i };
  });
  const userDataDir = profileDir();
  writeFileSync(join(userDataDir, 'repos.json'), JSON.stringify({ version: 1, repos: recents }));

  const gitDir = dirname(
    execFileSync('where', ['git'], { encoding: 'utf8' }).split(/\r?\n/).find(Boolean) ?? '',
  );
  const sys32 = join(process.env.SystemRoot || 'C:\\Windows', 'System32');
  const PATH = [stubDir, sys32, gitDir].join(';');
  // Windows env keys are case-insensitive but a spread keeps `Path`; set both to one value.
  const env = { PATH, Path: PATH };
  return {
    root,
    stubDir,
    A,
    B,
    C,
    recents,
    userDataDir,
    envForRun: (run) => ({ ...env, STUB_RUN: run }),
  };
}

/**
 * Standalone launch (not `runScenario`) because the scenarios seed userData and PATH, and some
 * relaunch against the same profile. `launch(run)` starts the app with `STUB_RUN=run`; `close()`
 * closes it cleanly mid-scenario.
 */
export async function runNewSession(name, fn) {
  const log = makeLog(name);
  if (process.platform !== 'win32') {
    console.log(`[${name}] SKIP — suite is Windows-only`);
    await finishScenario(0);
  }
  const fx = makeFixture();
  let launched = null;
  let code = 0;
  const launch = async (run) => {
    launched = await launchApp({ userDataDir: fx.userDataDir, env: fx.envForRun(run) });
    return launched;
  };
  const close = async () => {
    await closeApp(launched.app, launched.page);
    launched = null;
  };
  try {
    await fn({ fx, log, launch, close });
    log('PASS ✓');
  } catch (e) {
    if (e?.name === 'AssertionError') {
      log('FAIL ✗', e.message);
      code = 1;
    } else {
      console.error(`[${name}] ERROR:`, e?.message || e);
      if (e?.stack) console.error(e.stack);
      code = 2;
    }
  }

  try {
    await shutdownApp(launched?.app, launched?.page);
  } catch {
    /* already gone */
  }
  for (const dir of [fx.root, fx.userDataDir]) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch (e) {
      log('could not remove', dir, e?.code ?? e);
    }
  }
  await finishScenario(code);
}

export const q = (page, sel) => page.locator(sel);
export const pills = (page) =>
  page.$$eval('.ns-launch .ns-pill', (els) => els.map((e) => e.textContent));
export const folderNames = (page) =>
  page.$$eval('.ns-folder .ns-folder__name', (els) => els.map((e) => e.textContent));

export async function openDialog(page) {
  await page.locator('[aria-label="New session"]').first().click();
  await page.waitForSelector('.modal.ns', { state: 'visible', timeout: 10000 });
  // A menu opened while modal-pop still animates can close itself (learnings, mf-changes fix1).
  await page.waitForFunction(
    () => (document.querySelector('.modal.ns')?.getAnimations({ subtree: true }).length ?? 1) === 0,
    null,
    { timeout: 5000 },
  );
}

export async function closeDialog(page) {
  await page.locator('.ns__foot .btn', { hasText: 'Cancel' }).click();
  await page.waitForSelector('.modal.ns', { state: 'detached', timeout: 5000 });
}

export async function clearFolders(page) {
  for (let n = await q(page, '.ns-folder').count(); n > 0; n--) {
    await page.locator('.ns-folder').last().locator('.ns-folder__remove').click();
    await page.waitForFunction((k) => document.querySelectorAll('.ns-folder').length === k - 1, n);
  }
}

export async function browseAdd(app, page, paths) {
  await app.evaluate((_e, p) => global.__pickDirHook.queue(p), paths);
  for (const _ of paths) {
    const before = await q(page, '.ns-folder').count();
    await page.locator('.ns-folders__add').click();
    await page.locator('.ns-addmenu__browse').click();
    await page.waitForFunction(
      (k) => document.querySelectorAll('.ns-folder').length === k + 1,
      before,
      { timeout: 8000 },
    );
  }
}

export async function pick(page, label) {
  await page.locator('.ns-launch .ns-pill', { hasText: new RegExp(`^${label}$`) }).click();
}

export async function waitPreview(page, expected) {
  await page
    .waitForFunction(
      (want) => {
        const el = document.querySelector('.ns-preview:not(.ns-preview--busy)');
        return el?.textContent === want;
      },
      expected,
      { timeout: 10000 },
    )
    .catch(async () => {
      const got = await page.locator('.ns-preview').textContent();
      assert(
        false,
        `"Launches as" should read ${JSON.stringify(expected)}, got ${JSON.stringify(got)}`,
      );
    });
}

/** Every renderer→host message type the main process received, in order. */
export async function spyHostMessages(app) {
  await app.evaluate(({ ipcMain }) => {
    global.__hostMsgs = [];
    ipcMain.on('to-host', (_e, m) => global.__hostMsgs.push(m?.type));
  });
}
export const hostMsgs = (app) => app.evaluate(() => global.__hostMsgs);

/** The next `state`'s agent ids (a `ready` forces one). */
export const stateAgents = (page) =>
  page.evaluate(
    () =>
      new Promise((resolve) => {
        const off = window.agentDeck.subscribe((m) => {
          if (m.type === 'state') {
            off();
            resolve(m.agents.map((a) => a.id));
          }
        });
        window.agentDeck.post({ type: 'ready' });
      }),
  );

export async function tapResults(page) {
  await page.evaluate(() => {
    window.__results = [];
    window.agentDeck.subscribe((m) => {
      if (m.type === 'openRepo:result' || m.type === 'project:created') window.__results.push(m);
    });
  });
}

export async function openRepoViaHost(page, path, agentId) {
  return page.evaluate(
    ({ p, a }) =>
      new Promise((resolve) => {
        const requestId = 900000 + Math.floor(Math.random() * 99999);
        const off = window.agentDeck.subscribe((m) => {
          if (m.type === 'openRepo:result' && m.requestId === requestId) {
            off();
            resolve(m);
          }
        });
        window.agentDeck.post({ type: 'openRepo', path: p, agentId: a, requestId });
      }),
    { p: path, a: agentId },
  );
}

/** A fresh launch with the bridge, `openRepo:result`/`project:created` and host-message taps. */
export async function launchTapped(launch) {
  const { app, page } = await launch('first');
  await tapBridge(page);
  await tapResults(page);
  await spyHostMessages(app);
  return { app, page };
}

export function createProject(page) {
  return page.evaluate(
    () =>
      new Promise((resolve) => {
        const off = window.agentDeck.subscribe((m) => {
          if (m.type === 'project:created' && m.requestId === 4242) {
            off();
            resolve(m.id);
          }
        });
        window.agentDeck.post({ type: 'project:create', name: 'RMB pipeline', requestId: 4242 });
      }),
  );
}

const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);
const CSI = new RegExp(`${ESC}\\[[0-9;?]*[ -/]*[@-~]`, 'g');
const OSC = new RegExp(`${ESC}\\][^${BEL}]*${BEL}`, 'g');
const stripAnsi = (s) => s.replace(CSI, '').replace(OSC, '');

/** The STUB-ARGS line printed by a stub spawned in app launch `run`, never an earlier launch's. */
export async function waitStubArgs(page, sid, run) {
  const h = await page
    .waitForFunction(
      ({ id, marker }) => {
        const raw = window.__capBy?.[id] ?? '';
        const at = raw.indexOf(marker);
        return at >= 0 && raw.indexOf('STUB-ARGS:', at) >= 0 ? raw.slice(at) : null;
      },
      { id: sid, marker: `STUB-RUN:${run}` },
      { timeout: 30000 },
    )
    .catch(() => null);
  if (!h) {
    const got = stripAnsi(await page.evaluate((id) => window.__capBy?.[id] ?? '', sid));
    assert(
      false,
      `session ${sid}'s terminal never printed STUB-ARGS in launch ${run} (the stub did not run); it shows ${JSON.stringify(got.slice(-300))}`,
    );
  }
  const text = stripAnsi(await h.jsonValue()).replace(/\r?\n/g, '');
  return text.slice(text.indexOf('STUB-ARGS:'));
}

/**
 * Replays the start scenario's first two steps without their assertions: a claude session with
 * home A and root B started from the dialog in the "RMB pipeline" project, then Make home on B
 * and Cancel. Later steps' launcher ranking and dialog seeding depend on that history.
 */
export async function replayProjectSession(app, page, { A, B }) {
  await createProject(page);
  await openDialog(page);
  await page.locator('.ns-folders__add').click();
  await page.waitForSelector('.ns-addmenu', { state: 'visible' });
  await page.keyboard.press('Escape');
  await page.waitForSelector('.ns-addmenu', { state: 'detached' });
  await clearFolders(page);
  await browseAdd(app, page, [A, B]);
  await page.waitForFunction(
    () => document.querySelector('.ns-folder--home .ns-folder__branch')?.textContent === ' · main',
    null,
    { timeout: 10000 },
  );
  await pick(page, 'claude');
  await waitPreview(page, `${A}> claude --add-dir ${B}`);
  await page.locator('.ns-chip--none').click();
  await page.locator('.ns-projects [role="menuitemradio"]', { hasText: 'RMB pipeline' }).click();
  await page.locator('.ns__foot .btn--primary').click();
  await page.waitForSelector('.modal.ns', { state: 'detached', timeout: 10000 });
  const s1 = await page
    .waitForFunction(
      () => window.__results.find((m) => m.type === 'openRepo:result')?.sessionId ?? null,
    )
    .then((h) => h.jsonValue());
  await page.waitForFunction((id) => window.__sessions.find((s) => s.id === id) ?? null, s1);

  await openDialog(page);
  await page.locator('button[aria-label="Make bitbucket-ci-image home"]').click();
  await page.waitForFunction(
    (b) =>
      document.querySelector('.ns-preview:not(.ns-preview--busy) .ns-preview__cwd')?.textContent ===
      `${b}>`,
    B,
    { timeout: 10000 },
  );
  await closeDialog(page);
}
