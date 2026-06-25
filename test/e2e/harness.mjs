/**
 * Shared harness for Conduit real-app Playwright-Electron smoke tests.
 *
 * Extracted from paste.e2e.mjs. All scenarios import from here; they never
 * inline launch/bridge/assertion boilerplate.
 *
 * Conventions:
 *   exit 0 — pass (or SKIP on non-win32)
 *   exit 1 — test assertion failed
 *   exit 2 — harness/infra error (exception before assertions ran)
 */

import { existsSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));
export const REPO = join(here, '..', '..');
const require = createRequire(import.meta.url);

// ──────────────────────────────────────────────────────────────────────────────
// Logging
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Prefix-tagged log. Pass a tag (the scenario name) when constructing helpers;
 * bare `log` is available for quick use.
 */
export function makeLog(tag) {
  return (...a) => console.log(`[${tag}]`, ...a);
}
export const log = makeLog('harness');

// ──────────────────────────────────────────────────────────────────────────────
// Playwright resolution (path-based, never bare require('playwright'))
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Resolve Playwright from the npx cache or node_modules. Never uses a bare
 * specifier — Playwright is intentionally absent from package.json so dead-code
 * gates (Fallow) don't flag it as an unlisted dependency.
 */
export function loadPlaywright() {
  const candidates = [join(REPO, 'node_modules', 'playwright', 'index.js')];
  for (const root of [
    join(process.env.LOCALAPPDATA || '', 'npm-cache', '_npx'),
    join(homedir(), '.npm', '_npx'),
  ].filter(Boolean)) {
    try {
      for (const d of readdirSync(root)) {
        candidates.push(join(root, d, 'node_modules', 'playwright', 'index.js'));
      }
    } catch {
      /* cache dir absent */
    }
  }
  for (const p of candidates) if (existsSync(p)) return require(p);
  throw new Error('Playwright not found — run `npx playwright` once to populate the npx cache.');
}

// ──────────────────────────────────────────────────────────────────────────────
// App launch / cleanup
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Launch the real Conduit app in a throwaway user-data dir.
 *
 * @param {{ extraArgs?: string[] }} [opts]
 * @returns {{ app, page, userDataDir: string, cleanup: () => Promise<void> }}
 */
export async function launchApp({ extraArgs = [] } = {}) {
  const { _electron } = loadPlaywright();
  const electronPath = require('electron');
  const userDataDir = mkdtempSync(join(tmpdir(), 'conduit-ud-'));
  const app = await _electron.launch({
    executablePath: electronPath,
    args: [`--user-data-dir=${userDataDir}`, REPO, ...extraArgs],
    cwd: REPO,
  });
  const page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  await page.waitForFunction(() => !!window.agentDeck, null, { timeout: 20000 });

  const cleanup = async () => {
    try {
      await app.close();
    } catch {
      /* already closed */
    }
    // Temp dir is in os.tmpdir() — cleaned by OS; no manual cleanup needed
  };

  return { app, page, userDataDir, cleanup };
}

// ──────────────────────────────────────────────────────────────────────────────
// Bridge helpers
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Install `window.__cap` (accumulated term:data) and `window.__sessions`
 * (latest state.sessions) captures via agentDeck.subscribe. Idempotent.
 */
export async function tapBridge(page) {
  await page.evaluate(() => {
    if (window.__harnessTapped) return;
    window.__harnessTapped = true;
    window.__cap = '';
    window.__sessions = [];
    window.agentDeck.subscribe((m) => {
      if (m.type === 'term:data') window.__cap += m.data;
      if (m.type === 'state') window.__sessions = m.sessions || [];
    });
    // Re-send 'ready' so the host broadcasts a fresh postState() even if the
    // initial state message was delivered before we subscribed (e.g. on the
    // second launch in durability where sessions are already restored).
    window.agentDeck.post({ type: 'ready' });
  });
}

/**
 * Drive `openRepo` (no native folder dialog), wait for `.termpane` and for the
 * new session to appear in `window.__sessions`.
 *
 * @param {object} page
 * @param {{ path: string, agentId?: string }} opts
 * @returns {Promise<string>} The new session id.
 */
export async function openSession(page, { path, agentId = 'shell:cmd' }) {
  await tapBridge(page);
  const before = await page.evaluate(() => (window.__sessions || []).map((s) => s.id));
  await page.evaluate(
    ({ p, a }) => window.agentDeck.post({ type: 'openRepo', path: p, agentId: a }),
    { p: path.replace(/\\/g, '/'), a: agentId },
  );
  await page.waitForSelector('.termpane', { state: 'attached', timeout: 25000 });
  const sid = await page
    .waitForFunction(
      (ids) => {
        const cur = (window.__sessions || []).map((s) => s.id);
        return cur.find((id) => !ids.includes(id)) || null;
      },
      before,
      { timeout: 20000 },
    )
    .then((h) => h.jsonValue());
  return sid;
}

