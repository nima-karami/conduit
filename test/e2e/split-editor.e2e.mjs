/**
 * split-editor — two editor groups on screen (docs/specs/2026-09-28-split-editor.md §7).
 *
 * Slice 4 scenarios, in one profile reused across a restart (like editor-tabs-persist):
 *   E1  Ctrl+\ on a file tab → two groups, the right one active and holding the file.
 *   E2  typing in one group shows in the other; both tabs dirty; Ctrl+S clears both.
 *   E3  scrolling one group's editor leaves the other's scroll position alone.
 *   E13 with the right group active the split button is aria-disabled and Ctrl+\ announces the cap.
 *   E8  dragging the divider / ArrowLeft on it resizes, neither side < 240px, ratio survives restart.
 *   E6  closing the right group's only tab collapses to one group, the left one active.
 *   E12 the Terminal tab can't be split: Ctrl+\ off-terminal changes nothing, the menu item is
 *       disabled, and Ctrl+\ inside xterm stays the terminal's key.
 *
 * Slice 5 scenarios, continuing in launch 2:
 *   MV  Mod+Alt+ArrowRight moves the active tab from the left group to the right, which becomes
 *       active.
 *   RV  Review scrolled in one group, moved to the other, keeps its scroll anchor (±2px).
 *   TP  the Workspace Trust prompt stays visible and clickable above a web tab active in the left
 *       group (web hosts sit in the grid's body row, the prompt in its own row). Needs go + gopls.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  assert,
  launchApp,
  makeLog,
  openReview,
  openSession,
  shutdownApp,
  tapBridge,
} from './harness.mjs';

if (process.platform !== 'win32') {
  console.log('[split-editor] SKIP — suite is Windows-only');
  process.exit(0);
}

const log = makeLog('split-editor');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const repo = mkdtempSync(join(tmpdir(), 'conduit-split-repo-'));
writeFileSync(join(repo, 'a.ts'), 'export const answer = 42;\n');
const filler = Array.from({ length: 200 }, (_, i) => `// line ${i + 3}`).join('\n');
writeFileSync(
  join(repo, 'b.ts'),
  `import { answer } from './a';\nexport const doubled = answer * 2;\n${filler}\n`,
);
writeFileSync(join(repo, 'note.md'), '# Note\n\nSome text.\n');
writeFileSync(join(repo, 'go.mod'), 'module example.com/split\n\ngo 1.21\n');
writeFileSync(join(repo, 'main.go'), 'package main\n\nfunc main() {}\n');
// Committed, then edited: enough Review cards for the list to scroll (RV).
const REVIEW_FILES = 12;
const reviewLines = (n) => Array.from({ length: 120 }, (_, i) => `${n} line ${i + 1}`);
let hasGit = false;
try {
  execFileSync('git', ['init', '-q'], { cwd: repo });
  mkdirSync(join(repo, 'rv'));
  for (let n = 1; n <= REVIEW_FILES; n++) {
    writeFileSync(join(repo, 'rv', `f${n}.txt`), `${reviewLines(n).join('\n')}\n`);
  }
  execFileSync('git', ['-c', 'core.autocrlf=false', 'add', 'rv'], { cwd: repo });
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
const repoName = repoArg.split('/').filter(Boolean).pop();
const userDataDir = mkdtempSync(join(tmpdir(), 'conduit-split-ud-'));

const G = (g) => `.editor-group[data-group="${g}"]`;
const groupCount = (page) => page.locator('.editor-group').count();
const esc = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

async function openFromExplorer(page, name) {
  await page.click('.rtab:has-text("Files")');
  const row = page.locator('.filerow', {
    has: page.locator('.filerow__name', { hasText: new RegExp(`^${esc(name)}$`) }),
  });
  await row.first().waitFor({ state: 'attached', timeout: 20000 });
  await row.first().dblclick();
  await page.waitForFunction(
    (n) => document.querySelector('.tabbar [role="tab"].tab--active span')?.textContent === n,
    name,
    { timeout: 15000 },
  );
  await page.waitForSelector('.viewer__monaco .monaco-editor', { timeout: 15000 });
}

const firstLine = (page, g) =>
  page.evaluate((sel) => {
    const lines = [...document.querySelectorAll(`${sel} .monaco-editor .view-lines .view-line`)];
    lines.sort((a, b) => Number.parseFloat(a.style.top) - Number.parseFloat(b.style.top));
    return lines[0]?.textContent ?? null;
  }, G(g));

const scrollTopOf = (page, g) =>
  page.evaluate((sel) => {
    const ed = window.monaco.editor.getEditors().find((e) => e.getContainerDomNode().closest(sel));
    return ed ? ed.getScrollTop() : null;
  }, G(g));

const groupWidths = (page) =>
  page.evaluate(() =>
    [...document.querySelectorAll('.editor-group')].map((el) => el.getBoundingClientRect().width),
  );

const politeText = (page) =>
  page.evaluate(
    () =>
      document.querySelector('.shell > [role="status"][aria-live="polite"]:not(.bg-open-status)')
        ?.textContent ?? '',
  );

const hasBinary = (name) => spawnSync('where', [name], { stdio: 'ignore' }).status === 0;
const goplsInstalled = () =>
  hasBinary('gopls') || existsSync(join(homedir(), 'go', 'bin', 'gopls.exe'));

const groupTabs = (page, g) =>
  page.evaluate(
    (sel) => [...document.querySelectorAll(`${sel} [role="tab"] span`)].map((e) => e.textContent),
    G(g),
  );

async function waitPolite(page, text, label) {
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

/** One group holding b.ts → split a.ts, then move b.ts from the left group with the keyboard. */
async function phaseMove(page) {
  await openFromExplorer(page, 'a.ts');
  await page.locator(`${G(1)} .monaco-editor`).click();
  await page.keyboard.press('Control+Backslash');
  await page.waitForFunction(() => document.querySelectorAll('.editor-group').length === 2, null, {
    timeout: 10000,
  });
  await page.locator(`${G(1)} [role="tab"]`, { hasText: 'b.ts' }).click();
  await page.waitForSelector(`${G(1)}[data-active="true"] .tab--active`, { timeout: 5000 });
  await page.locator(`${G(1)} .monaco-editor`).click();
  await page.keyboard.press('Control+Alt+ArrowRight');
  await page
    .waitForFunction(
      (sel) =>
        document.querySelector(`${sel}[data-active="true"] .tab--active span`)?.textContent ===
        'b.ts',
      G(2),
      { timeout: 5000 },
    )
    .catch(() => assert(false, 'MV: b.ts is not the active tab of an active right group'));
  const left = await groupTabs(page, 1);
  assert(!left.includes('b.ts'), `MV: b.ts is still in the left group (${left})`);
  assert(
    (await page.locator(G(1)).getAttribute('data-active')) === null,
    'MV: the left group is still active',
  );
  await waitPolite(page, 'Moved b.ts to right group', 'MV');
  log('MV ✓ Mod+Alt+ArrowRight moved b.ts to the right group');
}

