/**
 * Shared fixture and drivers for the middle-click-surfaces scenarios
 * (docs/specs/2026-09-22-middle-click-new-tab.md §7). NOT a scenario — the runner only picks up
 * `*.e2e.mjs`.
 */

import { assert } from './harness.mjs';
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
import { focusEditor, waitActive } from './nav-history-fixture.mjs';

export const TOKEN = 'MIDDLETOKEN';
export const A_TOKEN_LINE = 150;
export const B_TOKEN_LINE = 120;
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

export const exact = (s) => new RegExp(`^${s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`);
export const fmt = (tabs) =>
  JSON.stringify(tabs.map((t) => `${t.title}${t.active ? '*' : ''}${t.preview ? '~' : ''}`));

/** Outer (non-peek) Monaco editor state; there is one mounted editor per displayed doc. */
export const editorState = (page) =>
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

export function writeSurfacesRepo() {
  return writeFixtureRepo({
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
}

export const treeRow = (page, name) =>
  page.locator('.filerow', { has: page.locator('.filerow__name', { hasText: exact(name) }) });
export const changeRow = (page, file) =>
  page.locator('.change', { has: page.locator('.change__file', { hasText: exact(file) }) });
export const searchBox = (page) => page.locator('.search__inputbox textarea').first();
export const group = (page, file) =>
  page.locator('.searchgroup', {
    has: page.locator('.searchgroup__file', { hasText: exact(file) }),
  });
export const match = (page, file, line) =>
  group(page, file)
    .locator('.searchmatch', {
      has: page.locator('.searchmatch__line', { hasText: exact(String(line)) }),
    })
    .first();

/**
 * Middle-click `target` and require a NEW pinned, inactive tab `title`, the exact announcement,
 * and the spec §7 "unchanged" snapshot.
 */
export const backgroundOpener = (page, log) => async (label, target, title, status) => {
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

/**
 * Replays middle-click-surfaces-search's setup, S2 and S3 background opens without their
 * assertions: a.ts pinned and focused, dirty.ts (Working Tree) and then b.ts opened in the
 * background (b.ts from its search match, so it has never been activated). Leaves the search box
 * empty.
 */
export async function replayPinnedAWithBackgroundB(page) {
  await page.click('.rtab:has-text("Files")');
  await treeRow(page, 'a.ts').first().waitFor({ state: 'visible', timeout: 20000 });
  await treeRow(page, 'a.ts').first().dblclick();
  await waitActive(page, 'a.ts', 15000);
  await page.waitForSelector('.monaco-editor', { state: 'visible', timeout: 15000 });
  await focusEditor(page);

  await page.locator('.rtab', { hasText: 'Changes' }).first().click();
  await changeRow(page, 'dirty.ts').first().waitFor({ state: 'visible', timeout: 20000 });
  await focusEditor(page);
  await middleClickJitter(page, changeRow(page, 'dirty.ts').first());
  await waitTab(page, 'dirty.ts (Working Tree)');

  await page.click('.rtab:has-text("Files")');
  await searchBox(page).fill(TOKEN);
  await match(page, 'a.ts', A_TOKEN_LINE).waitFor({ state: 'visible', timeout: 20000 });
  await match(page, 'b.ts', B_TOKEN_LINE).waitFor({ state: 'visible', timeout: 20000 });
  await focusEditor(page);
  await middleClickJitter(page, match(page, 'b.ts', B_TOKEN_LINE));
  await waitTab(page, 'b.ts');
  await searchBox(page).fill('');
}

export const paletteRow = (page, title) =>
  page
    .locator('.palette__row', { has: page.locator('.palette__title', { hasText: exact(title) }) })
    .first();

export async function openPalette(page, query) {
  await page.click('.omnibar');
  await page.waitForSelector('.palette__input', { state: 'visible', timeout: 10000 });
  await page.fill('.palette__input', query);
}
