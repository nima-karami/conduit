/**
 * changes-active-highlight — the Changes list marks the row of the file the focused editor tab
 * shows (docs/specs/2026-09-28-changes-active-highlight.md §7 Gherkin, plus "closing the active
 * tab moves the highlight" and D2). Real-app: the target is derived from the docs reducer's
 * active tab and the host's git status, and scroll-into-view is layout.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  changeRow,
  commitBase,
  git,
  installTabHelpers,
  openChangesPanel,
  tabTitles,
  waitActiveTab,
} from './changes-fixture.mjs';
import { assert, openSession, runScenario, waitForRepoGit } from './harness.mjs';
import { clickTerminalTab } from './nav-history-fixture.mjs';

const FILLER = Array.from({ length: 80 }, (_, i) => `f${String(i).padStart(2, '0')}.txt`);

function makeRepos() {
  const work = mkdtempSync(join(tmpdir(), 'conduit-cah-'));
  const home = join(work, 'home');
  const ref = join(work, 'ref');
  mkdirSync(home);
  mkdirSync(ref);
  for (const f of ['a.txt', 'b.txt', 'c.txt', 'zz-last.txt', ...FILLER])
    writeFileSync(join(home, f), `${f}\n`);
  commitBase(home);
  writeFileSync(join(home, 'a.txt'), 'a staged\n');
  git(home, 'add', 'a.txt');
  writeFileSync(join(home, 'a.txt'), 'a staged\na worktree\n');
  writeFileSync(join(home, 'b.txt'), 'b worktree\n');
  const st = git(home, 'status', '--porcelain', 'a.txt');
  assert(st.startsWith('MM'), `fixture: a.txt must be MM, got "${st}"`);
  writeFileSync(join(ref, 'r.txt'), 'r\n');
  commitBase(ref);
  writeFileSync(join(ref, 'r.txt'), 'r changed\n');
  return { home, ref };
}

/** Every `[aria-current="true"]` in the Changes list, with its section, repo and class. */
const activeRows = (page) =>
  page.evaluate(() => {
    const scroller = document.querySelector('.rightpane__scroll:not(.rightpane__scroll--files)');
    return Array.from(scroller?.querySelectorAll('[aria-current="true"]') ?? [], (el) => {
      let sec = el.previousElementSibling;
      while (sec && !sec.classList.contains('changes__section')) sec = sec.previousElementSibling;
      const head = el.closest('.repo-head__list')?.previousElementSibling;
      return {
        file: el.querySelector('.change__file')?.textContent ?? null,
        section: sec?.querySelector('span')?.textContent ?? null,
        repo: head?.querySelector('.repo-head__name')?.textContent ?? null,
        cls: el.classList.contains('change') && el.classList.contains('change--active'),
      };
    });
  });

const activeClassCount = (page) =>
  page.evaluate(() => document.querySelectorAll('.change--active').length);

/** Polls until the active rows are exactly `want` ([] or one {file, section[, repo]}). */
async function expectActive(page, want, what) {
  const deadline = Date.now() + 10000;
  let rows = [];
  let classes = -1;
  const matches = () =>
    rows.length === want.length &&
    classes === want.length &&
    rows.every(
      (r, i) =>
        r.cls &&
        r.file === want[i].file &&
        r.section === want[i].section &&
        (want[i].repo === undefined || r.repo === want[i].repo),
    );
  while (Date.now() < deadline) {
    rows = await activeRows(page);
    classes = await activeClassCount(page);
    if (matches()) return;
    await page.waitForTimeout(150);
  }
  assert(
    false,
    `${what}: active rows ${JSON.stringify(rows)} (${classes} with .change--active), want ${JSON.stringify(want)}`,
  );
}

async function activateTab(page, title) {
  const i = (await tabTitles(page)).indexOf(title);
  assert(i >= 0, `no tab titled "${title}" (tabs: ${JSON.stringify(await tabTitles(page))})`);
  await page.locator('.tabbar [role="tab"]').nth(i).click();
  await waitActiveTab(page, title);
}

