/**
 * Middle-click on terminal links (docs/specs/2026-09-22-middle-click-new-tab.md §3 "Terminal
 * path", §9 S13; AC-4, AC-7b). xterm calls a link's `activate` on mouseup with the real event, so
 * the scenario drives the pane's own link provider (`window.__termLinkProviders`) and hands
 * `activate` a `MouseEvent` carrying the button — clicking xterm's canvas in the hidden harness is
 * unreliable (see terminal-pane.tsx where the provider is exposed).
 *
 *   - FILE link `src/b.ts:12:3`, button 1 → b.ts is a pinned tab that is NOT active; the active
 *     tab, focus, selection and scroll are unchanged; the status region announces it.
 *   - URL link, button 1 → exactly one shell.openExternal with that URL, no tab (AC-7b).
 *   - Activating the b.ts tab lands the cursor on line 12 (AC-4: the staged reveal).
 *   - Left-click regression guard: button 0 on `src/c.ts:7` still opens c.ts ACTIVE.
 *
 * exit 0 pass/SKIP · 1 assertion failed · 2 infra error
 */
import { openViaTree } from './goto-matrix.mjs';
import {
  assert,
  clearSpyCalls,
  closeApp,
  getSpyCalls,
  openSession,
  runScenario,
  spyMain,
} from './harness.mjs';
import {
  sameSnapshot,
  snapshotUnchanged,
  tabInfo,
  waitStatus,
  waitTab,
  writeFixtureRepo,
} from './middle-click-fixture.mjs';
import { waitActive, waitCursor } from './nav-history-fixture.mjs';

const PATH_LINE = 'src/b.ts:12:3';
const LINK_URL = 'https://127.0.0.1:9/x';
const LEFT_LINE = 'src/c.ts:7';

const lines = (stem, n) =>
  `${Array.from({ length: n }, (_, i) => `export const ${stem}${i + 1} = ${i + 1};`).join('\n')}\n`;

/**
 * Finds the buffer row that reads exactly `lineText` (the echo's OUTPUT row, not the prompt row
 * that also contains it), asks the provider for that row's links and activates the one whose
 * text contains `linkText` with a `mouseup` of `button`. Retries because the first provideLinks
 * for a path can race the host's resolvePathToken reply and come back empty.
 */
async function activateLink(page, sid, lineText, linkText, button) {
  let result = { error: 'not attempted' };
  for (let attempt = 0; attempt < 8; attempt++) {
    result = await page.evaluate(
      ({ s, want, needle, btn }) =>
        new Promise((resolve) => {
          const buf = window.__terms?.[s]?.buffer.active;
          if (!buf) return resolve({ error: 'no terminal' });
          let row = -1;
          for (let y = buf.length - 1; y >= 0; y--) {
            if (buf.getLine(y)?.translateToString(true).trim() === want) {
              row = y;
              break;
            }
          }
          if (row < 0) return resolve({ error: `"${want}" not in buffer` });
          const provider = window.__termLinkProviders?.[s];
          if (!provider) return resolve({ error: 'no link provider' });
          let done = false;
          provider.provideLinks(row + 1, (links) => {
            if (done) return;
            done = true;
            const link = (links || []).find((l) => l.text.includes(needle));
            if (!link) {
              return resolve({ error: 'no link', texts: (links || []).map((l) => l.text) });
            }
            link.activate(new MouseEvent('mouseup', { button: btn }), link.text);
            resolve({ ok: true, text: link.text });
          });
          setTimeout(() => {
            if (!done) {
              done = true;
              resolve({ error: 'provideLinks timeout' });
            }
          }, 5000);
        }),
      { s: sid, want: lineText, needle: linkText, btn: button },
    );
    if (result.ok) return result;
    await page.waitForTimeout(500);
  }
  return result;
}

