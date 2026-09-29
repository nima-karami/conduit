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
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assert, launchApp, makeLog, openSession, shutdownApp, tapBridge } from './harness.mjs';

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
try {
  execFileSync('git', ['init', '-q'], { cwd: repo });
} catch {
  /* git absent — the scenario works without a repo */
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
    (sel) => document.querySelector(sel)?.getAttribute('aria-selected') === 'true',
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
