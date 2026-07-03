/**
 * shortcut-precedence — app shortcuts are a FALLBACK of the terminal, not a hijack.
 * With the terminal focused, a registered app combo must reach the shell/TUI (NOT fire the app
 * action); only Ctrl+` still works, to move focus out of the terminal. With the terminal not
 * focused, the same combo fires normally. Real-app because it hinges on actual DOM focus + the
 * window key handlers, which the mock shell can't exercise.
 *
 * Uses the command palette (Mod+Shift+P) as the representative app combo — it renders `.palette`
 * and has no browser-default collision (unlike Ctrl+P → print). The precedence path is identical
 * for every app shortcut.
 */
import { assert, closeApp, launchApp, makeLog, openSession, REPO } from './harness.mjs';

if (process.platform !== 'win32') {
  console.log('[shortcut-precedence] SKIP — suite is Windows-only');
  process.exit(0);
}

delete process.env.CONDUIT_E2E; // real, focusable window

const log = makeLog('shortcut-precedence');

let launched;
try {
  launched = await launchApp();
  const { app, page } = launched;

  const sid = await openSession(page, { path: REPO });
  log(`session ${sid}`);

  // Focus the terminal's key sink deterministically.
  await page.waitForSelector('.xterm-helper-textarea', { state: 'attached', timeout: 20000 });
  await page.locator('.xterm-helper-textarea').first().focus();
  const inTerm = await page.evaluate(() =>
    document.activeElement?.classList.contains('xterm-helper-textarea'),
  );
  assert(inTerm, 'the terminal textarea should be focused');
  log('terminal focused ✓');

  // 1) An app combo while the terminal is focused must NOT fire (the key goes to the shell/TUI).
  await page.keyboard.press('Control+Shift+P');
  await page.waitForTimeout(400);
  const openedWhileTerm = await page.locator('.palette').count();
  assert(
    openedWhileTerm === 0,
    'app shortcut must NOT hijack the terminal — the palette should stay closed',
  );
  log('PASS: Mod+Shift+P did not fire while the terminal was focused ✓');

  // 2) Ctrl+` is the reserved escape — focus leaves the terminal.
  await page.keyboard.press('Control+Backquote');
  await page.waitForFunction(
    () => !document.activeElement?.classList.contains('xterm-helper-textarea'),
    null,
    { timeout: 5000 },
  );
  log('PASS: Ctrl+` moved focus out of the terminal ✓');

  // 3) With the terminal no longer focused, the same combo fires normally.
  await page.keyboard.press('Control+Shift+P');
  await page.waitForSelector('.palette', { state: 'visible', timeout: 5000 });
  log('PASS: the same combo opens the palette when the terminal is not focused ✓');
  await page.keyboard.press('Escape');

  log('all assertions passed ✓');
  await closeApp(app, page);
} catch (err) {
  console.error('[shortcut-precedence] FAIL', err);
  if (launched) await closeApp(launched.app, launched.page).catch(() => {});
  process.exit(1);
}
