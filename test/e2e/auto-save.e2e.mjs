/**
 * Auto-save modes and conflicts (docs/specs/2026-09-28-auto-save.md §7) against the real built
 * app. Disk is asserted with fs in this process; keystrokes are real keyboard input into Monaco.
 * The setting, `off` and session teardown are in auto-save-basics.e2e.mjs.
 *
 * needs-human-smoke: "onWindowChange saves on window blur" (E5). `win.blur()` on the hidden
 * harness window never reaches the renderer as a `blur` (plan run notes M12), and a synthetic
 * `window.dispatchEvent(new Event('blur'))` would pass against a build no user can trigger.
 *
 * Run after a fresh build: `npm run build` then `node test/e2e/run-smoke.mjs auto-save`.
 */

import { chmodSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  activate,
  closeTab,
  disk,
  isDirty,
  modelValue,
  openFile,
  runAutoSave,
  setMode,
  sleep,
  tab,
  typeAtStart,
  waitFor,
  waitForModel,
  writesTo,
} from './auto-save-helpers.mjs';
import { assert } from './harness.mjs';

const banner = (page) => page.locator('.viewer__banner--warn');
const conflictMarker = (page) =>
  page.locator('.tab__conflict[aria-label="Changed on disk — auto-save paused"]');

async function phaseAfterDelay({ app, page, root, log }) {
  await setMode(page, 'afterDelay', 500);
  await openFile(page, 'ad.ts');
  await page.locator('.viewer__monaco .monaco-editor').first().click();
  await page.keyboard.press('Control+Home');
  for (const ch of 'abc') {
    await page.keyboard.type(ch);
    await sleep(100);
  }
  await waitFor(() => disk(root, 'ad.ts') === 'abcone\n', 'the auto-save after the pause', 1500);
  const writes = await writesTo(app, 'ad.ts');
  assert(writes.length === 1, `one write for the burst, got ${writes.length}`);
  assert(writes[0].expected === 'one\n', 'the auto-save carried the on-disk precondition');
  await waitFor(async () => !(await isDirty(page, 'ad.ts')), 'the dot to clear');
  // The save must leave the editor focused: the next keystroke lands without a click.
  await page.keyboard.type('d');
  await waitFor(() => disk(root, 'ad.ts') === 'abcdone\n', 'typing to continue after a save');
  await closeTab(page, 'ad.ts');
  log('afterDelay writes after a pause and coalesces a burst ✓');
}

async function phaseFocusTabSwitch({ page, root, log }) {
  await setMode(page, 'onFocusChange');
  await openFile(page, 'fc1.ts');
  await openFile(page, 'fc2.ts');
  await activate(page, 'fc1.ts');
  await typeAtStart(page, 'x');
  await activate(page, 'fc2.ts');
  await waitFor(() => disk(root, 'fc1.ts') === 'xone\n', 'the tab switch to save fc1');
  await waitFor(
    async () => (await page.locator('.tabbar .tab--dirty').count()) === 0,
    'no tab to show an unsaved dot',
  );
  await closeTab(page, 'fc1.ts');
  await closeTab(page, 'fc2.ts');
  log('onFocusChange saves on tab switch ✓');
}

async function phaseCleanNeverReverts({ app, page, root, log }) {
  await setMode(page, 'onFocusChange');
  await openFile(page, 'cl1.ts');
  await openFile(page, 'cl2.ts');
  await activate(page, 'cl1.ts');
  writeFileSync(join(root, 'cl1.ts'), 'theirs\n');
  await waitForModel(page, 'cl1.ts', 'theirs\n');
  await activate(page, 'cl2.ts');
  await sleep(600);
  assert(disk(root, 'cl1.ts') === 'theirs\n', "a clean tab must not revert an agent's change");
  assert((await writesTo(app, 'cl1.ts')).length === 0, 'no write for a clean tab');
  await closeTab(page, 'cl1.ts');
  await closeTab(page, 'cl2.ts');
  log("a clean open tab never reverts an agent's change ✓");
}

async function phaseCloseNoPrompt({ page, root, log }) {
  await setMode(page, 'onFocusChange');
  await openFile(page, 'q.ts');
  await typeAtStart(page, 'q');
  await page.keyboard.press('Control+W');
  await waitFor(async () => (await tab(page, 'q.ts').count()) === 0, 'the dirty tab to close');
  assert(
    (await page.locator('.confirm[role="alertdialog"]').count()) === 0,
    'no dialog while closing a dirty tab with auto-save on',
  );
  assert(disk(root, 'q.ts') === 'qone\n', 'the close saved the edit');
  log("closing a dirty tab with auto-save on doesn't prompt ✓");
}

