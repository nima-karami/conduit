/**
 * Shared git-fixture and Changes-panel / tab-title helpers for the scenarios that drive diff tabs
 * from the Changes list. NOT a scenario — the runner only picks up `*.e2e.mjs`.
 */

import { execFileSync } from 'node:child_process';
import { assert, openChangesTab } from './harness.mjs';

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
 * scope suffix; each repo's list (the `.repo-head__list` after its `.repo-head`) is a flat run of
 * section headers and rows, so a row's section is the last header above it.
 */
export const installTabHelpers = (page) =>
  page.evaluate(() => {
    const titleOf = (t) =>
      Array.from(t.children)
        .filter((c) => c.tagName === 'SPAN' && !c.className)
        .map((c) => c.textContent ?? '')
        .join('');
    const listIndex = (repo) => {
      const lists = Array.from(document.querySelectorAll('.repo-head__list'));
      if (repo === null) return lists.length > 0 ? 0 : -1;
      const head = Array.from(document.querySelectorAll('.repo-head')).find(
        (h) => h.querySelector('.repo-head__name')?.textContent === repo,
      );
      const next = head?.nextElementSibling;
      return next?.classList.contains('repo-head__list') ? lists.indexOf(next) : -1;
    };
    window.__sd = {
      titles: () => Array.from(document.querySelectorAll('.tabbar [role="tab"]'), titleOf),
      active: () => {
        const t = document.querySelector('.tabbar [role="tab"][aria-selected="true"]');
        return t ? titleOf(t) : null;
      },
      listIndex,
      rowIndex: (sec, f, repo) => {
        const list = document.querySelectorAll('.repo-head__list')[listIndex(repo)];
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
      assert(false, `active tab never became "${title}" (is "${is}")`);
    });
}

export async function openChangesPanel(page) {
  await openChangesTab(page);
  await page.waitForSelector('.changes__section', { state: 'visible', timeout: 15000 });
}

/** Index (among one repo's rows) of `file`'s row in section `section`, or -1. `repo` names the
 *  repo head; omitted → the first repo's list. */
export const rowIndex = (page, section, file, repo) =>
  page.evaluate(([sec, f, r]) => window.__sd.rowIndex(sec, f, r), [section, file, repo ?? null]);

export async function changeRow(page, section, file, { repo } = {}) {
  const r = repo ?? null;
  await page
    .waitForFunction(([sec, f, rr]) => window.__sd.rowIndex(sec, f, rr) >= 0, [section, file, r], {
      timeout: 15000,
    })
    .catch(() => {
      assert(false, `no "${file}" row under "${section}"${repo ? ` in ${repo}` : ''}`);
    });
  const li = await page.evaluate((rr) => window.__sd.listIndex(rr), r);
  const i = await rowIndex(page, section, file, repo);
  return page.locator('.repo-head__list').nth(li).locator(':scope > .change').nth(i);
}