async function closeTab(page, title) {
  const i = (await tabTitles(page)).indexOf(title);
  assert(i >= 0, `no tab titled "${title}" to close`);
  await page.locator('.tabbar [role="tab"]').nth(i).locator('.tab__close').click();
  await page.waitForFunction((t) => !window.__sd.titles().includes(t), title, { timeout: 8000 });
}

const rtabActive = (page) =>
  page.evaluate(() => document.querySelector('.rtab--active')?.textContent?.trim() ?? '');

async function openFromFiles(page, name) {
  await page.locator('.rtab', { hasText: 'Files' }).click();
  const row = page.locator('.filerow', {
    has: page.locator('.filerow__name', { hasText: new RegExp(`^${name.replace('.', '\\.')}$`) }),
  });
  await row.first().waitFor({ state: 'visible', timeout: 15000 });
  await row.first().dblclick();
  await waitActiveTab(page, name);
}

/** The active row's rect lies inside the Changes scroller's rect. */
const activeRowInView = (page) =>
  page.evaluate(() => {
    const sc = document.querySelector('.rightpane__scroll:not(.rightpane__scroll--files)');
    const row = sc?.querySelector('.change[aria-current="true"]');
    if (!sc || !row) return false;
    const a = sc.getBoundingClientRect();
    const b = row.getBoundingClientRect();
    return b.top >= a.top - 1 && b.bottom <= a.bottom + 1;
  });

const scrollTopOf = (page) =>
  page.evaluate(
    () =>
      document.querySelector('.rightpane__scroll:not(.rightpane__scroll--files)')?.scrollTop ?? -1,
  );

async function waitInView(page, what) {
  const ok = await page
    .waitForFunction(
      () => {
        const sc = document.querySelector('.rightpane__scroll:not(.rightpane__scroll--files)');
        const row = sc?.querySelector('.change[aria-current="true"]');
        if (!sc || !row) return false;
        const a = sc.getBoundingClientRect();
        const b = row.getBoundingClientRect();
        return b.top >= a.top - 1 && b.bottom <= a.bottom + 1;
      },
      null,
      { timeout: 8000 },
    )
    .then(
      () => true,
      () => false,
    );
  assert(ok, `${what}: the active row is not inside the Changes scroller's visible rect`);
}

async function refreshChanges(page) {
  await page.locator('.changes__refresh').click();
}

