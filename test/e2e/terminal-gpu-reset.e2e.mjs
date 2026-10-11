/**
 * Terminal panes survive a GPU-process restart (black-pane).
 *
 * A GPU-process restart wipes the pixels of @xterm/addon-webgl's shared, module-level texture
 * atlas while every WebGL terminal in the document keeps believing its glyphs are drawn, so each
 * pane paints only its cursor. The WebGL contexts come back inside xterm's own 3 s window, so the
 * addon never reports a loss. `webview/terminal-gpu.ts` handles it; this drives the real thing:
 *
 *   1. Open three shell sessions, print a block of text in each, and measure the glyph pixels of
 *      the active pane (all three must be on the WebGL renderer, or the scenario proves nothing).
 *   2. Kill THIS app's GPU process — by the PID `app.getAppMetrics()` reports, never by name.
 *   3. Wait for the restart, then measure the pane that was active, and a pane that was hidden
 *      during the reset after activating it. Both must draw text again, on WebGL again.
 *   4. The shader background (switched on first) must have rebuilt its program on the restored
 *      context — before the fix it stopped its loop on the loss and never came back.
 */

import { assert, openSession, REPO, runScenario } from './harness.mjs';

const SESSIONS = 3;
// Measured: ~17k bright pixels with text on screen; the broken atlas leaves 0–119 (the cursor).
const MIN_GLYPH_PX = 2000;
const RECOVERY_MS = 8000;
// capturePage of the hidden window now and then returns a blank frame (measured: 0 px before any
// reset), so a pane scores its best of several captures. The broken atlas stays dark however long
// it is sampled, so this cannot hide the defect.
const CAPTURES = 6;

const glyphPixels = async (app, page, sid) => {
  const rect = await page.evaluate((id) => {
    const screen = window.__terms?.[id]?.element?.querySelector('.xterm-screen');
    if (!screen || screen.offsetWidth === 0) return null;
    const r = screen.getBoundingClientRect();
    return {
      x: Math.round(r.x),
      y: Math.round(r.y),
      width: Math.round(r.width),
      height: Math.round(r.height),
    };
  }, sid);
  assert(rect, `session ${sid} has no visible .xterm-screen`);
  let best = 0;
  for (let i = 0; i < CAPTURES; i++) {
    if (i > 0) await page.waitForTimeout(250);
    const bright = await app.evaluate(async ({ BrowserWindow }, r) => {
      const win = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed());
      const bmp = (await win.webContents.capturePage(r)).toBitmap();
      let n = 0;
      for (let j = 0; j + 3 < bmp.length; j += 4) {
        if (bmp[j] + bmp[j + 1] + bmp[j + 2] > 480) n++;
      }
      return n;
    }, rect);
    best = Math.max(best, bright);
  }
  return best;
};

const activate = async (page, sid) => {
  await page.locator(`[data-sessionid="${sid}"] .session__text`).first().click();
  await page.waitForFunction((id) => (window.__terms?.[id]?.element?.offsetWidth ?? 0) > 0, sid, {
    timeout: 10000,
  });
};

// A program created before the loss is no program on the restored context, so a live one bound
// means the scene was rebuilt. Checked before any click: re-rendering the backdrop also rebuilds it.
const shaderLive = () => {
  const canvas = document.querySelector('canvas.bgfx--shader');
  const gl = canvas?.getContext('webgl');
  return !!gl && !gl.isContextLost() && gl.isProgram(gl.getParameter(gl.CURRENT_PROGRAM));
};

const onWebgl = (page, sid) =>
  page.evaluate(
    (id) => !!window.__terms?.[id]?.element?.querySelector('.xterm-screen canvas'),
    sid,
  );

await runScenario('terminal-gpu-reset', async ({ app, page, log }) => {
  await page.evaluate(() => {
    window.__terms = {};
    window.__settings = null;
    window.agentDeck.subscribe((m) => {
      if (m.type === 'state') window.__settings = m.settings;
    });
    window.agentDeck.post({ type: 'ready' });
  });
  await page.waitForFunction(() => !!window.__settings, null, { timeout: 10000 });
  await page.evaluate(() =>
    window.agentDeck.post({
      type: 'updateSettings',
      settings: { ...window.__settings, background: 'shader', reduceMotion: false },
    }),
  );
  await page.waitForFunction(shaderLive, null, { timeout: 10000 });

  const sids = [];
  for (let i = 0; i < SESSIONS; i++) {
    const sid = await openSession(page, { path: REPO, agentId: 'shell:cmd' });
    sids.push(sid);
    await page.waitForFunction((id) => !!window.__terms?.[id], sid, { timeout: 15000 });
    await page.evaluate((id) => {
      window.agentDeck.post({ type: 'term:input', sessionId: id, data: 'dir /w\r' });
    }, sid);
  }
  for (const sid of sids) {
    await page.waitForFunction((id) => (window.__capBy?.[id] ?? '').includes('bytes free'), sid, {
      timeout: 20000,
    });
  }

  const active = sids[SESSIONS - 1];
  const hidden = sids[0];
  await activate(page, active);
  await page.waitForTimeout(500);
  for (const sid of sids) assert(await onWebgl(page, sid), `session ${sid} is not on WebGL`);
  const before = await glyphPixels(app, page, active);
  log(`before reset: ${before} glyph px`);
  assert(before >= MIN_GLYPH_PX, `baseline too dark to measure (${before} px)`);

  const gpuPid = await app.evaluate(({ app: a }) => {
    const gpu = a.getAppMetrics().find((m) => m.type === 'GPU');
    if (!gpu) return null;
    process.kill(gpu.pid);
    return gpu.pid;
  });
  assert(gpuPid, 'this app reports no GPU process');
  log(`killed GPU process ${gpuPid}`);
  await page.waitForTimeout(RECOVERY_MS);

  const newGpu = await app.evaluate(
    ({ app: a }) => a.getAppMetrics().find((m) => m.type === 'GPU')?.pid ?? null,
  );
  assert(newGpu && newGpu !== gpuPid, `the GPU process did not restart (pid ${newGpu})`);
  const shaderResumed = await page.evaluate(shaderLive);
  log(`shader background rebuilt after reset: ${shaderResumed}`);

  const afterActive = await glyphPixels(app, page, active);
  log(`after reset, pane active during it: ${afterActive} glyph px`);
  await activate(page, hidden);
  await page.waitForTimeout(500);
  const afterHidden = await glyphPixels(app, page, hidden);
  log(`after reset, pane hidden during it: ${afterHidden} glyph px`);

  assert(afterActive >= MIN_GLYPH_PX, `active pane went dark after the reset (${afterActive} px)`);
  assert(afterHidden >= MIN_GLYPH_PX, `hidden pane went dark after the reset (${afterHidden} px)`);
  // Text alone would also come back by leaving every pane on the DOM renderer for good.
  for (const sid of sids) {
    assert(await onWebgl(page, sid), `session ${sid} did not return to WebGL after the reset`);
  }
  assert(shaderResumed, 'the shader background did not resume after the reset');
});
