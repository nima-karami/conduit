/**
 * scoped-diff-tabs — a Changes row opens the side of the file it sits under: Staged → HEAD→index
 * `<name> (Index)`, Changes → index→worktree `<name> (Working Tree)` (spec
 * 2026-09-22-scoped-diff-tabs §7). Real-app: the scope is a `readDiff` base/side pair crossing
 * into `git show`, and restore crosses docs.json — neither exists in the mock shell.
 *
 * Tab titles are compared EXACTLY ("both.ts" is a substring of "both.ts (Index)"), and diff
 * content is compared per CHANGED line: the unstaged side's context contains the staged marker.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assert, closeApp, launchApp, makeLog, openSession, tapBridge } from './harness.mjs';

const NAME = 'scoped-diff-tabs';
if (process.platform !== 'win32') {
  console.log(`[${NAME}] SKIP — suite is Windows-only (non-win32 platform)`);
  process.exit(0);
}
const log = makeLog(NAME);

const git = (dir, ...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8' }).trim();

const STAGED_MARK = 'MARK_STAGED_SIDE';
const UNSTAGED_MARK = 'MARK_UNSTAGED_SIDE';

// ── Fixture: both.ts is `MM` (one hunk per side) and conflicted.ts is a real merge conflict ──
function makeRepo() {
  const root = mkdtempSync(join(tmpdir(), 'conduit-scoped-diff-'));
  const lines = Array.from({ length: 20 }, (_, i) => `const l${i + 1} = ${i + 1};`);
  const body = (ls) => `${ls.join('\n')}\n`;
  writeFileSync(join(root, 'both.ts'), body(lines));
  writeFileSync(join(root, 'conflicted.ts'), body(lines.slice(0, 6)));
  git(root, 'init', '-q');
  git(root, 'config', 'user.email', 'e2e@conduit.test');
  git(root, 'config', 'user.name', 'e2e');
  git(root, 'config', 'commit.gpgsign', 'false');
  git(root, 'add', '.');
  git(root, 'commit', '-qm', 'base');

  git(root, 'checkout', '-qb', 'other');
  writeFileSync(join(root, 'conflicted.ts'), `${body(lines.slice(0, 6))}const fromOther = 1;\n`);
  git(root, 'commit', '-qam', 'other');
  git(root, 'checkout', '-q', '-');
  writeFileSync(join(root, 'conflicted.ts'), `${body(lines.slice(0, 6))}const fromMine = 1;\n`);
  git(root, 'commit', '-qam', 'mine');
  try {
    git(root, 'merge', 'other');
  } catch {
    /* the conflict IS the fixture */
  }

  const staged = [...lines];
  staged[1] = `const l2 = '${STAGED_MARK}';`;
  writeFileSync(join(root, 'both.ts'), body(staged));
  git(root, 'add', 'both.ts');
  const worktree = [...staged];
  worktree[17] = `const l18 = '${UNSTAGED_MARK}';`;
  writeFileSync(join(root, 'both.ts'), body(worktree));
  const status = execFileSync('git', ['status', '--porcelain', 'both.ts'], {
    cwd: root,
    encoding: 'utf8',
  });
  assert(status.startsWith('MM'), `fixture: both.ts must be MM, got "${status}"`);
  return root;
}

// ── Page helpers ───────────────────────────────────────────────────────────────────────────

const tabTitles = (page) =>
  page.evaluate(() =>
    Array.from(document.querySelectorAll('.tabbar [role="tab"]'), (t) =>
      Array.from(t.children)
        .filter((c) => c.tagName === 'SPAN' && !c.className)
        .map((c) => c.textContent ?? '')
        .join(''),
    ),
  );

const activeTabTitle = (page) =>
  page.evaluate(() => {
    const t = document.querySelector('.tabbar [role="tab"][aria-selected="true"]');
    if (!t) return null;
    return Array.from(t.children)
      .filter((c) => c.tagName === 'SPAN' && !c.className)
      .map((c) => c.textContent ?? '')
      .join('');
  });

async function waitActiveTab(page, title) {
  await page
    .waitForFunction(
      (want) => {
        const t = document.querySelector('.tabbar [role="tab"][aria-selected="true"]');
        if (!t) return false;
        const got = Array.from(t.children)
          .filter((c) => c.tagName === 'SPAN' && !c.className)
          .map((c) => c.textContent ?? '')
          .join('');
        return got === want;
      },
      title,
      { timeout: 15000 },
    )
    .catch(async () => {
      throw new Error(`active tab never became "${title}" (is "${await activeTabTitle(page)}")`);
    });
}