runScenario('changes-active-highlight', async ({ page, log }) => {
  const { home, ref } = makeRepos();
  await installTabHelpers(page);
  const sid = await openSession(page, { path: home, roots: [ref] });
  await waitForRepoGit(page);
  await page.waitForFunction(
    (id) => {
      const s = (window.__sessions || []).find((x) => x.id === id);
      return s?.repos?.length === 2 && Object.keys(s?.repoGit ?? {}).length === 2;
    },
    sid,
    { timeout: 25000 },
  );
  await openChangesPanel(page);
  await installTabHelpers(page);
  await page.waitForFunction(() => document.querySelectorAll('.repo-head').length === 2, null, {
    timeout: 15000,
  });
  const [homeName, refName] = await page.evaluate(() =>
    Array.from(document.querySelectorAll('.repo-head .repo-head__name'), (n) => n.textContent),
  );
  log('repo heads:', homeName, refName);

  // ── clicking a row highlights that row ────────────────────────────────────────
  await expectActive(page, [], 'no tab open');
  await (await changeRow(page, 'Changes', 'b.txt')).click();
  await waitActiveTab(page, 'b.txt (Working Tree)');
  await expectActive(page, [{ file: 'b.txt', section: 'Changes' }], 'b.txt row click');
  log('row click → that row active, aria-current + .change--active ✓');

  // ── staged vs unstaged diff tabs of the same (MM) file ────────────────────────
  await (await changeRow(page, 'Staged', 'a.txt')).click();
  await waitActiveTab(page, 'a.txt (Index)');
  await expectActive(page, [{ file: 'a.txt', section: 'Staged' }], 'a.txt Staged click');
  await (await changeRow(page, 'Changes', 'a.txt')).click();
  await waitActiveTab(page, 'a.txt (Working Tree)');
  await expectActive(page, [{ file: 'a.txt', section: 'Changes' }], 'a.txt Changes click');
  await activateTab(page, 'a.txt (Index)');
  await expectActive(page, [{ file: 'a.txt', section: 'Staged' }], 'a.txt (Index) tab');
  log('scoped tabs of an MM file each highlight their own side ✓');

  // ── file tab maps to the unstaged row; D2: opening a file switches the pane to Files ──
  await openFromFiles(page, 'a.txt');
  const paneAfterOpen = await rtabActive(page);
  assert(paneAfterOpen.startsWith('Files'), `D2: pane after a file open is "${paneAfterOpen}"`);
  await openChangesPanel(page);
  await expectActive(page, [{ file: 'a.txt', section: 'Changes' }], 'a.txt file tab');
  await activateTab(page, 'b.txt (Working Tree)');
  await activateTab(page, 'a.txt');
  await expectActive(page, [{ file: 'a.txt', section: 'Changes' }], 'a.txt file tab re-activated');
  assert((await rtabActive(page)).startsWith('Changes'), 'activating a tab keeps the pane');
  log('file tab → unstaged row; D2 file open switches to Files, tab activation does not ✓');

  // ── non-mapping tabs clear the highlight ─────────────────────────────────────
  await clickTerminalTab(page);
  await expectActive(page, [], 'Terminal tab');
  await openFromFiles(page, 'c.txt');
  await openChangesPanel(page);
  await expectActive(page, [], 'clean c.txt file tab');
  log('Terminal and a clean file tab highlight nothing ✓');

  // ── closing the active tab moves the highlight ────────────────────────────────
  await activateTab(page, 'a.txt (Index)');
  await activateTab(page, 'b.txt (Working Tree)');
  await expectActive(page, [{ file: 'b.txt', section: 'Changes' }], 'before close');
  await closeTab(page, 'b.txt (Working Tree)');
  const next = await page.evaluate(() => window.__sd.active());
  const expectFor = {
    'a.txt (Index)': [{ file: 'a.txt', section: 'Staged' }],
    'a.txt (Working Tree)': [{ file: 'a.txt', section: 'Changes' }],
    'a.txt': [{ file: 'a.txt', section: 'Changes' }],
    'c.txt': [],
  };
  assert(next in expectFor, `unexpected tab activated by the close: "${next}"`);
  await expectActive(page, expectFor[next], `after closing b.txt (active "${next}")`);
  log(`closing the active tab → highlight follows the neighbour "${next}" ✓`);

  // ── center view is not the editor ─────────────────────────────────────────────
  await activateTab(page, 'a.txt (Index)');
  await expectActive(page, [{ file: 'a.txt', section: 'Staged' }], 'before Board');
  await page.locator('.viewswitch__btn[title="Feature Board"]').click();
  await expectActive(page, [], 'Board center view');
  await page.locator('.viewswitch__btn[title="Editor"]').click();
  await expectActive(page, [{ file: 'a.txt', section: 'Staged' }], 'back to Editor');
  log('Board center view clears the highlight; Editor restores it ✓');

  // ── scroll into view ─────────────────────────────────────────────────────────
  for (const f of [...FILLER, 'zz-last.txt']) writeFileSync(join(home, f), `${f} changed\n`);
  await refreshChanges(page);
  const last = await changeRow(page, 'Changes', 'zz-last.txt');
  const scrollable = await page.evaluate(() => {
    const sc = document.querySelector('.rightpane__scroll:not(.rightpane__scroll--files)');
    return sc ? sc.scrollHeight > sc.clientHeight + 100 : false;
  });
  assert(scrollable, 'fixture: the Changes list must overflow its scroller');
  await last.scrollIntoViewIfNeeded();
  await last.click();
  await waitActiveTab(page, 'zz-last.txt (Working Tree)');
  await activateTab(page, 'a.txt (Index)');
  await waitInView(page, 'a.txt (Index) activated');
  await activateTab(page, 'zz-last.txt (Working Tree)');
  await expectActive(page, [{ file: 'zz-last.txt', section: 'Changes' }], 'zz-last tab');
  await waitInView(page, 'zz-last.txt tab activated');
  log('activating a tab scrolls its row into view ✓');

  await page.evaluate(() => {
    const sc = document.querySelector('.rightpane__scroll:not(.rightpane__scroll--files)');
    if (sc) sc.scrollTop = 0;
  });
  await refreshChanges(page);
  await page.waitForTimeout(1500);
  assert((await scrollTopOf(page)) === 0, 'a refresh with the same target must not scroll');
  await expectActive(page, [{ file: 'zz-last.txt', section: 'Changes' }], 'after refresh');
  assert(!(await activeRowInView(page)), 'precondition: the row is scrolled away');
  log('Refresh with the same target leaves scrollTop alone ✓');

  await page.locator('.rtab', { hasText: 'Files' }).click();
  await openChangesPanel(page);
  await expectActive(page, [{ file: 'zz-last.txt', section: 'Changes' }], 'remount');
  await waitInView(page, 'Files → Changes remount');
  log('Files → Changes re-scrolls the active row into view ✓');

  // ── scoped side vanishes ──────────────────────────────────────────────────────
  await activateTab(page, 'a.txt (Index)');
  await expectActive(page, [{ file: 'a.txt', section: 'Staged' }], 'before commit');
  git(home, 'commit', '-qm', 'index');
  await refreshChanges(page);
  await expectActive(page, [], 'staged side committed');
  log('committing the index clears a scoped-staged highlight ✓');

  // ── multi-repo ────────────────────────────────────────────────────────────────
  await (await changeRow(page, 'Changes', 'r.txt', { repo: refName })).click();
  await waitActiveTab(page, 'r.txt (Working Tree)');
  // Leave repo 1 as the repo context, so the Active view below shows repo 1.
  await (await changeRow(page, 'Changes', 'b.txt', { repo: homeName })).click();
  await waitActiveTab(page, 'b.txt (Working Tree)');
  await activateTab(page, 'r.txt (Working Tree)');
  await expectActive(page, [{ file: 'r.txt', section: 'Changes', repo: refName }], 'repo 2 tab');

  const refHead = page.locator('.repo-head', { hasText: refName });
  await refHead.locator('.repo-head__chev').click();
  await page.waitForFunction(
    (n) =>
      Array.from(document.querySelectorAll('.repo-head')).some(
        (h) =>
          h.querySelector('.repo-head__name')?.textContent === n &&
          h.querySelector('.repo-head__chev')?.getAttribute('aria-expanded') === 'false',
      ),
    refName,
    { timeout: 5000 },
  );
  await expectActive(page, [], 'repo 2 collapsed');
  await page.waitForTimeout(500);
  const stillCollapsed = await page.evaluate((n) => {
    const h = Array.from(document.querySelectorAll('.repo-head')).find(
      (x) => x.querySelector('.repo-head__name')?.textContent === n,
    );
    return (
      h?.querySelector('.repo-head__chev')?.getAttribute('aria-expanded') === 'false' &&
      !h.nextElementSibling?.classList.contains('repo-head__list')
    );
  }, refName);
  assert(stillCollapsed, 'D3: repo 2 must stay collapsed');
  log('collapsed repo: no highlight, stays collapsed ✓');

  await page.locator('.changes__kebab').click();
  await page.getByRole('menuitemradio', { name: 'Active repo' }).click();
  await page.waitForFunction(() => document.querySelectorAll('.repo-head').length === 1, null, {
    timeout: 8000,
  });
  const shown = await page.evaluate(
    () => document.querySelector('.repo-head .repo-head__name')?.textContent,
  );
  assert(shown === homeName, `D4: Active view shows "${shown}", want repo 1 "${homeName}"`);
  await expectActive(page, [], 'Active view, match in the other repo');
  log('Active view: no highlight and the active repo is not switched ✓');
});
