/**
 * Shared fixture + read helpers for the middle-click scenarios
 * (docs/specs/2026-09-22-middle-click-new-tab.md §7). NOT a scenario — the runner only picks up
 * `*.e2e.mjs`.
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const git = (cwd, ...args) => execFileSync('git', args, { cwd, stdio: 'pipe' });

function writeAll(root, files) {
  for (const [rel, body] of Object.entries(files)) {
    const abs = join(root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, body);
  }
}

/**
 * A git repo holding `files` as its first commit, then one commit per `commits` entry, then the
 * uncommitted `dirty` writes. Returns the root with `/` separators.
 */
export function writeFixtureRepo({ files, commits = [], dirty = {} }) {
  const root = mkdtempSync(join(tmpdir(), 'conduit-middle-'));
  git(root, 'init', '-q');
  git(root, 'config', 'user.email', 'e2e@conduit.test');
  git(root, 'config', 'user.name', 'e2e');
  git(root, 'config', 'commit.gpgsign', 'false');
  writeAll(root, files);
  git(root, 'add', '.');
  git(root, 'commit', '-qm', 'base');
  commits.forEach((c, i) => {
    writeAll(root, c);
    git(root, 'add', '.');
    git(root, 'commit', '-qm', `change ${i + 1}`);
  });
  writeAll(root, dirty);
  return root.replace(/\\/g, '/');
}

/**
 * Everything a background open must leave alone (spec §7 "unchanged"). Compare two snapshots
 * with `sameSnapshot`.
 */
export function snapshotUnchanged(page) {
  return page.evaluate(() => {
    const a = document.activeElement;
    const describe = (el) =>
      el
        ? `${el.tagName}.${String(el.className).split(' ')[0]}#${el.getAttribute('data-path') ?? el.getAttribute('data-tabid') ?? ''}`
        : 'none';
    return {
      activeTitle:
        document.querySelector('.tabbar [role="tab"].tab--active span')?.textContent ?? null,
      activeEl: describe(a),
      centerView: document.querySelector('.board, .arch') ? 'other' : 'editor',
      selection: Array.from(document.querySelectorAll('.filerow--selected'))
        .map((r) => r.getAttribute('data-path'))
        .join('|'),
      scrollY: window.scrollY,
      scrollTops: Array.from(
        document.querySelectorAll('.tabbar, [role="tree"], .search__results, .review'),
      )
        .map((el) => `${el.scrollTop},${el.scrollLeft}`)
        .join('|'),
    };
  });
}

export function sameSnapshot(a, b) {
  const diffs = Object.keys(a).filter((k) => a[k] !== b[k]);
  return diffs.length === 0
    ? null
    : diffs.map((k) => `${k}: ${JSON.stringify(a[k])} → ${JSON.stringify(b[k])}`).join('; ');
}

export function tabInfo(page) {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll('.tabbar [role="tab"]')).map((el) => ({
      title: el.querySelector('span')?.textContent ?? '',
      active: el.classList.contains('tab--active'),
      preview: el.classList.contains('tab--preview'),
      flash: el.classList.contains('tab--flash'),
    })),
  );
}

/** The dedicated background-open status region (not the nav/timer one). */
export function statusText(page) {
  return page.evaluate(() => document.querySelector('.bg-open-status')?.textContent ?? null);
}

/** Records every write to the status region into `window.__statusLog` (AC-14). */
export function watchStatus(page) {
  return page.evaluate(() => {
    window.__statusLog = [];
    const el = document.querySelector('.bg-open-status');
    if (!el) throw new Error('no .bg-open-status region');
    new MutationObserver(() => window.__statusLog.push(el.textContent ?? '')).observe(el, {
      childList: true,
      characterData: true,
      subtree: true,
    });
  });
}

/** Resolves when a tab titled `title` exists; returns its info. Throws on timeout. */
export async function waitTab(page, title, timeout = 10000) {
  await page.waitForFunction(
    (t) =>
      Array.from(document.querySelectorAll('.tabbar [role="tab"]')).some(
        (el) => el.querySelector('span')?.textContent === t,
      ),
    title,
    { timeout },
  );
  return (await tabInfo(page)).find((t) => t.title === title);
}

/**
 * A real-hand middle click: down, a few px of jitter, up on the same element. The jitter is what
 * lets Windows autoscroll engage in a scrollable container and swallow the `auxclick` (spec C2);
 * Playwright's `click({button:'middle'})` never moves, so it can't catch that defect.
 */
export async function middleClickJitter(page, locator) {
  const box = await locator.boundingBox();
  if (!box) throw new Error('middleClickJitter: element has no box');
  const x = box.x + Math.min(box.width / 2, 40);
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down({ button: 'middle' });
  await page.mouse.move(x + 3, y + 2, { steps: 3 });
  await page.mouse.move(x, y, { steps: 2 });
  await page.mouse.up({ button: 'middle' });
}

/** Resolves when the status region reads `text` exactly. Throws on timeout. */
export function waitStatus(page, text, timeout = 5000) {
  return page.waitForFunction(
    (t) => document.querySelector('.bg-open-status')?.textContent === t,
    text,
    { timeout },
  );
}
