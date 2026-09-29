/**
 * split-editor-drag — v1 tab drags between editor groups (docs/specs/2026-09-28-split-editor.md
 * §2.4 flows 3/4, §4 drag rows, §8 drop overlays). Every drag is a real page.mouse press → moves →
 * release, which drives the tab's native HTML5 drag (the board-sessions precedent).
 *   ED  one group: a tab dropped on the right third of the body creates group 2 and moves the tab
 *       there; the half-width edge overlay shows while hovering.
 *   BD  a tab dropped on the other group's body is appended there.
 *   SI  a tab dropped on a tab of the other strip is inserted before it.
 *   CD  Ctrl-drag onto the other strip duplicates; the source tab stays.
 *   OB  a tab dropped on its own group's body changes nothing.
 *   ES  Esc mid-drag changes nothing, and the overlays clear.
 *   PD  a panel re-dock drag is untouched: the strip background still drags the center panel, and
 *       a side panel dragged over the center arms `.centerpane--droptarget`, never a group overlay.
 */

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assert, launchApp, makeLog, openSession } from './harness.mjs';
import {
  G,
  groupCount,
  groupState,
  openFromExplorer,
  same,
  sleep,
  tabOf,
  waitShown,
} from './split-editor-helpers.mjs';

if (process.platform !== 'win32') {
  console.log('[split-editor-drag] SKIP — suite is Windows-only');
  process.exit(0);
}

const log = makeLog('split-editor-drag');

const repo = mkdtempSync(join(tmpdir(), 'conduit-split-drag-'));
for (const n of ['a', 'b', 'c']) writeFileSync(join(repo, `${n}.ts`), `export const ${n} = 1;\n`);
const repoArg = repo.replace(/\\/g, '/');

const center = async (locator, label, fx = 0.5, fy = 0.5) => {
  const box = await locator.boundingBox();
  assert(box, `${label}: no box`);
  return { x: box.x + box.width * fx, y: box.y + box.height * fy };
};
const body = (page, g) => page.locator(`${G(g)} > .editor-group__body`);
const tail = (page, g) => page.locator(`${G(g)} .tabbar__tail`);

/** A real mouse drag from → to; `during` runs while the pointer is held over `to`. */
async function drag(page, from, to, { ctrl = false, during } = {}) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  if (ctrl) await page.keyboard.down('Control');
  const steps = 16;
  for (let i = 1; i <= steps; i++) {
    await page.mouse.move(
      from.x + ((to.x - from.x) * i) / steps,
      from.y + ((to.y - from.y) * i) / steps,
    );
  }
  await sleep(100);
  await page.mouse.move(to.x + 2, to.y + 2);
  const seen = during ? await during() : undefined;
  await page.mouse.up();
  if (ctrl) await page.keyboard.up('Control');
  await sleep(300);
  return seen;
}

const overlays = (page) =>
  page.evaluate(() =>
    [...document.querySelectorAll('.editorgroups__drop')].map((el) => ({
      group: el.getAttribute('data-group'),
      cls: el.className,
      over: el.getAttribute('data-over'),
      width: el.getBoundingClientRect().width,
    })),
  );

const edgeOverlay = (page) =>
  page.evaluate(() => {
    const el = document.querySelector('.editorgroups__drop--edge');
    if (!el) return null;
    const after = getComputedStyle(el, '::after');
    return {
      zone: el.getBoundingClientRect().width,
      tint: after.content !== 'none' ? Number.parseFloat(after.width) : 0,
      bg: after.backgroundColor,
    };
  });

const both = async (page) => ({ g1: await groupState(page, 1), g2: await groupState(page, 2) });