/** The scroller's offset and the card at its top edge, with the edge's offset into that card. */
const reviewAnchor = (page, g) =>
  page.evaluate((sel) => {
    const el = document.querySelector(`${sel} .review__scroll`);
    if (!el) return null;
    const y = el.getBoundingClientRect().top;
    const card = [...el.querySelectorAll('.rcard')]
      .sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top)
      .find((c) => c.getBoundingClientRect().bottom > y);
    return {
      scrollTop: Math.round(el.scrollTop),
      path: card?.getAttribute('data-path') ?? null,
      offset: card ? Math.round(y - card.getBoundingClientRect().top) : null,
    };
  }, G(g));

async function pressMove(page, g, key) {
  await page.focus(`${G(g)} .review__scroll`);
  await page.keyboard.press(key);
  const to = g === 1 ? 2 : 1;
  await page
    .waitForSelector(`${G(to)}[data-active="true"] .review__scroll`, { timeout: 10000 })
    .catch(() => assert(false, `RV: Review did not move to an active group ${to}`));
  await sleep(900);
  return reviewAnchor(page, to);
}

/**
 * Review opened in the left group, scrolled, moved right and back. The groups differ in width
 * (E8 left the ratio at ~0.3), so across them the top card and its offset are what must hold;
 * back in the same group the pixel offset must too (±2px).
 */
