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
import { appendFileSync, mkdtempSync, writeFileSync } from 'node:fs';
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
const LATER_MARK = 'MARK_LATER_EDIT';
const NEW_MARK = 'MARK_UNTRACKED';

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
  writeFileSync(join(root, 'new.ts'), `const fresh = '${NEW_MARK}';\nconst two = 2;\n`);
  const status = execFileSync('git', ['status', '--porcelain', 'both.ts'], {
    cwd: root,
    encoding: 'utf8',
  });
  assert(status.startsWith('MM'), `fixture: both.ts must be MM, got "${status}"`);
  return root;
}

// ── Page helpers ───────────────────────────────────────────────────────────────────────────

/**
 * In-page DOM readers, installed once per launched page so every waitForFunction and evaluate
 * shares one definition. A tab's title is its bare (class-less) <span>; the Changes list is a flat
 * run of section headers and rows, so a row's section is the last header above it.
 */
const installHelpers = (page) =>
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

const tabTitles = (page) => page.evaluate(() => window.__sd.titles());

async function waitActiveTab(page, title) {
  await page
    .waitForFunction((want) => window.__sd.active() === want, title, { timeout: 15000 })
    .catch(async () => {
      const is = await page.evaluate(() => window.__sd.active());
      throw new Error(`active tab never became "${title}" (is "${is}")`);
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
  page.evaluate(([sec, f]) => window.__sd.rowIndex(sec, f), [section, file]);

async function changeRow(page, section, file) {
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

async function closeTab(page, title) {
  const titles = await tabTitles(page);
  const i = titles.indexOf(title);
  assert(i >= 0, `no tab titled "${title}" to close (tabs: ${JSON.stringify(titles)})`);
  await page.locator('.tabbar [role="tab"]').nth(i).locator('.tab__close').click();
  await page.waitForFunction((t) => !window.__sd.titles().includes(t), title, { timeout: 8000 });
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

async function editOnDiskRefreshes(page, root) {
  await (await changeRow(page, 'Changes', 'both.ts')).click();
  await waitActiveTab(page, 'both.ts (Working Tree)');
  await waitDiff(page, (d) => d.added.includes(UNSTAGED_MARK));
  await page.evaluate(() => {
    const eds = window.monaco.editor
      .getDiffEditors()
      .filter((e) => e.getContainerDomNode().isConnected);
    eds[eds.length - 1].getModifiedEditor().setPosition({ lineNumber: 18, column: 1 });
  });
  appendFileSync(join(root, 'both.ts'), `const later = '${LATER_MARK}';\n`);
  const after = await waitDiff(page, (d) => d.modified.includes(LATER_MARK), 20000);
  assert(
    after?.modified.includes(LATER_MARK),
    '(Working Tree) must pick up an on-disk edit without being reopened',
  );
  assert(after.cursorLine === 18, `cursor must survive the refresh; on line ${after.cursorLine}`);
  log('on-disk edit refreshed (Working Tree) in place, cursor kept on line 18 ✓');
}

/** Records every "Loading diff…" the center pane ever shows from now on. */
const armLoadingObserver = (page) =>
  page.evaluate(() => {
    window.__loadingSeen = [];
    const center = document.querySelector('.center');
    const check = () => {
      if (center?.textContent?.includes('Loading diff…')) window.__loadingSeen.push(Date.now());
    };
    window.__loadingObs?.disconnect();
    window.__loadingObs = new MutationObserver(check);
    window.__loadingObs.observe(center, { subtree: true, childList: true, characterData: true });
  });

async function stagingEmptiesWorkingTree(page) {
  await activateTab(page, 'both.ts (Working Tree)');
  await armLoadingObserver(page);
  const row = await changeRow(page, 'Changes', 'both.ts');
  await row.hover();
  await row.locator('.change__action[title="Stage this file"]').click();
  await page.waitForFunction(
    () =>
      !Array.from(document.querySelectorAll('.change .change__file')).some(
        (f) => f.textContent === 'both.ts' && f.closest('.change')?.title === 'Open unstaged diff',
      ),
    null,
    { timeout: 15000 },
  );
  const want = 'No unstaged changes in both.ts.';
  const notice = await page
    .waitForFunction(
      (w) => {
        const n = document.querySelector('.docpanel__body .viewer__notice > div');
        return n?.textContent === w ? n.textContent : null;
      },
      want,
      { timeout: 15000 },
    )
    .then((h) => h.jsonValue())
    .catch(() =>
      page.evaluate(() => document.querySelector('.docpanel__body .viewer__notice')?.textContent),
    );
  assert(notice === want, `(Working Tree) must show "${want}" once staged; got "${notice}"`);
  assert(
    (await tabTitles(page)).includes('both.ts (Working Tree)'),
    'the emptied (Working Tree) tab must stay open',
  );
  await activateTab(page, 'both.ts (Index)');
  const idx = await waitDiff(
    page,
    (d) => d.added.includes(UNSTAGED_MARK) && d.added.includes(LATER_MARK),
  );
  assert(
    idx?.added.includes(UNSTAGED_MARK) && idx.added.includes(STAGED_MARK),
    `(Index) must now hold every staged change; added=${JSON.stringify(idx?.added)}`,
  );
  const seen = await page.evaluate(() => window.__loadingSeen.length);
  assert(seen === 0, `a refresh flashed "Loading diff…" ${seen} time(s)`);
  log('staging emptied (Working Tree), (Index) gained the unstaged hunk, no Loading flash ✓');
}

async function untrackedFile(page) {
  await (await changeRow(page, 'Changes', 'new.ts')).click();
  await waitActiveTab(page, 'new.ts (Working Tree)');
  const d = await waitDiff(page, (i) => i.added.includes(NEW_MARK));
  assert(
    d &&
      d.original === '' &&
      d.removed === '' &&
      d.added.replace(/\n$/, '') === d.modified.replace(/\n$/, ''),
    `untracked (Working Tree) must be a whole-file add; ${JSON.stringify(d)}`,
  );
  log('untracked new.ts opens (Working Tree) as a whole-file add ✓');
}

async function restartKeepsScope(page, root) {
  const titles = await tabTitles(page);
  assert(
    titles.includes('both.ts (Index)') && titles.includes('both.ts (Working Tree)'),
    `both scoped tabs must be open before the restart: ${JSON.stringify(titles)}`,
  );
  // Let the debounced persistDocs land before closing.
  await page.waitForTimeout(800);
  await closeApp(launched.app, page);
  launched = await launchApp({ userDataDir });
  const next = launched.page;
  await tapBridge(next);
  await installHelpers(next);
  const repoName = root.replace(/\\/g, '/').split('/').filter(Boolean).pop();
  await next.waitForSelector(`.session:has-text("${repoName}")`, { timeout: 45000 });
  await next.locator('.session', { hasText: repoName }).first().click();
  await next.waitForFunction(
    () => {
      const ts = window.__sd.titles();
      return ts.includes('both.ts (Index)') && ts.includes('both.ts (Working Tree)');
    },
    null,
    { timeout: 20000 },
  );
  await activateTab(next, 'both.ts (Index)');
  const idx = await waitDiff(next, (d) => d.added.includes(STAGED_MARK));
  assert(
    idx?.added.includes(STAGED_MARK) && !idx.added.includes(UNSTAGED_MARK),
    `restored (Index) must show the staged side; added=${JSON.stringify(idx?.added)}`,
  );
  await activateTab(next, 'both.ts (Working Tree)');
  const wt = await waitDiff(next, (d) => d.added.includes(UNSTAGED_MARK));
  assert(
    wt?.added.includes(UNSTAGED_MARK) && !wt.added.includes(STAGED_MARK),
    `restored (Working Tree) must show the unstaged side; added=${JSON.stringify(wt?.added)}`,
  );
  log('both scoped tabs restored with their titles and content ✓');

  await closeTab(next, 'both.ts (Index)');
  await next.locator('.tabbar [role="tab"][aria-selected="true"]').focus();
  await next.keyboard.press('Control+Shift+T');
  await waitActiveTab(next, 'both.ts (Index)');
  const re = await waitDiff(next, (d) => d.added.includes(STAGED_MARK));
  assert(
    re?.added.includes(STAGED_MARK) && !re.added.includes(UNSTAGED_MARK),
    `Mod+Shift+T must reopen (Index) with the staged side; added=${JSON.stringify(re?.added)}`,
  );
  log('Mod+Shift+T reopened (Index) with its scope ✓');
  return next;
}

/**
 * The host catches every blob/fs failure itself, so there is no natural way to make a read
 * fail. Rewrite the host's `fileDiff` replies for `leaf` into error DTOs while the flag is set.
 */
const setDiffFailure = (app, leaf, on) =>
  app.evaluate(
    (electron, [l, flag]) => {
      global.__failDiffLeaf = flag ? l : null;
      const wc = electron.BrowserWindow.getAllWindows()[0].webContents;
      if (wc.__failWrapped) return;
      wc.__failWrapped = true;
      const send = wc.send.bind(wc);
      wc.send = (channel, msg, ...rest) => {
        const leafNow = global.__failDiffLeaf;
        if (leafNow && msg?.type === 'fileDiff' && msg.doc.path.endsWith(leafNow))
          msg = { ...msg, doc: { ...msg.doc, head: '', work: '', error: 'e2e: injected failure' } };
        return send(channel, msg, ...rest);
      };
    },
    [leaf, on],
  );

async function retryRecoversAndKeepsFocus(page) {
  await setDiffFailure(launched.app, 'both.ts', true);
  await (await changeRow(page, 'Staged', 'both.ts')).click();
  await waitActiveTab(page, 'both.ts (Index)');
  const errorText = "Couldn't read this diff.";
  await page.waitForFunction(
    (t) => document.querySelector('.difftab .viewer__notice > div')?.textContent === t,
    errorText,
    { timeout: 15000 },
  );
  // An idle project must leave the Error state alone: nothing re-reads it behind the user's back.
  await page.waitForTimeout(2000);
  const still = await page.evaluate(
    () => document.querySelector('.difftab .viewer__notice > div')?.textContent ?? null,
  );
  assert(still === errorText, `the Error notice must hold while idle; now "${still}"`);

  await setDiffFailure(launched.app, 'both.ts', false);
  await page.locator('.difftab .viewer__notice-action', { hasText: 'Retry' }).click();
  const d = await waitDiff(page, (i) => i.added.includes(UNSTAGED_MARK));
  assert(d?.added.includes(UNSTAGED_MARK), 'Retry must bring the real diff back');
  const focus = await page.evaluate(() => {
    const a = document.activeElement;
    return { tag: a?.tagName ?? null, inTab: !!a?.closest('.difftab') };
  });
  assert(focus.inTab, `after a successful Retry focus must stay in the tab, not ${focus.tag}`);
  log('Error state holds while idle; Retry restores the diff and keeps focus in the tab ✓');
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
  await installHelpers(page);
  await openSession(page, { path: root.replace(/\\/g, '/') });
  await openChangesPanel(page);

  await stagedAndUnstagedTabs(page);
  await unscopedOpenerUnchanged(page);
  await reviewCardAtScope(page);
  await conflictedRowUnscoped(page);
  await editOnDiskRefreshes(page, root);

  const relaunched = await restartKeepsScope(page, root);
  await openChangesPanel(relaunched);
  await stagingEmptiesWorkingTree(relaunched);
  await untrackedFile(relaunched);
  await retryRecoversAndKeepsFocus(relaunched);

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