async function phaseEdge(page) {
  for (const n of ['a.ts', 'b.ts', 'c.ts']) await openFromExplorer(page, n);
  assert((await groupCount(page)) === 1, 'ED: starts with one group');
  const from = await center(tabOf(page, 1, 'c.ts'), 'ED tab');
  const to = await center(body(page, 1), 'ED body', 0.88, 0.5);
  const seen = await drag(page, from, to, { during: () => edgeOverlay(page) });
  log('ED: edge overlay mid-drag', JSON.stringify(seen));
  assert(
    seen && seen.tint > 0,
    `ED: no right-half edge overlay while hovering (${JSON.stringify(seen)})`,
  );
  assert(
    Math.abs(seen.tint - seen.zone / 2) <= 2,
    `ED: the edge overlay is not half the body (${JSON.stringify(seen)})`,
  );
  await waitShown(page, 2, 'c.ts', 'ED');
  const s = await both(page);
  assert(same(s.g1.tabs, ['a.ts', 'b.ts']), `ED: group 1 still holds c.ts (${JSON.stringify(s)})`);
  assert(same(s.g2.tabs, ['c.ts']), `ED: group 2 is not [c.ts] (${JSON.stringify(s)})`);
  assert((await overlays(page)).length === 0, 'ED: overlays stay after the drop');
  log('ED ✓ a drop on the right edge creates group 2 with the tab');
}

async function phaseBodyAndStrip(page) {
  const from = await center(tabOf(page, 1, 'a.ts'), 'BD tab');
  const to = await center(body(page, 2), 'BD body');
  const seen = await drag(page, from, to, { during: () => overlays(page) });
  log('BD: overlays mid-drag', JSON.stringify(seen));
  assert(
    seen?.some((o) => o.group === '2' && o.over === 'group'),
    `BD: group 2's body tint did not show (${JSON.stringify(seen)})`,
  );
  await waitShown(page, 2, 'a.ts', 'BD');
  let s = await both(page);
  assert(
    same(s.g2.tabs, ['c.ts', 'a.ts']),
    `BD: a.ts not appended to group 2 (${JSON.stringify(s)})`,
  );
  assert(same(s.g1.tabs, ['b.ts']), `BD: a.ts still in group 1 (${JSON.stringify(s)})`);
  log('BD ✓ a drop on the other body appends');

  const bFrom = await center(tabOf(page, 1, 'b.ts'), 'SI tab');
  const bTo = await center(tabOf(page, 2, 'a.ts'), 'SI target', 0.3, 0.5);
  await drag(page, bFrom, bTo);
  await waitShown(page, 2, 'b.ts', 'SI');
  s = await both(page);
  assert(
    same(s.g2.tabs, ['c.ts', 'b.ts', 'a.ts']),
    `SI: b.ts not inserted before a.ts (${JSON.stringify(s)})`,
  );
  assert(same(s.g1.tabs, []), `SI: group 1 still holds tabs (${JSON.stringify(s)})`);
  log('SI ✓ a drop on the other strip inserts at the drop position');
}

async function phaseCtrlDuplicate(page) {
  const from = await center(tabOf(page, 2, 'b.ts'), 'CD tab');
  const to = await center(tail(page, 1), 'CD tail');
  await drag(page, from, to, { ctrl: true });
  await waitShown(page, 1, 'b.ts', 'CD');
  const s = await both(page);
  assert(same(s.g1.tabs, ['b.ts']), `CD: b.ts not duplicated into group 1 (${JSON.stringify(s)})`);
  assert(
    same(s.g2.tabs, ['c.ts', 'b.ts', 'a.ts']),
    `CD: the source tab left group 2 (${JSON.stringify(s)})`,
  );
  log('CD ✓ Ctrl-drag duplicates and keeps the source');
}

