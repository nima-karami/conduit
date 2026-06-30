/**
 * tab-scroll-state — per-tab scroll & view-state memory (FULL, spec 2026-06-30).
 *
 * Crosses renderer mount/unmount + Monaco view state, which the mock preview shell can't
 * exercise. Drives the REAL app. Covers:
 *   1. Scroll a long code file, switch tabs and back → scroll (top-visible line) restored.
 *   2. Closing + reopening the file starts at the top (its saved state was evicted on close).
 * Reveal-overrides-restore (spec §3) is NOT smoke-tested — it depends on cross-file
 * go-to-definition (custom worker-backed) which is too flaky in a tsconfig-less temp repo;
 * it's implemented + commented in code-viewer.tsx and unit-covered. See the note inline.
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

// The top-most visible editor line. Monaco positions each gutter line-number inside
// `.margin-view-overlays`; the inline `top` lives on the wrapper div, not always on the
// `.line-numbers` child — so walk up to the nearest ancestor carrying a finite `top`. The
// smallest such top is the line at the viewport top. Robust to virtualization (only visible
// lines are in the DOM) and needs no Monaco API handle.
const topVisibleLine = (page) =>
  page.evaluate(() => {
    const nums = Array.from(document.querySelectorAll('.viewer__monaco .line-numbers'));
    let best = null;
    let bestTop = Number.POSITIVE_INFINITY;
    for (const el of nums) {
      if (!el.textContent) continue;
      let node = el;
      let t = Number.parseFloat(node.style.top);
      while (!Number.isFinite(t) && node.parentElement) {
        node = node.parentElement;
        if (node.classList.contains('viewer__monaco')) break;
        t = Number.parseFloat(node.style.top);
      }
      if (Number.isFinite(t) && t < bestTop) {
        bestTop = t;
        best = el;
      }
    }
    return best ? Number(best.textContent) : null;
  });

const waitEditor = (page) =>
  page.waitForSelector('.viewer__monaco .view-lines', { state: 'attached', timeout: 20000 });

const tab = (page, name) => page.locator('.tabbar [role="tab"]', { hasText: name }).first();

// topVisibleLine is transiently null right after a remount: the `.margin-view-overlays` gutter
// paints a frame or two after `.view-lines` attaches. Poll until it reports a line. (The restore
// itself is pre-paint via restoreViewState, so the first non-null read already reflects it.)
const readTopReady = async (page) => {
  let top = null;
  for (let i = 0; i < 25 && top === null; i++) {
    top = await topVisibleLine(page);
    if (top === null) await page.waitForTimeout(120);
  }
  return top;
};

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
  // Ctrl+End can be dropped while the TS worker is still resolving the cross-file import even
  // though the editor is focused; retry until the scroll actually takes.
  const scrollToBottom = async () => {
    let top = null;
    for (let i = 0; i < 14 && (top ?? 0) <= 300; i++) {
      await page.click('.viewer__monaco .view-lines');
      await page.keyboard.press('Control+End');
      await page.waitForTimeout(250);
      top = await topVisibleLine(page);
    }
    return top;
  };
  const savedTop = await scrollToBottom();
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
  const restoredTop = await readTopReady(page);
  assert(
    restoredTop !== null && Math.abs(restoredTop - savedTop) <= 3,
    `scroll not restored: saved ${savedTop}, got ${restoredTop}`,
  );
  log('case 1 ✓ scroll restored to', restoredTop);

  // Reveal-overrides-restore (spec §3) is intentionally NOT smoke-tested: it needs a cross-file
  // go-to-definition (the custom worker-backed `agentdeck.goToDefinition`, CLAUDE.md), which can't
  // resolve a relative import in a tsconfig-less temp repo reliably enough for a deterministic
  // smoke. The precedence is implemented + commented in code-viewer.tsx (takeReveal() wins, else
  // restoreViewState — §3) and unit-covered; the real-app reveal path is left to human-smoke.

  // ── Case 2: close long.ts and reopen → starts at the top (state evicted) ───────
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
  const reopenTop = await readTopReady(page);
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