/**
 * Gracefully close the app, answering the quit-guard confirm dialog if it appears.
 *
 * Closing a window that owns RUNNING sessions makes the host send `confirmQuit` and wait for a
 * `quitDecision` (the in-app `[role="alertdialog"]`, NOT a native dialog) — so a bare
 * `app.close()` hangs forever. This triggers the close, replies `proceed: true` when the host
 * asks, and waits for the windows to actually go away. Resolves once the app has exited.
 *
 * @param {object} app  Playwright Electron app handle.
 * @param {object} page Its first window's page (already bridge-tapped).
 */
export async function closeApp(app, page) {
  await page.evaluate(() => {
    window.__quitAsked = false;
    window.agentDeck.subscribe((m) => {
      if (m.type === 'confirmQuit') window.__quitAsked = true;
    });
  });
  await app.evaluate((electron) => {
    const w = electron.BrowserWindow.getAllWindows()[0];
    if (w) w.close();
  });
  // If the guard asked, answer proceed. (No ask → no running sessions → it just closes.)
  const asked = await page
    .waitForFunction(() => window.__quitAsked === true, null, { timeout: 4000 })
    .then(() => true)
    .catch(() => false);
  if (asked) {
    await page
      .evaluate(() => window.agentDeck.post({ type: 'quitDecision', proceed: true }))
      .catch(() => {});
  }
  // Wait for the app to actually exit (windows gone). Poll with plain setTimeout — the page
  // closes mid-wait, so page.waitForTimeout would throw.
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    const n = await app
      .evaluate((electron) => electron.BrowserWindow.getAllWindows().length)
      .catch(() => 0);
    if (n === 0) return;
    await new Promise((r) => setTimeout(r, 150));
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// Main-process spy (app.evaluate)
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Wrap named Electron APIs in the main process so every call is recorded into a
 * buffer (`global.__spyCalls`). Call `getSpyCalls(app)` to read them back.
 *
 * `apiSpecs` is an array of objects:
 *   { api: 'Notification' | 'flashFrame' | 'setOverlayIcon' | 'setBadgeCount' | 'openPath' | 'showItemInFolder' }
 *
 * Idempotent (re-wrapping is a no-op if already patched).
 *
 * @param {object} app
 * @param {Array<{ api: string }>} apiSpecs
 */
export async function spyMain(app, apiSpecs) {
  await app.evaluate(
    (electron, { apiSpecs: specs }) => {
      if (!global.__spyCalls) global.__spyCalls = [];
      const record = (api, args) => global.__spyCalls.push({ api, args, ts: Date.now() });

      const { BrowserWindow, Notification, shell, app: electronApp } = electron;

      for (const { api } of specs) {
        if (api === 'Notification') {
          if (global.__spyNotificationPatched) continue;
          global.__spyNotificationPatched = true;
          const OrigNotif = Notification;
          // Wrap the constructor so `new Notification(opts)` is recorded.
          // eslint-disable-next-line no-global-assign
          global.Notification = class extends OrigNotif {
            constructor(opts) {
              super(opts);
              record('Notification', [opts]);
            }
          };
          // Best-effort: also try to patch the module-level Notification that
          // main.ts references as `electron.Notification` (esbuild emits
          // `new import_electron.Notification(...)`). The module property may be
          // non-configurable in some Electron builds, in which case defineProperty
          // throws — Notification spying is then unavailable and scenarios fall
          // back to flashFrame (the reliable, prototype-patchable attention signal).
          if (!electron.__spyNotifPatched) {
            try {
              const orig = electron.Notification;
              Object.defineProperty(electron, 'Notification', {
                configurable: true,
                get() {
                  return class SpyNotification extends orig {
                    constructor(opts) {
                      super(opts);
                      record('Notification', [opts]);
                    }
                    static isSupported() {
                      return orig.isSupported();
                    }
                  };
                },
              });
              electron.__spyNotifPatched = true;
            } catch {
              /* Notification property non-configurable — best-effort only */
            }
          }
        }
        if (api === 'flashFrame') {
          if (global.__spyFlashPatched) continue;
          global.__spyFlashPatched = true;
          const origFlash = BrowserWindow.prototype.flashFrame;
          BrowserWindow.prototype.flashFrame = function (flag) {
            record('flashFrame', [flag]);
            return origFlash.call(this, flag);
          };
        }
        if (api === 'setOverlayIcon') {
          if (global.__spyOverlayPatched) continue;
          global.__spyOverlayPatched = true;
          const origOverlay = BrowserWindow.prototype.setOverlayIcon;
          BrowserWindow.prototype.setOverlayIcon = function (...args) {
            record('setOverlayIcon', args);
            return origOverlay.apply(this, args);
          };
        }
        if (api === 'setBadgeCount') {
          if (global.__spyBadgePatched) continue;
          global.__spyBadgePatched = true;
          const origBadge = electronApp.setBadgeCount?.bind(electronApp);
          if (origBadge) {
            electronApp.setBadgeCount = (...args) => {
              record('setBadgeCount', args);
              return origBadge(...args);
            };
          }
        }
        if (api === 'openPath') {
          if (global.__spyOpenPathPatched) continue;
          global.__spyOpenPathPatched = true;
          const origOpen = shell.openPath.bind(shell);
          shell.openPath = (...args) => {
            record('openPath', args);
            return origOpen(...args);
          };
        }
        if (api === 'showItemInFolder') {
          if (global.__spyShowItemPatched) continue;
          global.__spyShowItemPatched = true;
          const origShow = shell.showItemInFolder.bind(shell);
          shell.showItemInFolder = (...args) => {
            record('showItemInFolder', args);
            return origShow(...args);
          };
        }
      }
    },
    { apiSpecs },
  );
}

/**
 * Read all recorded spy calls from the main process.
 * @param {object} app
 * @returns {Promise<Array<{ api: string, args: unknown[], ts: number }>>}
 */
export async function getSpyCalls(app) {
  return app.evaluate(() => global.__spyCalls || []);
}

/**
 * Clear recorded spy calls.
 * @param {object} app
 */
export async function clearSpyCalls(app) {
  await app.evaluate(() => {
    global.__spyCalls = [];
  });
}

// ──────────────────────────────────────────────────────────────────────────────
// Window focus control
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Drive `win.focus()` / `win.blur()` in the main process so focus-gated
 * behaviour (T1A) can be exercised.
 *
 * @param {object} app
 * @param {boolean} focused
 */
export async function setWindowFocus(app, focused) {
  await app.evaluate(
    (electron, { focused: f }) => {
      const { BrowserWindow } = electron;
      const win = BrowserWindow.getAllWindows()[0];
      if (!win) return;

      if (f) {
        // Restore the real isFocused and bring the window to the front.
        const wasFakeBlurred = win.__isFocusedOverride !== undefined;
        if (win.__isFocusedOverride !== undefined) delete win.__isFocusedOverride;
        if (win.setFocusable) win.setFocusable(true);
        win.show();
        win.focus();
        // The OS window never actually lost focus (the blur was faked via the
        // isFocused override), so win.focus() doesn't re-emit 'focus'. Emit it so
        // the APP's own focus handler runs — main.ts: win.on('focus', () =>
        // win?.flashFrame(false)). This tests the app's flash-clear behavior
        // (the spy records the app's flashFrame(false)), NOT a harness-issued
        // call — the harness must never perform the behavior under assertion.
        if (wasFakeBlurred) {
          win.emit('focus');
        }
      } else {
        // On Windows, the OS refocuses the only open window immediately after
        // blur()/minimize(), so win.isFocused() is unreliable for test purposes.
        //
        // Workaround: override isFocused() on this window instance to return
        // false.  The attention sweep in main.ts calls win.isFocused() directly,
        // so this makes shouldRaiseOsAttention() see windowFocused=false without
        // requiring an actual OS focus change.
        //
        // The override is removed when we re-focus (see the `f` branch above).
        win.__isFocusedOverride = false;
        const origIsFocused = win.isFocused.bind(win);
        win.isFocused = () =>
          win.__isFocusedOverride !== undefined ? win.__isFocusedOverride : origIsFocused();
        // Also fire the real blur so win.on('focus', …) listeners can use focus
        // events for flash-clear logic; but don't rely on OS to remove focus.
        try {
          win.blur();
        } catch {
          /* ignore — best effort */
        }
      }
    },
    { focused },
  );

  // Brief settle so the blur event (if it fires) propagates before callers proceed.
  await new Promise((r) => setTimeout(r, 200));
}

// ──────────────────────────────────────────────────────────────────────────────
// Drag-and-drop
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Dispatch a synthetic drag-and-drop sequence (dragenter → dragover → drop) on
 * `targetSelector`, carrying `files` (array of absolute path strings) in the
 * DataTransfer. Generalises the paste-ClipboardEvent technique.
 *
 * @param {object} page
 * @param {{ files: string[], targetSelector: string }} opts
 */
export async function sendDragDrop(page, { files, targetSelector }) {
  await page.evaluate(
    ({ files: fileList, sel }) => {
      const el = document.querySelector(sel);
      if (!el) throw new Error(`sendDragDrop: no element matching "${sel}"`);

      // Browsers won't let us construct real File objects with arbitrary paths,
      // so carry the paths as DataTransfer text/custom types the DnD handler reads.
      const dt = new DataTransfer();
      dt.setData('text/plain', fileList.join('\n'));
      dt.setData('application/conduit-files', JSON.stringify(fileList));

      const makeEvent = (type) =>
        new DragEvent(type, {
          bubbles: true,
          cancelable: true,
          dataTransfer: dt,
        });

      el.dispatchEvent(makeEvent('dragenter'));
      el.dispatchEvent(makeEvent('dragover'));
      el.dispatchEvent(makeEvent('drop'));
    },
    { files, sel: targetSelector },
  );
}

// ──────────────────────────────────────────────────────────────────────────────
// Shell reader helper (used by paste scenario)
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Write a reader script to a temp dir, send it as `term:input`, and wait for
 * the `READY` sentinel. Used by stdin-asserting scenarios (paste).
 *
 * @param {object} page
 * @param {string} sid  Session id
 * @param {{ script: string, dumpPath: string }} opts
 *   script — the content of the reader (PowerShell) script
 *   dumpPath — absolute path the script writes its result to (must use DUMP env var)
 */
export async function runShellReader(page, sid, { script, dumpPath }) {
  const scriptDir = mkdtempSync(join(tmpdir(), 'conduit-reader-'));
  const scriptPath = join(scriptDir, 'reader.ps1');
  writeFileSync(scriptPath, script);

  await page.evaluate(
    ({ sid: s, reader, dump }) => {
      window.__cap = '';
      window.agentDeck.post({
        type: 'term:input',
        sessionId: s,
        data: `set "DUMP=${dump}" && powershell -NoProfile -ExecutionPolicy Bypass -File "${reader}"\r`,
      });
    },
    { sid, reader: scriptPath.replace(/\\/g, '/'), dump: dumpPath.replace(/\\/g, '/') },
  );

  await page.waitForFunction(() => window.__cap.includes('READY'), null, { timeout: 15000 });
  await page.waitForTimeout(900); // let xterm process ESC[?2004h
}

// ──────────────────────────────────────────────────────────────────────────────
// Assertion helpers
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Hard assertion. Throws with `msg` if `cond` is falsy, which will propagate
 * to the scenario's top-level catch and exit with code 1.
 *
 * @param {boolean} cond
 * @param {string} msg
 */
export function assert(cond, msg) {
  if (!cond) throw new AssertionError(msg);
}

/**
 * Assert that `calls` contains at least one call matching `api` (and optionally
 * `predicate`).
 *
 * @param {Array<{ api: string, args: unknown[], ts: number }>} calls
 * @param {string} api
 * @param {((call: { api: string, args: unknown[], ts: number }) => boolean) | undefined} predicate
 */
export function assertCall(calls, api, predicate) {
  const matching = calls.filter((c) => c.api === api);
  if (matching.length === 0) {
    throw new AssertionError(
      `Expected spy call to "${api}" but none was recorded. Calls: ${JSON.stringify(calls.map((c) => c.api))}`,
    );
  }
  if (predicate) {
    const passed = matching.some(predicate);
    if (!passed) {
      throw new AssertionError(
        `Spy call to "${api}" found but predicate failed. Calls: ${JSON.stringify(matching)}`,
      );
    }
  }
}

class AssertionError extends Error {
  constructor(msg) {
    super(msg);
    this.name = 'AssertionError';
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// Exit-code convention helpers
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Wrap an async scenario body with standard exit-code handling.
 * Usage:
 *   runScenario('paste', async ({ app, page, log }) => { ... });
 *
 * @param {string} name  Scenario name (used for log prefix)
 * @param {(ctx: { app: any, page: any, log: (...a: any[]) => void }) => Promise<void>} fn
 */
export async function runScenario(name, fn) {
  if (process.platform !== 'win32') {
    console.log(`[${name}] SKIP — suite is Windows-only (non-win32 platform)`);
    process.exit(0);
  }

  const scenarioLog = makeLog(name);
  let launched = null;
  try {
    launched = await launchApp();
    await fn({ app: launched.app, page: launched.page, log: scenarioLog });
    scenarioLog('PASS ✓');
    process.exit(0);
  } catch (e) {
    const isAssertion = e?.name === 'AssertionError';
    if (isAssertion) {
      scenarioLog('FAIL ✗', e.message);
      process.exit(1);
    } else {
      console.error(`[${name}] ERROR:`, e?.message || e);
      process.exit(2);
    }
  } finally {
    try {
      await launched?.cleanup();
    } catch {
      /* ignore */
    }
  }
}