async function phaseNoOps(page) {
  const before = await both(page);
  const from = await center(tabOf(page, 2, 'a.ts'), 'OB tab');
  await drag(page, from, await center(body(page, 2), 'OB body'));
  let s = await both(page);
  assert(same(s.g1.tabs, before.g1.tabs), `OB: group 1 changed (${JSON.stringify(s)})`);
  assert(same(s.g2.tabs, before.g2.tabs), `OB: group 2 changed (${JSON.stringify(s)})`);
  log('OB ✓ a drop on its own group body changes nothing');

  const esFrom = await center(tabOf(page, 2, 'a.ts'), 'ES tab');
  const esTo = await center(body(page, 1), 'ES body');
  const seen = await drag(page, esFrom, esTo, {
    during: async () => {
      const armed = await overlays(page);
      await page.keyboard.press('Escape');
      await sleep(200);
      return { armed, after: await overlays(page) };
    },
  });
  log('ES: overlays before/after Esc', JSON.stringify(seen));
  assert(seen.armed.length > 0, 'ES: the drag never armed the group overlays');
  s = await both(page);
  assert(same(s.g1.tabs, before.g1.tabs), `ES: group 1 changed (${JSON.stringify(s)})`);
  assert(same(s.g2.tabs, before.g2.tabs), `ES: group 2 changed (${JSON.stringify(s)})`);
  assert((await overlays(page)).length === 0, 'ES: overlays stay after the cancelled drag');
  log('ES ✓ Esc mid-drag changes nothing and clears the overlays');
}

async function phasePanelDock(page) {
  const stripFrom = await center(tail(page, 2), 'PD strip');
  const explorer = page.locator('.panel--explorer');
  const seenStrip = await drag(page, stripFrom, await center(explorer, 'PD explorer'), {
    during: async () => ({
      explorerArmed: await explorer.evaluate((el) => el.classList.contains('panel--droptarget')),
      groupOverlays: (await overlays(page)).length,
    }),
  });
  log('PD: strip-background drag', JSON.stringify(seenStrip));
  assert(seenStrip.explorerArmed, 'PD: the strip background no longer drags the center panel');
  assert(seenStrip.groupOverlays === 0, 'PD: a panel drag armed the group overlays');
  const x = (sel) =>
    page.evaluate((s) => document.querySelector(s)?.getBoundingClientRect().x, sel);
  assert(
    (await x('.panel--explorer')) < (await x('.centerpane')),
    'PD: dropping the strip background on the explorer did not re-dock the center panel',
  );

  // The explorer is barless: its tab row's background is its move-drag surface.
  const grip = await page.evaluate(() => {
    const row = document.querySelector('.panel--explorer .rightpane__tabs');
    const box = row?.getBoundingClientRect();
    if (!box) return null;
    const y = box.top + box.height / 2;
    for (let x = box.right - 2; x > box.left; x -= 4) {
      if (document.elementFromPoint(x, y) === row) return { x, y };
    }
    return null;
  });
  assert(grip, 'PD: no background point on the explorer tab row');
  const seenBar = await drag(page, grip, await center(body(page, 1), 'PD center'), {
    during: async () => ({
      centerArmed: await page.evaluate(
        () => !!document.querySelector('.centerpane.centerpane--droptarget'),
      ),
      groupOverlays: (await overlays(page)).length,
    }),
  });
  log('PD: side-panel drag over the center', JSON.stringify(seenBar));
  assert(seenBar.centerArmed, 'PD: .centerpane--droptarget did not appear');
  assert(seenBar.groupOverlays === 0, 'PD: a panel drag armed the group overlays');
  log('PD ✓ panel re-dock drags are untouched');
}

let launched = null;
let code = 0;
try {
  launched = await launchApp({
    userDataDir: mkdtempSync(join(tmpdir(), 'conduit-split-drag-ud-')),
  });
  const { page } = launched;
  await openSession(page, { path: repoArg });
  await phaseEdge(page);
  await phaseBodyAndStrip(page);
  await phaseCtrlDuplicate(page);
  await phaseNoOps(page);
  await phasePanelDock(page);
  log('PASS ✓ split-editor-drag: all assertions passed');
} catch (e) {
  if (e?.name === 'AssertionError') {
    console.log('[split-editor-drag] FAIL ✗', e.message);
    code = 1;
  } else {
    console.error('[split-editor-drag] ERROR:', e?.message || e);
    if (e?.stack) console.error(e.stack);
    code = 2;
  }
}
try {
  await launched?.cleanup();
} catch {
  /* already gone */
}
process.exit(code);
