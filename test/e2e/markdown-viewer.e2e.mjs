/**
 * Markdown viewer: heading anchors, scoped Ctrl+A, and rich context-menu copy.
 *
 * Covers three reported bugs in the rendered markdown view:
 *  - the heading "#" anchor must NOT be part of a text selection / Select All;
 *  - Ctrl+A must select only the markdown contents, not the whole app;
 *  - the right-click Copy (the Select All → Copy repro) must put rich HTML on the
 *    clipboard (like native Ctrl+C), not just plain text.
 *
 * Driven against the REAL app: opens CHANGELOG.md (lots of headings) in the rendered view.
 */

import { assert, openSession, REPO, runScenario } from './harness.mjs';

const menuItem = (page, label) =>
  page.locator('.ctxmenu__item', { hasText: new RegExp(`^${label}$`) });

runScenario('markdown-viewer', async ({ app, page, log }) => {
  await openSession(page, { path: REPO });
  await page.locator('.rtab', { hasText: 'Files' }).click();

  // Open CHANGELOG.md in the rendered markdown view.
  const row = page.locator('.filerow', {
    has: page.locator('.filerow__name', { hasText: /^CHANGELOG\.md$/ }),
  });
  await row.first().waitFor({ state: 'attached', timeout: 20000 });
  await row.first().click();
  await page
    .locator('.markdown h1, .markdown h2')
    .first()
    .waitFor({ state: 'visible', timeout: 20000 });
  log('CHANGELOG.md rendered ✓');

  // ── Ctrl+A is scoped to the markdown, and the heading "#" is not selected ─────
  await page.locator('.markdown').click({ position: { x: 8, y: 8 } });
  await page.keyboard.press('Control+a');
  const sel = await page.evaluate(() => {
    const s = window.getSelection();
    const md = document.querySelector('.markdown');
    const text = s ? s.toString() : '';
    return {
      anchorInside: !!(s?.anchorNode && md?.contains(s.anchorNode)),
      length: text.length,
      includesToggle: text.includes('View source'), // a sibling button OUTSIDE .markdown
      includesHashHeading: text.includes('#Changelog'), // the old anchor would glue "#" on
    };
  });
  assert(sel.anchorInside, 'Ctrl+A selection should be anchored inside .markdown');
  assert(sel.length > 0, 'Ctrl+A should select the markdown text');
  assert(!sel.includesToggle, 'Ctrl+A must NOT reach outside .markdown (toggle button selected)');
  assert(!sel.includesHashHeading, 'heading anchor "#" must not be part of the selection');
  log('Ctrl+A scoped to markdown + no stray "#" ✓');

  // ── Right-click Select All → Copy puts rich HTML on the clipboard ─────────────
  await app.evaluate(({ clipboard }) => clipboard.clear());

  await page.locator('.markdown').click({ button: 'right', position: { x: 8, y: 8 } });
  await menuItem(page, 'Select All').click();

  await page.locator('.markdown').click({ button: 'right', position: { x: 8, y: 8 } });
  await menuItem(page, 'Copy').click();
  await page.waitForTimeout(400); // async clipboard.write

  const { html, plain } = await app.evaluate(({ clipboard }) => ({
    html: clipboard.readHTML(),
    plain: clipboard.readText(),
  }));
  assert(
    /<(h1|h2|h3|p|ul|li|strong|code)\b/i.test(html),
    `clipboard should hold rendered HTML, got: ${html.slice(0, 120)}`,
  );
  assert(plain.length > 0, 'clipboard should also hold plain text');
  assert(!plain.includes('#Changelog'), 'copied text must not include the heading anchor "#"');
  log('context-menu Copy wrote rich HTML (text/html) + plain text ✓');
});
