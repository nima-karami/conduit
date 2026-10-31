/**
 * conduit-mcp-app-git — open_review and open_git_history end to end (spec
 * docs/specs/2026-10-30-conduit-mcp-app-control.md §2.1, §2.2, §3, §5 EARS 2 and 3, A4, A5; plan
 * T3.4). A 600-commit repo (main; branch feature at c599; tag v1 at c1) is the home of fake agents
 * A and B:
 *   - Review opens for the working tree, one commit, and ranges whose endpoints classify as tag,
 *     branch, commit or working; the tab activates without moving DOM focus;
 *   - a ref starting with "-", an unresolvable ref, "working" as a base and a repo outside the
 *     session's folders are refused, and nothing opens;
 *   - History opens selecting a commit beyond the first page, and a branch ref selects its tip;
 *   - from split partner B, Review and History (singletons) open in B's own layout and leave A's
 *     screen; A stays active and B stays split.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  activeTab,
  gitFixture,
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
    const a = await openFake(page, repo);
    const b = await openFake(page, repo);
    const bName = (await sessions(page)).find((s) => s.id === b.sessionId)?.name;
    await makeActive(a.sessionId);

    /**
     * A4: park focus on a control outside the center pane, run `open`, and report whether focus
     * stayed there. Collected, and asserted in the last phase, so one finding can't hide the rest.
     */
    const focusMoves = [];
    const keepsFocus = async (what, open) => {
      await page.evaluate(() => {
        const el = document.querySelector('.footbtn[title^="Settings"]');
        el?.focus();
        window.__focusBefore = el;
      });
      await open();
      const seen = await page.evaluate(() => {
        const d = (el) => (el ? `${el.tagName}.${el.className}` : 'null');
        return {
          same: document.activeElement === window.__focusBefore,
          before: d(window.__focusBefore),
          after: d(document.activeElement),
        };
      });
      if (!seen.same) focusMoves.push({ what, ...seen });
    };

    phase('review working');
    await keepsFocus('open_review', async () => {
      const working = await callTool(page, a.sessionId, 'open_review', {
        source: { kind: 'working' },
      });
      assert(
        same(working, { opened: 'review', source: { kind: 'working', scope: 'all' } }),
        `working: ${JSON.stringify(working)}`,
      );
      await waitActiveTab(REVIEW);
    });
    log('open_review working activates Review ✓');

    phase('review commit');
    const commit = await callTool(page, a.sessionId, 'open_review', {
      source: { kind: 'commit', ref: shas[3] },
    });
    assert(
      same(commit, { opened: 'review', source: { kind: 'commit', sha: shas[3] } }),
      `commit: ${JSON.stringify(commit)}`,
    );
    await waitActiveTab(REVIEW);
    log('open_review commit resolves the sha ✓');

    phase('review range');
    const range = async (base, head) =>
      callTool(page, a.sessionId, 'open_review', { source: { kind: 'range', base, head } });
    const tagBranch = await range('v1', 'feature');
    assert(
      same(tagBranch?.source, {
        kind: 'range',
        base: { kind: 'tag', ref: 'v1' },
        head: { kind: 'branch', ref: 'feature' },
      }),
      `v1…feature: ${JSON.stringify(tagBranch)}`,
    );
    const branches = await range('feature', 'main');
    assert(
      same(branches?.source, {
        kind: 'range',
        base: { kind: 'branch', ref: 'feature' },
        head: { kind: 'branch', ref: 'main' },
      }),
      `feature…main: ${JSON.stringify(branches)}`,
    );
    const toWorking = await range(shas[5].slice(0, 10), 'working');
    assert(
      same(toWorking?.source, {
        kind: 'range',
        base: { kind: 'commit', sha: shas[5] },
        head: { kind: 'working' },
      }),
      `sha…working: ${JSON.stringify(toWorking)}`,
    );
    await waitActiveTab(REVIEW);
    log('ranges classify tag, branch, commit and working endpoints ✓');

    phase('bad refs');
    const refusals = [
      ['open_review', { source: { kind: 'range', base: '-x', head: 'main' } }, 'bad_ref'],
      ['open_review', { source: { kind: 'commit', ref: '--all' } }, 'bad_ref'],
      ['open_review', { source: { kind: 'commit', ref: 'nope' } }, 'bad_ref'],
      ['open_review', { source: { kind: 'range', base: 'working', head: 'main' } }, 'bad_ref'],
      ['open_review', { source: { kind: 'working' }, repo: '..' }, 'not_a_repo'],
      ['open_git_history', { ref: '-x' }, 'bad_ref'],
      ['open_git_history', { ref: 'nope' }, 'bad_ref'],
    ];
    const tabsBefore = await shownTabs(page);
    for (const [tool, args, code] of refusals) {
      const r = await callTool(page, a.sessionId, tool, args);
      assert(errCode(r) === code, `${tool} ${JSON.stringify(args)}: ${JSON.stringify(r)}`);
    }
    assert(
      same(await shownTabs(page), tabsBefore),
      `a refusal opened a tab: ${await shownTabs(page)}`,
    );
    assert((await activeTab(page)) === REVIEW, 'a refusal moved the active tab');
    log('leading "-", unknown refs, working as base and a foreign repo are refused ✓');

    phase('history at depth');
    await keepsFocus('open_git_history', async () => {
      const deep = await callTool(page, a.sessionId, 'open_git_history', { ref: shas[0] });
      assert(
        same(deep, { opened: 'git-history', selected: shas[0] }),
        `deep: ${JSON.stringify(deep)}`,
      );
      await waitActiveTab(HISTORY);
      await waitDetail(shas[0], 'c1');
    });
    const tip = await callTool(page, a.sessionId, 'open_git_history', { ref: 'feature' });
    assert(
      same(tip, { opened: 'git-history', selected: shas[598] }),
      `feature: ${JSON.stringify(tip)}`,
    );
    await waitDetail(shas[598], 'c599');
    log('History selects c1 beyond the first page, and feature selects c599 ✓');

    phase('split partner review');
    assert((await shownTabs(page)).includes(REVIEW), "A lost Review before B's open");
    await splitWith(page, b.sessionId);
    const bReview = await callTool(page, b.sessionId, 'open_review', {
      source: { kind: 'working' },
    });
    assert(bReview?.opened === 'review', `B's open_review: ${JSON.stringify(bReview)}`);
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

    phase('A4 focus');
    assert(
      focusMoves.length === 0,
      `a tool-driven open moved DOM focus: ${JSON.stringify(focusMoves)}`,
    );
    log('open_review and open_git_history keep DOM focus where it was ✓');

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
