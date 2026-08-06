/**
 * Scrolling up in a terminal must leave a way back to the newest output.
 *
 * Regression guard for the runaway-scroll bug: while an agent streams, a reader who scrolls
 * up cannot get back to the bottom with the wheel. Once xterm's scrollback ring is full it
 * keeps the reader's text stationary by decrementing ydisp on every trimmed line while ybase
 * stays pinned, so the gap to the bottom grows at the OUTPUT rate — which outruns any wheel.
 * The only reliable way back is a direct scrollToBottom, which also clears xterm's
 * `isUserScrolling` flag and so re-arms follow-mode.
 *
 * Both halves below are load-bearing:
 *   - the scroll is driven by a REAL wheel, because xterm reports a wheel scroll with
 *     suppressScrollEvent and so never fires onScroll for it. A scrollLines() call takes a
 *     different code path and passes against a build where no user could ever see the control.
 *   - it scrolls while the terminal is IDLE, because a running producer fires onScroll on
 *     every line of output and hides whether the wheel path reports anything at all.
 */
import { assert, closeApp, launchApp, makeLog, openSession, REPO } from './harness.mjs';

if (process.platform !== 'win32') {
  console.log('[terminal-follow] SKIP — suite is Windows-only');
  process.exit(0);
}

const log = makeLog('terminal-follow');

let launched;
try {
  launched = await launchApp();
  const { app, page } = launched;

  // Opt into the terminal observability hook BEFORE any terminal mounts — the assertions are
  // about the xterm buffer's scroll position, not the term:data byte stream.
  await page.evaluate(() => {
    window.__terms = {};
  });

  const sid = await openSession(page, { path: REPO });
  log(`session ${sid}`);

  const baseY = () => page.evaluate((id) => window.__terms[id]?.buffer.active.baseY ?? 0, sid);
  const atBottom = () =>
    page.evaluate((id) => {
      const buf = window.__terms[id].buffer.active;
      return buf.viewportY >= buf.baseY;
    }, sid);

  // A bounded producer: enough scrollback to scroll through, then it stops on its own.
  await page.evaluate(
    (id) =>
      window.agentDeck.post({
        type: 'term:input',
        sessionId: id,
        data: 'for /L %i in (1,1,3000) do @echo conduit-follow-line %i\r',
      }),
    sid,
  );
  await page.waitForFunction((id) => (window.__terms?.[id]?.buffer.active.baseY ?? 0) > 200, sid, {
    timeout: 30000,
  });

  // Wait for it to go quiet, so only the wheel can report a scroll from here on.
  let last = -1;
  for (let i = 0; i < 40; i++) {
    const now = await baseY();
    if (now === last) break;
    last = now;
    await page.waitForTimeout(500);
  }
  log(`producer idle at baseY=${last} ✓`);
  assert(await atBottom(), 'the viewport should be following before the user scrolls');

  const box = await page.evaluate(() => {
    const vp = [...document.querySelectorAll('.xterm-viewport')].find(
      (e) => e.offsetParent !== null,
    );
    const r = vp.getBoundingClientRect();
    return { cx: r.x + r.width / 2, cy: r.y + r.height / 2 };
  });
  await page.mouse.move(box.cx, box.cy);
  for (let i = 0; i < 10; i++) {
    await page.mouse.wheel(0, -120);
    await page.waitForTimeout(40);
  }
  assert(!(await atBottom()), 'a real wheel scroll should leave the viewport off the bottom');

  const pill = page.locator('.term-follow');
  await pill.waitFor({ state: 'attached', timeout: 8000 });
  log('PASS: "Jump to latest" appears after a real wheel scroll on an idle terminal ✓');

  await pill.click({ force: true });
  const pinned = await page
    .waitForFunction(
      (id) => {
        const buf = window.__terms[id].buffer.active;
        return buf.viewportY >= buf.baseY;
      },
      sid,
      { timeout: 8000 },
    )
    .then(() => true)
    .catch(() => false);
  assert(pinned, '"Jump to latest" should pin the viewport to the newest output');
  await pill.waitFor({ state: 'detached', timeout: 8000 });
  log('PASS: clicking it returns to the bottom and the control hides itself ✓');

  // The fix is re-arming follow-mode, not a one-shot jump: it must STAY at the bottom while
  // new output arrives.
  await page.evaluate(
    (id) =>
      window.agentDeck.post({
        type: 'term:input',
        sessionId: id,
        data: 'for /L %i in (1,1,2000) do @echo conduit-follow-again %i\r',
      }),
    sid,
  );
  await page.waitForTimeout(3000);
  assert(await atBottom(), 'follow-mode should stay armed as more output arrives');
  log('PASS: follow-mode stays armed ✓');

  log('all assertions passed ✓');
  await closeApp(app, page);
} catch (err) {
  console.error('[terminal-follow] FAIL', err);
  if (launched) await closeApp(launched.app, launched.page).catch(() => {});
  process.exit(1);
}
