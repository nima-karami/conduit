/** Shared by the split-editor e2e scenarios: selectors and real-input steps on editor groups. */

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assert, openChangesTab } from './harness.mjs';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const G = (g) => `.editor-group[data-group="${g}"]`;
export const groupCount = (page) => page.locator('.editor-group').count();
const esc = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export async function openFromExplorer(page, name) {
  await explorer(page, name, 'dblclick');
  await page.waitForFunction(
    (n) => document.querySelector('.tabbar [role="tab"].tab--active span')?.textContent === n,
    name,
    { timeout: 15000 },
  );
  await page.waitForSelector('.viewer__monaco .monaco-editor', { timeout: 15000 });
}

export const politeText = (page) =>
  page.evaluate(
    () =>
      document.querySelector('.shell > [role="status"][aria-live="polite"]:not(.bg-open-status)')
        ?.textContent ?? '',
  );

export const groupTabs = (page, g) =>
  page.evaluate(
    (sel) => [...document.querySelectorAll(`${sel} [role="tab"] span`)].map((e) => e.textContent),
    G(g),
  );

export async function waitPolite(page, text, label) {
  await page
    .waitForFunction(
      (t) =>
        document.querySelector('.shell > [role="status"][aria-live="polite"]:not(.bg-open-status)')
          ?.textContent === t,
      text,
      { timeout: 5000 },
    )
    .catch(async () =>
      assert(false, `${label}: the polite region says ${JSON.stringify(await politeText(page))}`),
    );
}

export const tabOf = (page, g, name) =>
  page.locator(`${G(g)} [role="tab"]`, {
    has: page.locator('span', { hasText: new RegExp(`^${esc(name)}$`) }),
  });

/** The group's shown tab: `.tab--active` in the active group, `.tab--current` in the other. */
export const shownTab = (page, g) =>
  page.evaluate(
    (sel) =>
      document.querySelector(`${sel} .tab--active span, ${sel} .tab--current span`)?.textContent ??
      null,
    G(g),
  );

export const groupState = async (page, g) => ({
  tabs: await groupTabs(page, g),
  shown: await shownTab(page, g),
});

export const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** A real click or double-click on an explorer row (single = preview, double = pinned). */
export async function explorer(page, name, how) {
  await page.click('.rtab:has-text("Files")');
  const row = page.locator('.filerow', {
    has: page.locator('.filerow__name', { hasText: new RegExp(`^${esc(name)}$`) }),
  });
  await row.first().waitFor({ state: 'attached', timeout: 20000 });
  if (how === 'dblclick') await row.first().dblclick();
  else await row.first().click();
}

export async function waitShown(page, g, name, label) {
  await page
    .waitForFunction(
      ({ sel, n }) =>
        document.querySelector(`${sel}[data-active="true"] .tab--active span`)?.textContent === n,
      { sel: G(g), n: name },
      { timeout: 15000 },
    )
    .catch(async () =>
      assert(
        false,
        `${label}: group ${g} is not active on ${name} (${JSON.stringify(await groupState(page, g))})`,
      ),
    );
}

/**
 * The repo split-editor-split/-move/-restore work in. b.ts is committed so Alt+F5 has changes;
 * rv/ is committed, then edited, so Review has enough cards to scroll. `hasGit` is false without git.
 */
export function makeSplitRepo() {
  const repo = mkdtempSync(join(tmpdir(), 'conduit-split-repo-'));
  writeFileSync(join(repo, 'a.ts'), 'export const answer = 42;\n');
  const filler = Array.from({ length: 200 }, (_, i) => `// line ${i + 3}`).join('\n');
  writeFileSync(
    join(repo, 'b.ts'),
    `import { answer } from './a';\nexport const doubled = answer * 2;\n${filler}\n`,
  );
  writeFileSync(
    join(repo, 'c.ts'),
    "import { answer } from './a';\nexport const tripled = answer * 3;\n",
  );
  for (const n of ['x', 'y', 'z', 'p', 'q'])
    writeFileSync(join(repo, `${n}.ts`), `export const ${n} = 1;\n`);
  writeFileSync(join(repo, 'note.md'), '# Note\n\nSome text.\n');
  writeFileSync(join(repo, 'go.mod'), 'module example.com/split\n\ngo 1.21\n');
  writeFileSync(join(repo, 'main.go'), 'package main\n\nfunc main() {}\n');
  const REVIEW_FILES = 12;
  const reviewLines = (n) => Array.from({ length: 120 }, (_, i) => `${n} line ${i + 1}`);
  let hasGit = false;
  try {
    execFileSync('git', ['init', '-q'], { cwd: repo });
    mkdirSync(join(repo, 'rv'));
    for (let n = 1; n <= REVIEW_FILES; n++) {
      writeFileSync(join(repo, 'rv', `f${n}.txt`), `${reviewLines(n).join('\n')}\n`);
    }
    execFileSync('git', ['-c', 'core.autocrlf=false', 'add', 'rv', 'b.ts'], { cwd: repo });
    execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init'], {
      cwd: repo,
    });
    for (let n = 1; n <= REVIEW_FILES; n++) {
      const lines = reviewLines(n);
      lines[3] = `${n} line 4 edited`;
      lines[115] = `${n} line 116 edited`;
      writeFileSync(join(repo, 'rv', `f${n}.txt`), `${lines.join('\n')}\n`);
    }
    hasGit = true;
  } catch {
    /* git absent — RV is skipped, everything else works without a repo */
  }
  const repoArg = repo.replace(/\\/g, '/');
  return { repo, repoArg, repoName: repoArg.split('/').filter(Boolean).pop(), hasGit };
}

