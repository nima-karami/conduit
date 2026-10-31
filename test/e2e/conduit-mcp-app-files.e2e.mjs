/**
 * conduit-mcp-app-files — open_file and close_files end to end (spec
 * docs/specs/2026-10-30-conduit-mcp-app-control.md §2.1, §5 EARS 1; plan T3.3). Fake agents A
 * (home: a git repo) and B, B split beside A:
 *   - a split partner's open_file lands in its own session: A stays active, B stays split, A's
 *     tabs don't change;
 *   - an open_file whose tab the shown session already holds stays there and leaves the human's
 *     cursor where it was; the caller's layout gets nothing;
 *   - close_files closes the clean tabs it names, reports unopened paths not_open, and the closed
 *     tab is on the reopen stack;
 *   - a dirty file with auto-save off is skipped unsaved, its tab stays, no dialog shows, and its
 *     diff tab still closes; with auto-save on it is saved and closed;
 *   - all:true closes every tab of the session, Review included.
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { disk, isDirty, setMode, tab, typeAtStart } from './auto-save-helpers.mjs';
import { changeRow, commitBase, installTabHelpers, openChangesPanel } from './changes-fixture.mjs';
import {
  activeTab,
  namesFile,
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
  tapMcp,
  until,
} from './conduit-mcp-helpers.mjs';
import { assert, phase, removeDir, runScenario } from './harness.mjs';

const LINES = Array.from({ length: 60 }, (_, i) => `line ${i + 1}`).join('\n');

await runScenario(
  'conduit-mcp-app-files',
  async ({ page, log }) => {
    await tapMcp(page);
    const temp = (label) => mkdtempSync(join(tmpdir(), `conduit-mcp-app-files-${label}-`));
    const dirA = temp('a');
    const dirB = temp('b');
    const file = (name) => join(dirA, name);
    writeFileSync(file('a.txt'), LINES);
    writeFileSync(file('b.txt'), 'b\n');
    writeFileSync(file('c.txt'), 'c\n');
    commitBase(dirA);
    writeFileSync(file('c.txt'), 'c changed\n');
    writeFileSync(file('d.txt'), 'd\n');

    const isActive = async (sessionId) => (await activeSessionId(page)) === sessionId;
    const makeActive = async (sessionId) => {
      await page.locator(`.session[data-sessionid="${sessionId}"]`).click();
      assert(await until(() => isActive(sessionId), 5_000), `${sessionId} never became active`);
    };
    const hasTab = async (name) => (await shownTabs(page)).some((id) => namesFile(id, file(name)));
    const waitTab = async (name, present) =>
      assert(
        await until(async () => (await hasTab(name)) === present, 10_000),
        `${name} tab ${present ? 'never opened' : 'never closed'}: ${JSON.stringify(await shownTabs(page))}`,
      );
    const lineOf = (name) =>
      page.evaluate(
        (n) =>
          (window.monaco?.editor.getEditors() ?? [])
            .find((e) => e.getModel()?.uri.toString().endsWith(`/${n}`))
            ?.getPosition()?.lineNumber ?? null,
        name,
      );
    const paths = (list) => list.map((p) => (typeof p === 'string' ? p : p.path));
    const only = (list, name) => list.length === 1 && namesFile(paths(list)[0], file(name));
    const terminalShown = () =>
      page.evaluate(
        () =>
          document
            .querySelector('.tab[data-tabid="__terminal__"]')
            ?.getAttribute('aria-pressed') === 'true',
      );

    phase('setup');
    await installTabHelpers(page);
    const a = await openFake(page, dirA);
    const b = await openFake(page, dirB);
    const bName = (await sessions(page)).find((s) => s.id === b.sessionId)?.name;
    await makeActive(a.sessionId);
    await splitWith(page, b.sessionId);

    phase('split partner open_file');
    const opened = await callTool(page, b.sessionId, 'open_file', { path: file('d.txt') });
    assert(opened?.session_id === b.sessionId, `B's open_file: ${JSON.stringify(opened)}`);
    // A switch or a tab lands within a frame of the open; give it well over that.
    assert(!(await until(() => hasTab('d.txt'), 1_500)), "B's file opened in A's tab strip");
    assert(await isActive(a.sessionId), 'open_file switched the active session');
    assert((await splitName(page)) === bName, `split partner is ${await splitName(page)}`);
    assert(await terminalShown(), "A's terminal is no longer the shown tab");
    log("a split partner's open_file leaves A active, B split, A's tabs unchanged ✓");

    phase('shown keeps its tab and cursor');
    const mine = await callTool(page, a.sessionId, 'open_file', { path: 'a.txt', line: 10 });
    assert(mine?.session_id === a.sessionId, `A's open_file: ${JSON.stringify(mine)}`);
    await waitTab('a.txt', true);
    assert(await until(async () => (await lineOf('a.txt')) === 10, 10_000), 'cursor never on 10');
    const theirs = await callTool(page, b.sessionId, 'open_file', {
      path: file('a.txt'),
      line: 40,
    });
    assert(theirs?.session_id === b.sessionId, `B's open_file a.txt: ${JSON.stringify(theirs)}`);
    // A reveal lands within a frame of the open; give it well over that.
    assert(
      !(await until(async () => (await lineOf('a.txt')) !== 10, 2_000)),
      `the human's cursor moved to ${await lineOf('a.txt')}`,
    );
    assert(namesFile((await activeTab(page)) ?? '', file('a.txt')), 'a.txt is no longer active');
    assert(await isActive(a.sessionId), 'open_file switched the active session');
    log("B's open_file of A's a.txt at 40 leaves A's tab and cursor (10) alone ✓");

    phase("B's own layout");
    await makeActive(b.sessionId);
    await waitTab('d.txt', true);
    assert(!(await hasTab('a.txt')), "a.txt moved to B's layout");
    await makeActive(a.sessionId);
    await waitTab('a.txt', true);
    log('B holds d.txt and not a.txt; A still holds a.txt ✓');

    phase('close_files clean');
    await callTool(page, a.sessionId, 'open_file', { path: 'b.txt' });
    await waitTab('b.txt', true);
    // An MCP open is a preview; pin b.txt so the later c.txt opens can't take its slot.
    await tab(page, 'b.txt').dblclick();
    assert(
      await until(
        async () =>
          !(await tab(page, 'b.txt').evaluate((el) => el.classList.contains('tab--preview'))),
        5_000,
      ),
      'b.txt never pinned',
    );
    const clean = await callTool(page, a.sessionId, 'close_files', {
      paths: ['a.txt', 'missing.txt'],
    });
    assert(
      only(clean?.closed ?? [], 'a.txt') &&
        only(clean.skipped, 'missing.txt') &&
        clean.skipped[0].reason === 'not_open',
      `close_files: ${JSON.stringify(clean)}`,
    );
    await waitTab('a.txt', false);
    assert(await hasTab('b.txt'), 'close_files closed b.txt too');
    await page.evaluate(() => document.activeElement?.blur());
    await page.keyboard.press('Control+Shift+T');
    await waitTab('a.txt', true);
    log('close_files closes a.txt, skips missing.txt not_open; reopen brings a.txt back ✓');

    phase('dirty, auto-save off');
    await openChangesPanel(page);
    await (await changeRow(page, 'Changes', 'c.txt')).click();
    const isDiffC = (id) => id.startsWith('diff') && namesFile(id, file('c.txt'));
    assert(
      await until(async () => (await shownTabs(page)).some(isDiffC), 10_000),
      `no c.txt diff tab: ${JSON.stringify(await shownTabs(page))}`,
    );
    await callTool(page, a.sessionId, 'open_file', { path: 'c.txt' });
    await tab(page, 'c.txt').waitFor({ timeout: 10_000 });
    await page.waitForSelector('.viewer__monaco .monaco-editor', { timeout: 15_000 });
    await typeAtStart(page, 'TYPED ');
    assert(await until(() => isDirty(page, 'c.txt'), 5_000), 'c.txt never went dirty');
    const off = await callTool(page, a.sessionId, 'close_files', { paths: ['c.txt', 'b.txt'] });
    assert(
      only(off?.closed ?? [], 'b.txt') &&
        only(off.skipped, 'c.txt') &&
        off.skipped[0].reason === 'unsaved',
      `close_files dirty: ${JSON.stringify(off)}`,
    );
    await waitTab('b.txt', false);
    assert(
      await until(async () => !(await shownTabs(page)).some(isDiffC), 5_000),
      "c.txt's diff tab stayed",
    );
    assert(await isDirty(page, 'c.txt'), 'the skipped c.txt lost its unsaved buffer');
    assert((await page.locator('.confirm').count()) === 0, 'close_files showed a dialog');
    log('dirty c.txt skipped unsaved, its diff tab and b.txt closed, no dialog ✓');

    phase('dirty, auto-save on');
    await setMode(page, 'afterDelay', 60_000);
    const on = await callTool(page, a.sessionId, 'close_files', { paths: ['c.txt'] });
    assert(
      only(on?.closed ?? [], 'c.txt') && on.skipped.length === 0,
      `auto-save: ${JSON.stringify(on)}`,
    );
    await waitTab('c.txt', false);
    assert(disk(dirA, 'c.txt').startsWith('TYPED '), `c.txt on disk: ${disk(dirA, 'c.txt')}`);
    await setMode(page, 'off');
    log('with auto-save on, dirty c.txt is saved and closed ✓');

    phase('all');
    const review = await callTool(page, a.sessionId, 'open_review', {
      source: { kind: 'working' },
    });
    assert(review?.opened === 'review', `open_review: ${JSON.stringify(review)}`);
    assert(
      await until(async () => (await shownTabs(page)).includes('review:@review'), 10_000),
      `no Review tab: ${JSON.stringify(await shownTabs(page))}`,
    );
    const all = await callTool(page, a.sessionId, 'close_files', { all: true });
    assert(
      all?.closed?.includes('@review') &&
        all.closed.some((p) => namesFile(p, file('a.txt'))) &&
        all.skipped.length === 0,
      `close_files all: ${JSON.stringify(all)}`,
    );
    assert(
      await until(async () => (await shownTabs(page)).length === 0, 10_000),
      `tabs left: ${JSON.stringify(await shownTabs(page))}`,
    );
    assert(await until(terminalShown, 5_000), "A's terminal isn't shown after all:true");
    log('all:true closes every tab of A, Review included ✓');

    phase('cleanup');
    // The sessions hold their folders as cwd; close them before removing the folders.
    for (const s of await sessions(page)) {
      await page.evaluate((id) => window.agentDeck.post({ type: 'kill', id }), s.id);
    }
    assert(
      await until(async () => (await sessions(page)).length === 0, 15_000),
      'sessions survived kill',
    );
    for (const dir of [dirA, dirB]) await removeDir(dir, { budgetMs: 10_000 });
  },
  { userDataDir: fakeAgentProfile('app-files') },
);
