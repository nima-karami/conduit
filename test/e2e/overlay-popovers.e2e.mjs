/**
 * overlay-popovers (spec docs/specs/2026-09-07-overlay-layers.md, plan
 * docs/plans/2026-09-07-overlay-layers.plan.md T3.0) — real-app proof that the two bespoke
 * anchored dropdowns (the compare-refs combobox list and the arch type picker) escape their
 * clipping ancestors by portaling through `Popover`.
 *
 * Findings covered (numbering matches the spec's table):
 *   2. The compare-refs ref combobox's listbox is clipped by the dialog's Neon chamfer at the
 *      base commit (it renders inline, `position: absolute` inside `.cmp-combo`). After the fix
 *      it is a `Popover` portaled to `document.body`.
 *   4. The arch inspector's type picker is clipped by the inspector's own `overflow-y: auto`
 *      scrollport when opened for a port near the bottom of a scrolled list. After the fix it is
 *      a `Popover` anchored to the chip.
 *
 * Not `runScenario`-based: finding 2 needs a specific theme (Neon) seeded into the profile
 * BEFORE first paint (`visual/shoot.mjs:387`'s technique) — `runScenario` launches with no
 * profile hook, so this file drives `launchApp`/`closeApp` directly, the way
 * `arch-node-graph.e2e.mjs` does.
 *
 * Windows only, real app — see CLAUDE.md (run alone on a quiet machine).
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assert, closeApp, launchApp, makeLog, openSession } from './harness.mjs';

const log = makeLog('overlay-popovers');

function git(dir, ...args) {
  return execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
}

/** Seeds a profile on the Neon theme so the very first paint is already themed — the same
 *  technique `visual/shoot.mjs:387`'s `seedProfile` uses. */
function seedNeonProfile() {
  const dir = mkdtempSync(join(tmpdir(), 'conduit-overlay-popovers-ud-'));
  writeFileSync(
    join(dir, 'settings.json'),
    JSON.stringify({ version: 1, settings: { theme: 'neon', restoreSessions: false } }),
  );
  return dir;
}

/** Compare has no band button anymore: it is the picker's trailing "Compare refs…" row
 *  (`visual` fixture precedent: `review-compare.e2e.mjs`'s `openCompareDialog`). */
async function openCompareDialog(page) {
  await page.click('.review__source');
  await page.waitForSelector('.commit-picker', { state: 'visible', timeout: 8000 });
  await page
    .locator('.commit-picker__list .commit-picker__row', { hasText: 'Compare refs…' })
    .click();
  await page.waitForSelector('.compare-dialog', { state: 'visible', timeout: 8000 });
}

