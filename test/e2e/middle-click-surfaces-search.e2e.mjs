/**
 * Middle-click opens in a background tab, per surface (docs/specs/2026-09-22-middle-click-new-tab.md
 * §7 AC-5): Changes row (S2), search match (S3) and name-only head (S4), plus a match in the active
 * file and a non-name-only head doing nothing. Every open asserts the spec's "unchanged" snapshot.
 * The other surfaces are in middle-click-surfaces-links and -sessions.
 *
 * Run: `npm run build`, then `node test/e2e/run-smoke.mjs middle-click-surfaces-search`.
 */

import { assert, closeApp, openSession, phase, runScenario } from './harness.mjs';
import {
  middleClickJitter,
  sameSnapshot,
  snapshotUnchanged,
  statusText,
  tabInfo,
  waitStatus,
} from './middle-click-fixture.mjs';
import {
  A_TOKEN_LINE,
  B_TOKEN_LINE,
  backgroundOpener,
  changeRow,
  editorState,
  fmt,
  group,
  match,
  searchBox,
  TOKEN,
  treeRow,
  writeSurfacesRepo,
} from './middle-click-surfaces-helpers.mjs';
import { focusEditor, waitActive } from './nav-history-fixture.mjs';

runScenario('middle-click-surfaces-search', async ({ app, page, log }) => {
  const root = writeSurfacesRepo();
  await openSession(page, { path: root });
  const expectBackgroundOpen = backgroundOpener(page, log);

  phase('setup');
  await page.click('.rtab:has-text("Files")');
  await treeRow(page, 'a.ts').first().waitFor({ state: 'visible', timeout: 20000 });
  await treeRow(page, 'a.ts').first().dblclick();
  assert(await waitActive(page, 'a.ts', 15000), 'setup: a.ts never became the active tab');
  assert(
    !(await tabInfo(page)).find((t) => t.title === 'a.ts')?.preview,
    'setup: a dblclick should pin a.ts',
  );
  await page.waitForSelector('.monaco-editor', { state: 'visible', timeout: 15000 });
  await focusEditor(page);
  const focused = await page
    .waitForFunction(() => !!document.activeElement?.closest('.monaco-editor'), null, {
      timeout: 5000,
    })
    .then(() => true)
    .catch(() => false);
  assert(focused, 'setup: the a.ts editor should hold focus');
  log('setup: a.ts active, pinned, editor focused ✓');

  phase('S2 Changes row');
  await page.locator('.rtab', { hasText: 'Changes' }).first().click();
  await changeRow(page, 'dirty.ts').first().waitFor({ state: 'visible', timeout: 20000 });
  await focusEditor(page);
  await expectBackgroundOpen(
    'S2 Changes row',
    changeRow(page, 'dirty.ts').first(),
    'dirty.ts (Working Tree)',
    'Opened dirty.ts (Working Tree) in a background tab',
  );

  phase('S3 search matches');
  await page.click('.rtab:has-text("Files")');
  await searchBox(page).fill(TOKEN);
  await match(page, 'a.ts', A_TOKEN_LINE).waitFor({ state: 'visible', timeout: 20000 });
  await match(page, 'b.ts', B_TOKEN_LINE).waitFor({ state: 'visible', timeout: 20000 });
  await focusEditor(page);

  {
    const before = await snapshotUnchanged(page);
    const tabsBefore = await tabInfo(page);
    const edBefore = await editorState(page);
    assert(edBefore, 'AC-5: no mounted a.ts editor to read');
    assert(
      edBefore.line !== A_TOKEN_LINE,
      `AC-5 precondition: the cursor must not already be on line ${A_TOKEN_LINE}`,
    );
    await middleClickJitter(page, match(page, 'a.ts', A_TOKEN_LINE));
    const announced = await waitStatus(page, 'a.ts is already open', 8000)
      .then(() => true)
      .catch(() => false);
    assert(
      announced,
      `AC-5: status should read "a.ts is already open", got ${JSON.stringify(await statusText(page))}`,
    );
    const edAfter = await editorState(page);
    assert(
      JSON.stringify(edAfter) === JSON.stringify(edBefore),
      `AC-5: middle on the active file's match moved the editor ${JSON.stringify(edBefore)} → ${JSON.stringify(edAfter)}`,
    );
    const tabs = await tabInfo(page);
    assert(
      tabs.length === tabsBefore.length,
      `AC-5: no tab may be added; before ${fmt(tabsBefore)}, after ${fmt(tabs)}`,
    );
    const diff = sameSnapshot(before, await snapshotUnchanged(page));
    assert(diff === null, `AC-5: state changed — ${diff}`);
    log('AC-5 match in the active file: cursor/scroll unchanged, "already open" ✓');
  }

  await focusEditor(page);
  await expectBackgroundOpen(
    'S3 search match',
    match(page, 'b.ts', B_TOKEN_LINE),
    'b.ts',
    'Opened b.ts in a background tab',
  );

  {
    // L3 scope: a head with matches toggles collapse on left-click; middle must do nothing.
    const head = group(page, 'a.ts').locator('.searchgroup__head').first();
    const before = await snapshotUnchanged(page);
    const tabsBefore = await tabInfo(page);
    await middleClickJitter(page, head);
    // A negative can only be observed over a window; 800 ms covers a React commit comfortably.
    await page.waitForTimeout(800);
    const rows = await group(page, 'a.ts').locator('.searchmatch').count();
    assert(rows === 1, `S4 non-name-only head: middle-click collapsed the group (${rows} rows)`);
    const tabs = await tabInfo(page);
    assert(
      tabs.length === tabsBefore.length,
      `S4 non-name-only head: middle must open nothing; after ${fmt(tabs)}`,
    );
    const diff = sameSnapshot(before, await snapshotUnchanged(page));
    assert(diff === null, `S4 non-name-only head: state changed — ${diff}`);
    log('S4 non-name-only head: middle is a no-op, rows stay rendered ✓');
  }

  phase('S4 name-only head');
  await searchBox(page).fill('namehit');
  const nameHead = group(page, 'namehit.ts').locator('.searchgroup__head').first();
  await group(page, 'namehit.ts')
    .locator('.searchgroup__namebadge')
    .first()
    .waitFor({ state: 'visible', timeout: 20000 });
  await focusEditor(page);
  await expectBackgroundOpen(
    'S4 name-only head',
    nameHead,
    'namehit.ts',
    'Opened namehit.ts in a background tab',
  );

  await closeApp(app, page);
});
