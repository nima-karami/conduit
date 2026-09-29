/**
 * split-editor-focus-keep — keyboard focus the user put somewhere stays there
 * (docs/specs/2026-09-28-split-editor.md §10):
 *   TK  the tab-navigation chords leave the Terminal (VS Code's commandsToSkipShell): Ctrl+Tab
 *       cycles on out of xterm, and Ctrl+2 and Ctrl+PageDown leave it, sending nothing to the
 *       shell; Ctrl+9 with fewer than 9 docs and Ctrl+W still reach xterm and change no tab
 *   LM  a view that mounts late (its diff reply held back by the host) does not take focus back
 *       from xterm, where the user clicked and typed after asking for it
 *   CG  closing the right group from its strip menu by keyboard leaves focus in the explorer
 * Failures are collected, so one run reports every step that misses.
 */

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { changeRow, commitBase, installTabHelpers } from './changes-fixture.mjs';
import { assert, openChangesTab, openSession, runScenario } from './harness.mjs';
import {
  G,
  groupCount,
  openFromExplorer,
  sleep,
  tabOf,
  waitShown,
} from './split-editor-helpers.mjs';

const root = mkdtempSync(join(tmpdir(), 'conduit-split-keep-'));
writeFileSync(join(root, 'a.ts'), 'export const a = 1;\n');
writeFileSync(join(root, 'b.ts'), 'export const b = 2;\n');
writeFileSync(join(root, 'd.txt'), 'one\ntwo\n');
commitBase(root);
writeFileSync(join(root, 'd.txt'), 'one\nTWO changed\n');

const DIFF_DELAY_MS = 4000;