async function phaseReviewMove(page) {
  if (!hasGit) {
    log('RV not run (no git)');
    return;
  }
  await page.locator(`${G(1)} .monaco-editor`).click();
  await openReview(page);
  await page.waitForSelector(`${G(1)} .review .rcard[data-path="rv/f1.txt"] .rline`, {
    state: 'attached',
    timeout: 25000,
  });
  // Mid-list: a fraction of the estimate-sized scrollHeight lands on the end clamp once the
  // narrow group's real heights resolve, and an end-clamped offset can't survive a wider group.
  await page.$eval(`${G(1)} .review__scroll`, (el) => {
    el.scrollTop = 1500;
  });
  // Past the 120ms anchor-capture debounce and the re-measure it triggers.
  await sleep(900);
  const before = await reviewAnchor(page, 1);
  assert(
    before?.path && before.scrollTop > 200,
    `RV: expected a scrolled Review, got ${JSON.stringify(before)}`,
  );
  const right = await pressMove(page, 1, 'Control+Alt+ArrowRight');
  log('RV: anchor', JSON.stringify(before), '→', JSON.stringify(right));
  assert(
    right?.path === before.path && Math.abs(right.offset - before.offset) <= 2,
    `RV: the right group's top card is ${JSON.stringify(right)}, was ${JSON.stringify(before)}`,
  );
  const back = await pressMove(page, 2, 'Control+Alt+ArrowLeft');
  log('RV: back in the left group', JSON.stringify(back));
  assert(
    back && Math.abs(back.scrollTop - before.scrollTop) <= 2,
    `RV: Review's scroll moved from ${before.scrollTop} to ${back?.scrollTop}`,
  );
  log('RV ✓ Review moved with its scroll anchor');
}

async function phaseTrustOverWeb(page) {
  if (!hasBinary('go') || !goplsInstalled()) {
    // Not the word the runner reads as a whole-scenario skip.
    log('TP not run (no go toolchain)');
    return;
  }
  await openFromExplorer(page, 'main.go');
  const prompt = page.locator('.trust-prompt');
  await prompt
    .waitFor({ state: 'visible', timeout: 20000 })
    .catch(() => assert(false, 'TP: the trust prompt did not appear for main.go'));

  const server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<!doctype html><title>split web</title><body>web</body>');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    await page.click('.omnibar');
    await page.waitForSelector('.palette__input', { state: 'visible', timeout: 10000 });
    await page.fill('.palette__input', '>open web page');
    await page.waitForSelector('.palette__title', { timeout: 8000 });
    await page.keyboard.press('Enter');
    await page.waitForSelector('.modal__input', { state: 'visible', timeout: 8000 });
    await page.fill('.modal__input', `http://127.0.0.1:${server.address().port}/`);
    await page.keyboard.press('Enter');
    const hostSel = '.editorgroups > .webhost[data-group="1"]:not([hidden])';
    await page
      .locator(hostSel)
      .waitFor({ state: 'visible', timeout: 10000 })
      .catch(() => assert(false, 'TP: no visible web host in the left group'));
    await prompt
      .waitFor({ state: 'visible', timeout: 5000 })
      .catch(() => assert(false, 'TP: the trust prompt left when the web tab opened'));
    const probe = await page.evaluate((sel) => {
      const p = document.querySelector('.trust-prompt');
      const h = document.querySelector(sel);
      const btn = p?.querySelector('.btn--primary');
      if (!p || !h || !btn) return null;
      const pr = p.getBoundingClientRect();
      const hr = h.getBoundingClientRect();
      const br = btn.getBoundingClientRect();
      const hit = document.elementFromPoint(br.x + br.width / 2, br.y + br.height / 2);
      return {
        promptBottom: pr.bottom,
        hostTop: hr.top,
        hostHeight: hr.height,
        hitsPrompt: !!hit?.closest('.trust-prompt'),
      };
    }, hostSel);
    assert(probe, 'TP: prompt, web host or Trust button missing');
    log('TP: rects', JSON.stringify(probe));
    assert(probe.hostHeight > 0, 'TP: the web host has no height');
    assert(
      probe.hostTop >= probe.promptBottom - 0.5,
      `TP: the web host (top ${probe.hostTop}) overlaps the trust prompt (bottom ${probe.promptBottom})`,
    );
    assert(probe.hitsPrompt, 'TP: the Trust button is covered by the web host');
    log('TP ✓ the trust prompt stays above a left-group web tab');
  } finally {
    server.close();
  }
}

