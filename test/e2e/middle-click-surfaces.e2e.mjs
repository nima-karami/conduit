/**
 * Middle-click opens in a background tab, per surface (docs/specs/2026-09-22-middle-click-new-tab.md
 * §7 AC-4/5/7/10/13): Changes row (S2), search match (S3) and name-only head (S4), oversize diff
 * notice (S9), markdown links (S10), breadcrumb dropdown (S11), palette file row (S12), and a
 * palette file owned by another session (D2). Every open asserts the spec's "unchanged" snapshot.
 *
 * Run: `npm run build`, then `node test/e2e/run-smoke.mjs middle-click-surfaces`.
 */

import {
  assert,
  clearSpyCalls,
  closeApp,
  getSpyCalls,
  openSession,
  runScenario,
  spyMain,
} from './harness.mjs';
import {
  middleClickJitter,
  sameSnapshot,
  snapshotUnchanged,
  statusText,
  tabInfo,
  waitStatus,
  waitTab,
  writeFixtureRepo,
} from './middle-click-fixture.mjs';
import { focusEditor, selectSession, waitActive, waitCursor } from './nav-history-fixture.mjs';

const TOKEN = 'MIDDLETOKEN';
const A_TOKEN_LINE = 150;
const B_TOKEN_LINE = 120;
// file-service MAX_BYTES is 2 MB; a worktree side over it is diffed as the oversize notice.
const OVERSIZE_BYTES = 2 * 1024 * 1024 + 64 * 1024;

function tsBody(stem, lines, tokenLine) {
  const out = [];
  for (let n = 1; n <= lines; n++) out.push(`export const ${stem}${n} = ${n};`);
  if (tokenLine) out[tokenLine - 1] = `export const ${stem}Tok = '${TOKEN}';`;
  return `${out.join('\n')}\n`;
}

function bigBody() {
  const line = `${'x'.repeat(99)}\n`;
  return line.repeat(Math.ceil(OVERSIZE_BYTES / line.length));
}

const exact = (s) => new RegExp(`^${s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`);
const fmt = (tabs) =>
  JSON.stringify(tabs.map((t) => `${t.title}${t.active ? '*' : ''}${t.preview ? '~' : ''}`));

/** Outer (non-peek) Monaco editor state; there is one mounted editor per displayed doc. */
const editorState = (page) =>
  page.evaluate(() => {
    const eds = (window.monaco?.editor.getEditors() ?? []).filter((e) => {
      const n = e.getDomNode();
      return n?.isConnected && !n.closest('.zone-widget');
    });
    const ed = eds[eds.length - 1];
    if (!ed) return null;
    return {
      line: ed.getPosition()?.lineNumber ?? null,
      column: ed.getPosition()?.column ?? null,
      scrollTop: ed.getScrollTop(),
    };
  });

