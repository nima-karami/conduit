/**
 * terminal-exit-focus — leaving the Terminal by a tab-navigation chord lands keyboard focus in the
 * doc it shows, every time (docs/specs/2026-09-28-split-editor.md §10):
 *   EX  Ctrl+Tab / Ctrl+Shift+Tab / Ctrl+PageDown / Ctrl+PageUp cycle a.ts, b.ts and the Terminal;
 *       every exit from the Terminal must put focus in the landed doc's editor, not on <body>.
 *       The loss was a race — a passive effect of an earlier commit, flushed at the start of the
 *       chord's render, dropped the chord's focus request — so it is looped, not sampled once.
 *   DG  Ctrl+1..9 in xterm are the app's: a digit past the doc count is a no-op, never shell input.
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assert, openSession, runScenario } from './harness.mjs';
import { G, openFromExplorer, sleep, tabOf } from './split-editor-helpers.mjs';

const root = mkdtempSync(join(tmpdir(), 'conduit-terminal-exit-'));
writeFileSync(join(root, 'a.ts'), 'export const a = 1;\n');
writeFileSync(join(root, 'b.ts'), 'export const b = 2;\n');
const git = (...a) => execFileSync('git', a, { cwd: root, encoding: 'utf8' });
git('init', '-q');

const EXITS_PER_CHORD = 8;
const GAP_MS = 450;

runScenario('terminal-exit-focus', async ({ page, log }) => {
  const misses = [];
  await page.evaluate(() => {
    window.__terms = {};
  });
  const sid = await openSession(page, { path: root.replace(/\\/g, '/') });
  await page.waitForFunction((id) => !!window.__terms?.[id], sid, { timeout: 15000 });
  await page.evaluate((id) => {
    window.__ptyIn = [];
    window.__terms[id].onData((d) => window.__ptyIn.push(d));
  }, sid);
  await page.waitForFunction(
    (id) => {
      const buf = window.__terms[id].buffer.active;
      for (let i = 0; i < buf.length; i++) {
        if (/>\s*$/.test(buf.getLine(i)?.translateToString(true) ?? '')) return true;
      }
      return false;
    },
    sid,
    { timeout: 20000 },
  );
  const ptyIn = () => page.evaluate(() => window.__ptyIn.splice(0));
  const state = () =>
    page.evaluate((sel) => {
      const shown = document.querySelector(`${sel} [role="tab"][aria-selected="true"] span`);
      const ed = (window.monaco?.editor.getEditors() ?? []).find((e) => e.hasTextFocus());
      const a = document.activeElement;
      return {
        shown: shown?.textContent ?? null,
        editor: ed ? (ed.getModel()?.uri.path.split('/').pop() ?? null) : null,
        xterm: !!a?.closest('.xterm'),
        at: a ? `${a.tagName.toLowerCase()}.${String(a.className).split(' ')[0]}` : 'none',
      };
    }, G(1));

  await openFromExplorer(page, 'a.ts');
  await openFromExplorer(page, 'b.ts');
  await tabOf(page, 1, 'b.ts').click();
  await page
    .locator(`${G(1)} .monaco-editor .view-lines`)
    .first()
    .click();
  await sleep(300);

  // EX
  for (const chord of ['Control+Tab', 'Control+Shift+Tab', 'Control+PageDown', 'Control+PageUp']) {
    let exits = 0;
    let lost = 0;
    let prev = await state();
    for (let presses = 0; exits < EXITS_PER_CHORD && presses < EXITS_PER_CHORD * 4; presses++) {
      await page.keyboard.press(chord);
      await sleep(GAP_MS);
      let s = await state();
      if (prev.shown === null && s.shown !== null) {
        exits++;
        if (s.editor !== s.shown) {
          // The defect never recovers on its own; a slow landing gets a second look.
          await sleep(1000);
          s = await state();
          if (s.editor !== s.shown) {
            lost++;
            misses.push(`EX ${chord} exit ${exits}: shows ${s.shown}, focus on ${s.at}`);
          }
        }
      }
      if (s.shown === null && !s.xterm) {
        misses.push(`EX ${chord}: on the Terminal but focus on ${s.at}`);
      }
      prev = s;
    }
    const sent = await ptyIn();
    log(`EX ${chord}: ${exits} exits from the Terminal, ${lost} lost focus`);
    if (exits < EXITS_PER_CHORD) misses.push(`EX ${chord}: only ${exits} exits from the Terminal`);
    if (sent.length > 0) misses.push(`EX ${chord}: sent ${JSON.stringify(sent)} to the shell`);
  }

  // DG: past the doc count from xterm (2 docs open).
  for (const digit of ['3', '9']) {
    await page.locator(`${G(1)} [data-tabid="__terminal__"]`).click();
    await page.locator(`${G(1)} .xterm:visible`).click();
    await sleep(300);
    await ptyIn();
    await page.keyboard.press(`Control+${digit}`);
    await sleep(400);
    const s = await state();
    const sent = await ptyIn();
    log(`DG Ctrl+${digit} in xterm: sent ${JSON.stringify(sent)} · ${JSON.stringify(s)}`);
    if (sent.length > 0) misses.push(`DG Ctrl+${digit}: sent ${JSON.stringify(sent)} to the shell`);
    if (s.shown !== null || !s.xterm) misses.push(`DG Ctrl+${digit}: left the Terminal (${s.at})`);
  }

  assert(misses.length === 0, `terminal exit missed ${misses.length}:\n  ${misses.join('\n  ')}`);
});