let launched = null;
let code = 0;
try {
  // ── Launch 1 ──────────────────────────────────────────────────────────────
  launched = await launchApp({ userDataDir });
  let { page } = launched;
  const sid = await openSession(page, { path: repoArg });
  assert(sid, 'no session id from openSession');
  // E12
  const termTab = page.locator(`${G(1)} button.tab[data-tabid="__terminal__"]`);
  await termTab.click();
  await page.waitForFunction(
    (sel) => document.querySelector(sel)?.classList.contains('tab--active'),
    `${G(1)} button.tab[data-tabid="__terminal__"]`,
    { timeout: 5000 },
  );
  await termTab.focus();
  assert(
    await page.evaluate(() => !document.activeElement?.closest('.xterm')),
    'E12: focus should be on the strip, not in xterm',
  );
  await page.keyboard.press('Control+Backslash');
  await sleep(500);
  assert((await groupCount(page)) === 1, 'E12: Ctrl+\\ on the Terminal tab split something');
  await termTab.click({ button: 'right' });
  const item = page.locator('.ctxmenu__item', { hasText: /^Split Right$/ });
  await item.waitFor({ timeout: 5000 }).catch(() => assert(false, 'E12: no Split Right menu item'));
  assert(await item.isDisabled(), 'E12: Split Right is enabled on the Terminal tab');
  await page.keyboard.press('Escape');
  await page.locator('.termhost .xterm >> visible=true').first().click();
  await page.waitForFunction(() => !!document.activeElement?.closest('.xterm'), null, {
    timeout: 5000,
  });
  await page.keyboard.press('Control+Backslash');
  await sleep(500);
  assert((await groupCount(page)) === 1, 'E12: Ctrl+\\ inside xterm split something');
  log('E12 ✓ the Terminal cannot be split');

  await openFromExplorer(page, 'b.ts');

  // E1
  await page.locator('.viewer__monaco .monaco-editor').first().click();
  await page.keyboard.press('Control+Backslash');
  await page
    .waitForFunction(() => document.querySelectorAll('.editor-group').length === 2, null, {
      timeout: 10000,
    })
    .catch(() => assert(false, 'E1: Ctrl+\\ did not create a second editor group'));
  assert(
    (await page.locator(`${G(2)}[data-active="true"] .tab--active span`).textContent()) === 'b.ts',
    'E1: the right group is not active with b.ts as its active tab',
  );
  assert(
    (await page.locator(G(1)).getAttribute('data-active')) === null,
    'E1: the left group still carries data-active',
  );
  assert(
    (await page.locator(`${G(1)} .tab--current span`).textContent()) === 'b.ts',
    'E1: the left group does not show b.ts as its idle active tab (.tab--current)',
  );
  log('E1 ✓ two groups, right active with b.ts');

  // E2
  await page.waitForSelector(`${G(1)} .monaco-editor`, { timeout: 15000 });
  await page.waitForSelector(`${G(2)} .monaco-editor`, { timeout: 15000 });
  await page.locator(`${G(2)} .monaco-editor`).click();
  await page.keyboard.press('Control+Home');
  await page.keyboard.type('X');
  await page
    .waitForFunction(
      (sel) => {
        const lines = [
          ...document.querySelectorAll(`${sel} .monaco-editor .view-lines .view-line`),
        ];
        lines.sort((a, b) => Number.parseFloat(a.style.top) - Number.parseFloat(b.style.top));
        return lines[0]?.textContent?.startsWith('X') ?? false;
      },
      G(1),
      { timeout: 5000 },
    )
    .catch(async () =>
      assert(
        false,
        `E2: the left editor's first line is ${JSON.stringify(await firstLine(page, 1))}`,
      ),
    );
  await page
    .waitForFunction(() => document.querySelectorAll('.tab--dirty').length === 2, null, {
      timeout: 5000,
    })
    .catch(() => assert(false, 'E2: both b.ts tabs should show the unsaved dot'));
  await page.keyboard.press('Control+S');
  await page
    .waitForFunction(() => document.querySelectorAll('.tab--dirty').length === 0, null, {
      timeout: 5000,
    })
    .catch(() => assert(false, 'E2: Ctrl+S did not clear both dirty dots'));
  log('E2 ✓ shared buffer, both dirty, one save clears both');

  // E3
  const left0 = await scrollTopOf(page, 1);
  const right0 = await scrollTopOf(page, 2);
  assert(left0 !== null && right0 !== null, 'E3: could not find both editors');
  const box = await page.locator(`${G(2)} .monaco-editor`).boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  const lineHeight = await page.evaluate(() =>
    window.monaco.editor.getEditors()[0].getOption(window.monaco.editor.EditorOption.lineHeight),
  );
  await page.mouse.wheel(0, lineHeight * 30);
  await page
    .waitForFunction(
      ({ sel, before }) => {
        const ed = window.monaco.editor
          .getEditors()
          .find((e) => e.getContainerDomNode().closest(sel));
        return !!ed && ed.getScrollTop() > before;
      },
      { sel: G(2), before: right0 },
      { timeout: 5000 },
    )
    .catch(() => assert(false, 'E3: the right editor did not scroll'));
  await sleep(300);
  assert((await scrollTopOf(page, 1)) === left0, 'E3: scrolling the right editor moved the left');
  log('E3 ✓ independent scroll');

  // E13
  assert(
    (await page.locator(`${G(2)} .tabbar__split`).getAttribute('aria-disabled')) === 'true',
    'E13: the split button is not aria-disabled while the right group is active',
  );
  await page.locator(`${G(2)} .monaco-editor`).click();
  await page.keyboard.press('Control+Backslash');
  await page
    .waitForFunction(
      () =>
        document.querySelector('.shell > [role="status"][aria-live="polite"]:not(.bg-open-status)')
          ?.textContent === 'Only two editor groups are supported.',
      null,
      { timeout: 5000 },
    )
    .catch(async () =>
      assert(false, `E13: the polite region says ${JSON.stringify(await politeText(page))}`),
    );
  assert((await groupCount(page)) === 2, 'E13: Ctrl+\\ at the cap changed the group count');
  log('E13 ✓ cap reached is disabled and announced');

  // E8
  // Keys first: at the hidden window's width a 200px drag reaches the 240px clamp.
  const w0 = await groupWidths(page);
  await page.locator('.editorgroups__divider').focus();
  for (let i = 0; i < 3; i++) await page.keyboard.press('ArrowLeft');
  await sleep(200);
  const w1 = await groupWidths(page);
  assert(w1[0] < w0[0] - 30, `E8: ArrowLeft ×3 did not narrow the left group (${w0} → ${w1})`);
  assert(Math.round(Math.min(...w1)) >= 240, `E8: a group went below 240px (${w1})`);
  const div = await page.locator('.editorgroups__divider').boundingBox();
  assert(div, 'E8: no divider');
  const dx = div.x + div.width / 2;
  const dy = div.y + div.height / 2;
  await page.mouse.move(dx, dy);
  await page.mouse.down();
  await page.mouse.move(dx - 100, dy, { steps: 5 });
  await page.mouse.move(dx - 200, dy, { steps: 5 });
  await page.mouse.up();
  await sleep(200);
  const w2 = await groupWidths(page);
  assert(w2[0] < w1[0] - 50, `E8: the drag did not narrow the left group (${w1} → ${w2})`);
  assert(Math.round(Math.min(...w2)) >= 240, `E8: a group went below 240px (${w2})`);
  const ratioBefore = w2[0] / (w2[0] + w2[1]);
  log('E8: widths', w0, '→', w1, '→', w2);
  await sleep(1500);

  await shutdownApp(launched.app, page);
  launched = null;

  // ── Launch 2: the split and its ratio restore ─────────────────────────────
  launched = await launchApp({ userDataDir });
  page = launched.page;
  await tapBridge(page);
  await page.waitForFunction((id) => (window.__sessions || []).some((s) => s.id === id), sid, {
    timeout: 45000,
  });
  await page.waitForSelector(`.session:has-text("${repoName}")`, { timeout: 20000 });
  await page.locator('.session', { hasText: repoName }).first().click();
  await page
    .waitForFunction(() => document.querySelectorAll('.editor-group').length === 2, null, {
      timeout: 20000,
    })
    .catch(() => assert(false, 'E8: the split did not restore'));
  await sleep(300);
  const w3 = await groupWidths(page);
  const ratioAfter = w3[0] / (w3[0] + w3[1]);
  assert(
    Math.abs(ratioAfter - ratioBefore) <= 0.01,
    `E8: ratio ${ratioBefore.toFixed(3)} restored as ${ratioAfter.toFixed(3)}`,
  );
  log('E8 ✓ resized, clamped, ratio restored', ratioBefore.toFixed(3), ratioAfter.toFixed(3));

  // E6
  await page
    .locator(`${G(2)} .tab .tab__close`)
    .first()
    .click();
  await page
    .waitForFunction(() => document.querySelectorAll('.editor-group').length === 1, null, {
      timeout: 10000,
    })
    .catch(() => assert(false, 'E6: closing the right group’s last tab did not collapse it'));
  assert(
    (await page.locator(G(1)).getAttribute('data-active')) === 'true',
    'E6: the left group is not active after the collapse',
  );
  log('E6 ✓ collapse to one active group');

  await phaseMove(page);
  await phaseReviewMove(page);

  await phaseTrustOverWeb(page);

  log('PASS ✓ split-editor: all assertions passed');
} catch (e) {
  if (e?.name === 'AssertionError') {
    console.log('[split-editor] FAIL ✗', e.message);
    code = 1;
  } else {
    console.error('[split-editor] ERROR:', e?.message || e);
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