/** The mounted diff editor's content, with changed lines split per side. */
const diffInfo = (page) =>
  page.evaluate(() => {
    const eds = (window.monaco?.editor.getDiffEditors() ?? []).filter(
      (e) => e.getContainerDomNode().isConnected,
    );
    const ed = eds[eds.length - 1];
    const model = ed?.getModel();
    const changes = ed?.getLineChanges();
    if (!ed || !model || !changes) return null;
    const added = [];
    const removed = [];
    for (const c of changes) {
      if (c.originalEndLineNumber > 0)
        for (let l = c.originalStartLineNumber; l <= c.originalEndLineNumber; l++)
          removed.push(model.original.getLineContent(l));
      if (c.modifiedEndLineNumber > 0)
        for (let l = c.modifiedStartLineNumber; l <= c.modifiedEndLineNumber; l++)
          added.push(model.modified.getLineContent(l));
    }
    const pos = ed.getModifiedEditor().getPosition();
    return {
      original: model.original.getValue(),
      modified: model.modified.getValue(),
      added: added.join('\n'),
      removed: removed.join('\n'),
      cursorLine: pos?.lineNumber ?? null,
      toggle:
        document
          .querySelector(
            '.diff-controls [aria-label="Inline view"], .diff-controls [aria-label="Side-by-side view"]',
          )
          ?.getAttribute('aria-label') ?? null,
    };
  });

/** Poll the mounted diff editor until `ok(info)` holds; returns the last info either way. */
async function waitDiff(page, ok, timeout = 15000) {
  const deadline = Date.now() + timeout;
  let info = null;
  while (Date.now() < deadline) {
    info = await diffInfo(page);
    if (info && ok(info)) return info;
    await page.waitForTimeout(150);
  }
  return info;
}

