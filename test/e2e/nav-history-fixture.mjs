/**
 * Shared fixture + read helpers for the editor-nav-history scenarios
 * (docs/specs/2026-09-22-editor-nav-history.md §7). NOT a scenario — the runner only picks up
 * `*.e2e.mjs`. The ACs are split across three scenario files because several need a fresh
 * history and one launch driving all of them runs past the runner's per-scenario guard.
 */

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launchApp, tapBridge } from './harness.mjs';

export { openViaTree, placeCursor, tapIndex, waitForIndexReady } from './goto-matrix.mjs';

const LINES = 130;

function fileBody(name) {
  const stem = name.replace(/\.ts$/, '').replace(/[^A-Za-z0-9_]/g, '_');
  const lines = [];
  for (let n = 1; n <= LINES; n++) lines.push(`export const ${stem}f${n} = ${n};`);
  if (name === 'a.ts') {
    lines[0] = "import { navTarget } from './b';";
    lines[11] = 'export const usesTarget = navTarget();';
  }
  if (name === 'b.ts') {
    lines[39] = 'export function navTarget(): number {';
    lines[40] = '  return 40;';
    lines[41] = '}';
  }
  return `${lines.join('\n')}\n`;
}

/** Writes a tsconfig plus a/b/c/x.ts and each extra name; returns the root with `/` separators. */
export function makeNavFixture(extraNames = []) {
  const root = mkdtempSync(join(tmpdir(), 'conduit-navhist-'));
  writeFileSync(
    join(root, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: { strict: true, module: 'esnext', target: 'es2022' },
      include: ['*.ts'],
    }),
  );
  for (const name of ['a.ts', 'b.ts', 'c.ts', 'x.ts', ...extraNames]) {
    writeFileSync(join(root, name), fileBody(name));
  }
  return root.replace(/\\/g, '/');
}

/** The editor the user is in: the focused one, else the last mounted outer (non-peek) editor. */
export function cursorLine(page) {
  return page.evaluate(() => {
    const eds = (window.monaco?.editor.getEditors() ?? []).filter((e) => {
      const n = e.getDomNode();
      return n?.isConnected && !n.closest('.zone-widget');
    });
    const ed = eds.find((e) => e.hasTextFocus()) ?? eds[eds.length - 1];
    return ed?.getPosition()?.lineNumber ?? null;
  });
}

export async function waitCursor(page, line, timeout = 10000) {
  try {
    await page.waitForFunction(
      (want) => {
        const eds = (window.monaco?.editor.getEditors() ?? []).filter((e) => {
          const n = e.getDomNode();
          return n?.isConnected && !n.closest('.zone-widget');
        });
        const ed = eds.find((e) => e.hasTextFocus()) ?? eds[eds.length - 1];
        return ed?.getPosition()?.lineNumber === want;
      },
      line,
      { timeout },
    );
    return true;
  } catch {
    return false;
  }
}

export function lineVisible(page, line) {
  return page.evaluate((want) => {
    const eds = (window.monaco?.editor.getEditors() ?? []).filter((e) => {
      const n = e.getDomNode();
      return n?.isConnected && !n.closest('.zone-widget');
    });
    const ed = eds.find((e) => e.hasTextFocus()) ?? eds[eds.length - 1];
    return (ed?.getVisibleRanges() ?? []).some(
      (r) => r.startLineNumber <= want && want <= r.endLineNumber,
    );
  }, line);
}

export function activeTab(page) {
  return page.evaluate(
    () => document.querySelector('.tabbar [role="tab"].tab--active span')?.textContent ?? null,
  );
}

/** Resolves true when `title` becomes the active doc tab; false on timeout (callers assert). */
export async function waitActive(page, title, timeout = 10000) {
  try {
    await page.waitForFunction(
      (want) =>
        document.querySelector('.tabbar [role="tab"].tab--active span')?.textContent === want,
      title,
      { timeout },
    );
    return true;
  } catch {
    return false;
  }
}

export function isPreview(page, title) {
  return page.evaluate(
    (want) =>
      Array.from(document.querySelectorAll('.tabbar [role="tab"]')).some(
        (el) =>
          el.querySelector('span')?.textContent === want && el.classList.contains('tab--preview'),
      ),
    title,
  );
}

