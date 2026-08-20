/**
 * A dead renderer must not strand the user in a black window.
 *
 * Before the `render-process-gone` handler existed, a renderer OOM/crash left the window
 * permanently blank. The main process — sessions and their PTY children — was untouched, so
 * the only escape was quitting the whole app, which killed every live shell.
 *
 * This drives the real crash (`webContents.forcefullyCrashRenderer()`, the only way to produce
 * a genuine `render-process-gone`) and asserts the recovery is complete: the window comes back
 * on its own, the session pane re-attaches with NO clicking, the pre-crash scrollback is
 * replayed, and freshly typed input still round-trips through the SAME live shell.
 * See docs/specs/2026-08-20-renderer-crash-recovery.md.
 *
 * Everything after the crash is driven through the MAIN process
 * (`webContents.executeJavaScript`) rather than the Playwright page: a crashed target leaves
 * the `Page` object permanently dead — every call answers "Target crashed" — and the reload
 * reuses the same target, so Playwright never hands out a fresh handle. Page-based
 * `.termpane`/`__terms` assertions would report a black window against a build that recovered
 * perfectly.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assert, launchApp, makeLog, openSession } from './harness.mjs';

if (process.platform !== 'win32') {
  console.log('[renderer-crash-recover] SKIP — suite is Windows-only');
  process.exit(0);
}

const log = makeLog('renderer-crash-recover');
const BEFORE = `PRECRASH-${Date.now()}`;
const AFTER = `RECOVERED-${Date.now()}`;

/** Run `src` in the (possibly just-reloaded) renderer, from the main process. */
function evalRenderer(app, src) {
  return app.evaluate(({ BrowserWindow }, code) => {
    const w = BrowserWindow.getAllWindows()[0];
    if (!w || w.isDestroyed() || w.webContents.isDestroyed()) throw new Error('window gone');
    return w.webContents.executeJavaScript(code);
  }, src);
}

/** Poll `src` until it evaluates truthy in the renderer; throw an assertion after `timeout`. */
async function waitInRenderer(app, src, msg, timeout = 40000) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    last = await evalRenderer(app, src).catch(() => null);
    if (last) return last;
    await new Promise((r) => setTimeout(r, 200));
  }
  const err = new Error(`${msg} (last value: ${JSON.stringify(last)})`);
  err.name = 'AssertionError';
  throw err;
}

/** Source for reading a session's whole rendered xterm buffer (scrollback included). */
const readBuffer = (sid) =>
  `(() => {
    const t = (window.__terms || {})[${JSON.stringify(sid)}];
    if (!t) return '';
    const b = t.buffer.active, out = [];
    for (let i = 0; i < b.length; i++) out.push(b.getLine(i)?.translateToString(true) ?? '');
    return out.join('\\n');
  })()`;

