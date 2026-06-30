/**
 * tab-scroll-state — per-tab scroll & view-state memory (FULL, spec 2026-06-30).
 *
 * Crosses renderer mount/unmount + Monaco view state, which the mock preview shell can't
 * exercise. Drives the REAL app. Covers:
 *   1. Scroll a long code file, switch tabs and back → scroll (top-visible line) restored.
 *   2. A cross-file Go-to-Definition (F12) into the scrolled-away file OVERRIDES its saved
 *      scroll on remount — the revealed line wins (spec §3 reveal-vs-restore).
 *   3. Closing + reopening the file starts at the top (its saved state was evicted on close).
 *
 * REQUIRES `npm run build` before running (drives the built renderer bundle).
 * DO NOT run here — the conductor runs e2e. Teardown via closeApp (NEVER bare app.close():
 * the quit-guard would hang). Windows-only (mirrors the rest of the smoke suite).
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assert, closeApp, launchApp, makeLog, openSession } from './harness.mjs';

if (process.platform !== 'win32') {
  console.log('[tab-scroll-state] SKIP — suite is Windows-only');
  process.exit(0);
}

const log = makeLog('tab-scroll-state');

// A temp git repo with a LONG TS file (target defined mid-file, line ~401) and a SHORT TS file
// that imports it — so a cross-file F12 from short.ts reveals long.ts at a known mid-file line.
const repo = mkdtempSync(join(tmpdir(), 'conduit-scroll-repo-'));
const TARGET_LINE = 401;
const longLines = [];
for (let i = 1; i < TARGET_LINE; i++) longLines.push(`const a${i} = ${i};`);
longLines.push('export function target() {'); // line TARGET_LINE
longLines.push('  return 42;');
longLines.push('}');
for (let i = TARGET_LINE + 3; i <= 980; i++) longLines.push(`const b${i} = ${i};`);
writeFileSync(join(repo, 'long.ts'), `${longLines.join('\n')}\n`);
writeFileSync(
  join(repo, 'short.ts'),
  `import { target } from './long';\nexport const z = target();\n`,
);
try {
  execFileSync('git', ['init', '-q'], { cwd: repo });
} catch {
  /* git absent — explorer still works without a repo */
}
const repoArg = repo.replace(/\\/g, '/');

// The top-most visible editor line: Monaco renders each gutter number with an inline `top`, so the
// smallest finite top is the line at the viewport top. Robust to virtualization (only visible
// lines are in the DOM) and needs no Monaco API handle.
const topVisibleLine = (page) =>
  page.evaluate(() => {
    const nums = Array.from(document.querySelectorAll('.viewer__monaco .line-numbers'));
    let best = null;
    let bestTop = Number.POSITIVE_INFINITY;
    for (const el of nums) {
      const t = Number.parseFloat(el.style.top);
      if (Number.isFinite(t) && t < bestTop && el.textContent) {
        bestTop = t;
        best = el;
      }
    }
    return best ? Number(best.textContent) : null;
  });

const waitEditor = (page) =>
  page.waitForSelector('.viewer__monaco .view-lines', { state: 'attached', timeout: 20000 });

const tab = (page, name) => page.locator('.tabbar [role="tab"]', { hasText: name }).first();

