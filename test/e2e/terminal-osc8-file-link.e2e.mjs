/**
 * Terminal `file://` link targets, decoded and confined host-side (plan
 * docs/plans/2026-10-16-terminal-path-links.plan.md T8.5; spec rows 19-21). The session's home
 * holds src/a.ts; a second temp dir outside every session root holds x.ts. Every click is a real
 * mouse click at the link's cells, and every line is printed by the shell (PowerShell), so
 * xterm's hit-test → provider/handler → host round trip runs as for a user.
 *
 *   5. A visible `file:///<home>/src/a.ts` opens in-app; openExternal is never called.
 *   6. A visible `file:///<outside>/x.ts` opens nothing: a confined dead click, the deliberate
 *      asymmetry with a plain absolute path (plan Decisions).
 *
 * exit 0 pass/SKIP · 1 assertion failed · 2 infra error
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  assert,
  getSpyCalls,
  openSession,
  runScenario,
  spyMain,
  typeLine,
  waitForOutput,
} from './harness.mjs';
import { tabInfo } from './middle-click-fixture.mjs';

const body = (tag) =>
  `${Array.from({ length: 30 }, (_, i) => `export const ${tag}${i + 1} = ${i + 1};`).join('\n')}\n`;

runScenario('terminal-osc8-file-link', async ({ app, page, log }) => {
  const home = mkdtempSync(join(tmpdir(), 'conduit-osc8f-')).replace(/\\/g, '/');
  const outside = mkdtempSync(join(tmpdir(), 'conduit-osc8out-')).replace(/\\/g, '/');
  mkdirSync(join(home, 'src'));
  writeFileSync(join(home, 'src', 'a.ts'), body('a'));
  writeFileSync(join(outside, 'x.ts'), body('x'));
  log('fixture', home, outside);

  await spyMain(app, [{ api: 'openExternal' }]);
  await page.evaluate(() => {
    window.__terms = {};
    window.__opens = [];
    const realOpen = window.open.bind(window);
    window.open = (...args) => {
      window.__opens.push(args.map(String));
      return realOpen(...args);
    };
  });
  // PowerShell, so OSC 8 can be printed by the shell ([char]27) rather than injected.
  const sid = await openSession(page, { path: home, agentId: 'shell:powershell' });
  await page.waitForFunction((id) => !!window.__terms?.[id], sid, { timeout: 20000 });
  await page.waitForFunction(() => (window.__cap || '').includes('PS '), null, { timeout: 30000 });
  await page.waitForTimeout(500);

  const waitQuiet = async () => {
    let last = -1;
    for (let i = 0; i < 40; i++) {
      const len = await page.evaluate(() => (window.__cap || '').length);
      if (len === last) return;
      last = len;
      await page.waitForTimeout(500);
    }
  };

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
          onScreen: row >= 0 && screenRow >= 0 && screenRow < term.rows && r.width > 0,
          x: r.x + (col + 0.5) * cellW,
          y: r.y + (screenRow + 0.5) * cellH,
        };
      },
      { id: sid, needle, charIdx },
    );

  const hovering = () =>
    page.evaluate((id) => !!window.__terms[id].element.querySelector('.xterm-cursor-pointer'), sid);

  /** Real hover then click, once xterm shows the link pointer (the user's "this is a link"). */
  const clickLink = async (needle, charIdx) => {
    const c = await cellOf(needle, charIdx);
    assert(c.onScreen, `"${needle}" is not on screen: ${JSON.stringify(c)}`);
    for (let attempt = 0; attempt < 40; attempt++) {
      await page.mouse.move(c.x, c.y + 400);
      await page.mouse.move(c.x, c.y, { steps: 4 });
      await page.waitForTimeout(400);
      if (await hovering()) break;
    }
    assert(await hovering(), `"${needle}" never showed the link pointer`);
    await page.mouse.click(c.x, c.y);
  };

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
  /** Whether any editor model is the file ending in `suffix` (a preview tab can be replaced in
   *  place, so a tab count alone cannot tell). */
  const docOpen = (suffix) =>
    page.evaluate(
      (sfx) =>
        (window.monaco?.editor.getModels() ?? []).some((m) =>
          m.uri.path.toLowerCase().endsWith(sfx),
        ),
      suffix,
    );
  const waitDoc = async (suffix, ms = 15000) => {
    for (const t0 = Date.now(); Date.now() - t0 < ms; ) {
      if (await docOpen(suffix)) return true;
      await page.waitForTimeout(250);
    }
    return false;
  };
  const externalCalls = async () =>
    (await getSpyCalls(app)).filter((c) => c.api === 'openExternal').length;
  /** Nothing opened: no new tab, no external open, no window.open. */
  const assertNothingOpened = async (tabsBefore, what, forbidden) => {
    await page.waitForTimeout(1500);
    assert(!(await docOpen(forbidden)), `${what}: ${forbidden} must not open`);
    assert((await tabInfo(page)).length === tabsBefore, `${what}: no tab may open`);
    assert((await externalCalls()) === 0, `${what}: openExternal must not be called`);
    const opens = await page.evaluate(() => window.__opens.length);
    assert(opens === 0, `${what}: window.open must not be called`);
  };

  const inside = `file:///${home}/src/a.ts`;
  const outsideUrl = `file:///${outside}/x.ts`;
  for (const line of [inside, outsideUrl]) {
    await typeLine(page, sid, `Write-Output '${line}'`);
    await waitForOutput(page, sid, line);
  }
  await waitQuiet();

  // ── 5. a visible file:// URL inside home opens in-app ──────────────────────────────
  await clickLink(inside, 10);
  assert(await waitDoc('/src/a.ts'), 'a click on the file:// URL should open src/a.ts');
  const opened5 = (await activeDocPath())?.toLowerCase() ?? '';
  assert(opened5.endsWith('/src/a.ts'), `src/a.ts should be the active doc, got ${opened5}`);
  assert((await externalCalls()) === 0, 'a file:// URL must never reach openExternal');
  log('step 5: a visible file:// URL inside home opened in-app ✓');

  // ── 6. a visible file:// URL outside every root opens nothing ──────────────────────
  await backToTerminal();
  const tabs6 = (await tabInfo(page)).length;
  await clickLink(outsideUrl, 10);
  await assertNothingOpened(tabs6, 'an out-of-root file:// URL', '/x.ts');
  log('step 6: a visible out-of-root file:// URL is a dead click ✓');
});