runScenario('middle-click-terminal', async ({ app, page, log }) => {
  const root = writeFixtureRepo({
    files: {
      'a.ts': lines('a', 20),
      'src/b.ts': lines('b', 40),
      'src/c.ts': lines('c', 20),
    },
  });
  log('fixture', root);

  await page.evaluate(() => {
    window.__terms = {};
    window.__termLinkProviders = {};
  });
  const sid = await openSession(page, { path: root });

  // Echo while the terminal is still the visible center view, so the PTY is certainly attached.
  await page.evaluate(
    ({ s, cmds }) => {
      for (const c of cmds) window.agentDeck.post({ type: 'term:input', sessionId: s, data: c });
    },
    { s: sid, cmds: [`echo ${PATH_LINE}\r`, `echo ${LINK_URL}\r`, `echo ${LEFT_LINE}\r`] },
  );
  await page.waitForFunction(
    ({ s, want }) => {
      const buf = window.__terms?.[s]?.buffer.active;
      if (!buf) return false;
      const rows = [];
      for (let y = 0; y < buf.length; y++)
        rows.push(buf.getLine(y)?.translateToString(true).trim());
      return want.every((w) => rows.includes(w));
    },
    { s: sid, want: [PATH_LINE, LINK_URL, LEFT_LINE] },
    { timeout: 20000 },
  );
  log('echoed link lines ✓');

  await openViaTree(page, root, ['a.ts']);
  assert(await waitActive(page, 'a.ts', 15000), 'a.ts should open as the active tab');
  // Let late focus/scroll from the tree double-click settle, or the snapshot races it.
  await page.waitForTimeout(600);
  const tabsBefore = await tabInfo(page);
  const before = await snapshotUnchanged(page);
  log('before', JSON.stringify(before));

  const bg = await activateLink(page, sid, PATH_LINE, 'b.ts', 1);
  log('middle path activate', JSON.stringify(bg));
  assert(bg.ok === true, `path link should activate, got ${JSON.stringify(bg)}`);

  const b = await waitTab(page, 'b.ts').catch(() => null);
  assert(b, 'middle-click on the file link should create a b.ts tab');
  assert(!b.active, 'b.ts must open in the BACKGROUND (not active)');
  assert(!b.preview, 'b.ts must be a pinned tab, not a preview');
  const bgDiff = sameSnapshot(before, await snapshotUnchanged(page));
  assert(bgDiff === null, `background open must leave the view unchanged: ${bgDiff}`);
  const announced = await waitStatus(page, 'Opened b.ts in a background tab')
    .then(() => true)
    .catch(() => false);
  assert(announced, 'status region should announce "Opened b.ts in a background tab"');
  log('file link → background tab ✓');

  await spyMain(app, [{ api: 'openExternal' }]);
  await clearSpyCalls(app);
  const tabCount = (await tabInfo(page)).length;
  assert(tabCount === tabsBefore.length + 1, `expected one new tab, got ${tabCount}`);
  const ext = await activateLink(page, sid, LINK_URL, LINK_URL, 1);
  log('middle url activate', JSON.stringify(ext));
  assert(ext.ok === true, `URL link should activate, got ${JSON.stringify(ext)}`);
  const deadline = Date.now() + 5000;
  let calls = [];
  while (Date.now() < deadline) {
    calls = (await getSpyCalls(app)).filter((c) => c.api === 'openExternal');
    if (calls.length > 0) break;
    await page.waitForTimeout(150);
  }
  // A second, duplicate open would land shortly after the first; give it the chance to.
  await page.waitForTimeout(500);
  calls = (await getSpyCalls(app)).filter((c) => c.api === 'openExternal');
  log('openExternal calls', JSON.stringify(calls.map((c) => c.args)));
  assert(calls.length === 1, `URL middle-click → exactly one openExternal, got ${calls.length}`);
  assert(
    calls[0].args[0] === LINK_URL,
    `openExternal should get ${LINK_URL}, got ${calls[0].args[0]}`,
  );
  const afterUrl = await tabInfo(page);
  assert(
    afterUrl.length === tabCount,
    `URL middle-click must not open a tab (${tabCount} → ${afterUrl.length})`,
  );
  log('URL link → one external open, no tab ✓');

  await page
    .locator('.tabbar [role="tab"]', { has: page.locator('span', { hasText: /^b\.ts$/ }) })
    .first()
    .click();
  assert(await waitActive(page, 'b.ts'), 'clicking the b.ts tab should activate it');
  assert(await waitCursor(page, 12), 'activated b.ts should land on line 12 (the link :line)');
  log('activated background tab lands on :12 ✓');

  const left = await activateLink(page, sid, LEFT_LINE, 'c.ts', 0);
  log('left path activate', JSON.stringify(left));
  assert(left.ok === true, `left path link should activate, got ${JSON.stringify(left)}`);
  assert(await waitActive(page, 'c.ts'), 'left-click on a file link must still open it ACTIVE');
  log('left-click still opens in the foreground ✓');

  await closeApp(app, page);
});
