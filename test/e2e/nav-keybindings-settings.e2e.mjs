/**
 * nav-keybindings-settings — the Settings → Shortcuts flows for the Code navigation rows
 * (docs/specs/2026-09-28-nav-keybindings.md §7): defaults shown, a recorded chord navigates at
 * once without a reload, refusal, reset, persistence across a relaunch on the same profile.
 * The surfaces themselves are nav-keybindings-surfaces.
 *
 * Uses launchApp/closeApp directly (not runScenario) so AC-9 can relaunch on the same user-data
 * dir. Run: `npm run build`, then `node test/e2e/run-smoke.mjs nav-keybindings-settings`.
 */

import { assert, closeApp, finishScenario, launchApp, makeLog, openSession } from './harness.mjs';
import {
  activeTab,
  cursorLine,
  focusEditor,
  makeNavFixture,
  openAtLineViaSearch,
  tapIndex,
  waitActive,
  waitCursor,
  waitForIndexReady,
} from './nav-history-fixture.mjs';

if (process.platform !== 'win32') {
  console.log('[nav-keybindings-settings] SKIP — suite is Windows-only');
  await finishScenario(0);
}

const log = makeLog('nav-keybindings-settings');
const DEF = 'Go to Definition';

async function openShortcuts(page) {
  await page.locator('.footbtn[title^="Settings"]').click();
  await page.locator('.settings__navitem', { hasText: 'Shortcuts' }).click();
  await page.locator('.shortcuts').waitFor({ state: 'visible', timeout: 5000 });
}

async function closeSettings(page) {
  await page.keyboard.press('Escape');
  await page.locator('.modal.settings').first().waitFor({ state: 'detached', timeout: 5000 });
}

const row = (page, description) =>
  page.locator('.shortcuts__row', {
    has: page.locator('.shortcuts__desc', { hasText: new RegExp(`^${description}`) }),
  });

const rowCombo = (page, description) =>
  row(page, description).locator('.shortcuts__keys kbd').first().textContent();

async function waitRowCombo(page, description, want) {
  const until = Date.now() + 5000;
  let got = null;
  while (Date.now() < until) {
    got = await rowCombo(page, description);
    if (got === want) return;
    await page.waitForTimeout(50);
  }
  assert(false, `row "${description}" should show "${want}", shows "${got}"`);
}

async function record(page, description, key) {
  await page
    .getByRole('button', { name: `Record shortcut for ${description}`, exact: true })
    .click();
  await waitRowCombo(page, description, 'Press keys…');
  await page.keyboard.press(key);
}

async function snapshot(page) {
  return JSON.stringify({ tab: await activeTab(page), line: await cursorLine(page) });
}

async function assertInert(page, key, what) {
  const before = await snapshot(page);
  await page.keyboard.press(key);
  await page.waitForTimeout(1000);
  const after = await snapshot(page);
  assert(after === before, `${what}: ${key} must be inert, went ${before} → ${after}`);
}

async function assertNavigates(page, key, what) {
  await page.keyboard.press(key);
  assert(
    await waitActive(page, 'b.ts'),
    `${what}: ${key} should open b.ts, on ${await activeTab(page)}`,
  );
  assert(
    await waitCursor(page, 40),
    `${what}: ${key} should land on b.ts:40, at ${await cursorLine(page)}`,
  );
}

async function backToCall(page) {
  await page.keyboard.press('Alt+ArrowLeft');
  assert(await waitActive(page, 'a.ts'), 'back to a.ts');
  assert(await waitCursor(page, 12), 'back on a.ts:12');
  await focusEditor(page);
}

async function ready(page, root) {
  await tapIndex(page);
  await openSession(page, { path: root });
  await waitForIndexReady(page, log);
}