async function phaseEolCloseUntouched({ app, page, root, log }) {
  await setMode(page, 'onFocusChange');
  await openFile(page, 'eol.ts');
  await waitFor(
    () => isDirty(page, 'eol.ts'),
    'the mixed-EOL tab to read dirty with no edit (C10)',
  );
  await page.locator('.viewer__monaco .monaco-editor').first().click();
  await page.keyboard.press('Control+W');
  await waitFor(
    async () => (await tab(page, 'eol.ts').count()) === 0,
    'the untouched tab to close',
  );
  assert(
    (await page.locator('.confirm[role="alertdialog"]').count()) === 0,
    'no prompt for a buffer the user never edited',
  );
  assert(disk(root, 'eol.ts') === 'a\r\nb\n', 'closing must not rewrite its line endings');
  assert((await writesTo(app, 'eol.ts')).length === 0, 'no write was even attempted');
  log('closing an untouched mixed-EOL file writes nothing and asks nothing ✓');
}

/** Counts the renderer's `git:blame` requests as the host receives them. */
async function spyBlame(app) {
  await app.evaluate(({ ipcMain }) => {
    if (global.__blameSpy) return;
    global.__blameSpy = [];
    ipcMain.prependListener('to-host', (_e, m) => {
      if (m?.type === 'git:blame') global.__blameSpy.push(m.path);
    });
  });
}
const blameRequests = async (app) => (await app.evaluate(() => global.__blameSpy)).length;
const cursorIn = (page, name) =>
  page.evaluate((n) => {
    const ed = window.monaco.editor
      .getEditors()
      .find((e) => e.getModel()?.uri.toString().endsWith(`/${n}`));
    const s = ed?.getSelection();
    return s ? [s.startLineNumber, s.startColumn, s.endLineNumber, s.endColumn].join(',') : null;
  }, name);

async function phaseReseedKeepsView({ app, page, root, log }) {
  await spyBlame(app);
  await setMode(page, 'afterDelay', 300);
  await openFile(page, 'rv.ts');
  await page.locator('.viewer__monaco .monaco-editor').first().click();
  await page.keyboard.press('Control+Home');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('End');
  await page.evaluate(() =>
    window.monaco.editor
      .getEditors()
      .find((e) => e.getModel()?.uri.toString().endsWith('/rv.ts'))
      ?.getAction('agentdeck.toggleGitBlame')
      ?.run(),
  );
  await waitFor(async () => (await blameRequests(app)) === 1, 'blame to be requested');

  await page.keyboard.type('x');
  await waitFor(() => disk(root, 'rv.ts') === 'l1\nl2x\nl3\n', 'the auto-save');
  await waitFor(async () => !(await isDirty(page, 'rv.ts')), 'the dot to clear');
  await sleep(300);
  assert((await cursorIn(page, 'rv.ts')) === '2,4,2,4', 'a save leaves the cursor where it was');
  assert((await blameRequests(app)) === 1, "a save's own echo does not re-request blame");

  writeFileSync(join(root, 'rv.ts'), 'l1\nl2x\nl3\nl4\n');
  await waitForModel(page, 'rv.ts', 'l1\nl2x\nl3\nl4\n');
  await waitFor(async () => (await blameRequests(app)) === 2, 'blame re-requested for new content');
  assert(
    (await cursorIn(page, 'rv.ts')) === '2,4,2,4',
    "an agent's rewrite keeps the cursor where it was",
  );
  await closeTab(page, 'rv.ts');
  log('a save keeps the view and blame; an external change keeps the view, refreshes blame ✓');
}

async function phaseWindowChange({ log }) {
  log(
    'onWindowChange saves on window blur — needs-human-smoke (M12: no renderer blur when hidden)',
  );
}

async function phaseExternalChange({ app, page, root, log, shot }) {
  await setMode(page, 'afterDelay', 500);
  await openFile(page, 'ex.ts');
  await typeAtStart(page, 'mine');
  writeFileSync(join(root, 'ex.ts'), 'theirs\n');
  await banner(page).waitFor({ timeout: 5000 });
  assert(disk(root, 'ex.ts') === 'theirs\n', 'the external change was not clobbered');
  const text = await banner(page).textContent();
  assert(text?.includes('ex.ts changed on disk'), `banner names the file, got "${text}"`);
  assert(text?.includes('Overwrite') && text.includes('Reload from disk'), 'banner actions');
  assert((await conflictMarker(page).count()) === 1, 'the tab shows the conflict marker');
  await shot('conflict-banner');
  await page.keyboard.type('x');
  await sleep(1000);
  assert(
    (await writesTo(app, 'ex.ts')).length === 1,
    'auto-save is paused: an edit in conflict writes nothing',
  );
  await banner(page).locator('button', { hasText: 'Overwrite' }).click();
  await waitFor(() => disk(root, 'ex.ts') === 'minexone\n', 'Overwrite to write the buffer');
  await waitFor(async () => !(await isDirty(page, 'ex.ts')), 'the dot to clear after Overwrite');
  log('an external change is never clobbered; Overwrite writes the buffer ✓');

  await typeAtStart(page, 'more');
  writeFileSync(join(root, 'ex.ts'), 'theirs2\n');
  await banner(page).waitFor({ timeout: 5000 });
  await banner(page).locator('button', { hasText: 'Reload from disk' }).click();
  await waitForModel(page, 'ex.ts', 'theirs2\n');
  await waitFor(async () => !(await isDirty(page, 'ex.ts')), 'no dot after Reload');
  assert((await banner(page).count()) === 0, 'the banner goes away after Reload');
  assert(disk(root, 'ex.ts') === 'theirs2\n', 'Reload wrote nothing');
  await closeTab(page, 'ex.ts');
  log('Reload from disk adopts the disk content ✓');
}