let launched = null;
try {
  launched = await launchApp();
  const { app, page } = launched;

  const sid = await openSession(page, { path: repoArg });
  assert(sid, 'no session id from openSession');
  log('session', sid);

  await page.click('.rtab:has-text("Files")');
  await page.waitForSelector('.filerow__name', { timeout: 20000 });
  const row = (name) => page.locator('.filerow', { hasText: name }).first();

  // Open long.ts (permanent) and scroll to the bottom.
  await row('long.ts').dblclick();
  await waitEditor(page);
  await page.click('.viewer__monaco');
  await page.keyboard.press('Control+End');
  await page.waitForTimeout(400);
  const savedTop = await topVisibleLine(page);
  assert(
    savedTop !== null && savedTop > 300,
    `expected to be scrolled down, top line = ${savedTop}`,
  );
  log('long.ts scrolled — top visible line', savedTop);

  // Open short.ts (long.ts unmounts; its view state persists in the store + its model survives).
  await row('short.ts').dblclick();
  await waitEditor(page);

  // ── Case 1: switch back to long.ts → scroll restored within a row ──────────────
  await tab(page, 'long.ts').click();
  await waitEditor(page);
  await page.waitForTimeout(300);
  const restoredTop = await topVisibleLine(page);
  assert(
    restoredTop !== null && Math.abs(restoredTop - savedTop) <= 3,
    `scroll not restored: saved ${savedTop}, got ${restoredTop}`,
  );
  log('case 1 ✓ scroll restored to', restoredTop);

  // ── Case 2: cross-file F12 from short.ts overrides long.ts's saved scroll ──────
  // Switch to short.ts and put the cursor on the `target` identifier via deterministic keyboard
  // nav: End-of-line is after `target();`, three Lefts land just past the `target` word.
  await tab(page, 'short.ts').click();
  await waitEditor(page);
  await page.click('.viewer__monaco');
  await page.keyboard.press('Control+End');
  for (let i = 0; i < 3; i++) await page.keyboard.press('ArrowLeft');
  // Warm the TS worker, then Go to Definition; it stages a reveal for long.ts and reactivates it,
  // so long.ts remounts WITH a pending reveal and must skip its saved-scroll restore.
  await page.waitForTimeout(1500);
  await page.keyboard.press('F12');
  await page.waitForFunction(
    (name) => {
      const t = Array.from(document.querySelectorAll('.tabbar [role="tab"]')).find(
        (x) => x.querySelector('span')?.textContent === name,
      );
      return (
        !!t && (t.classList.contains('tab--active') || t.getAttribute('aria-selected') === 'true')
      );
    },
    'long.ts',
    { timeout: 15000 },
  );
  await waitEditor(page);
  await page.waitForTimeout(400);
  const revealTop = await topVisibleLine(page);
  assert(
    revealTop !== null && revealTop < savedTop - 100,
    `reveal did not override saved scroll: revealTop ${revealTop} vs savedTop ${savedTop}`,
  );
  assert(
    Math.abs(revealTop - TARGET_LINE) < 120,
    `reveal landed off target: top line ${revealTop}, expected near ${TARGET_LINE}`,
  );
  log('case 2 ✓ reveal overrode saved scroll → top line', revealTop);

  // ── Case 3: close long.ts and reopen → starts at the top (state evicted) ───────
  await tab(page, 'long.ts').click();
  await tab(page, 'long.ts').locator('.tab__close').click();
  await page.waitForFunction(
    () =>
      !Array.from(document.querySelectorAll('.tabbar [role="tab"]')).some(
        (x) => x.querySelector('span')?.textContent === 'long.ts',
      ),
    null,
    { timeout: 10000 },
  );
  await row('long.ts').dblclick();
  await waitEditor(page);
  await page.waitForTimeout(300);
  const reopenTop = await topVisibleLine(page);
  assert(reopenTop !== null && reopenTop <= 2, `reopen should start at top, got ${reopenTop}`);
  log('case 3 ✓ reopened at top → line', reopenTop);

  await closeApp(app, page);
  launched = null;
  log('PASS ✓ tab-scroll-state: all assertions passed');
  process.exit(0);
} catch (e) {
  const isAssertion = e?.name === 'AssertionError';
  if (isAssertion) {
    console.log('[tab-scroll-state] FAIL ✗', e.message);
  } else {
    console.error('[tab-scroll-state] ERROR:', e?.message || e);
  }
  try {
    if (launched) await closeApp(launched.app, launched.page);
  } catch {
    /* ignore */
  }
  process.exit(isAssertion ? 1 : 2);
}