let launched = null;
let code = 0;
try {
  launched = await launchApp();
  const { app, page } = launched;

  const cwd = mkdtempSync(join(tmpdir(), 'conduit-crash-'));
  const sid = await openSession(page, { path: cwd });
  log('session', sid);

  // The harness launches with the repo as an argument, so Conduit already owns a session for
  // it. Leave only ours: the reloaded renderer auto-selects sessions[0], and a stray sibling
  // would put a different terminal on screen and make the replay assertion meaningless.
  await page.evaluate((keep) => {
    for (const s of window.__sessions || []) {
      if (s.id !== keep) window.agentDeck.post({ type: 'kill', id: s.id });
    }
  }, sid);
  await page.waitForFunction((keep) => (window.__sessions || []).every((s) => s.id === keep), sid, {
    timeout: 15000,
  });
  // ConPTY needs a moment to spawn and paint; input typed before the prompt exists is lost.
  await page.waitForFunction(() => /Microsoft Windows|>/.test(window.__cap || ''), null, {
    timeout: 25000,
  });

  // Seeds the ring AND proves the PTY works before the crash — the post-crash assertions are
  // only meaningful against a shell that was demonstrably alive.
  await page.evaluate(
    ({ s, c }) => window.agentDeck.post({ type: 'term:input', sessionId: s, data: `${c}\r` }),
    { s: sid, c: `echo ${BEFORE}` },
  );
  await page.waitForFunction((n) => (window.__cap || '').includes(n), BEFORE, { timeout: 25000 });
  log('pre-crash marker echoed by the live shell');

  // `__terms` is opt-in and read at Terminal construction, so it must exist before the reloaded
  // renderer mounts its pane. Playwright's addInitScript can't reach a crashed page, and
  // `webContents.executeJavaScript` is documented to suspend until the page stops loading — by
  // which time React has already built the Terminal. CDP's own document-start injection is the
  // only hook early enough, and it survives the crash because it lives on the webContents.
  await app.evaluate(async ({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0];
    global.__reloads = 0;
    w.webContents.on('did-finish-load', () => {
      global.__reloads++;
    });
    w.webContents.debugger.attach('1.3');
    await w.webContents.debugger.sendCommand('Page.enable');
    await w.webContents.debugger.sendCommand('Page.addScriptToEvaluateOnNewDocument', {
      source: 'window.__terms = window.__terms || {};',
    });
  });

  const pidBefore = await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].webContents.getOSProcessId(),
  );

  await app.evaluate(({ BrowserWindow }) => {
    for (const w of BrowserWindow.getAllWindows()) w.webContents.forcefullyCrashRenderer();
  });
  log('renderer crashed (pid', pidBefore, ')');

  const recovered = await (async () => {
    const deadline = Date.now() + 45000;
    while (Date.now() < deadline) {
      const info = await app
        .evaluate(({ BrowserWindow }) => {
          const w = BrowserWindow.getAllWindows()[0];
          if (!w || w.isDestroyed()) return null;
          return { reloads: global.__reloads, pid: w.webContents.getOSProcessId() };
        })
        .catch(() => null);
      if (info && info.reloads > 0) return info;
      await new Promise((r) => setTimeout(r, 200));
    }
    return null;
  })();
  assert(recovered, 'Window never recovered after the renderer crash — it is still black.');
  assert(
    recovered.pid !== pidBefore,
    `Renderer OS process id is unchanged (${recovered.pid}) — no crash happened, so this run proves nothing.`,
  );
  log('renderer reloaded (pid', recovered.pid, ')');

  // No click, no relaunch: the reloaded renderer must re-attach on its own.
  await waitInRenderer(
    app,
    '!!document.querySelector(".termpane")',
    'The recovered window never mounted a terminal pane',
  );
  const running = await waitInRenderer(
    app,
    `new Promise((res) => {
       window.agentDeck.subscribe((m) => {
         if (m.type === 'state') {
           res((m.sessions || []).some((s) => s.id === ${JSON.stringify(sid)} && s.status === 'running'));
         }
       });
       window.agentDeck.post({ type: 'ready' });
     })`,
    `Session ${sid} is no longer running in the host after the crash`,
  );
  assert(running, `Session ${sid} is no longer running in the host after the crash`);
  log('session still running and the pane re-attached without any interaction');

  const buf = await waitInRenderer(
    app,
    `(() => { const s = ${readBuffer(sid)}; return s.includes(${JSON.stringify(BEFORE)}) ? s : ''; })()`,
    `Pre-crash marker "${BEFORE}" never reappeared in the recovered terminal — the ring was not replayed`,
  ).catch(async (e) => {
    const d = await evalRenderer(
      app,
      `JSON.stringify({ exposed: Object.keys(window.__terms || {}), buffer: ${readBuffer(sid)} })`,
    ).catch(() => '(renderer unreachable)');
    e.message += ` — ${d}`;
    throw e;
  });
  assert(buf.includes(BEFORE), 'ring replay missing from the recovered buffer');
  log('pre-crash scrollback replayed into the fresh terminal');

  // The decisive one: input reaching the SAME shell proves the PTY child outlived the crash.
  await evalRenderer(
    app,
    `window.agentDeck.post({ type: 'term:input', sessionId: ${JSON.stringify(sid)}, data: ${JSON.stringify(`echo ${AFTER}\r`)} })`,
  );
  await waitInRenderer(
    app,
    `${readBuffer(sid)}.includes(${JSON.stringify(AFTER)})`,
    `Newly typed "${AFTER}" never came back — input no longer reaches the surviving shell`,
  );
  log('post-crash input round-tripped through the surviving shell');

  // The crashed Playwright page can't answer the quit guard, so arm the reply in the renderer.
  await evalRenderer(
    app,
    `window.agentDeck.subscribe((m) => {
       if (m.type === 'confirmQuit') window.agentDeck.post({ type: 'quitDecision', proceed: true });
     })`,
  ).catch(() => {});
  await app
    .evaluate(({ BrowserWindow }) => {
      const w = BrowserWindow.getAllWindows()[0];
      if (w) w.close();
    })
    .catch(() => {});

  log('PASS ✓');
} catch (e) {
  if (e?.name === 'AssertionError') {
    log('FAIL ✗', e.message);
    code = 1;
  } else {
    console.error('[renderer-crash-recover] ERROR:', e?.message || e, e?.stack ?? '');
    code = 2;
  }
}
try {
  await launched?.cleanup();
} catch {
  /* already gone */
}
process.exit(code);