async function phaseFailedSave({ app, page, root, log }) {
  const file = join(root, 'ro.ts');
  await setMode(page, 'afterDelay', 300);
  await openFile(page, 'ro.ts');
  const toasts0 = await page.locator('.toast--error').count();
  chmodSync(file, 0o444);
  try {
    await typeAtStart(page, 'z');
    await page.locator('.viewer__banner--error').waitFor({ timeout: 5000 });
    assert(await isDirty(page, 'ro.ts'), 'a failed save keeps the unsaved dot');
    await page.keyboard.type('z');
    await waitFor(async () => (await writesTo(app, 'ro.ts')).length === 2, 'the second attempt');
    await page.locator('.viewer__banner--error').waitFor({ timeout: 5000 });
    await sleep(300);
    const toasts = (await page.locator('.toast--error').count()) - toasts0;
    assert(toasts === 1, `exactly one error toast for the failure streak, got ${toasts}`);
    assert((await modelValue(page, 'ro.ts')) === 'zzone\n', 'the buffer is kept');
    assert(disk(root, 'ro.ts') === 'one\n', 'nothing reached disk');
    // Still read-only, so the close's own save fails too and falls back to the prompt.
    await closeTab(page, 'ro.ts', 'Discard');
  } finally {
    chmodSync(file, 0o644);
  }
  log('failed save keeps the buffer and does not storm ✓');
}

async function phaseConflictedBackground({ app, page, root, log }) {
  await setMode(page, 'onFocusChange');
  await openFile(page, 'cb1.ts');
  await openFile(page, 'cb2.ts');
  await activate(page, 'cb1.ts');
  await typeAtStart(page, 'mine');
  writeFileSync(join(root, 'cb1.ts'), 'theirs\n');
  await activate(page, 'cb2.ts');
  await conflictMarker(page).waitFor({ timeout: 5000 });
  assert(disk(root, 'cb1.ts') === 'theirs\n', 'the background conflict wrote nothing');
  const before = (await writesTo(app, 'cb1.ts')).length;
  await tab(page, 'cb1.ts').click({ button: 'middle' });
  await page.waitForSelector('.confirm[role="alertdialog"]', { timeout: 5000 });
  const msg = await page.locator('.confirm__msg').first().textContent();
  assert(
    msg?.startsWith("Couldn't save automatically: The file changed on disk."),
    `the prompt names the reason, got "${msg}"`,
  );
  await page.locator('.confirm__actions button', { hasText: 'Save' }).first().click();
  await page.waitForSelector('.confirm[role="alertdialog"]', { state: 'detached', timeout: 5000 });
  await sleep(300);
  assert((await tab(page, 'cb1.ts').count()) === 1, 'Save during a conflict leaves the tab open');
  assert(disk(root, 'cb1.ts') === 'theirs\n', 'Save during a conflict writes nothing');
  assert((await writesTo(app, 'cb1.ts')).length === before, 'no write was even attempted');
  assert((await modelValue(page, 'cb1.ts')) === 'mineone\n', 'the edits are kept');
  await closeTab(page, 'cb1.ts', 'Discard');
  await closeTab(page, 'cb2.ts');
  log('a conflicted background tab keeps its edits ✓');
}

runAutoSave('auto-save', {
  files: {
    ...Object.fromEntries(
      ['ad', 'fc1', 'fc2', 'cl1', 'cl2', 'q', 'ex', 'ro', 'cb1', 'cb2'].map((n) => [
        `${n}.ts`,
        'one\n',
      ]),
    ),
    'eol.ts': 'a\r\nb\n',
    'rv.ts': 'l1\nl2\nl3\n',
  },
  phases: {
    afterDelay: phaseAfterDelay,
    focusTabSwitch: phaseFocusTabSwitch,
    cleanNeverReverts: phaseCleanNeverReverts,
    closeNoPrompt: phaseCloseNoPrompt,
    eolCloseUntouched: phaseEolCloseUntouched,
    reseedKeepsView: phaseReseedKeepsView,
    windowChange: phaseWindowChange,
    externalChange: phaseExternalChange,
    failedSave: phaseFailedSave,
    conflictedBackground: phaseConflictedBackground,
  },
});