runScenario('split-editor-focus-keep', async ({ app, page, log }) => {
  const misses = [];
  await page.evaluate(() => {
    window.__terms = {};
  });
  const sid = await openSession(page, { path: root.replace(/\\/g, '/') });
  log('session', sid);
  await installTabHelpers(page);
  await page.waitForFunction((id) => !!window.__terms?.[id], sid, { timeout: 15000 });
  await page.evaluate((id) => {
    window.__ptyIn = [];
    window.__terms[id].onData((d) => window.__ptyIn.push(d));
  }, sid);
  const bufferText = () =>
    page.evaluate((id) => {
      const buf = window.__terms[id].buffer.active;
      const lines = [];
      for (let i = 0; i < buf.length; i++) lines.push(buf.getLine(i)?.translateToString(true));
      return lines.join('\n').trimEnd();
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
  const onTerminal = () =>
    page.evaluate(
      (sel) => !document.querySelector(`${sel} [role="tab"][aria-selected="true"]`),
      G(1),
    );
  const xtermFocused = () => page.evaluate(() => !!document.activeElement?.closest('.xterm'));
  const editorFocusIn = (g, name) =>
    page
      .waitForFunction(
        ({ sel, n }) =>
          (window.monaco?.editor.getEditors() ?? []).some(
            (e) =>
              e.hasTextFocus() &&
              e.getDomNode()?.closest(sel) &&
              e.getModel()?.uri.path.endsWith(`/${n}`),
          ),
        { sel: G(g), n: name },
        { timeout: 3000 },
      )
      .then(
        () => true,
        () => false,
      );
  const shownName = () =>
    page.evaluate(
      (sel) => document.querySelector(`${sel} [role="tab"].tab--active span`)?.textContent ?? null,
      G(1),
    );
  /** Ctrl+Tab until the Terminal is active; false when it never gets there. */
  const cycleToTerminal = async () => {
    for (let n = 0; n < 4 && !(await onTerminal()); n++) {
      await page.keyboard.press('Control+Tab');
      await sleep(250);
    }
    return onTerminal();
  };

  await openFromExplorer(page, 'a.ts');
  await openFromExplorer(page, 'b.ts');
  await page
    .locator(`${G(1)} .monaco-editor .view-lines`)
    .first()
    .click();

  // TK: Ctrl+Tab onto the Terminal focuses xterm; the next Ctrl+Tab leaves it for a doc.
  if (!(await cycleToTerminal())) misses.push('TK: Ctrl+Tab never reached the Terminal');
  const landedInXterm = await page
    .waitForFunction(() => !!document.activeElement?.closest('.xterm'), null, { timeout: 3000 })
    .then(
      () => true,
      () => false,
    );
  log('TK: Ctrl+Tab onto the Terminal focused xterm:', landedInXterm);
  if (!landedInXterm) misses.push('TK: Ctrl+Tab onto the Terminal did not focus xterm');
  await ptyIn();
  const before = await bufferText();
  await page.keyboard.press('Control+Tab');
  await sleep(400);
  const out = await shownName();
  const outFocused = out ? await editorFocusIn(1, out) : false;
  const sentOnTab = await ptyIn();
  const afterTab = await bufferText();
  log(
    `TK Ctrl+Tab from the Terminal: shows ${out} · editor focused ${outFocused} · sent ${JSON.stringify(sentOnTab)}`,
  );
  if (out === null) misses.push('TK: Ctrl+Tab from the Terminal stayed on the Terminal');
  else if (!outFocused)
    misses.push(`TK: Ctrl+Tab left the Terminal for ${out} but focus is not in its editor`);
  if (sentOnTab.length > 0)
    misses.push(`TK: Ctrl+Tab sent ${JSON.stringify(sentOnTab)} to the shell`);
  if (afterTab !== before) misses.push('TK: the prompt changed after Ctrl+Tab');

  // TK: Ctrl+2 from the Terminal jumps to the second doc tab.
  await cycleToTerminal();
  await page.locator(`${G(1)} .xterm:visible`).click();
  await ptyIn();
  const beforeDigit = await bufferText();
  await page.keyboard.press('Control+2');
  await sleep(400);
  const jumped = await shownName();
  const jumpedFocused = jumped === 'b.ts' && (await editorFocusIn(1, 'b.ts'));
  const sentOnDigit = await ptyIn();
  log(
    `TK Ctrl+2 from the Terminal: shows ${jumped} · editor focused ${jumpedFocused} · sent ${JSON.stringify(sentOnDigit)}`,
  );
  if (!jumpedFocused)
    misses.push(`TK: Ctrl+2 from the Terminal shows ${jumped}, focused ${jumpedFocused}`);
  if (sentOnDigit.length > 0)
    misses.push(`TK: Ctrl+2 sent ${JSON.stringify(sentOnDigit)} to the shell`);
  if ((await bufferText()) !== beforeDigit) misses.push('TK: the prompt changed after Ctrl+2');

  // TK: Ctrl+PageDown from the Terminal leaves it for a doc.
  await cycleToTerminal();
  await page.locator(`${G(1)} .xterm:visible`).click();
  await ptyIn();
  const beforePage = await bufferText();
  await page.keyboard.press('Control+PageDown');
  await sleep(400);
  const paged = await shownName();
  const sentOnPage = await ptyIn();
  log(`TK Ctrl+PageDown from the Terminal: shows ${paged} · sent ${JSON.stringify(sentOnPage)}`);
  if (paged === null) misses.push('TK: Ctrl+PageDown from the Terminal stayed on the Terminal');
  if (sentOnPage.length > 0)
    misses.push(`TK: Ctrl+PageDown sent ${JSON.stringify(sentOnPage)} to the shell`);
  if ((await bufferText()) !== beforePage)
    misses.push('TK: the prompt changed after Ctrl+PageDown');

  // TK: Ctrl+9 past the open-doc count is not the app's, so xterm gets the key. xterm.js maps
  // Ctrl+9 to no bytes, so arrival at its textarea is the observable, not PTY input.
  await cycleToTerminal();
  await page.locator(`${G(1)} .xterm:visible`).click();
  await ptyIn();
  await page.evaluate(() => {
    window.__xtermKeys = [];
    const a = document.activeElement;
    if (a?.closest('.xterm'))
      a.addEventListener('keydown', (e) =>
        window.__xtermKeys.push(`${e.ctrlKey ? 'C-' : ''}${e.key}`),
      );
  });
  await page.keyboard.press('Control+9');
  await sleep(400);
  const reached = await page.evaluate(() => window.__xtermKeys);
  const sentOnNine = await ptyIn();
  const stayed9 = (await onTerminal()) && (await xtermFocused());
  log(
    `TK Ctrl+9 with 2 docs: xterm saw ${JSON.stringify(reached)} · sent ${JSON.stringify(sentOnNine)} · still on the Terminal in xterm ${stayed9}`,
  );
  if (!reached.includes('C-9')) misses.push('TK: Ctrl+9 with 2 docs never reached xterm');
  if (!stayed9) misses.push('TK: Ctrl+9 with 2 docs left the Terminal');

  // TK: Ctrl+W in xterm is the shell's.
  await cycleToTerminal();
  await page.locator(`${G(1)} .xterm:visible`).click();
  await ptyIn();
  const tabsBefore = await page.locator(`${G(1)} [role="tab"]`).count();
  await page.keyboard.press('Control+w');
  await sleep(500);
  const sentOnW = await ptyIn();
  const tabsAfter = await page.locator(`${G(1)} [role="tab"]`).count();
  log(`TK Ctrl+W in xterm: sent ${JSON.stringify(sentOnW)} · tabs ${tabsBefore} → ${tabsAfter}`);
  if (!sentOnW.includes('\x17'))
    misses.push(`TK: Ctrl+W did not reach the shell (${JSON.stringify(sentOnW)})`);
  if (tabsAfter !== tabsBefore || !(await onTerminal()))
    misses.push('TK: Ctrl+W in xterm closed a tab');

  // LM: group 2 asks for a diff whose reply the host holds back; the user moves on to xterm.
  await tabOf(page, 1, 'a.ts').click();
  await waitShown(page, 1, 'a.ts', 'LM');
  await page.keyboard.press('Control+Backslash');
  await waitShown(page, 2, 'a.ts', 'LM');
  await page.locator(`${G(1)} [data-tabid="__terminal__"]`).click();
  await tabOf(page, 2, 'a.ts').click();
  await waitShown(page, 2, 'a.ts', 'LM');
  await app.evaluate(({ BrowserWindow }, delay) => {
    const wc = BrowserWindow.getAllWindows()[0].webContents;
    const proto = Object.getPrototypeOf(wc);
    if (!global.__heldSend) {
      global.__heldSend = proto.send;
      proto.send = function (channel, msg, ...rest) {
        if (global.__holdDiffs && channel === 'to-webview' && msg?.type === 'fileDiff') {
          setTimeout(() => global.__heldSend.call(this, channel, msg, ...rest), delay);
          return;
        }
        return global.__heldSend.call(this, channel, msg, ...rest);
      };
    }
    global.__holdDiffs = true;
  }, DIFF_DELAY_MS);
  await openChangesTab(page);
  await (await changeRow(page, 'Changes', 'd.txt')).dblclick();
  await page
    .waitForFunction(
      (sel) => document.querySelector(`${sel} .tab--active`)?.textContent?.includes('d.txt'),
      G(2),
      { timeout: 5000 },
    )
    .catch(() => assert(false, 'LM: the diff did not open in the right group'));
  await page.locator(`${G(2)} .tab--active`).click();
  const mountedAtRequest = await page.locator(`${G(2)} .monaco-diff-editor`).count();
  assert(mountedAtRequest === 0, 'LM: the diff mounted before the late-mount window');
  await page.locator(`${G(1)} .xterm:visible`).click();
  await page.keyboard.type('echo keep-typing');
  await page
    .waitForSelector(`${G(2)} .monaco-diff-editor .editor.modified`, { timeout: 15000 })
    .catch(() => assert(false, 'LM: the diff never mounted'));
  await sleep(600);
  const keptXterm = await xtermFocused();
  const typed = (await bufferText()).includes('keep-typing');
  log(
    `LM after the late diff mount: xterm focused ${keptXterm} · typed text in the prompt ${typed}`,
  );
  if (!keptXterm) misses.push('LM: the late diff mount took focus from xterm');
  if (!typed) misses.push('LM: the typed text is not in the prompt');
  await app.evaluate(() => {
    global.__holdDiffs = false;
  });

  // CG: focus in the explorer; the right group closes from its strip menu by keyboard.
  await page.locator('.rtab', { hasText: 'Files' }).click();
  const marked = await page.evaluate(() => {
    const a = document.activeElement;
    if (!a || a === document.body) return false;
    a.setAttribute('data-e2e-focus', 'kept');
    return true;
  });
  assert(marked, 'CG: clicking the Files tab left nothing focused');
  await page.locator(`${G(2)} .tabbar`).dispatchEvent('contextmenu');
  await page
    .locator('.ctxmenu__item', { hasText: /^Close Editor Group$/ })
    .waitFor({ timeout: 5000 })
    .catch(() => assert(false, 'CG: no Close Editor Group'));
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  const discard = page.locator('.confirm__actions button', { hasText: 'Discard' }).first();
  if (
    await discard.waitFor({ timeout: 1000 }).then(
      () => true,
      () => false,
    )
  )
    await discard.click();
  await page
    .waitForFunction(() => document.querySelectorAll('.editor-group').length === 1, null, {
      timeout: 5000,
    })
    .catch(() => assert(false, 'CG: the right group did not close'));
  assert((await groupCount(page)) === 1, 'CG: two groups remain');
  await sleep(500);
  const stayed = await page.evaluate(
    () => document.activeElement?.getAttribute('data-e2e-focus') === 'kept',
  );
  const now = await page.evaluate(
    () => document.activeElement?.className || document.activeElement?.tagName,
  );
  log(`CG after the collapse: focus stayed on the Files tab ${stayed} (now ${now})`);
  if (!stayed) misses.push(`CG: the collapse moved focus from the explorer to ${now}`);

  assert(misses.length === 0, `focus missed ${misses.length} step(s):\n  ${misses.join('\n  ')}`);
});