/*
 * Replay primitives. Playwright's waitForFunction polls on rAF, its click waits two frames for the
 * target to be stable and each mouse-move step waits one; the runner's hidden window throttles rAF
 * to ~1 fps, which made a replayed prefix cost more than the assertions after it. Setup polls on a
 * timer, clicks with `force` after waiting for visibility, and focuses editors directly.
 */
export const until = (page, fn, arg, timeout = 10000) =>
  page.waitForFunction(fn, arg, { timeout, polling: 100 });

export async function press(locator, opts) {
  await locator.first().waitFor({ state: 'visible', timeout: 15000 });
  await locator.first().click({ force: true, ...opts });
}

/**
 * Stands in for a click into the editor under `scope`: focus activates its group just as a
 * pointer-down does (editor-group-pane.tsx), and every replayed click is followed by keys that set
 * the cursor or don't read it. A forced click there did not reliably take focus.
 */
export async function focusEditor(page, scope) {
  await page.waitForSelector(`${scope} .monaco-editor`, { timeout: 15000 });
  await page.evaluate((sel) => {
    window.monaco.editor
      .getEditors()
      .find((e) => e.getContainerDomNode().closest(sel))
      ?.focus();
  }, scope);
  await until(page, (sel) => !!document.activeElement?.closest(`${sel} .monaco-editor`), scope);
}

const untilGroups = (page, n) =>
  until(page, (k) => document.querySelectorAll('.editor-group').length === k, n);

export const untilDirty = (page, n) =>
  until(page, (k) => document.querySelectorAll('.tab--dirty').length === k, n);

export const untilShown = (page, g, name) =>
  until(
    page,
    ({ sel, n }) =>
      document.querySelector(`${sel}[data-active="true"] .tab--active span`)?.textContent === n,
    { sel: G(g), n: name },
    15000,
  );

/** `explorer` for setup. */
export async function setupExplorer(page, name, how) {
  await press(page.locator('.rtab:has-text("Files")'));
  const row = page.locator('.filerow', {
    has: page.locator('.filerow__name', { hasText: new RegExp(`^${esc(name)}$`) }),
  });
  await row.first().waitFor({ state: 'visible', timeout: 20000 });
  if (how === 'dblclick') await row.first().dblclick({ force: true });
  else await row.first().click({ force: true });
}

/** `openFromExplorer` for setup. */
async function setupOpen(page, name) {
  await setupExplorer(page, name, 'dblclick');
  await until(
    page,
    (n) => document.querySelector('.tabbar [role="tab"].tab--active span')?.textContent === n,
    name,
    15000,
  );
  await page.waitForSelector('.viewer__monaco .monaco-editor', { timeout: 15000 });
}

/**
 * split-editor-split's steps up to E6, as setup (no assertions, no restart in between): one
 * active group on b.ts, b.ts saved with E2's edit, the divider ratio at E8's ~0.3.
 */
export async function replaySplitToE6(page) {
  await setupOpen(page, 'b.ts');
  await focusEditor(page, '.viewer__monaco');
  await page.keyboard.press('Control+Backslash');
  await untilGroups(page, 2);
  await page.waitForSelector(`${G(1)} .monaco-editor`, { timeout: 15000 });
  await page.waitForSelector(`${G(2)} .monaco-editor`, { timeout: 15000 });
  await focusEditor(page, G(2));
  await page.keyboard.press('Control+Home');
  await page.keyboard.type('X');
  await untilDirty(page, 2);
  await page.keyboard.press('Control+S');
  await untilDirty(page, 0);
  await page.locator('.editorgroups__divider').focus();
  for (let i = 0; i < 3; i++) await page.keyboard.press('ArrowLeft');
  await sleep(200);
  const div = await page.locator('.editorgroups__divider').boundingBox();
  const dx = div.x + div.width / 2;
  const dy = div.y + div.height / 2;
  await page.mouse.move(dx, dy);
  await page.mouse.down();
  await page.mouse.move(dx - 100, dy);
  await page.mouse.move(dx - 200, dy);
  await page.mouse.up();
  await sleep(200);
  await press(page.locator(`${G(2)} .tab .tab__close`));
  await untilGroups(page, 1);
}