let launched;
try {
  launched = await launchApp({ userDataDir: seedNeonProfile() });
  const { app, page } = launched;

  // ── (2) Compare ref combobox list must not be clipped under Neon ───────────────────────────
  const rootA = mkdtempSync(join(tmpdir(), 'conduit-overlay-popovers-cmp-'));
  writeFileSync(join(rootA, 'seed.txt'), 'seed\n');
  git(rootA, 'init', '-q', '-b', 'main');
  git(rootA, 'config', 'user.email', 't@t');
  git(rootA, 'config', 'user.name', 't');
  git(rootA, 'add', '.');
  git(rootA, 'commit', '-qm', 'init seed');
  writeFileSync(join(rootA, 'seed.txt'), 'seed changed\n');

  await openSession(page, { path: rootA });
  await page.waitForFunction(
    () => document.documentElement.getAttribute('data-theme') === 'neon',
    null,
    { timeout: 10000 },
  );
  await page.waitForSelector('.git-indicator__review', { state: 'visible', timeout: 20000 });
  await page.click('.git-indicator__review');
  await page.waitForSelector('.review', { state: 'visible', timeout: 10000 });
  log('session A open on Neon, Review tab open ✓');

  await openCompareDialog(page);
  log('compare dialog open ✓');

  const baseInput = '.compare-dialog__slots .cmp-field:nth-child(1) .cmp-combo__input';
  // The base field autofocuses on dialog mount, which can open-then-immediately-reclose its
  // list once (the focus-triggered scroll-into-view that settles the dialog's own layout is
  // itself an "outside scroll" from the popover's point of view). Blur first so the click below
  // is a real focus transition — the one that matters for this assertion — rather than a no-op
  // click on an element that was already focused.
  await page.evaluate(() => document.activeElement?.blur?.());
  await page.click(baseInput);
  await page.waitForSelector('[role="listbox"]', { state: 'visible', timeout: 5000 });

  const geo2 = await page.evaluate(() => {
    const el = document.querySelector('[role="listbox"]');
    const r = el.getBoundingClientRect();
    return {
      parentIsBody: el.parentElement === document.body,
      parentClass: el.parentElement ? el.parentElement.className : null,
      rect: { x: r.x, y: r.y, w: r.width, h: r.height, bottom: r.bottom },
    };
  });
  const vh2 = await page.evaluate(() => document.documentElement.clientHeight);
  log(
    `(2) measured: parentIsBody=${geo2.parentIsBody} parentClass="${geo2.parentClass}" rect=${JSON.stringify(geo2.rect)} viewportH=${vh2}`,
  );
  assert(
    geo2.parentIsBody,
    `(2) [role=listbox] must be a direct child of body — measured parent class "${geo2.parentClass}"`,
  );
  assert(
    geo2.rect.bottom <= vh2,
    `(2) listbox bottom ${geo2.rect.bottom} must be <= viewport height ${vh2}`,
  );

  const hit2 = await page.evaluate(() => {
    const el = document.querySelector('[role="listbox"]');
    if (!el) return null;
    const rows = el.querySelectorAll('[role="option"]');
    const last = rows[rows.length - 1];
    if (!last) return null;
    const r = last.getBoundingClientRect();
    const hitEl = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
    return el.contains(hitEl);
  });
  assert(hit2, "(2) elementFromPoint at the last option's centre must land inside the listbox");
  log('(2) listbox parented to body, within the viewport, last option hit-tests correctly ✓');

  await page.locator(baseInput).fill('m');
  await page.waitForTimeout(200);
  assert(
    (await page.locator('[role="listbox"]').count()) === 1,
    '(2) the list must stay attached while typing a query',
  );
  log('(2) list stays attached while typing ✓');

  await page.keyboard.press('Escape');
  await page.waitForSelector('[role="listbox"]', { state: 'detached', timeout: 5000 });
  assert(
    await page.locator('.compare-dialog').isVisible(),
    '(2) the dialog must remain open after the first Escape (list-close only)',
  );
  log('(2) first Escape closed only the list; dialog remains open ✓');

  await page.keyboard.press('Escape');
  await page.waitForSelector('.compare-dialog', { state: 'detached', timeout: 5000 });
  log('(2) second Escape closed the dialog ✓');

  // ── (4) arch type picker for the last port in a scrolled inspector ─────────────────────────
  const rootB = mkdtempSync(join(tmpdir(), 'conduit-overlay-popovers-arch-'));
  mkdirSync(join(rootB, '.conduit'), { recursive: true });

  await openSession(page, { path: rootB });
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
  assert(opened, '(4) architecture canvas should open (via the command palette)');
  await page.waitForFunction(() => !!window.__archDoc, null, { timeout: 5000 });
  const gid = await page.evaluate(() => window.__archGraphId);
  const a = await page.evaluate((g) => window.__archDoc.graphs[g].nodes[0].id, gid);
  log('(4) canvas open ✓');

  // Select the node (reveals the ZUI +/- widgets), then add enough input ports that the
  // inspector's port list overflows and must scroll.
  await page.locator(`.react-flow__node[data-id="${a}"] .archnode__head`).click();
  const addIn = page.locator(`.react-flow__node[data-id="${a}"] .archnode__col--in .archport__add`);
  await addIn.waitFor({ state: 'visible', timeout: 5000 });
  const PORT_COUNT = 15;
  for (let i = 0; i < PORT_COUNT; i++) {
    await addIn.click();
    await page.waitForFunction(
      ([g, id, n]) =>
        (window.__archDoc.graphs[g].nodes.find((x) => x.id === id).inputs || []).length === n,
      [gid, a, i + 1],
      { timeout: 5000 },
    );
  }
  log(`(4) added ${PORT_COUNT} input ports ✓`);

  await page.waitForSelector('.arch__inspector', { state: 'visible', timeout: 5000 });
  // Scroll the inspector's port list all the way down so the last chip sits at the very bottom
  // of the (clipped) scrollport — the position the audit named as the reproduction case.
  await page.locator('.arch__inspector').evaluate((el) => {
    el.scrollTop = el.scrollHeight;
  });

  const lastChip = page.locator('.arch__portlist .arch__portrow .typechip').last();
  await lastChip.waitFor({ state: 'visible', timeout: 5000 });
  await lastChip.click();
  await page.waitForSelector('.typepicker', { state: 'visible', timeout: 5000 });

  const geo4 = await page.evaluate(() => {
    const el = document.querySelector('.typepicker');
    const r = el.getBoundingClientRect();
    return {
      parentIsBody: el.parentElement === document.body,
      parentClass: el.parentElement ? el.parentElement.className : null,
      rect: { x: r.x, y: r.y, w: r.width, h: r.height, right: r.right, bottom: r.bottom },
    };
  });
  const viewport4 = await page.evaluate(() => ({
    w: document.documentElement.clientWidth,
    h: document.documentElement.clientHeight,
  }));
  log(
    `(4) measured: parentIsBody=${geo4.parentIsBody} parentClass="${geo4.parentClass}" rect=${JSON.stringify(geo4.rect)} viewport=${JSON.stringify(viewport4)}`,
  );
  assert(
    geo4.parentIsBody,
    `(4) .typepicker must be a direct child of body — measured parent class "${geo4.parentClass}"`,
  );
  assert(
    geo4.rect.x >= 0 &&
      geo4.rect.y >= 0 &&
      geo4.rect.right <= viewport4.w &&
      geo4.rect.bottom <= viewport4.h,
    `(4) .typepicker rect ${JSON.stringify(geo4.rect)} must be fully inside the viewport ${JSON.stringify(viewport4)}`,
  );
  assert(
    await page.locator('.typepicker__search').isVisible(),
    '(4) .typepicker__search must be visible once the picker opens',
  );
  log('(4) type picker parented to body, fully inside the viewport, search field visible ✓');

  await page.locator('.react-flow__pane').click({ position: { x: 40, y: 40 } });
  await page.waitForSelector('.typepicker', { state: 'detached', timeout: 5000 });
  log('(4) outside mousedown on the canvas closed the picker ✓');

  log('all assertions passed ✓');
  await closeApp(app, page);
} catch (err) {
  console.error('[overlay-popovers] FAIL', err);
  if (launched) {
    await launched.page
      .screenshot({ path: join(tmpdir(), 'overlay-popovers-fail.png') })
      .catch(() => {});
    await closeApp(launched.app, launched.page).catch(() => {});
  }
  process.exit(err?.name === 'AssertionError' ? 1 : 2);
}
