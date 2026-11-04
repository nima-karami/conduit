/**
 * tab-drag-to-terminal — dragging an open file tab onto the terminal pastes the file's path at the
 * prompt, like an explorer drag (terminal-drop). Every drag is a real page.mouse press → moves →
 * release, which drives the tab's native HTML5 drag (split-editor-drag's precedent).
 *   TP  one group showing the terminal: a group-1 file tab dropped on the terminal's left side
 *       pastes its path; no tab moves and the overlays clear.
 *   ED  same layout: the right-third edge drop still splits the tab into group 2.
 *   XG  split: a group-2 file tab dropped on group 1's terminal pastes its path; no tab moves.
 * Each pasted file has its own name, so a late ConPTY repaint of one paste can't pass the next.
 */

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assert, finishScenario, launchApp, makeLog, openSession, profileDir } from './harness.mjs';
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
  console.log('[tab-drag-to-terminal] SKIP — suite is Windows-only');
  await finishScenario(0);
}

const log = makeLog('tab-drag-to-terminal');

const A = 'tabterm_tpa';
const B = 'tabterm_xgb';
const fileA = `${A}.ts`;
const fileB = `${B}.ts`;
const repo = mkdtempSync(join(tmpdir(), 'conduit-tab-term-'));
writeFileSync(join(repo, fileA), 'export const a = 1;\n');
writeFileSync(join(repo, fileB), 'export const b = 2;\n');
const repoArg = repo.replace(/\\/g, '/');

const center = async (locator, label, fx = 0.5, fy = 0.5) => {
  const box = await locator.boundingBox();
  assert(box, `${label}: no box`);
  return { x: box.x + box.width * fx, y: box.y + box.height * fy };
};
const body = (page, g) => page.locator(`${G(g)} > .editor-group__body`);
const terminalShown = (page) => page.locator(`${G(1)} button[data-tabid][aria-pressed="true"]`);

/** A real mouse drag from → to; `during` runs while the pointer is held over `to`. */
async function drag(page, from, to, { during } = {}) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
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
  await sleep(300);
  return seen;
}

const overlays = (page) =>
  page.evaluate(() =>
    [...document.querySelectorAll('.editorgroups__drop')].map((el) => ({
      group: el.getAttribute('data-group'),
      hit: el.getAttribute('data-hit'),
      over: el.getAttribute('data-over'),
    })),
  );

const both = async (page) => ({ g1: await groupState(page, 1), g2: await groupState(page, 2) });

async function showTerminal(page, label) {
  await page.locator(`${G(1)} button[data-tabid][aria-pressed]`).click();
  await terminalShown(page)
    .waitFor({ timeout: 5000 })
    .catch(() => assert(false, `${label}: group 1 never showed the terminal`));
  await page
    .waitForFunction(
      () => [...document.querySelectorAll('.termpane')].some((el) => el.offsetWidth > 0),
      null,
      { timeout: 10000 },
    )
    .catch(() => assert(false, `${label}: no visible terminal pane`));
}

/** Asserts `name` reaches `sid`'s shell (echoed at the prompt) after the drop. */
async function assertPasted(page, sid, name, label) {
  const ok = await page
    .waitForFunction(
      ({ s, t }) => (window.__capBy?.[s] ?? '').includes(t),
      { s: sid, t: name },
      {
        timeout: 20000,
      },
    )
    .then(() => true)
    .catch(() => false);
  assert(ok, `${label}: the tab's path never reached the shell prompt`);
}

async function phaseTerminalPaste(page, sid) {
  await openFromExplorer(page, fileA);
  await openFromExplorer(page, fileB);
  await showTerminal(page, 'TP');
  const before = await both(page);
  const from = await center(tabOf(page, 1, fileA), 'TP tab');
  const to = await center(body(page, 1), 'TP terminal', 0.3, 0.5);
  const seen = await drag(page, from, to, { during: () => overlays(page) });
  log('TP: overlays mid-drag', JSON.stringify(seen));
  assert(
    !seen.some((o) => o.over === 'group'),
    `TP: a group overlay took the terminal drop (${JSON.stringify(seen)})`,
  );
  await assertPasted(page, sid, A, 'TP');
  const s = await both(page);
  assert((await groupCount(page)) === 1, `TP: a group was created (${JSON.stringify(s)})`);
  assert(same(s.g1.tabs, before.g1.tabs), `TP: group 1's tabs changed (${JSON.stringify(s)})`);
  assert((await overlays(page)).length === 0, 'TP: overlays stay after the drop');
  assert((await terminalShown(page).count()) === 1, 'TP: group 1 stopped showing the terminal');
  log('TP ✓ a file tab dropped on the terminal pastes its path; no tab moved');
}

async function phaseEdgeSplit(page) {
  const from = await center(tabOf(page, 1, fileB), 'ED tab');
  const to = await center(body(page, 1), 'ED body', 0.88, 0.5);
  const seen = await drag(page, from, to, { during: () => overlays(page) });
  log('ED: overlays mid-drag', JSON.stringify(seen));
  assert(
    seen.some((o) => o.group === '1' && o.hit === 'edge' && o.over === 'edge'),
    `ED: the edge zone never armed over the terminal (${JSON.stringify(seen)})`,
  );
  await waitShown(page, 2, fileB, 'ED');
  const s = await both(page);
  assert(same(s.g2.tabs, [fileB]), `ED: group 2 is not [${fileB}] (${JSON.stringify(s)})`);
  log('ED ✓ the right-edge drop over the terminal still splits the tab into group 2');
}

async function phaseCrossGroupPaste(page, sid) {
  await showTerminal(page, 'XG');
  const before = await both(page);
  const echoedEarly = await page.evaluate(({ s, t }) => (window.__capBy?.[s] ?? '').includes(t), {
    s: sid,
    t: B,
  });
  assert(!echoedEarly, `XG: ${fileB}'s path reached the shell before its drop`);
  const from = await center(tabOf(page, 2, fileB), 'XG tab');
  const to = await center(body(page, 1), 'XG terminal');
  const seen = await drag(page, from, to, { during: () => overlays(page) });
  log('XG: overlays mid-drag', JSON.stringify(seen));
  assert(
    !seen.some((o) => o.group === '1'),
    `XG: group 1's overlay still covers the terminal (${JSON.stringify(seen)})`,
  );
  await assertPasted(page, sid, B, 'XG');
  const s = await both(page);
  assert(same(s.g1.tabs, before.g1.tabs), `XG: group 1's tabs changed (${JSON.stringify(s)})`);
  assert(same(s.g2.tabs, before.g2.tabs), `XG: group 2's tabs changed (${JSON.stringify(s)})`);
  assert((await overlays(page)).length === 0, 'XG: overlays stay after the drop');
  log("XG ✓ the other group's file tab dropped on the terminal pastes its path; no tab moved");
}

let launched = null;
let code = 0;
try {
  launched = await launchApp({ userDataDir: profileDir('tab-term') });
  const { page } = launched;
  const sid = await openSession(page, { path: repoArg });
  await phaseTerminalPaste(page, sid);
  await phaseEdgeSplit(page);
  await phaseCrossGroupPaste(page, sid);
  log('PASS ✓ tab-drag-to-terminal: all assertions passed');
} catch (e) {
  if (e?.name === 'AssertionError') {
    console.log('[tab-drag-to-terminal] FAIL ✗', e.message);
    code = 1;
  } else {
    console.error('[tab-drag-to-terminal] ERROR:', e?.message || e);
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
