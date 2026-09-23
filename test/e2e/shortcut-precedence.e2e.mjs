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
import { openViaTree } from './goto-matrix.mjs';
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

  // Focus the ACTIVE terminal's key sink deterministically. The app starts with a second session
  // whose pane stays mounted but hidden, and focusing that textarea silently does nothing — which
  // once let Alt+Left pass here only because it navigated to the other session's terminal.
  const activeTerminal = page.locator('.termhost:visible .xterm-helper-textarea').first();
  await activeTerminal.waitFor({ state: 'attached', timeout: 20000 });
  await activeTerminal.focus();
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

  // 4) Alt+Arrow (navBack/navForward) must NOT hijack the terminal either — they take the same
  // fallback path as any registry shortcut. History has to exist first, or a fired navBack would
  // have nowhere to go and the check could not fail: open two files, return to the Terminal tab,
  // and confirm Back is live before pressing. A fired navBack would land on a doc tab and blur
  // the terminal; a stray browser-back would blank the app.
  await openViaTree(page, REPO, ['README.md']);
  await openViaTree(page, REPO, ['package.json']);
  await page.locator('.tabbar > button.tab:not([role="tab"])').first().click();
  await page.waitForFunction(
    () => !document.querySelector('.tabbar [role="tab"].tab--active'),
    null,
    {
      timeout: 5000,
    },
  );
  const backEnabled = await page.evaluate(
    () => document.querySelector('button[title="Back"]')?.disabled === false,
  );
  assert(backEnabled, 'Back should be enabled once two files were opened');
  await activeTerminal.focus();
  assert(
    await page.evaluate(() => document.activeElement?.classList.contains('xterm-helper-textarea')),
    'the terminal textarea should be focused again before Alt+Arrow',
  );
  await page.keyboard.press('Alt+ArrowLeft');
  await page.keyboard.press('Alt+ArrowRight');
  await page.waitForTimeout(500);
  const stillInTerm = await page.evaluate(() =>
    document.activeElement?.classList.contains('xterm-helper-textarea'),
  );
  assert(stillInTerm, 'Alt+Arrow must not hijack the terminal — focus should stay in it');
  const docActivated = await page.evaluate(
    () => !!document.querySelector('.tabbar [role="tab"].tab--active'),
  );
  assert(!docActivated, 'Alt+Arrow in the terminal must not navigate to a doc tab');
  const sessionAlive = await page.evaluate(
    (id) => (window.__sessions || []).some((s) => s.id === id),
    sid,
  );
  assert(
    sessionAlive,
    'the app should be intact after Alt+Arrow in the terminal (no browser-back)',
  );
  log('PASS: Alt+Arrow passed through the terminal without hijacking ✓');

  log('all assertions passed ✓');
  await closeApp(app, page);
} catch (err) {
  console.error('[shortcut-precedence] FAIL', err);
  if (launched) await closeApp(launched.app, launched.page).catch(() => {});
  process.exit(1);
}
