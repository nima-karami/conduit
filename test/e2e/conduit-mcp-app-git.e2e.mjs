/**
 * conduit-mcp-app-git — open_review and open_git_history end to end (spec
 * docs/specs/2026-10-30-conduit-mcp-app-control.md §2.1, §2.2, §3, §5 EARS 2 and 3, A4, A5; plan
 * T3.4). A 600-commit repo (main; branch feature at c599; tag v1 at c1) is the home of fake agents
 * A and B:
 *   - open_file, then Review for the working tree, one commit, and ranges whose endpoints classify
 *     as tag, branch, commit or working; each open hides the terminal or editor holding the caret,
 *     so focus lands in the opened view and the open is announced (A4);
 *   - a ref starting with "-", an unresolvable ref, "working" as a base and a repo outside the
 *     session's folders are refused, and nothing opens;
 *   - History opens selecting a commit beyond the first page, and a branch ref selects its tip;
 *     from a caret in the terminal or the editor, focus lands in History;
 *   - from split partner B, Review and History (singletons) open in B's own layout and leave A's
 *     screen; A stays active and B stays split, and A's caret stays in its editor, typing there;
 *   - an open while focus sits on a control it doesn't hide leaves focus there;
 *   - a Review find bar the user left open comes back with a tool's open of Review without taking
 *     the keyboard; from a hidden caret, focus lands in that bar;
 *   - an open_file from a caret on the Board brings the editor back and lands focus in it.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  activeTab,
  assertLanded,
  focusedNow,
  gitFixture,
  hearLive,
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
  tapMcp,
  until,
} from './conduit-mcp-helpers.mjs';
import { assert, phase, removeDir, runScenario } from './harness.mjs';

const errCode = (r) => r?.error?.code;
const REVIEW = 'review:@review';
const HISTORY = 'git-history:@git-history';
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

await runScenario(
  'conduit-mcp-app-git',
  async ({ page, log }) => {
    await tapMcp(page);
    const root = mkdtempSync(join(tmpdir(), 'conduit-mcp-app-git-'));
    const { dir: repo, shas } = gitFixture(join(root, 'repo'), { commits: 600 });
    const { dir: outside } = gitFixture(join(root, 'outside'), { commits: 2 });

    const isActive = async (sessionId) => (await activeSessionId(page)) === sessionId;
    const makeActive = async (sessionId) => {
      await page.locator(`.session[data-sessionid="${sessionId}"]`).click();
      assert(await until(() => isActive(sessionId), 5_000), `${sessionId} never became active`);
    };
    const waitActiveTab = async (id) =>
      assert(
        await until(async () => (await activeTab(page)) === id, 10_000),
        `active tab is ${await activeTab(page)}, not ${id}`,
      );
    const sourceLabel = () =>
      page.evaluate(
        () =>
          document.querySelector('.review .review__source .gh__reffilter-label')?.textContent ??
          null,
      );
    const detail = () =>
      page.evaluate(() => ({
        sha: document.querySelector('.gh__detail .gh__detail-sha-text')?.textContent ?? null,
        subject: document.querySelector('.gh__detail .gh__message-subject')?.textContent ?? null,
      }));
    const waitDetail = async (sha, subject) =>
      assert(
        await until(async () => same(await detail(), { sha, subject }), 15_000),
        `History detail: ${JSON.stringify(await detail())}, want ${subject} ${sha}`,
      );

    phase('setup');
    await hearLive(page);
    const a = await openFake(page, repo);
    const b = await openFake(page, repo);
    const bName = (await sessions(page)).find((s) => s.id === b.sessionId)?.name;
    await makeActive(a.sessionId);

    /** A4: an open that hides nothing (focus on a control outside the center pane) keeps focus. */
    const keepsFocus = async (what, open) => {
      await page.evaluate(() => {
        const el = document.querySelector('.footbtn[title^="Settings"]');
        el?.focus();
        window.__focusBefore = el;
      });
      await open();
      assert(
        await page.evaluate(() => document.activeElement === window.__focusBefore),
        `${what} moved focus off a control it doesn't hide, to ${await focusedNow(page)}`,
      );
    };
    const FILE = 'f.txt';
    const showFile = async () => {
      await page.locator('.tabbar [role="tab"]', { hasText: FILE }).first().click();
      await page.waitForSelector('.viewer__monaco .monaco-editor', { timeout: 15_000 });
    };
    const fileText = () =>
      page.evaluate(() => {
        const ed = (window.monaco?.editor.getEditors() ?? []).find((e) =>
          e.getModel()?.uri.path.toLowerCase().endsWith('/f.txt'),
        );
        return ed?.getModel()?.getValue() ?? null;
      });

    phase('file lands');
    await parkKeyboard(page, 'terminal');
    const opened = await callTool(page, a.sessionId, 'open_file', { path: FILE });
    assert(opened?.opened, `open_file: ${JSON.stringify(opened)}`);
    await page.waitForSelector('.viewer__monaco .monaco-editor', { timeout: 15_000 });
    await assertLanded(page, '.monaco-editor', `${a.handle} opened file`, 'terminal → open_file');
    log('open_file from a terminal caret lands focus in the editor ✓');

    phase('review working');
    await parkKeyboard(page, 'editor');
    const working = await callTool(page, a.sessionId, 'open_review', {
      source: { kind: 'working' },
    });
    assert(
      same(working, { opened: 'review', source: { kind: 'working', scope: 'all' } }),
      `working: ${JSON.stringify(working)}`,
    );
    await waitActiveTab(REVIEW);
    await assertLanded(page, '.review', `${a.handle} opened Review`, 'editor → open_review');
    log('open_review working activates Review; focus lands there from the editor ✓');

    // Each open starts from a caret in the terminal, so the Review activating (and focus landing
    // in it) is the open's doing, and the header label is what Review rendered from the source it
    // was handed.
    const reviewShows = async (label, open) => {
      await parkKeyboard(page, 'terminal');
      await waitActiveTab(null);
      const r = await open();
      await waitActiveTab(REVIEW);
      await assertLanded(page, '.review', `${a.handle} opened Review`, `terminal → ${label}`);
      assert(
        await until(async () => (await sourceLabel()) === label, 10_000),
        `Review shows "${await sourceLabel()}", not "${label}"`,
      );
      return r;
    };

    phase('review commit');
    const commit = await reviewShows(`${shas[3].slice(0, 7)} c4`, () =>
      callTool(page, a.sessionId, 'open_review', { source: { kind: 'commit', ref: shas[3] } }),
    );
    assert(
      same(commit, { opened: 'review', source: { kind: 'commit', sha: shas[3] } }),
      `commit: ${JSON.stringify(commit)}`,
    );
    log('open_review commit resolves the sha and Review shows c4 ✓');

    phase('review range');
    const range = (label, base, head) =>
      reviewShows(label, () =>
        callTool(page, a.sessionId, 'open_review', { source: { kind: 'range', base, head } }),
      );
    const tagBranch = await range('v1…feature', 'v1', 'feature');
    assert(
      same(tagBranch?.source, {
        kind: 'range',
        base: { kind: 'tag', ref: 'v1' },
        head: { kind: 'branch', ref: 'feature' },
      }),
      `v1…feature: ${JSON.stringify(tagBranch)}`,
    );
    const branches = await range('feature…main', 'feature', 'main');
    assert(
      same(branches?.source, {
        kind: 'range',
        base: { kind: 'branch', ref: 'feature' },
        head: { kind: 'branch', ref: 'main' },
      }),
      `feature…main: ${JSON.stringify(branches)}`,
    );
    const toWorking = await range(
      `${shas[5].slice(0, 7)}…Working tree`,
      shas[5].slice(0, 10),
      'working',
    );
    assert(
      same(toWorking?.source, {
        kind: 'range',
        base: { kind: 'commit', sha: shas[5] },
        head: { kind: 'working' },
      }),
      `sha…working: ${JSON.stringify(toWorking)}`,
    );
    log('ranges classify tag, branch, commit and working endpoints, and Review shows each ✓');

    phase('bad refs');
    const labelBefore = await sourceLabel();
    const refusals = [
      ['open_review', { source: { kind: 'range', base: '-x', head: 'main' } }, 'bad_ref'],
      ['open_review', { source: { kind: 'commit', ref: '--all' } }, 'bad_ref'],
      ['open_review', { source: { kind: 'commit', ref: 'nope' } }, 'bad_ref'],
      ['open_review', { source: { kind: 'range', base: 'working', head: 'main' } }, 'bad_ref'],
      ['open_git_history', { ref: '-x' }, 'bad_ref'],
      ['open_git_history', { ref: 'nope' }, 'bad_ref'],
    ];
    const tabsBefore = await shownTabs(page);
    for (const [tool, args, code] of refusals) {
      const r = await callTool(page, a.sessionId, tool, args);
      assert(errCode(r) === code, `${tool} ${JSON.stringify(args)}: ${JSON.stringify(r)}`);
    }
    // A real repository outside the session's folders: only the confinement check refuses it.
    for (const tool of ['open_review', 'open_git_history']) {
      const args =
        tool === 'open_review' ? { source: { kind: 'working' }, repo: outside } : { repo: outside };
      const r = await callTool(page, a.sessionId, tool, args);
      assert(
        errCode(r) === 'not_a_repo' &&
          r.error.message.includes('home folder or an attached folder'),
        `${tool} outside repo: ${JSON.stringify(r)}`,
      );
    }
    assert(
      same(await shownTabs(page), tabsBefore),
      `a refusal opened a tab: ${await shownTabs(page)}`,
    );
    assert((await activeTab(page)) === REVIEW, 'a refusal moved the active tab');
    assert(
      (await sourceLabel()) === labelBefore,
      `a refusal changed Review to ${await sourceLabel()}`,
    );
    log('leading "-", unknown refs, working as base and a repo outside the session are refused ✓');

    phase('history at depth');
    await parkKeyboard(page, 'terminal');
    const deep = await callTool(page, a.sessionId, 'open_git_history', { ref: shas[0] });
    assert(
      same(deep, { opened: 'git-history', selected: shas[0] }),
      `deep: ${JSON.stringify(deep)}`,
    );
    await waitActiveTab(HISTORY);
    await waitDetail(shas[0], 'c1');
    await assertLanded(page, '.gh', `${a.handle} opened History`, 'terminal → open_git_history');
    await showFile();
    await parkKeyboard(page, 'editor');
    const tip = await callTool(page, a.sessionId, 'open_git_history', { ref: 'feature' });
    assert(
      same(tip, { opened: 'git-history', selected: shas[598] }),
      `feature: ${JSON.stringify(tip)}`,
    );
    await waitActiveTab(HISTORY);
    await waitDetail(shas[598], 'c599');
    await assertLanded(page, '.gh', `${a.handle} opened History`, 'editor → open_git_history');
    await keepsFocus('open_git_history again', async () => {
      const again = await callTool(page, a.sessionId, 'open_git_history', { ref: shas[0] });
      assert(again?.selected === shas[0], `again: ${JSON.stringify(again)}`);
      await waitDetail(shas[0], 'c1');
    });
    log('History selects c1 and c599; focus lands from either caret, stays on a visible control ✓');

    phase('review find bar');
    const reviewWorking = () =>
      callTool(page, a.sessionId, 'open_review', { source: { kind: 'working' } });
    const inFindBar = () =>
      page.evaluate(() => !!document.activeElement?.closest('.term-find--review'));
    await parkKeyboard(page, 'terminal');
    await reviewWorking();
    await waitActiveTab(REVIEW);
    await assertLanded(page, '.review', `${a.handle} opened Review`, 'terminal → open_review');
    await page.locator('.review .review__find').click();
    assert(await until(inFindBar, 5_000), 'the find bar never took the keyboard');
    await parkKeyboard(page, 'terminal');
    await waitActiveTab(null);
    await keepsFocus('open_review onto an open find bar', async () => {
      await reviewWorking();
      await waitActiveTab(REVIEW);
      await page.waitForSelector('.review .term-find__input', { timeout: 10_000 });
    });
    await parkKeyboard(page, 'terminal');
    await waitActiveTab(null);
    await reviewWorking();
    await waitActiveTab(REVIEW);
    await assertLanded(
      page,
      '.term-find--review',
      `${a.handle} opened Review`,
      'terminal → open_review onto an open find bar',
    );
    log(
      "Review's restored find bar leaves a visible control's focus alone; a hidden caret lands in it ✓",
    );

    phase('board');
    await page.locator('.viewswitch__btn[title="Feature Board"]').click();
    await page.waitForSelector('.board', { timeout: 10_000 });
    await page.locator('.board__head button').first().focus();
    assert(
      await page.evaluate(() => !!document.activeElement?.closest('.board')),
      'the keyboard never reached the Board',
    );
    const fromBoard = await callTool(page, a.sessionId, 'open_file', { path: FILE });
    assert(fromBoard?.opened, `open_file from the Board: ${JSON.stringify(fromBoard)}`);
    await page.waitForSelector('.board', { state: 'detached', timeout: 10_000 });
    await page.waitForSelector('.viewer__monaco .monaco-editor', { timeout: 15_000 });
    await assertLanded(page, '.monaco-editor', `${a.handle} opened file`, 'Board → open_file');
    log('open_file from a caret on the Board brings the editor back and lands focus in it ✓');

    phase('split partner review');
    assert((await shownTabs(page)).includes(REVIEW), "A lost Review before B's open");
    await splitWith(page, b.sessionId);
    await showFile();
    await parkKeyboard(page, 'editor');
    await page.evaluate(() => {
      window.__caretBefore = document.activeElement;
    });
    const bReview = await callTool(page, b.sessionId, 'open_review', {
      source: { kind: 'working' },
    });
    assert(bReview?.opened === 'review', `B's open_review: ${JSON.stringify(bReview)}`);
    assert(
      await page.evaluate(() => document.activeElement === window.__caretBefore),
      `B's open moved A's caret to ${await focusedNow(page)}`,
    );
    const textBefore = await fileText();
    await page.keyboard.type('Z');
    assert(
      await until(async () => {
        const now = await fileText();
        return now !== textBefore && now?.replace('Z', '') === textBefore;
      }, 5_000),
      `typing after B's open never reached A's f.txt: ${JSON.stringify(await fileText())}`,
    );
    await page.keyboard.press('Control+z');
    assert(
      await until(async () => (await fileText()) === textBefore, 5_000),
      'undo never restored f.txt',
    );
    assert(
      await until(async () => !(await shownTabs(page)).includes(REVIEW), 5_000),
      "Review stayed on A's screen",
    );
    assert(await isActive(a.sessionId), "B's open_review switched the active session");
    assert((await splitName(page)) === bName, `split partner is ${await splitName(page)}`);
    log("B's open_review takes Review off A's screen; A active, B split ✓");

    phase('split partner history');
    const bHistory = await callTool(page, b.sessionId, 'open_git_history', { ref: shas[1] });
    assert(
      same(bHistory, { opened: 'git-history', selected: shas[1] }),
      `B's open_git_history: ${JSON.stringify(bHistory)}`,
    );
    assert(
      await until(async () => !(await shownTabs(page)).includes(HISTORY), 5_000),
      "History stayed on A's screen",
    );
    assert(await isActive(a.sessionId), "B's open_git_history switched the active session");
    assert((await splitName(page)) === bName, `split partner is ${await splitName(page)}`);
    log("B's open_git_history takes History off A's screen; A active, B split ✓");

    phase("B's layout");
    await makeActive(b.sessionId);
    await waitActiveTab(HISTORY);
    assert((await shownTabs(page)).includes(REVIEW), `B's tabs: ${await shownTabs(page)}`);
    await waitDetail(shas[1], 'c2');
    log('B holds Review and History, History active at c2 ✓');

    phase('cleanup');
    // The sessions hold their folders as cwd; close them before removing the folders.
    for (const s of await sessions(page)) {
      await page.evaluate((id) => window.agentDeck.post({ type: 'kill', id }), s.id);
    }
    assert(
      await until(async () => (await sessions(page)).length === 0, 15_000),
      'sessions survived kill',
    );
    await removeDir(root, { budgetMs: 10_000 });
  },
  { userDataDir: fakeAgentProfile('app-git') },
);