export function hasTab(page, title) {
  return page.evaluate(
    (want) =>
      Array.from(document.querySelectorAll('.tabbar [role="tab"]')).some(
        (el) => el.querySelector('span')?.textContent === want,
      ),
    title,
  );
}

export function navDisabled(page) {
  return page.evaluate(() => ({
    back: !!document.querySelector('button[title="Back"]')?.disabled,
    forward: !!document.querySelector('button[title="Forward"]')?.disabled,
  }));
}

export function announcement(page) {
  return page.evaluate(
    () => document.querySelector('[role="status"][aria-live="polite"]')?.textContent ?? '',
  );
}

export function activeSessionId(page) {
  return page.evaluate(
    () =>
      document.querySelector('.session.session--active')?.getAttribute('data-sessionid') ?? null,
  );
}

export async function selectSession(page, sessionId) {
  await page.locator(`.session[data-sessionid="${sessionId}"] .session__name`).first().click();
  await page.waitForFunction(
    (id) =>
      document.querySelector('.session.session--active')?.getAttribute('data-sessionid') === id,
    sessionId,
    { timeout: 10000 },
  );
}

export async function clickTerminalTab(page) {
  await page.locator('.tabbar > button.tab:not([role="tab"])').first().click();
  await page.waitForFunction(
    () => !document.querySelector('.tabbar [role="tab"].tab--active'),
    null,
    {
      timeout: 10000,
    },
  );
}

/** A real mouse click at the start of `line` in the active outer editor. */
export async function clickLine(page, line) {
  const at = await page.evaluate((want) => {
    const eds = (window.monaco?.editor.getEditors() ?? []).filter((e) => {
      const n = e.getDomNode();
      return n?.isConnected && !n.closest('.zone-widget');
    });
    const ed = eds.find((e) => e.hasTextFocus()) ?? eds[eds.length - 1];
    if (!ed) return null;
    ed.revealLine(want);
    const vp = ed.getScrolledVisiblePosition({ lineNumber: want, column: 1 });
    const r = ed.getDomNode().getBoundingClientRect();
    return vp ? { x: r.left + vp.left + 4, y: r.top + vp.top + vp.height / 2 } : null;
  }, line);
  if (!at) throw new Error(`clickLine: line ${line} has no on-screen position`);
  await page.mouse.click(at.x, at.y);
}

export async function focusEditor(page) {
  await page.evaluate(() => {
    const eds = (window.monaco?.editor.getEditors() ?? []).filter((e) => {
      const n = e.getDomNode();
      return n?.isConnected && !n.closest('.zone-widget');
    });
    eds[eds.length - 1]?.focus();
  });
}

/**
 * Land on `fileTitle:line` through a Search-panel hit — a real user route that records exactly
 * one entry (see the plan's "Spec staleness": a click/setPosition from line 1 to 12 is itself an
 * R3 jump). The query is cleared afterwards so the tree is usable again.
 */
export async function openAtLineViaSearch(page, query, fileTitle, line) {
  await page.click('.rtab:has-text("Files")');
  const box = page.locator('.search__inputbox textarea').first();
  await box.fill(query);
  const match = page
    .locator('.searchgroup', {
      has: page.locator('.searchgroup__file', { hasText: new RegExp(`^${fileTitle}$`) }),
    })
    .locator('.searchmatch', {
      has: page.locator('.searchmatch__line', { hasText: new RegExp(`^${line}$`) }),
    })
    .first();
  await match.waitFor({ timeout: 20000 });
  await match.click();
  if (!(await waitActive(page, fileTitle, 15000))) {
    throw new Error(`openAtLineViaSearch: ${fileTitle} never became active`);
  }
  if (!(await waitCursor(page, line, 15000))) {
    throw new Error(`openAtLineViaSearch: cursor never reached ${fileTitle}:${line}`);
  }
  await box.fill('');
  await focusEditor(page);
}

export async function freshApp() {
  const launched = await launchApp();
  await tapBridge(launched.page);
  return launched;
}
