/**
 * Scrolling up in a busy terminal must leave a way back to the newest output.
 *
 * Regression guard for the runaway-scroll bug: while an agent streams, a reader who
 * scrolls up cannot get back to the bottom with the wheel. Once xterm's scrollback ring
 * is full it keeps the reader's text stationary by decrementing ydisp on every trimmed
 * line while ybase stays pinned, so the gap to the bottom grows at the OUTPUT rate —
 * which outruns any wheel. The only reliable way back is a direct scrollToBottom, which
 * also clears xterm's `isUserScrolling` flag and so re-arms follow-mode.
 *
 * Contract: scrolled off the bottom → a "Jump to latest" control exists; clicking it
 * pins the viewport to the newest output and KEEPS it pinned as more output arrives.
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

  // Opt into the terminal observability hook BEFORE any terminal mounts — the assertions
  // are about the xterm buffer's scroll position, not the term:data byte stream.
  await page.evaluate(() => {
    window.__terms = {};
  });

  const sid = await openSession(page, { path: REPO });
  log(`session ${sid}`);

  // A long-running producer, so the viewport is chasing a moving bottom exactly like an
  // agent in auto mode.
  await page.evaluate(
    (id) =>
      window.agentDeck.post({
        type: 'term:input',
        sessionId: id,
        data: 'for /L %i in (1,1,200000) do @echo conduit-follow-line %i\r',
      }),
    sid,
  );

  const atBottom = () =>
    page.evaluate((id) => {
      const buf = window.__terms[id].buffer.active;
      return buf.viewportY >= buf.baseY;
    }, sid);

  // Wait until output is genuinely flowing (baseY climbing), so scrolling up is meaningful.
  await page.waitForFunction((id) => (window.__terms?.[id]?.buffer.active.baseY ?? 0) > 200, sid, {
    timeout: 30000,
  });
  log('output streaming ✓');

  // The user scrolls up to read. Driven through the terminal API rather than a wheel event:
  // the suite's window is hidden, and what is under test is the follow state, not the wheel
  // takeover (that has its own unit coverage in terminal-scroll.test.ts).
  await page.evaluate((id) => window.__terms[id].scrollLines(-120), sid);
  assert(!(await atBottom()), 'scrolling up should leave the viewport off the bottom');

  const pill = page.locator('.term-follow');
  await pill.waitFor({ state: 'attached', timeout: 8000 });
  log('PASS: "Jump to latest" appears once scrolled off the bottom ✓');

  // Let the producer run on. This is the runaway condition: the gap only ever grows.
  await page.waitForTimeout(2000);
  assert(!(await atBottom()), 'a streaming producer should not carry the reader back down');

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
  log('PASS: clicking it returns to the bottom ✓');

  // The real fix is re-arming follow-mode, not a one-shot jump: it must STAY at the bottom
  // while output keeps arriving.
  await page.waitForTimeout(2000);
  assert(await atBottom(), 'follow-mode should stay armed as more output arrives');
  await pill.waitFor({ state: 'detached', timeout: 8000 });
  log('PASS: follow-mode stays armed and the control hides itself ✓');

  log('all assertions passed ✓');
  await closeApp(app, page);
} catch (err) {
  console.error('[terminal-follow] FAIL', err);
  if (launched) await closeApp(launched.app, launched.page).catch(() => {});
  process.exit(1);
}
