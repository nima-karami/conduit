/**
 * Terminal path links v2, MVP flows (plan docs/plans/2026-10-16-terminal-path-links.plan.md
 * T4.6; spec §2.2 rows 2, 4, 27, 32, 55). A non-git parent holds repoA, repoB and a worktree
 * T-123/repoA-wt of repoA (branch feat/x), each with src/index.ts. Every click is a real mouse
 * click at the link's cells, so xterm's hit-test → provider → activate path runs as for a user.
 *
 *   1. `src/index.ts:42` is ambiguous → the picker opens with 3 rows naming each repo/worktree,
 *      focus inside it and its accessible name announcing "3 matches".
 *   2. ArrowDown to repoB + Enter → repoB/src/index.ts opens at line 42.
 *   3. The same link again → repoB is row 0 (last pick).
 *   4. Esc closes it and focus returns to the terminal.
 *   5. `● Update(src/index.ts)` → only the path cells are a link; a click on `U` opens nothing.
 *   6. `…/repoB/src/index.ts` → a single candidate, opened directly.
 *   7. repoA's file deleted on disk, then picked → "no longer exists" toast, no tab opens.
 *   8. Printed on the bottom row, the link's picker is clamped up over the resting pointer; with
 *      no mouse move, Enter still opens the top-ranked row (QA r1 Q3).
 *
 * Step 1 also checks the visible heading (Q2) and that the worktree row's accessible name
 * carries its tag and branch (Q4).
 *
 * exit 0 pass/SKIP · 1 assertion failed · 2 infra error
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assert, openSession, runScenario, typeLine, waitForOutput } from './harness.mjs';
import { tabInfo } from './middle-click-fixture.mjs';
import { waitCursor } from './nav-history-fixture.mjs';

const git = (args, cwd) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
const body = (tag) =>
  `${Array.from({ length: 60 }, (_, i) => `export const ${tag}${i + 1} = ${i + 1};`).join('\n')}\n`;

function makeRepo(dir, tag) {
  mkdirSync(join(dir, 'src'), { recursive: true });
  git(['init', '-q', '-b', 'main'], dir);
  git(['config', 'user.email', 't@t'], dir);
  git(['config', 'user.name', 't'], dir);
  git(['config', 'commit.gpgsign', 'false'], dir);
  writeFileSync(join(dir, 'src', 'index.ts'), body(tag));
  git(['add', '-A'], dir);
  git(['commit', '-qm', tag], dir);
}

const norm = (p) => (p ?? '').replace(/\\/g, '/').toLowerCase();

const LINE_AMBIG = 'src/index.ts:42';
const LINE_TOOL = '● Update(src/index.ts)';
const LINE_ELIDED = '…/repoB/src/index.ts';
// Long, so the picker is wide enough to be clamped left of the pointer that opened it.
const DEEP_DIR = 'src/a-deliberately-long-folder-name-so-the-picker-is-wide/deep';
const LINE_BOTTOM = `${DEEP_DIR}/index.ts:7`;

runScenario('terminal-path-links-v2', async ({ page, log }) => {
  const parent = mkdtempSync(join(tmpdir(), 'conduit-pl2-')).replace(/\\/g, '/');
  makeRepo(join(parent, 'repoA'), 'a');
  makeRepo(join(parent, 'repoB'), 'b');
  mkdirSync(join(parent, 'T-123'));
  git(
    ['worktree', 'add', '-q', '-b', 'feat/x', join(parent, 'T-123', 'repoA-wt')],
    join(parent, 'repoA'),
  );
  log('fixture', parent);

  await page.evaluate(() => {
    window.__terms = {};
    window.__termLinkProviders = {};
  });
  const sid = await openSession(page, { path: parent });
  await page.waitForFunction(
    (id) => {
      const s = (window.__sessions || []).find((x) => x.id === id);
      return (
        s?.repos?.length === 3 && Object.values(s.repoGit ?? {}).some((g) => g?.isWorktree === true)
      );
    },
    sid,
    { timeout: 30000 },
  );
  await page.waitForFunction((dir) => (window.__cap || '').includes('>'), parent, {
    timeout: 30000,
  });
  await page.waitForTimeout(500);
  /** Until the PTY output stops growing: a repaint landing mid-hover moves the rows. */
  const waitQuiet = async () => {
    let last = -1;
    for (let i = 0; i < 40; i++) {
      const len = await page.evaluate(() => (window.__cap || '').length);
      if (len === last) return;
      last = len;
      await page.waitForTimeout(500);
    }
  };
  // Printed by the shell, not written into the xterm: ConPTY repaints its screen when the
  // terminal is re-shown, and bytes it never produced would vanish from under the click.
  await typeLine(page, sid, 'chcp 65001 >nul');
  for (const line of [LINE_AMBIG, LINE_TOOL, LINE_ELIDED]) {
    await typeLine(page, sid, `echo ${line}`);
    await waitForOutput(page, sid, line);
  }
  await waitQuiet();

  /** Viewport point of char `charIdx` of the last row whose text contains `needle`. */
  const cellOf = (needle, charIdx) =>
    page.evaluate(
      ({ id, needle, charIdx }) => {
        const term = window.__terms[id];
        const buf = term.buffer.active;
        let row = -1;
        let col = -1;
        for (let y = 0; y < buf.length; y++) {
          const text = buf.getLine(y)?.translateToString(true) ?? '';
          const at = text.indexOf(needle);
          if (at >= 0) {
            row = y;
            col = at + charIdx;
          }
        }
        const r = term.element.querySelector('.xterm-screen').getBoundingClientRect();
        const cellW = r.width / term.cols;
        const cellH = r.height / term.rows;
        const screenRow = row - buf.viewportY;
        return {
          row,
          col,
          onScreen: row >= 0 && screenRow >= 0 && screenRow < term.rows && r.width > 0,
          x: r.x + (col + 0.5) * cellW,
          y: r.y + (screenRow + 0.5) * cellH,
        };
      },
      { id: sid, needle, charIdx },
    );

  /** Real hover then click. With `onLink`, the click waits for xterm's pointer cursor — the
   *  same "this is a link" cue a user waits for — so it never lands before the link resolved. */
  const clickAt = async (needle, charIdx, { onLink = true } = {}) => {
    const c = await cellOf(needle, charIdx);
    assert(c.onScreen, `"${needle}" is not on screen: ${JSON.stringify(c)}`);
    const hovering = () =>
      page.evaluate(
        (id) => !!window.__terms[id].element.querySelector('.xterm-cursor-pointer'),
        sid,
      );
    for (let attempt = 0; attempt < 40; attempt++) {
      // Off the cell first: xterm re-resolves a cell's link only on a mousemove into it, and the
      // pointer may still rest where an earlier, since-repainted link was.
      await page.mouse.move(c.x, c.y + 400);
      await page.mouse.move(c.x, c.y, { steps: 4 });
      await page.waitForTimeout(400);
      if (!onLink || (await hovering())) break;
    }
    if (onLink) assert(await hovering(), `"${needle}" never showed the link pointer`);
    await page.mouse.click(c.x, c.y);
    return c;
  };

  const pickerRowsText = () =>
    page.evaluate(() =>
      Array.from(document.querySelectorAll('.pathpick [role="option"]')).map(
        (el) => el.textContent ?? '',
      ),
    );

  const activeDocPath = () =>
    page.evaluate(() => {
      const eds = (window.monaco?.editor.getEditors() ?? []).filter(
        (e) => e.getDomNode()?.isConnected,
      );
      const ed = eds.find((e) => e.hasTextFocus()) ?? eds[eds.length - 1];
      return ed?.getModel()?.uri.path ?? null;
    });

  const backToTerminal = async () => {
    await page.click('.tab[data-tabid="__terminal__"]');
    await page.waitForFunction((id) => window.__terms[id]?.element?.offsetWidth > 0, sid, {
      timeout: 10000,
    });
    await waitQuiet();
  };

  // ── 1. ambiguous → picker ──────────────────────────────────────────────────────────
  await clickAt(LINE_AMBIG, 3);
  await page.waitForSelector('.pathpick', { state: 'visible', timeout: 10000 });
  await page.waitForFunction(
    () => document.querySelectorAll('.pathpick [role="option"]').length === 3,
    null,
    {
      timeout: 5000,
    },
  );
  const rows1 = await pickerRowsText();
  log('picker rows:', JSON.stringify(rows1));
  for (const want of ['repoA', 'repoB', 'repoA-wt', 'feat/x']) {
    assert(
      rows1.some((t) => t.includes(want)),
      `picker rows should name ${want}: ${JSON.stringify(rows1)}`,
    );
  }
  const focusedLabel = await page.evaluate(
    () => document.activeElement?.getAttribute('aria-label') ?? '',
  );
  assert(
    focusedLabel.includes('3 matches'),
    `focused element should announce 3 matches, got "${focusedLabel}"`,
  );
  const head = await page.evaluate(() => {
    const el = document.querySelector('.pathpick__head');
    return el
      ? {
          text: el.textContent ?? '',
          shown: el.getBoundingClientRect().height > 0,
          inList: !!el.closest('[role="listbox"]'),
          focusable: el.tabIndex >= 0,
        }
      : null;
  });
  assert(
    head?.shown && head.text === 'src/index.ts · 3 matches' && !head.inList && !head.focusable,
    `the picker should show a non-row, non-focusable heading "src/index.ts · 3 matches", got ${JSON.stringify(head)}`,
  );
  const wtName = await page.evaluate(
    () =>
      Array.from(document.querySelectorAll('.pathpick [role="option"]'))
        .map((el) => el.getAttribute('aria-label') ?? '')
        .find((n) => n.startsWith('repoA-wt')) ?? '',
  );
  assert(
    wtName.includes('Worktree') && wtName.includes('feat/x'),
    `the worktree row's accessible name should carry its tag and branch, got "${wtName}"`,
  );
  log('step 1: picker with 3 named rows and a heading, focus announces the count ✓');

  // ── 2. pick repoB → opens at line 42 ───────────────────────────────────────────────
  const repoBIdx = rows1.findIndex((t) => /^repoB(?!-)/.test(t));
  assert(repoBIdx >= 0, `no repoB row in ${JSON.stringify(rows1)}`);
  for (let i = 0; i < repoBIdx; i++) await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await page.waitForSelector('.pathpick', { state: 'detached', timeout: 5000 });
  await page.waitForFunction(() => (window.monaco?.editor.getEditors() ?? []).length > 0, null, {
    timeout: 15000,
  });
  await waitCursor(page, 42, 15000);
  const opened = norm(await activeDocPath());
  assert(
    opened.endsWith('/repob/src/index.ts'),
    `repoB's index.ts should be the active doc, got ${opened}`,
  );
  log('step 2: repoB/src/index.ts opened at line 42 ✓');

  // ── 3. last pick ranks first ───────────────────────────────────────────────────────
  await backToTerminal();
  await clickAt(LINE_AMBIG, 3);
  await page.waitForSelector('.pathpick', { state: 'visible', timeout: 10000 });
  const rows3 = await pickerRowsText();
  assert(
    /^repoB(?!-)/.test(rows3[0] ?? ''),
    `row 0 should be repoB after picking it, got ${JSON.stringify(rows3)}`,
  );
  log('step 3: last pick is row 0 ✓');

  // ── 4. Esc closes, focus back in the terminal ──────────────────────────────────────
  await page.keyboard.press('Escape');
  await page.waitForSelector('.pathpick', { state: 'detached', timeout: 5000 });
  const focusCls = await page.evaluate(() => document.activeElement?.className ?? '');
  assert(
    focusCls.includes('xterm-helper-textarea'),
    `focus should return to the terminal, got "${focusCls}"`,
  );
  log('step 4: Esc returns focus to the terminal ✓');

  // ── 5. tool header: only the path cells link ───────────────────────────────────────
  const tool = await cellOf(LINE_TOOL, 0);
  const links = await page.evaluate(
    ({ id, row }) =>
      new Promise((resolve) => {
        window.__termLinkProviders[id].provideLinks(row + 1, (ls) =>
          resolve(
            (ls ?? []).map((l) => ({ text: l.text, start: l.range.start.x, end: l.range.end.x })),
          ),
        );
      }),
    { id: sid, row: tool.row },
  );
  const pathCol = LINE_TOOL.indexOf('src/');
  log('tool-header links:', JSON.stringify(links), 'path col', tool.col + pathCol);
  assert(
    links.length === 1 &&
      links[0].text === 'src/index.ts' &&
      links[0].start === tool.col + pathCol + 1,
    `the tool header's only link should be its path cells, got ${JSON.stringify(links)}`,
  );
  const tabsBefore = (await tabInfo(page)).length;
  await clickAt(LINE_TOOL, LINE_TOOL.indexOf('U'), { onLink: false });
  await page.waitForTimeout(800);
  const pickerOnU = await page.locator('.pathpick').count();
  assert(
    pickerOnU === 0 && (await tabInfo(page)).length === tabsBefore,
    'a click on "Update(" must open nothing',
  );
  log('step 5: tool header links only its path ✓');

  // ── 6. truncated …/ path → single candidate opens directly ─────────────────────────
  await clickAt(LINE_ELIDED, 4);
  await page.waitForFunction(
    () => {
      const eds = (window.monaco?.editor.getEditors() ?? []).filter(
        (e) => e.getDomNode()?.isConnected,
      );
      return eds.some((e) =>
        (e.getModel()?.uri.path ?? '').toLowerCase().endsWith('/repob/src/index.ts'),
      );
    },
    null,
    { timeout: 15000 },
  );
  assert(
    (await page.locator('.pathpick').count()) === 0,
    'a single candidate must open without the picker',
  );
  log('step 6: …/repoB/src/index.ts opened directly ✓');

  // ── 7. stale candidate → toast, nothing opens ──────────────────────────────────────
  rmSync(join(parent, 'repoA', 'src', 'index.ts'));
  await backToTerminal();
  const tabs7 = (await tabInfo(page)).length;
  await clickAt(LINE_AMBIG, 3);
  await page.waitForSelector('.pathpick', { state: 'visible', timeout: 10000 });
  const rows7 = await pickerRowsText();
  const repoAIdx = rows7.findIndex((t) => /^repoA(?!-)/.test(t));
  assert(
    repoAIdx >= 0,
    `repoA should still be offered from the cache, got ${JSON.stringify(rows7)}`,
  );
  for (let i = 0; i < repoAIdx; i++) await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await page.waitForSelector('.toast', { state: 'visible', timeout: 5000 });
  const toastText = await page.locator('.toast').last().textContent();
  assert(
    /no longer exists/.test(toastText ?? ''),
    `expected a "no longer exists" toast, got "${toastText}"`,
  );
  await page.waitForTimeout(500);
  assert((await tabInfo(page)).length === tabs7, 'a stale pick must open no tab');
  log('step 7: stale pick toasts and opens nothing ✓');

  // ── 8. resting pointer under a clamped picker keeps the top-ranked row ─────────────
  for (const dir of ['repoA', 'repoB', 'T-123/repoA-wt']) {
    mkdirSync(join(parent, dir, DEEP_DIR), { recursive: true });
    writeFileSync(join(parent, dir, DEEP_DIR, 'index.ts'), body('d'));
  }
  await typeLine(page, sid, 'cls');
  // Blank lines first and right-aligned, so the link lands in the bottom-right corner and the
  // picker is clamped up and left over the pointer that clicked it (unclamped, the pointer only
  // ever rests on the frame's own padding).
  await typeLine(page, sid, 'for /L %i in (1,1,120) do @echo.');
  const cols = await page.evaluate((id) => window.__terms[id].cols, sid);
  await typeLine(page, sid, `echo ${' '.repeat(cols - LINE_BOTTOM.length - 1)}${LINE_BOTTOM}`);
  await waitForOutput(page, sid, LINE_BOTTOM);
  await waitQuiet();
  const c8 = await clickAt(LINE_BOTTOM, LINE_BOTTOM.length - 6);
  await page.waitForSelector('.pathpick', { state: 'visible', timeout: 10000 });
  await page.waitForFunction(
    () => document.querySelectorAll('.pathpick [role="option"]').length === 3,
    null,
    { timeout: 5000 },
  );
  // Long enough for the hover update a stationary pointer gets after layout.
  await page.waitForTimeout(600);
  const rest = await page.evaluate(({ x, y }) => {
    const opts = Array.from(document.querySelectorAll('.pathpick [role="option"]'));
    const under = document.elementFromPoint(x, y)?.closest('[role="option"]');
    return {
      underIdx: under ? opts.indexOf(under) : -1,
      activeIdx: opts.findIndex((el) => el.getAttribute('aria-selected') === 'true'),
      top: opts[0]?.textContent ?? '',
      at: { x, y, vw: window.innerWidth, vh: window.innerHeight },
      frame: document.querySelector('.pathpick')?.getBoundingClientRect().toJSON(),
      rows: opts.map((el) => Math.round(el.getBoundingClientRect().top)),
      hit: document.elementFromPoint(x, y)?.className ?? null,
    };
  }, c8);
  log('step 8 pointer rests on row', rest.underIdx, 'active row', rest.activeIdx);
  assert(
    rest.underIdx >= 1,
    `precondition: the resting pointer should be over a row below the first, got ${JSON.stringify(rest)}`,
  );
  assert(
    rest.activeIdx === 0,
    `the top-ranked row should stay active under a resting pointer, got ${JSON.stringify(rest)}`,
  );
  const topRepo = `${
    /^repoA-wt/.test(rest.top) ? '/t-123/repoa-wt' : /^repoB/.test(rest.top) ? '/repob' : '/repoa'
  }/${DEEP_DIR}/index.ts`;
  await page.keyboard.press('Enter');
  await page.waitForSelector('.pathpick', { state: 'detached', timeout: 5000 });
  await waitCursor(page, 7, 15000);
  const opened8 = norm(await activeDocPath());
  assert(opened8.endsWith(topRepo), `Enter should open the top-ranked ${topRepo}, got ${opened8}`);
  log('step 8: a resting pointer does not steal the preselection ✓');
});