async function replayReviewMove(page, from, key) {
  const to = from === 1 ? 2 : 1;
  await page.focus(`${G(from)} .review__scroll`);
  await page.keyboard.press(key);
  await page.waitForSelector(`${G(to)}[data-active="true"] .review__scroll`, { timeout: 10000 });
  await sleep(900);
}

/** split-editor-move's M1, MV, RV, E4 and E5 steps, as setup (RV and E4 only with git). */
export async function replayMoves(page, hasGit) {
  await press(tabOf(page, 1, 'b.ts'), { button: 'right' });
  await page
    .locator('.ctxmenu__item', { hasText: /^Move to Other Group$/ })
    .waitFor({ timeout: 5000 });
  await page.keyboard.press('Escape');
  await focusEditor(page, G(1));
  await page.keyboard.press('Control+Alt+ArrowRight');
  await untilGroups(page, 2);
  await untilShown(page, 2, 'b.ts');
  await until(page, (sel) => !!document.activeElement?.closest(sel), G(2));
  await page.keyboard.press('Control+Alt+ArrowLeft');
  await untilGroups(page, 1);
  await untilShown(page, 1, 'b.ts');

  await setupOpen(page, 'a.ts');
  await focusEditor(page, G(1));
  await page.keyboard.press('Control+Backslash');
  await untilGroups(page, 2);
  await press(page.locator(`${G(1)} [role="tab"]`, { hasText: 'b.ts' }));
  await page.waitForSelector(`${G(1)}[data-active="true"] .tab--active`, { timeout: 5000 });
  await focusEditor(page, G(1));
  await page.keyboard.press('Control+Alt+ArrowRight');
  await untilShown(page, 2, 'b.ts');

  if (hasGit) {
    await focusEditor(page, G(1));
    await openChangesTab(page);
    await press(page.locator('.changes__review'));
    await page.waitForSelector('.review', { state: 'visible', timeout: 20000 });
    await page.waitForSelector(`${G(1)} .review .rcard[data-path="rv/f1.txt"] .rline`, {
      state: 'attached',
      timeout: 25000,
    });
    await page.$eval(`${G(1)} .review__scroll`, (el) => {
      el.scrollTop = 1500;
    });
    await sleep(900);
    await replayReviewMove(page, 1, 'Control+Alt+ArrowRight');
    await replayReviewMove(page, 2, 'Control+Alt+ArrowLeft');

    await page.focus(`${G(1)} .review__scroll`);
    await page.keyboard.press('Control+W');
    await until(page, () => !document.querySelector('.review'), null);
    await setupExplorer(page, 'c.ts', 'dblclick');
    await untilShown(page, 1, 'c.ts');
    await page.waitForSelector(`${G(1)} .monaco-editor .view-lines`, { timeout: 15000 });
    const at = await tokenPoint(page, 1, 'answer');
    await page.mouse.click(at.x, at.y);
    await page.keyboard.press('F12');
    await untilShown(page, 1, 'a.ts');
  }

  await focusEditor(page, G(2));
  await setupExplorer(page, 'x.ts', 'dblclick');
  await untilShown(page, 2, 'x.ts');
  await press(page.locator(`${G(1)} button.tab[data-tabid="__terminal__"]`));
  await page.waitForSelector(
    `${G(1)}[data-active="true"] button.tab--active[data-tabid="__terminal__"]`,
    { timeout: 5000 },
  );
  await setupExplorer(page, 'y.ts', 'dblclick');
  await untilShown(page, 2, 'y.ts');
}

export const editorPosition = (page, g) =>
  page.evaluate((sel) => {
    const ed = window.monaco.editor.getEditors().find((e) => e.getContainerDomNode().closest(sel));
    return ed?.getPosition() ?? null;
  }, G(g));

/** Where `token` is painted in group g's editor, read from the rendered line with a DOM Range. */
export const tokenPoint = (page, g, token) =>
  page.evaluate(
    ({ sel, tok }) => {
      const ed = window.monaco.editor
        .getEditors()
        .find((e) => e.getContainerDomNode().closest(sel));
      const model = ed?.getModel();
      if (!model) return null;
      const off = model.getValue().indexOf(tok);
      if (off < 0) return null;
      const pos = model.getPositionAt(off);
      const top =
        ed.getDomNode().getBoundingClientRect().top + ed.getScrolledVisiblePosition(pos).top;
      const line = [...ed.getDomNode().querySelectorAll('.view-lines .view-line')].find(
        (el) => Math.abs(el.getBoundingClientRect().top - top) < 2,
      );
      if (!line) return null;
      let at = pos.column - 1 + Math.floor(tok.length / 2);
      const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        if (at < n.length) {
          const range = document.createRange();
          range.setStart(n, at);
          range.setEnd(n, at + 1);
          const r = range.getBoundingClientRect();
          return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
        }
        at -= n.length;
      }
      return null;
    },
    { sel: G(g), tok: token },
  );
