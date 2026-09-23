/**
 * Shared git-fixture and Changes-panel / tab-title helpers for the scenarios that drive diff tabs
 * from the Changes list. NOT a scenario — the runner only picks up `*.e2e.mjs`.
 */

import { execFileSync } from 'node:child_process';

export const git = (dir, ...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8' }).trim();

/** `git init` plus a committer identity, then commit everything in `root` as `base`. */
export function commitBase(root) {
  git(root, 'init', '-q');
  git(root, 'config', 'user.email', 'e2e@conduit.test');
  git(root, 'config', 'user.name', 'e2e');
  git(root, 'config', 'commit.gpgsign', 'false');
  git(root, 'add', '.');
  git(root, 'commit', '-qm', 'base');
}

/**
 * In-page DOM readers, installed once per launched page so every waitForFunction and evaluate
 * shares one definition. A tab's title is its bare (class-less) <span>s joined — the name and the
 * scope suffix; the Changes list is a flat run of section headers and rows, so a row's section is
 * the last header above it.
 */
export const installTabHelpers = (page) =>
  page.evaluate(() => {
    const titleOf = (t) =>
      Array.from(t.children)
        .filter((c) => c.tagName === 'SPAN' && !c.className)
        .map((c) => c.textContent ?? '')
        .join('');
    window.__sd = {
      titles: () => Array.from(document.querySelectorAll('.tabbar [role="tab"]'), titleOf),
      active: () => {
        const t = document.querySelector('.tabbar [role="tab"][aria-selected="true"]');
        return t ? titleOf(t) : null;
      },
      rowIndex: (sec, f) => {
        const list = document.querySelector('.changes__section')?.parentElement;
        if (!list) return -1;
        const rows = Array.from(list.querySelectorAll(':scope > .change'));
        let cur = '';
        for (const el of list.children) {
          if (el.classList.contains('changes__section'))
            cur = el.querySelector('span')?.textContent ?? '';
          else if (cur === sec && el.querySelector('.change__file')?.textContent === f)
            return rows.indexOf(el);
        }
        return -1;
      },
    };
  });

export const tabTitles = (page) => page.evaluate(() => window.__sd.titles());

export async function waitActiveTab(page, title) {
  await page
    .waitForFunction((want) => window.__sd.active() === want, title, { timeout: 15000 })
    .catch(async () => {
      const is = await page.evaluate(() => window.__sd.active());
      throw new Error(`active tab never became "${title}" (is "${is}")`);
    });
}

export async function openChangesPanel(page) {
  if (!(await page.isVisible('.right'))) {
    await page.keyboard.press('Control+Shift+E');
    await page.waitForSelector('.right', { state: 'visible', timeout: 8000 });
  }
  await page.evaluate(() => {
    Array.from(document.querySelectorAll('.rtab'))
      .find((el) => el.textContent?.trim().startsWith('Changes'))
      ?.click();
  });
  await page.waitForSelector('.changes__section', { state: 'visible', timeout: 15000 });
}

/** Index (among the Changes list's rows) of `file`'s row in section `section`, or -1. */
export const rowIndex = (page, section, file) =>
  page.evaluate(([sec, f]) => window.__sd.rowIndex(sec, f), [section, file]);

export async function changeRow(page, section, file) {
  await page
    .waitForFunction(([sec, f]) => window.__sd.rowIndex(sec, f) >= 0, [section, file], {
      timeout: 15000,
    })
    .catch(() => {
      throw new Error(`no "${file}" row under "${section}"`);
    });
  const i = await rowIndex(page, section, file);
  return page.locator('.changes__section ~ .change').nth(i);
}