const root = makeNavFixture([]);
let launched = null;
let code = 0;
try {
  launched = await launchApp();
  let { app, page } = launched;
  await ready(page, root);

  // AC-1
  await openShortcuts(page);
  const groups = await page.locator('.shortcuts__gtitle').allTextContents();
  assert(
    groups.indexOf('Code navigation') === groups.indexOf('Editor') + 1,
    `"Code navigation" should follow "Editor", groups ${JSON.stringify(groups)}`,
  );
  await waitRowCombo(page, DEF, 'F12');
  await waitRowCombo(page, 'Go to Implementations', 'Ctrl + F12');
  await waitRowCombo(page, 'Go to References', 'Shift + F12');
  log('AC-1 Code navigation group after Editor with the default chords ✓');

  // AC-2
  await page.evaluate(() => {
    window.__navMarker = 1;
  });
  await record(page, DEF, 'Alt+D');
  await waitRowCombo(page, DEF, 'Alt + D');
  await closeSettings(page);
  await openAtLineViaSearch(page, 'navTarget();', 'a.ts', 12);
  await assertNavigates(page, 'Alt+D', 'AC-2');
  assert(
    (await page.evaluate(() => window.__navMarker)) === 1,
    'AC-2: the window marker must survive (no reload)',
  );
  log('AC-2 recorded Alt+D navigates at once, no reload ✓');
  await backToCall(page);

  // AC-10
  const at = await page.evaluate(() => {
    const ed = (window.monaco?.editor.getEditors() ?? []).find((e) => e.hasTextFocus());
    const pos = ed?.getPosition();
    const vp = pos ? ed.getScrolledVisiblePosition(pos) : null;
    if (!ed || !vp) return null;
    const r = ed.getDomNode().getBoundingClientRect();
    return { x: r.left + vp.left + 2, y: r.top + vp.top + vp.height / 2 };
  });
  assert(at, 'AC-10: the caret must be on screen to right-click it');
  await page.mouse.click(at.x, at.y, { button: 'right' });
  await page.waitForSelector('.ctxmenu', { timeout: 5000 });
  const defHint = await page
    .locator('.ctxmenu__item', { hasText: /^Go to Definition/ })
    .locator('.ctxmenu__hint')
    .textContent();
  assert(defHint === 'Alt+D', `AC-10: the menu's Go to Definition hint, got "${defHint}"`);
  await page.keyboard.press('Escape');
  await page.locator('.ctxmenu').waitFor({ state: 'detached', timeout: 5000 });
  await focusEditor(page);
  log('AC-10 the context menu hints the rebound chord ✓');

  // AC-8
  await openShortcuts(page);
  await record(page, DEF, 'd');
  await page.waitForTimeout(300);
  assert(
    (await rowCombo(page, DEF)) === 'Press keys…',
    'AC-8: a refused key keeps the row recording',
  );
  const note = await row(page, DEF).locator('.shortcuts__note').textContent();
  assert(note === 'This key types text in the editor', `AC-8: refusal note, got "${note}"`);
  await page.keyboard.press('Escape');
  await waitRowCombo(page, DEF, 'Alt + D');
  assert(
    (await page.locator('.modal.settings').count()) === 1,
    'AC-8: Escape cancels the recording, not the modal',
  );
  assert(
    (await row(page, DEF).locator('.shortcuts__note').count()) === 0,
    'AC-8: the refusal note clears when recording ends',
  );
  log('AC-8 "d" refused with a reason; Escape leaves the binding unchanged ✓');

  // AC-6
  await page.getByRole('button', { name: `Reset ${DEF} to F12`, exact: true }).click();
  await waitRowCombo(page, DEF, 'F12');
  assert(
    (await row(page, DEF)
      .getByRole('button', { name: /^Reset/ })
      .count()) === 0,
    'AC-6: Reset hides once the row is back at its default',
  );
  await closeSettings(page);
  await focusEditor(page);
  await assertNavigates(page, 'F12', 'AC-6');
  await backToCall(page);
  await assertInert(page, 'Alt+D', 'AC-6');
  log('AC-6 Reset restores F12; Alt+D inert ✓');

  // Conflict notes
  const conflictNotes = () =>
    row(page, DEF).locator('.shortcuts__note--conflict').allTextContents();
  await openShortcuts(page);
  await record(page, DEF, 'Control+P');
  await waitRowCombo(page, DEF, 'Ctrl + P');
  assert(
    (await conflictNotes()).includes('· conflict: overrides Search files & sessions while editing'),
    `Definition = Ctrl+P should name the app shortcut, notes ${JSON.stringify(await conflictNotes())}`,
  );
  assert(
    (await row(page, 'Search files & sessions').locator('.shortcuts__conflict').textContent()) ===
      ' · conflict',
    'the Search row should show "· conflict"',
  );
  await record(page, DEF, 'Control+Slash');
  await waitRowCombo(page, DEF, 'Ctrl + /');
  assert(
    (await conflictNotes()).includes('· shadows Toggle Line Comment in the editor'),
    `Definition = Ctrl+/ should name Monaco's default, notes ${JSON.stringify(await conflictNotes())}`,
  );
  await record(page, DEF, 'Alt+Z');
  await waitRowCombo(page, DEF, 'Alt + Z');
  assert(
    (await conflictNotes()).includes('· shadows Toggle Word Wrap in the editor'),
    `Definition = Alt+Z should name the code-viewer chord, notes ${JSON.stringify(await conflictNotes())}`,
  );
  log('conflict notes name the app shortcut, the Monaco default and the code-viewer chord ✓');

  // A Monaco command with no action label (toggleFindRegex on Alt+R) is named in words, never by id.
  const REFS = 'Go to References';
  await record(page, REFS, 'Alt+R');
  await waitRowCombo(page, REFS, 'Alt + R');
  const refNotes = await row(page, REFS).locator('.shortcuts__note--conflict').allTextContents();
  assert(
    refNotes.length > 0 && refNotes.every((t) => /^· shadows [A-Z][^.]* in the editor$/.test(t)),
    `Alt+R conflict notes must use readable labels, got ${JSON.stringify(refNotes)}`,
  );
  log(`Alt+R notes: ${JSON.stringify(refNotes)} ✓`);
  await page.getByRole('button', { name: `Reset ${REFS} to Shift + F12`, exact: true }).click();
  await waitRowCombo(page, REFS, 'Shift + F12');

  // Spec §4: the nav chord wins over the code viewer's own Alt+Z in every editor — one already
  // open when the rebind landed, and one opened after it (whose actions register later).
  await closeSettings(page);
  await focusEditor(page);
  const focusedEditorId = () =>
    page.evaluate(
      () =>
        (window.monaco?.editor.getEditors() ?? []).find((e) => e.hasTextFocus())?.getId() ?? null,
    );
  const openEditorId = await focusedEditorId();
  await assertNavigates(page, 'Alt+Z', 'Alt+Z in the editor open before the rebind');
  await backToCall(page);
  await page
    .locator('.tabbar [role="tab"]', { has: page.locator('span', { hasText: /^a.ts$/ }) })
    .locator('.tab__close')
    .click();
  await page.waitForFunction(
    () =>
      !Array.from(document.querySelectorAll('.tabbar [role="tab"] span')).some(
        (el) => el.textContent === 'a.ts',
      ),
    null,
    { timeout: 5000 },
  );
  await openAtLineViaSearch(page, 'navTarget();', 'a.ts', 12);
  const newEditorId = await focusedEditorId();
  assert(
    newEditorId !== null && newEditorId !== openEditorId,
    `a.ts must be a NEW editor after reopening (${openEditorId} → ${newEditorId})`,
  );
  await assertNavigates(page, 'Alt+Z', 'Alt+Z in an editor opened after the rebind');
  await backToCall(page);
  log('Alt+Z = Go to Definition wins over Toggle Word Wrap in open and newly opened editors ✓');
  await openShortcuts(page);
  await page.getByRole('button', { name: `Reset ${DEF} to F12`, exact: true }).click();
  await waitRowCombo(page, DEF, 'F12');
  await closeSettings(page);

  // AC-9
  await openShortcuts(page);
  await record(page, DEF, 'Alt+D');
  await waitRowCombo(page, DEF, 'Alt + D');
  await closeSettings(page);
  const udd = launched.userDataDir;
  await closeApp(app, page);
  launched = await launchApp({ userDataDir: udd });
  ({ app, page } = launched);
  await ready(page, root);
  await openShortcuts(page);
  await waitRowCombo(page, DEF, 'Alt + D');
  await closeSettings(page);
  await openAtLineViaSearch(page, 'navTarget();', 'a.ts', 12);
  await assertNavigates(page, 'Alt+D', 'AC-9');
  log('AC-9 the override survives a relaunch and navigates ✓');

  log('PASS ✓');
} catch (e) {
  if (e?.name === 'AssertionError') {
    log('FAIL ✗', e.message);
    code = 1;
  } else {
    console.error('[nav-keybindings-settings] ERROR:', e?.message || e);
    if (e?.stack) console.error(e.stack);
    code = 2;
  }
}
try {
  await launched?.cleanup();
} catch {
  /* already gone */
}
await finishScenario(code);
