/**
 * conduit-mcp-app-web — open_url end to end (spec docs/specs/2026-10-30-conduit-mcp-app-control.md
 * §2.1, §3, A4; plan T3.5). A loopback HTTP fixture and fake agents A and B:
 *   - a focused open lands an active web tab in A at the normalised URL; focus:false adds the tab
 *     and leaves the active one;
 *   - a focused open into the shown session brings the editor forward from another center view;
 *   - a split partner's focused open lands in its own layout and records no navigation: Back and
 *     Forward afterwards walk A's own history and never reach B;
 *   - an off-screen caller is refused caller_not_visible and opens nothing;
 *   - javascript:, file:, conduit-preview: and ftp: URLs are bad_url and open nothing;
 *   - a focused open that hides the terminal or editor holding the caret lands focus on the web
 *     tab's host, never inside the guest page, and is announced; one that hides nothing (or a
 *     focus:false open) leaves focus where it was (A4).
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  activeTab,
  assertLanded,
  focusedNow,
  httpFixture,
  parkKeyboard,
  shownTabs,
  splitName,
  splitWith,
} from './conduit-mcp-app-helpers.mjs';
import {
  activeSessionId,
  callTool,
  fakeAgentProfile,
  openFake,
  sessions,
  sleep,
  tapMcp,
  until,
} from './conduit-mcp-helpers.mjs';
import { assert, phase, removeDir, runScenario } from './harness.mjs';
import { openPalette, paletteRow } from './middle-click-surfaces-helpers.mjs';

const errCode = (r) => r?.error?.code;
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

await runScenario(
  'conduit-mcp-app-web',
  async ({ page, log }) => {
    await tapMcp(page);
    const http = await httpFixture();
    const temp = (label) => mkdtempSync(join(tmpdir(), `conduit-mcp-app-web-${label}-`));
    const dirA = temp('a');
    const dirB = temp('b');
    writeFileSync(join(dirA, 'w.txt'), 'web fixture\n');
    const url = http.url;
    const web = (u) => `web:${u}`;

    const isActive = async (sessionId) => (await activeSessionId(page)) === sessionId;
    const makeActive = async (sessionId) => {
      await page.locator(`.session[data-sessionid="${sessionId}"]`).click();
      assert(await until(() => isActive(sessionId), 5_000), `${sessionId} never became active`);
    };
    const waitActiveTab = async (id, what) =>
      assert(
        await until(async () => (await activeTab(page)) === id, 10_000),
        `${what}: active tab is ${await activeTab(page)}, not ${id}`,
      );
    const webTabs = async () => (await shownTabs(page)).filter((id) => id.startsWith('web:'));
    const viewOn = () =>
      page.evaluate(() => document.querySelector('.viewswitch__btn--on')?.getAttribute('title'));

    phase('setup');
    const a = await openFake(page, dirA);
    const b = await openFake(page, dirB);
    const bName = (await sessions(page)).find((s) => s.id === b.sessionId)?.name;
    await makeActive(a.sessionId);

    phase('foreground');
    await parkKeyboard(page, 'terminal');
    const fg = await callTool(page, a.sessionId, 'open_url', { url });
    assert(same(fg, { opened: url }), `foreground: ${JSON.stringify(fg)}`);
    await waitActiveTab(web(url), 'foreground');
    await assertLanded(page, '.webview', `${a.handle} opened web page`, 'terminal → open_url');
    const focusNow = () =>
      page.evaluate(() => {
        const el = document.activeElement;
        return {
          host: !!el?.closest('.webview') && el?.tagName !== 'WEBVIEW',
          after: `${el?.tagName}.${el?.className}`,
        };
      });
    // A guest page can take focus as it loads, after the tab activates: sample again once the
    // page's <title> has reached the tab.
    const tabTitle = () =>
      page.evaluate(
        (id) =>
          document.querySelector(`.tabbar [data-tabid="${CSS.escape(id)}"]`)?.textContent ?? '',
        web(url),
      );
    assert(
      await until(async () => (await tabTitle()).includes('ok'), 15_000),
      `the loopback page never loaded: tab says "${await tabTitle()}"`,
    );
    const focusAtLoad = await focusNow();
    assert(focusAtLoad.host, `the loaded page took DOM focus: ${focusAtLoad.after}`);
    log(`open_url lands an active web tab at ${url} with focus on its host, and its page loads ✓`);

    phase('background');
    await page.evaluate(() => {
      window.__focusBefore = document.activeElement;
    });
    const bg = await callTool(page, a.sessionId, 'open_url', { url: `${url}x`, focus: false });
    assert(same(bg, { opened: `${url}x` }), `background: ${JSON.stringify(bg)}`);
    assert(
      await until(async () => (await webTabs()).includes(web(`${url}x`)), 10_000),
      `no background tab: ${JSON.stringify(await webTabs())}`,
    );
    assert((await activeTab(page)) === web(url), 'focus:false changed the active tab');
    assert(
      await page.evaluate(() => document.activeElement === window.__focusBefore),
      `focus:false moved focus to ${await focusedNow(page)}`,
    );
    log('focus:false adds the tab and keeps the active one and focus ✓');

    phase('editor forward');
    await page.locator('.viewswitch__btn[title="Feature Board"]').click();
    assert(
      await until(async () => (await viewOn()) === 'Feature Board', 5_000),
      'board never shown',
    );
    const g3 = await callTool(page, a.sessionId, 'open_url', { url: `${url}g3` });
    assert(same(g3, { opened: `${url}g3` }), `editor forward: ${JSON.stringify(g3)}`);
    assert(
      await until(async () => (await viewOn()) === 'Editor', 5_000),
      `center view stayed ${await viewOn()}`,
    );
    await waitActiveTab(web(`${url}g3`), 'editor forward');
    log('a focused open into the shown session switches the board back to the editor ✓');

    phase('split partner, no navigation');
    await splitWith(page, b.sessionId);
    const theirs = await callTool(page, b.sessionId, 'open_url', { url: `${url}b` });
    assert(same(theirs, { opened: `${url}b` }), `B's open_url: ${JSON.stringify(theirs)}`);
    assert(
      !(await until(async () => (await webTabs()).includes(web(`${url}b`)), 1_500)),
      "B's tab opened in A's tab strip",
    );
    assert(await isActive(a.sessionId), "B's open_url switched the active session");
    assert((await splitName(page)) === bName, `split partner is ${await splitName(page)}`);
    assert((await activeTab(page)) === web(`${url}g3`), "B's open_url moved A's active tab");
    // A's own history is url → g3; an entry for B's open would put B at its end.
    const step = async (key, want, what) => {
      await page.evaluate(() => document.activeElement?.blur());
      await page.keyboard.press(key);
      await waitActiveTab(want, what);
      assert(await isActive(a.sessionId), `${what} switched to ${await activeSessionId(page)}`);
    };
    await step('Alt+ArrowLeft', web(url), 'Back');
    await step('Alt+ArrowRight', web(`${url}g3`), 'Forward');
    await page.keyboard.press('Alt+ArrowRight');
    // A step lands within a frame or two; give it well over that.
    await sleep(1_500);
    assert(await isActive(a.sessionId), `a second Forward reached ${await activeSessionId(page)}`);
    assert((await activeTab(page)) === web(`${url}g3`), 'a second Forward moved the tab');
    log("B's open lands in B, A stays; Back/Forward walk A's history only ✓");

    phase('caller_not_visible');
    await openPalette(page, '>Close split pane');
    await paletteRow(page, 'Close split pane').click();
    assert(await until(async () => (await splitName(page)) === null, 5_000), 'split never closed');
    const hidden = await callTool(page, b.sessionId, 'open_url', { url: `${url}hidden` });
    assert(errCode(hidden) === 'caller_not_visible', `off-screen B: ${JSON.stringify(hidden)}`);
    await makeActive(b.sessionId);
    assert(
      same(await webTabs(), [web(`${url}b`)]),
      `B's web tabs: ${JSON.stringify(await webTabs())}`,
    );
    await waitActiveTab(web(`${url}b`), "B's own open");
    await makeActive(a.sessionId);
    log('off-screen B refused caller_not_visible; B holds only its own split-time tab ✓');

    phase('bad_url');
    const before = await shownTabs(page);
    for (const bad of [
      'javascript:alert(1)',
      'file:///c:/x',
      'conduit-preview://t/x',
      'ftp://x/',
    ]) {
      const r = await callTool(page, a.sessionId, 'open_url', { url: bad });
      assert(errCode(r) === 'bad_url', `${bad}: ${JSON.stringify(r)}`);
    }
    assert(same(await shownTabs(page), before), `a bad_url opened a tab: ${await shownTabs(page)}`);
    log('javascript:, file:, conduit-preview: and ftp: are bad_url, nothing opens ✓');

    phase('editor caret');
    const file = await callTool(page, a.sessionId, 'open_file', { path: 'w.txt' });
    assert(file?.opened, `open_file: ${JSON.stringify(file)}`);
    await page.waitForSelector('.viewer__monaco .monaco-editor', { timeout: 15_000 });
    await parkKeyboard(page, 'editor');
    const fromEditor = await callTool(page, a.sessionId, 'open_url', { url: `${url}e` });
    assert(same(fromEditor, { opened: `${url}e` }), `from editor: ${JSON.stringify(fromEditor)}`);
    await waitActiveTab(web(`${url}e`), 'from editor');
    await assertLanded(page, '.webview', `${a.handle} opened web page`, 'editor → open_url');
    log('open_url from an editor caret lands focus on the web tab host ✓');

    phase('visible control');
    await page.evaluate(() => {
      const el = document.querySelector('.footbtn[title^="Settings"]');
      el?.focus();
      window.__focusBefore = el;
    });
    const outside = await callTool(page, a.sessionId, 'open_url', { url: `${url}o` });
    assert(same(outside, { opened: `${url}o` }), `outside: ${JSON.stringify(outside)}`);
    await waitActiveTab(web(`${url}o`), 'outside');
    assert(
      await page.evaluate(() => document.activeElement === window.__focusBefore),
      `an open that hid nothing moved focus to ${await focusedNow(page)}`,
    );
    log('open_url leaves focus on a control it does not hide ✓');

    phase('cleanup');
    // The sessions hold their folders as cwd; close them before removing the folders.
    for (const s of await sessions(page)) {
      await page.evaluate((id) => window.agentDeck.post({ type: 'kill', id }), s.id);
    }
    assert(
      await until(async () => (await sessions(page)).length === 0, 15_000),
      'sessions survived kill',
    );
    await http.close();
    for (const dir of [dirA, dirB]) await removeDir(dir, { budgetMs: 10_000 });
  },
  { userDataDir: fakeAgentProfile('app-web') },
);
