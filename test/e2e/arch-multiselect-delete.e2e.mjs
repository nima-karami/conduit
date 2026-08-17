/**
 * Architecture canvas — right-click scoping against a multi-selection (real-app smoke).
 *
 * Covers the selection-aware-context-menus spec §5/§14 D. The unit test pins the menu ARRAY;
 * this pins the two things it structurally cannot: that the collapse actually repaints the canvas
 * before the menu paints over it, and that a multi-delete is ONE history entry against the real
 * doc (one Ctrl+Z brings both components back).
 *
 * Selection is controlled from `selectedIds` (the canvas sets `selected:` on each React Flow node
 * explicitly), so `.react-flow__node.selected` is a deterministic assertion rather than a race
 * against React Flow's internal store. Observes the live document via `window.__archDoc`, the same
 * read-only snapshot arch-node-graph.e2e.mjs uses. Runs HIDDEN.
 */

import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assert, openSession, runScenario } from './harness.mjs';

/** The rendered menu rows in order: {label, danger, disabled}. */
const menuRows = (page) =>
  page.evaluate(() => {
    const root = document.querySelector('.ctxmenu .ctxmenu__scroll');
    if (!root) throw new Error('.ctxmenu__scroll not found — the menu item container moved');
    return Array.from(root.children).map((wrap) => {
      const item = wrap.querySelector('.ctxmenu__item');
      return {
        label: item?.querySelector('span:last-child')?.textContent?.trim() ?? '',
        danger: !!item?.classList.contains('ctxmenu__item--danger'),
        disabled: !!item?.disabled,
      };
    });
  });

runScenario('arch-multiselect-delete', async ({ page, log }) => {
  // Throwaway project: applyDoc persists, so this must never touch the repo's own architecture.
  const tmpProject = mkdtempSync(join(tmpdir(), 'conduit-archsel-'));
  mkdirSync(join(tmpProject, '.conduit'), { recursive: true });
  await openSession(page, { path: tmpProject });

  // Open the canvas via the command palette. Retried: on a saturated machine the shortcut
  // occasionally doesn't register (env flake, not a product bug) — same preamble as arch-node-graph.
  await page.waitForSelector('.xterm-helper-textarea', { state: 'attached', timeout: 20000 });
  let opened = false;
  for (let attempt = 0; attempt < 4 && !opened; attempt++) {
    await page
      .locator('.xterm-helper-textarea')
      .first()
      .focus()
      .catch(() => {});
    await page.keyboard.press('Control+Backquote');
    await page.waitForTimeout(250);
    await page.keyboard.press('Control+Shift+P');
    const palette = await page
      .waitForSelector('.palette', { state: 'visible', timeout: 3000 })
      .then(() => true)
      .catch(() => false);
    if (!palette) continue;
    await page.keyboard.type('architecture');
    await page.keyboard.press('Enter');
    opened = await page
      .waitForSelector('.archnode', { timeout: 6000 })
      .then(() => true)
      .catch(() => false);
    if (!opened) await page.keyboard.press('Escape').catch(() => {});
  }
  assert(opened, 'architecture canvas should open (via the command palette)');
  await page.waitForFunction(() => !!window.__archDoc, null, { timeout: 5000 });

  const gid = await page.evaluate(() => window.__archGraphId);
  const nodeIds = await page.evaluate(
    (g) => window.__archDoc.graphs[g].nodes.map((n) => n.id),
    gid,
  );
  assert(nodeIds.length >= 2, `seed graph needs 2+ nodes (got ${nodeIds.length})`);
  const [a, b] = nodeIds;
  const body = (id) => page.locator(`.react-flow__node[data-id="${id}"] .archnode__body`).first();
  const selectedCount = () => page.locator('.react-flow__node.selected').count();
  log(`canvas open with ${nodeIds.length} nodes ✓`);

  const expectSelected = async (n, label) => {
    const ok = await page
      .waitForFunction(
        (want) => document.querySelectorAll('.react-flow__node.selected').length === want,
        n,
        { timeout: 5000 },
      )
      .then(() => true)
      .catch(() => false);
    assert(ok, `${label}: expected ${n} selected (got ${await selectedCount()})`);
    log(`${label}: ${n} selected ✓`);
  };

  // ── Collapse leg: right-clicking a node OUTSIDE the selection collapses onto it ──
  await body(a).click();
  await expectSelected(1, 'click node A');
  await body(b).click({ button: 'right' });
  await page.waitForSelector('.ctxmenu', { state: 'visible', timeout: 8000 });
  await page.waitForTimeout(120);
  await expectSelected(1, 'right-click node B collapses onto it');
  const bSelected = await page.locator(`.react-flow__node[data-id="${b}"].selected`).count();
  assert(bSelected === 1, 'the collapsed selection must be the RIGHT-CLICKED node');
  const soloRows = await menuRows(page);
  assert(
    soloRows[soloRows.length - 1].label === 'Delete component',
    `a single target must read "Delete component" (got ${soloRows[soloRows.length - 1].label})`,
  );
  await page.keyboard.press('Escape');
  await page.waitForSelector('.ctxmenu', { state: 'detached', timeout: 5000 });
  log('collapse leg ✓');

  // ── Multi leg: right-clicking INSIDE the selection preserves it and scopes Delete ──
  await body(a).click();
  await body(b).click({ modifiers: ['Control'] });
  await expectSelected(2, 'ctrl-click node B extends the selection');

  await body(a).click({ button: 'right' });
  await page.waitForSelector('.ctxmenu', { state: 'visible', timeout: 8000 });
  await page.waitForTimeout(120);
  await expectSelected(2, 'selection preserved under the open menu');

  const rows = await menuRows(page);
  log('menu:', JSON.stringify(rows.map((r) => r.label)));
  const last = rows[rows.length - 1];
  assert(
    last.label === 'Delete 2 components',
    `last item should read "Delete 2 components" (got ${last.label})`,
  );
  assert(last.danger, 'the destructive item must carry the danger class');
  for (const label of ['Rename…', 'Set icon…', 'Duplicate', 'Copy name']) {
    const row = rows.find((r) => r.label === label);
    assert(row, `menu should still offer "${label}"`);
    assert(row.disabled, `"${label}" must be disabled while 2 components are targeted`);
  }
  const group = rows.find((r) => r.label === 'Group selection');
  assert(
    group && !group.disabled,
    'Group selection must be offered and enabled for a multi-select',
  );

  // ── The delete lands on the real document, and is ONE history entry ──
  await page.locator('.ctxmenu__item--danger').last().click();
  const gone = await page
    .waitForFunction(
      ([g, ids]) => {
        const ns = window.__archDoc.graphs[g].nodes.map((n) => n.id);
        return ids.every((id) => !ns.includes(id));
      },
      [gid, [a, b]],
      { timeout: 8000 },
    )
    .then(() => true)
    .catch(() => false);
  assert(gone, 'both selected components should be gone from the document');
  log('both components deleted from the doc ✓');

  await page.keyboard.press('Control+z');
  const restored = await page
    .waitForFunction(
      ([g, ids]) => {
        const ns = window.__archDoc.graphs[g].nodes.map((n) => n.id);
        return ids.every((id) => ns.includes(id));
      },
      [gid, [a, b]],
      { timeout: 8000 },
    )
    .then(() => true)
    .catch(() => false);
  assert(restored, 'one undo must restore BOTH components — a multi-delete is one history entry');
  log('single undo restored both ✓');
});