runScenario('middle-click-surfaces', async ({ app, page, log }) => {
  const root = writeFixtureRepo({
    files: {
      'a.ts': tsBody('a', 200, A_TOKEN_LINE),
      'b.ts': tsBody('b', 200, B_TOKEN_LINE),
      'c.ts': tsBody('c', 20),
      'd.ts': tsBody('d', 20),
      'namehit.ts': tsBody('n', 20),
      'palettepick.ts': tsBody('p', 20),
      'dirty.ts': tsBody('dirty', 20),
      'big.txt': 'small\n',
      'zproj/z.ts': tsBody('z', 20),
      'README.md': [
        '# Fixture',
        '',
        '[b link](b.ts)',
        '',
        '[c link](c.ts#x)',
        '',
        // Port 9 is discard: nothing is served, and the spy never calls through anyway.
        '[external link](http://127.0.0.1:9/)',
        '',
      ].join('\n'),
    },
    dirty: {
      'dirty.ts': `${tsBody('dirty', 20)}export const dirtyExtra = 1;\n`,
      'big.txt': bigBody(),
    },
  });

  const sidA = await openSession(page, { path: root });

  /**
   * Middle-click `target` and require a NEW pinned, inactive tab `title`, the exact announcement,
   * and the spec §7 "unchanged" snapshot.
   */
  const expectBackgroundOpen = async (label, target, title, status) => {
    await target.waitFor({ state: 'visible', timeout: 15000 });
    const before = await snapshotUnchanged(page);
    const tabsBefore = await tabInfo(page);
    assert(
      !tabsBefore.some((t) => t.title === title),
      `${label}: precondition — "${title}" must not be open yet; tabs ${fmt(tabsBefore)}`,
    );
    await middleClickJitter(page, target);
    const opened = await waitTab(page, title)
      .then(() => true)
      .catch(() => false);
    assert(
      opened,
      `${label}: middle-click opened no "${title}" tab; tabs ${fmt(await tabInfo(page))}`,
    );
    const announced = await waitStatus(page, status, 8000)
      .then(() => true)
      .catch(() => false);
    assert(
      announced,
      `${label}: status should read "${status}", got ${JSON.stringify(await statusText(page))}`,
    );
    const tabs = await tabInfo(page);
    const tab = tabs.find((t) => t.title === title);
    assert(!tab.preview, `${label}: "${title}" must be pinned, not a preview tab`);
    assert(!tab.active, `${label}: "${title}" must open in the BACKGROUND; tabs ${fmt(tabs)}`);
    assert(
      tabs.length === tabsBefore.length + 1,
      `${label}: expected exactly one new tab; before ${fmt(tabsBefore)}, after ${fmt(tabs)}`,
    );
    const diff = sameSnapshot(before, await snapshotUnchanged(page));
    assert(diff === null, `${label}: background open changed state — ${diff}`);
    log(`${label}: "${title}" opened pinned in the background ✓`);
  };

  // ── 1. a.ts pinned + focused editor ─────────────────────────────────────────────────────
  await page.click('.rtab:has-text("Files")');
  const treeRow = (name) =>
    page.locator('.filerow', { has: page.locator('.filerow__name', { hasText: exact(name) }) });
  await treeRow('a.ts').first().waitFor({ state: 'visible', timeout: 20000 });
  await treeRow('a.ts').first().dblclick();
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

  // ── 2. S2 Changes row ───────────────────────────────────────────────────────────────────
  await page.locator('.rtab', { hasText: 'Changes' }).first().click();
  const changeRow = (file) =>
    page.locator('.change', { has: page.locator('.change__file', { hasText: exact(file) }) });
  await changeRow('dirty.ts').first().waitFor({ state: 'visible', timeout: 20000 });
  await focusEditor(page);
  await expectBackgroundOpen(
    'S2 Changes row',
    changeRow('dirty.ts').first(),
    'dirty.ts (Working Tree)',
    'Opened dirty.ts (Working Tree) in a background tab',
  );

  // ── 3. S3 search matches + AC-5 ─────────────────────────────────────────────────────────
  await page.click('.rtab:has-text("Files")');
  const searchBox = page.locator('.search__inputbox textarea').first();
  await searchBox.fill(TOKEN);
  const group = (file) =>
    page.locator('.searchgroup', {
      has: page.locator('.searchgroup__file', { hasText: exact(file) }),
    });
  const match = (file, line) =>
    group(file)
      .locator('.searchmatch', {
        has: page.locator('.searchmatch__line', { hasText: exact(String(line)) }),
      })
      .first();
  await match('a.ts', A_TOKEN_LINE).waitFor({ state: 'visible', timeout: 20000 });
  await match('b.ts', B_TOKEN_LINE).waitFor({ state: 'visible', timeout: 20000 });
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
    await middleClickJitter(page, match('a.ts', A_TOKEN_LINE));
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
    match('b.ts', B_TOKEN_LINE),
    'b.ts',
    'Opened b.ts in a background tab',
  );

  {
    // L3 scope: a head with matches toggles collapse on left-click; middle must do nothing.
    const head = group('a.ts').locator('.searchgroup__head').first();
    const before = await snapshotUnchanged(page);
    const tabsBefore = await tabInfo(page);
    await middleClickJitter(page, head);
    // A negative can only be observed over a window; 800 ms covers a React commit comfortably.
    await page.waitForTimeout(800);
    const rows = await group('a.ts').locator('.searchmatch').count();
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

  // ── 4. S4 name-only search head ─────────────────────────────────────────────────────────
  await searchBox.fill('namehit');
  const nameHead = group('namehit.ts').locator('.searchgroup__head').first();
  await group('namehit.ts')
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
  await searchBox.fill('');

  // ── 5. S10 markdown links + AC-7 ────────────────────────────────────────────────────────
  await treeRow('README.md').first().waitFor({ state: 'visible', timeout: 15000 });
  await treeRow('README.md').first().click();
  assert(await waitActive(page, 'README.md', 15000), 'S10: README.md never became active');
  const mdLink = (text) => page.locator('.markdown a', { hasText: text }).first();
  await mdLink('external link').waitFor({ state: 'visible', timeout: 15000 });

  await spyMain(app, [{ api: 'openExternal' }]);
  await clearSpyCalls(app);
  {
    const before = await snapshotUnchanged(page);
    const tabsBefore = await tabInfo(page);
    await middleClickJitter(page, mdLink('external link'));
    const externalCalls = async () =>
      (await getSpyCalls(app)).filter((c) => c.api === 'openExternal');
    const deadline = Date.now() + 5000;
    while ((await externalCalls()).length === 0 && Date.now() < deadline) {
      await page.waitForTimeout(100);
    }
    // A duplicate host-side open (C5) would land after the renderer's; give it time to show.
    await page.waitForTimeout(800);
    const calls = await externalCalls();
    assert(
      calls.length === 1,
      `AC-7: expected exactly one host openExternal, got ${calls.length}: ${JSON.stringify(calls.map((c) => c.args))}`,
    );
    assert(
      String(calls[0].args[0]).startsWith('http://127.0.0.1:9'),
      `AC-7: openExternal got the wrong URL ${JSON.stringify(calls[0].args)}`,
    );
    const tabs = await tabInfo(page);
    assert(
      tabs.length === tabsBefore.length,
      `AC-7: an external link must add no tab; before ${fmt(tabsBefore)}, after ${fmt(tabs)}`,
    );
    const diff = sameSnapshot(before, await snapshotUnchanged(page));
    assert(diff === null, `AC-7: state changed — ${diff}`);
    log('AC-7 external markdown link: one openExternal, no tab ✓');
  }

  {
    const before = await snapshotUnchanged(page);
    const tabsBefore = await tabInfo(page);
    await middleClickJitter(page, mdLink('b link'));
    const announced = await waitStatus(page, 'b.ts is already open', 8000)
      .then(() => true)
      .catch(() => false);
    assert(
      announced,
      `S10 b.ts link: status should read "b.ts is already open", got ${JSON.stringify(await statusText(page))}`,
    );
    const tabs = await tabInfo(page);
    assert(
      tabs.length === tabsBefore.length,
      `S10 b.ts link: already-open must add no tab; after ${fmt(tabs)}`,
    );
    const diff = sameSnapshot(before, await snapshotUnchanged(page));
    assert(diff === null, `S10 b.ts link: state changed — ${diff}`);
    log('S10 link to an open file: "already open", nothing changes ✓');
  }

  await expectBackgroundOpen(
    'S10 markdown link with #fragment',
    mdLink('c link'),
    'c.ts',
    'Opened c.ts in a background tab',
  );
  assert(
    (await tabInfo(page)).find((t) => t.active)?.title === 'README.md',
    'S10: README.md must stay the active tab',
  );

  // ── 6. S11 breadcrumb dropdown ──────────────────────────────────────────────────────────
  await page
    .locator('.breadcrumb-bar__seg', { hasText: exact('README.md') })
    .first()
    .click();
  const crumbItem = page.locator('.ctxmenu__item', { hasText: exact('d.ts') }).first();
  await crumbItem.waitFor({ state: 'visible', timeout: 15000 });
  await expectBackgroundOpen(
    'S11 breadcrumb dropdown',
    crumbItem,
    'd.ts',
    'Opened d.ts in a background tab',
  );
  const menuClosed = await page
    .waitForSelector('.ctxmenu', { state: 'detached', timeout: 5000 })
    .then(() => true)
    .catch(() => false);
  assert(menuClosed, 'S11: the breadcrumb dropdown should close after a middle-click select');

  // ── 7. S12 palette + AC-10 ──────────────────────────────────────────────────────────────
  const paletteRow = (title) =>
    page
      .locator('.palette__row', { has: page.locator('.palette__title', { hasText: exact(title) }) })
      .first();
  const openPalette = async (query) => {
    await page.click('.omnibar');
    await page.waitForSelector('.palette__input', { state: 'visible', timeout: 10000 });
    await page.fill('.palette__input', query);
  };
  await openPalette('palettepick');
  await paletteRow('palettepick.ts').waitFor({ state: 'visible', timeout: 15000 });
  await expectBackgroundOpen(
    'S12 palette file row',
    paletteRow('palettepick.ts'),
    'palettepick.ts',
    'Opened palettepick.ts in a background tab',
  );
  assert(
    await page.locator('.palette').first().isVisible(),
    'AC-10: the palette must stay open after a middle-click',
  );
  assert(
    await page.evaluate(
      () => document.activeElement?.classList.contains('palette__input') ?? false,
    ),
    'AC-10: .palette__input must keep focus',
  );
  log('AC-10 palette stays open with its input focused ✓');
  await page.keyboard.press('Escape');
  await page.waitForSelector('.palette', { state: 'detached', timeout: 5000 });

  // ── 8. S9 oversize diff notice ──────────────────────────────────────────────────────────
  await page.locator('.rtab', { hasText: 'Changes' }).first().click();
  await changeRow('big.txt').first().waitFor({ state: 'visible', timeout: 15000 });
  await changeRow('big.txt').first().click();
  assert(
    await waitActive(page, 'big.txt (Working Tree)', 15000),
    'S9: the big.txt diff tab never became active',
  );
  const openFileBtn = page.locator('.viewer__notice-action', { hasText: 'Open file' }).first();
  await openFileBtn.waitFor({ state: 'visible', timeout: 15000 });
  await expectBackgroundOpen(
    'S9 oversize notice "Open file"',
    openFileBtn,
    'big.txt',
    'Opened big.txt in a background tab',
  );

  // ── 9. AC-13 cross-session (D2) ─────────────────────────────────────────────────────────
  // B's root nests inside A's, so A's palette lists zproj/z.ts while resolveOwningSession
  // hands it to B (longest ancestor).
  const sidB = await openSession(page, { path: `${root}/zproj` });
  await page.waitForFunction(
    (id) =>
      document.querySelector('.session.session--active')?.getAttribute('data-sessionid') === id,
    sidB,
    { timeout: 10000 },
  );
  const bName = await page.evaluate(
    (id) => (window.__sessions || []).find((s) => s.id === id)?.name ?? null,
    sidB,
  );
  assert(bName, 'AC-13: session B has no name in window.__sessions');
  await selectSession(page, sidA);
  // A's strip can paint a frame before its remembered doc is restored; the baseline must be the
  // settled strip, with A's last active doc (the S9 diff) back on top.
  assert(
    await waitActive(page, 'big.txt (Working Tree)', 10000),
    "AC-13: A's strip did not come back with its remembered doc after switching to A",
  );

  const aTabsBefore = await tabInfo(page);
  await openPalette('z.ts');
  await paletteRow('zproj/z.ts').waitFor({ state: 'visible', timeout: 15000 });
  {
    const before = await snapshotUnchanged(page);
    await middleClickJitter(page, paletteRow('zproj/z.ts'));
    const status = `Opened z.ts in a background tab in ${bName}`;
    const announced = await waitStatus(page, status, 8000)
      .then(() => true)
      .catch(() => false);
    assert(
      announced,
      `AC-13: status should read "${status}", got ${JSON.stringify(await statusText(page))}`,
    );
    const aTabs = await tabInfo(page);
    assert(
      fmt(aTabs) === fmt(aTabsBefore),
      `AC-13: A's strip changed ${fmt(aTabsBefore)} → ${fmt(aTabs)}`,
    );
    const diff = sameSnapshot(before, await snapshotUnchanged(page));
    assert(diff === null, `AC-13: state changed — ${diff}`);
  }
  await page.keyboard.press('Escape');
  await page.waitForSelector('.palette', { state: 'detached', timeout: 5000 });

  await selectSession(page, sidB);
  const zOpen = await waitTab(page, 'z.ts')
    .then(() => true)
    .catch(() => false);
  assert(zOpen, `AC-13: B's strip has no z.ts tab; tabs ${fmt(await tabInfo(page))}`);
  const bTabs = await tabInfo(page);
  const zTab = bTabs.find((t) => t.title === 'z.ts');
  assert(!zTab.preview, 'AC-13: z.ts must be pinned in B');
  assert(
    !bTabs.some((t) => t.active),
    `AC-13: B's remembered active doc (the terminal) must not change; tabs ${fmt(bTabs)}`,
  );
  log(`AC-13 cross-session: z.ts landed pinned in "${bName}", A untouched ✓`);

  // ── AC-4: a background search-match tab opens at its line when later activated ─────────
  await selectSession(page, sidA);
  const bBack = await waitTab(page, 'b.ts')
    .then(() => true)
    .catch(() => false);
  assert(bBack, "AC-4: b.ts is missing from A's strip after switching back");
  await page
    .locator('.tabbar [role="tab"]', { has: page.locator('span', { hasText: exact('b.ts') }) })
    .first()
    .click();
  assert(await waitActive(page, 'b.ts', 15000), 'AC-4: b.ts never became active');
  assert(
    await waitCursor(page, B_TOKEN_LINE, 15000),
    `AC-4: activating b.ts should land on its match line ${B_TOKEN_LINE}, got ${JSON.stringify(await editorState(page))}`,
  );
  log(`AC-4 b.ts opens at line ${B_TOKEN_LINE} when first activated ✓`);

  await closeApp(app, page);
});