async function openChangesPanel(page) {
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
const rowIndex = (page, section, file) =>
  page.evaluate(
    ([sec, f]) => {
      const list = document.querySelector('.changes__section')?.parentElement;
      if (!list) return -1;
      const rows = Array.from(list.querySelectorAll(':scope > .change'));
      let cur = '';
      for (const el of list.children) {
        if (el.classList.contains('changes__section')) {
          cur = el.querySelector('span')?.textContent ?? '';
        } else if (
          el.classList.contains('change') &&
          cur === sec &&
          el.querySelector('.change__file')?.textContent === f
        ) {
          return rows.indexOf(el);
        }
      }
      return -1;
    },
    [section, file],
  );

async function changeRow(page, section, file) {
  await page
    .waitForFunction(
      ([sec, f]) => {
        const list = document.querySelector('.changes__section')?.parentElement;
        if (!list) return false;
        let cur = '';
        for (const el of list.children) {
          if (el.classList.contains('changes__section'))
            cur = el.querySelector('span')?.textContent ?? '';
          else if (cur === sec && el.querySelector('.change__file')?.textContent === f) return true;
        }
        return false;
      },
      [section, file],
      { timeout: 15000 },
    )
    .catch(() => {
      throw new Error(`no "${file}" row under "${section}"`);
    });
  const i = await rowIndex(page, section, file);
  return page.locator('.changes__section + .change, .changes__section ~ .change').nth(i);
}

async function closeTab(page, title) {
  const titles = await tabTitles(page);
  const i = titles.indexOf(title);
  assert(i >= 0, `no tab titled "${title}" to close (tabs: ${JSON.stringify(titles)})`);
  await page.locator('.tabbar [role="tab"]').nth(i).locator('.tab__close').click();
  await page.waitForFunction(
    (t) =>
      !Array.from(document.querySelectorAll('.tabbar [role="tab"]')).some((el) =>
        Array.from(el.children).some(
          (c) => c.tagName === 'SPAN' && !c.className && c.textContent === t,
        ),
      ),
    title,
    { timeout: 8000 },
  );
}

async function activateTab(page, title) {
  const i = (await tabTitles(page)).indexOf(title);
  assert(i >= 0, `no tab titled "${title}"`);
  await page.locator('.tabbar [role="tab"]').nth(i).click();
  await waitActiveTab(page, title);
}

// ── Scenarios ──────────────────────────────────────────────────────────────────────────────

async function stagedAndUnstagedTabs(page) {
  await (await changeRow(page, 'Staged', 'both.ts')).click();
  await waitActiveTab(page, 'both.ts (Index)');
  const idx = await waitDiff(page, (d) => d.added.includes(STAGED_MARK));
  assert(
    idx?.added.includes(STAGED_MARK) && !idx.added.includes(UNSTAGED_MARK),
    `(Index) must change only the staged line; added=${JSON.stringify(idx?.added)}`,
  );

  await (await changeRow(page, 'Changes', 'both.ts')).click();
  await waitActiveTab(page, 'both.ts (Working Tree)');
  const wt = await waitDiff(page, (d) => d.added.includes(UNSTAGED_MARK));
  assert(
    wt?.added.includes(UNSTAGED_MARK) && !wt.added.includes(STAGED_MARK),
    `(Working Tree) must change only the unstaged line; added=${JSON.stringify(wt?.added)}`,
  );
  assert(
    (await tabTitles(page)).includes('both.ts (Index)'),
    '(Index) must still be open beside (Working Tree)',
  );
  const titleAttr = await (await changeRow(page, 'Staged', 'both.ts')).getAttribute('title');
  assert(titleAttr === 'Open staged diff', `staged row tooltip: "${titleAttr}"`);
  log('Staged row → (Index), Changes row → (Working Tree), both open ✓');
}

async function unscopedOpenerUnchanged(page) {
  await (await changeRow(page, 'Changes', 'both.ts')).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Open diff', exact: true }).click();
  await waitActiveTab(page, 'both.ts');
  const all = await waitDiff(
    page,
    (d) => d.added.includes(STAGED_MARK) && d.added.includes(UNSTAGED_MARK),
  );
  assert(
    all?.added.includes(STAGED_MARK) && all.added.includes(UNSTAGED_MARK),
    `unscoped tab must change both lines against HEAD; added=${JSON.stringify(all?.added)}`,
  );
  await closeTab(page, 'both.ts');
  log('context-menu "Open diff" is still the unscoped both.ts tab ✓');
}

async function reviewCardAtScope(page) {
  await closeTab(page, 'both.ts (Working Tree)');
  await page.click('.git-indicator__review');
  await page.waitForSelector('.review .rcard', { state: 'visible', timeout: 15000 });
  await page.getByRole('radio', { name: 'Unstaged', exact: true }).click();
  await page.waitForFunction(
    () => {
      const card = document.querySelector('.review .rcard[data-path="both.ts"]');
      return !!card && !card.querySelector('.rcard__notice--loading');
    },
    null,
    { timeout: 15000 },
  );
  await page.click('.review .rcard[data-path="both.ts"] .rcard__sbs');
  await waitActiveTab(page, 'both.ts (Working Tree)');
  const wt = await waitDiff(page, (d) => d.added.includes(UNSTAGED_MARK));
  assert(
    wt?.added.includes(UNSTAGED_MARK) && !wt.added.includes(STAGED_MARK),
    `Review@Unstaged card must open the (Working Tree) side; added=${JSON.stringify(wt?.added)}`,
  );
  assert(wt.toggle === 'Inline view', `card-opened diff must be side-by-side; toggle=${wt.toggle}`);
  await closeTab(page, 'Review Changes');
  await openChangesPanel(page);
  log('Review card at Unstaged opens (Working Tree), side-by-side ✓');
}

async function conflictedRowUnscoped(page) {
  const section = (await rowIndex(page, 'Staged', 'conflicted.ts')) >= 0 ? 'Staged' : 'Changes';
  const row = await changeRow(page, section, 'conflicted.ts');
  const titleAttr = await row.getAttribute('title');
  await row.click();
  await waitActiveTab(page, 'conflicted.ts');
  assert(titleAttr === 'Open diff', `conflicted row tooltip: "${titleAttr}"`);
  await closeTab(page, 'conflicted.ts');
  log(`conflicted row (under ${section}) opens the unscoped tab ✓`);
}

// ── Run ────────────────────────────────────────────────────────────────────────────────────

const userDataDir = mkdtempSync(join(tmpdir(), 'conduit-ud-scoped-'));
let launched = null;
let code = 0;
try {
  const root = makeRepo();
  launched = await launchApp({ userDataDir });
  const { page } = launched;
  await tapBridge(page);
  await openSession(page, { path: root.replace(/\\/g, '/') });
  await openChangesPanel(page);

  await stagedAndUnstagedTabs(page);
  await unscopedOpenerUnchanged(page);
  await reviewCardAtScope(page);
  await conflictedRowUnscoped(page);

  log('PASS ✓');
} catch (e) {
  if (e?.name === 'AssertionError') {
    log('FAIL ✗', e.message);
    code = 1;
  } else {
    console.error(`[${NAME}] ERROR:`, e?.message || e);
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
