/**
 * status-bar — the center footer (spec docs/specs/archive/2026-11-02-sidebar-agent-tree.md §7, §4 needs-you
 * projection; plan "E2e migration manifest"). Real sessions, real server facts, real asks/messages:
 *   - the active session's branch, and a worktree item only for a real linked git worktree;
 *   - "N agents" counts the window's live sessions whatever the Space filter, search or folds;
 *   - a finished-but-unseen (Done) session is not counted, even with its legacy flag up;
 *   - asks, then blocked/bell sessions, then messages: the button's tooltip names the first and a
 *     click routes to it (ask → the approval card takes focus; session → it becomes active;
 *     message → its thread in the Messages panel); the ask also reads Needs you on its row;
 *   - Snooze takes a session's reason out of the count without touching the server's fact;
 *   - the commands hint shows the effective openCommands combo and follows a rebind;
 *   - no active session: machine and counts only.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  bell,
  burst,
  completionsOf,
  footerAttention,
  report,
  rowMenu,
  rowState,
  SPAWN_GRACE_WAIT_MS,
  STAYS_MS,
  selectRow,
  sessionOf,
  sleep,
  waitCompletions,
  waitFooterAttention,
  waitRowState,
} from './attention-footer-helpers.mjs';
import { commitBase, git } from './changes-fixture.mjs';
import {
  callTool,
  clickAskAnswer,
  FAKE_AGENT_ID,
  fakeAgentProfile,
  openFake,
  resultAfter,
  setGlobalPolicy,
  startCall,
  tapMcp,
  toolsSeen,
  until,
} from './conduit-mcp-helpers.mjs';
import {
  assert,
  createProject,
  filterAgents,
  openSession,
  phase,
  REPO,
  removeDir,
  runScenario,
  selectSpace,
  statusBar,
  statusItem,
} from './harness.mjs';

const SUBJECT = 'status bar check';

const itemText = async (page, item) => {
  const loc = statusItem(page, item);
  return (await loc.count()) === 0 ? null : ((await loc.textContent()) ?? '').trim();
};

/** Wait until a footer item reads `want` (null: absent); throws with the last read. */
async function waitItem(page, item, want, what, ms = 15_000) {
  const deadline = Date.now() + ms;
  let got = null;
  while (Date.now() < deadline) {
    got = await itemText(page, item);
    if (got === want) return;
    await sleep(100);
  }
  assert(
    false,
    `${what}: footer ${item} reads ${JSON.stringify(got)}, want ${JSON.stringify(want)}`,
  );
}

const runningCount = (page) =>
  page.evaluate(() => (window.__sessions || []).filter((s) => s.status === 'running').length);

const treeRows = (page) => page.locator('[data-agent-tree] .session').count();

async function checkUpdateLabelFits(app, page, log) {
  const size = await app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0];
    const previous = win.getContentSize();
    win.setContentSize(1320, 820);
    return previous;
  });
  const previousTheme = await page.evaluate(() => document.documentElement.dataset.theme);
  try {
    await page.waitForFunction(() => innerWidth === 1320 && innerHeight === 820);
    for (const theme of ['aero', 'aero-dark', 'neon']) {
      await page.evaluate((id) => {
        document.documentElement.dataset.theme = id;
      }, theme);
      for (const [status, label] of [
        ['downloading', 'Updating · 42%'],
        ['ready', 'Update ready'],
      ]) {
        await app.evaluate(({ BrowserWindow }, state) => {
          BrowserWindow.getAllWindows()[0].webContents.send('to-webview', {
            type: 'updateStatus',
            status: state,
            version: '9.9.9',
            percent: 42,
          });
        }, status);
        await waitItem(page, 'update', label, `${theme} ${status}`);
        const facts = await page.evaluate(async () => {
          await document.fonts.ready;
          await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
          const footer = document.querySelector('footer[data-status-bar]');
          const item = footer.querySelector('[data-status-item="update"]');
          const text = item.querySelector('.statusbar__text');
          const lowerPriority = ['machine', 'branch', 'worktree'].map((name) => {
            const node = footer.querySelector(`[data-status-item="${name}"]`);
            const label = node?.querySelector('.statusbar__text');
            return {
              name,
              visible: !!node && getComputedStyle(node).display !== 'none',
              clipped: !!label && label.scrollWidth > label.clientWidth,
            };
          });
          return {
            itemFits: item.scrollWidth <= item.clientWidth,
            textFits: text.scrollWidth <= text.clientWidth,
            footerFits: footer.scrollWidth <= footer.clientWidth,
            lowerPriority,
          };
        });
        log(`${theme} ${status} footer geometry: ${JSON.stringify(facts)}`);
        assert(
          facts.itemFits && facts.textFits && facts.footerFits,
          `${theme} ${label} must fit in full at 1320px (${JSON.stringify(facts)})`,
        );
        assert(
          facts.lowerPriority.every((item) => item.visible) &&
            facts.lowerPriority.some((item) => item.clipped),
          `${theme}: lower-priority labels ellipsize and remain present`,
        );
      }
    }
  } finally {
    await app.evaluate(({ BrowserWindow }, previous) => {
      BrowserWindow.getAllWindows()[0].webContents.send('to-webview', {
        type: 'updateStatus',
        status: 'up-to-date',
      });
      BrowserWindow.getAllWindows()[0].setContentSize(...previous);
    }, size);
    await page.evaluate((previous) => {
      if (previous === undefined) delete document.documentElement.dataset.theme;
      else document.documentElement.dataset.theme = previous;
    }, previousTheme);
  }
}

await runScenario(
  'status-bar',
  async ({ app, page, log }) => {
    await tapMcp(page);
    const root = mkdtempSync(join(tmpdir(), 'conduit-status-bar-'));
    const main = join(root, 'main');
    mkdirSync(main);
    writeFileSync(join(main, 'readme.txt'), 'status bar fixture\n');
    commitBase(main);
    git(main, 'branch', '-M', 'sb-main');
    const linkedName = `wt-linked-${'long-name-'.repeat(6)}`;
    const linkedBranch = `sb-wt-${'long-branch-'.repeat(6)}`;
    const linked = join(root, linkedName);
    git(main, 'worktree', 'add', '-q', '-b', linkedBranch, linked);
    const work = join(root, 'work');
    const target = join(root, 'target');
    mkdirSync(work);
    mkdirSync(target);

    phase('branch and worktree of the active session');
    const M = await openSession(page, { path: main });
    const W = await openSession(page, { path: linked });
    await selectRow(page, M);
    await statusBar(page).waitFor({ state: 'visible', timeout: 15_000 });
    assert(
      (await statusBar(page).getAttribute('aria-label')) === 'Session status',
      `footer label: ${await statusBar(page).getAttribute('aria-label')}`,
    );
    await waitItem(page, 'machine', 'This computer', 'machine');
    await waitItem(page, 'branch', 'sb-main', 'a plain repo');
    assert((await itemText(page, 'worktree')) === null, 'a plain repo showed a worktree item');
    await selectRow(page, W);
    await waitItem(page, 'branch', linkedBranch, 'a linked worktree');
    await waitItem(page, 'worktree', `worktree ${linkedName}`, 'a linked worktree');
    await checkUpdateLabelFits(app, page, log);
    await selectRow(page, M);
    await waitItem(page, 'worktree', null, 'back on the plain repo');
    await waitItem(page, 'commands', 'Ctrl + Shift + P commands', 'default openCommands hint');
    log('branch / worktree / default hint ✓');

    phase('more sessions');
    const D = await openSession(page, { path: REPO });
    const R = await openSession(page, { path: REPO });
    const B = await openSession(page, { path: REPO });
    const A = await openFake(page, work);
    log('sessions', JSON.stringify({ M, W, D, R, B, A: A.sessionId }));
    await selectRow(page, A.sessionId);
    await sleep(SPAWN_GRACE_WAIT_MS);

    phase('live count ignores Space, search and folds');
    const live = `${await runningCount(page)} agents`;
    await waitItem(page, 'live', live, 'live count');
    await filterAgents(page, 'zz-no-such-agent');
    assert(await until(async () => (await treeRows(page)) === 0, 5_000), 'the search hid no rows');
    assert(
      (await itemText(page, 'live')) === live,
      `live under a search: ${await itemText(page, 'live')}`,
    );
    await filterAgents(page, '');
    const space = await createProject(page, 'Empty status space');
    await selectSpace(page, space);
    assert(
      await until(async () => (await treeRows(page)) === 0, 5_000),
      'the empty Space still lists rows',
    );
    assert(
      (await itemText(page, 'live')) === live,
      `live in an empty Space: ${await itemText(page, 'live')}`,
    );
    await selectSpace(page, 'all');
    const header = page.locator('button.proj__label[data-agent-group]').first();
    await header.click();
    await page.waitForFunction(
      () =>
        document
          .querySelector('button.proj__label[data-agent-group]')
          ?.getAttribute('aria-expanded') === 'false',
      null,
      { timeout: 5_000 },
    );
    assert(
      (await itemText(page, 'live')) === live,
      `live with a fold: ${await itemText(page, 'live')}`,
    );
    await header.click();
    log(`live "${live}" through search / Space / fold ✓`);

    phase('a Done session is not counted');
    await selectRow(page, A.sessionId);
    const d0 = await completionsOf(page, D);
    await burst(page, D, 'd1');
    await waitCompletions(page, D, d0 + 1, 'a background run');
    await waitRowState(page, D, 'Done', 'an unseen run');
    // The legacy flag the old header chip counted: up for D, and still not counted here.
    assert(
      await until(async () => (await sessionOf(page, D))?.needsAttention === true, 10_000),
      'D never raised its legacy needsAttention, so this check would prove nothing',
    );
    assert(
      (await footerAttention(page)) === null,
      `Done counted: ${JSON.stringify(await footerAttention(page))}`,
    );
    await sleep(STAYS_MS);
    assert(
      (await footerAttention(page)) === null,
      `Done counted: ${JSON.stringify(await footerAttention(page))}`,
    );
    log('finished-unseen not counted ✓');

    phase('asks, then sessions, then messages');
    await setGlobalPolicy(page, 'open_session', { access: 'ask', when: 'viewing', move: 'yes' });
    assert(
      await until(() => toolsSeen(A.sessionId).includes('open_session'), 15_000),
      'A never listed open_session',
    );
    const sent = await callTool(page, A.sessionId, 'send_message', {
      to: ['you'],
      subject: SUBJECT,
      body: 'the footer routes here last',
    });
    assert(sent.recipients?.[0]?.status === 'queued', `send to you: ${JSON.stringify(sent)}`);
    await waitFooterAttention(page, '1 needs you', 'a message for you');
    await bell(page, B);
    await report(page, R, 'working');
    await waitRowState(page, R, 'Working', 'R reported Working');
    await report(page, R, 'blocked');
    await waitRowState(page, R, 'Needs you', 'R reported Blocked');
    await waitRowState(page, B, 'Needs you', 'B rang a bell');
    const before = await startCall(page, A.sessionId, 'open_session', {
      path: target,
      agent: FAKE_AGENT_ID,
      focus: false,
    });
    const card = page.locator('.askcard');
    await card.waitFor({ timeout: 10_000 });
    const four = await waitFooterAttention(page, '4 need you', 'ask + R + B + message, D excluded');
    assert(
      four.title === `${A.handle} is waiting for your approval`,
      `first entry is not the ask: ${JSON.stringify(four.title)}`,
    );
    await waitRowState(page, A.sessionId, 'Needs you', 'a pending ask on its caller');
    assert((await rowState(page, D)) === 'Done', `D left Done: ${await rowState(page, D)}`);
    await statusItem(page, 'attention').click();
    assert(
      await until(() => page.evaluate(() => !!document.activeElement?.closest('.askcard')), 5_000),
      'the footer did not focus the approval card',
    );
    await clickAskAnswer(page, 'deny');
    const denied = await resultAfter(A.sessionId, before, 10_000);
    assert(denied?.error?.code === 'denied', `deny: ${JSON.stringify(denied)}`);
    await card.waitFor({ state: 'detached', timeout: 5_000 });
    assert(
      await until(async () => (await rowState(page, A.sessionId)) !== 'Needs you', 5_000),
      'A still reads Needs you after its ask was answered',
    );
    const three = await waitFooterAttention(page, '3 need you', 'after the ask');
    // A session entry carries no reason copy, so the tooltip is the count: not the message's.
    assert(
      three.title === '3 need you',
      `first entry after the ask: ${JSON.stringify(three.title)}`,
    );
    const [first, second] = await page.evaluate(
      (ids) => (window.__sessions || []).map((s) => s.id).filter((id) => ids.includes(id)),
      [R, B],
    );
    await statusItem(page, 'attention').click();
    await page.waitForFunction(
      (id) =>
        document
          .querySelector(`[data-agent-tree] .session[data-sessionid="${id}"]`)
          ?.getAttribute('aria-selected') === 'true',
      first,
      { timeout: 5_000 },
    );
    await waitFooterAttention(page, '2 need you', 'the focused session saw its reason');
    log('ask → card, then the first reason session, in order ✓');

    phase('snooze takes a reason out of the count');
    await rowMenu(page, second, 'Snooze for 10 minutes');
    const one = await waitFooterAttention(page, '1 needs you', 'a snoozed reason');
    const raw = (await sessionOf(page, second))?.attentionReason;
    assert(raw === 'blocked' || raw === 'bell', `snooze changed the server's fact: ${raw}`);
    assert(
      one.title === 'a message for you',
      `first entry after snooze: ${JSON.stringify(one.title)}`,
    );
    log('snooze ✓');

    phase('a message entry opens its thread');
    await statusItem(page, 'attention').click();
    await page
      .locator('#right-pane[data-right-view="messages"]')
      .waitFor({ state: 'visible', timeout: 10_000 });
    const barTitle = page.locator('.mcpmsg__bartitle');
    await barTitle.waitFor({ timeout: 5_000 });
    const opened = (await barTitle.textContent())?.trim();
    assert(opened === SUBJECT, `the footer opened thread ${JSON.stringify(opened)}`);
    await waitFooterAttention(page, null, 'every entry handled');
    log('message → thread; button gone at zero ✓');

    phase('the commands hint follows a rebind');
    await page.locator('.footbtn[title^="Settings"]').click();
    await page.locator('.settings__navitem', { hasText: 'Shortcuts' }).click();
    await page.locator('.shortcuts').waitFor({ state: 'visible', timeout: 5_000 });
    await page
      .getByRole('button', { name: 'Record shortcut for Command palette', exact: true })
      .click();
    await page.keyboard.press('Control+Alt+J');
    await page
      .locator('.shortcuts__row', {
        has: page.locator('.shortcuts__desc', { hasText: /^Command palette/ }),
      })
      .locator('.shortcuts__keys kbd', { hasText: 'Ctrl + Alt + J' })
      .first()
      .waitFor({ timeout: 5_000 });
    await page.keyboard.press('Escape');
    await page.locator('.modal.settings').first().waitFor({ state: 'detached', timeout: 5_000 });
    await waitItem(page, 'commands', 'Ctrl + Alt + J commands', 'a rebound openCommands');
    log('rebound hint ✓');

    phase('no active session: machine and counts only');
    for (const s of await page.evaluate(() => (window.__sessions || []).map((x) => x.id))) {
      await page.evaluate((id) => window.agentDeck.post({ type: 'kill', id }), s);
    }
    assert(
      await until(() => page.evaluate(() => (window.__sessions || []).length === 0), 15_000),
      'sessions survived kill',
    );
    await statusBar(page).waitFor({ state: 'visible', timeout: 10_000 });
    await waitItem(page, 'live', '0 agents', 'no sessions');
    await waitItem(page, 'machine', 'This computer', 'no sessions');
    for (const item of ['branch', 'worktree', 'commands', 'attention']) {
      assert((await itemText(page, item)) === null, `no active session still shows ${item}`);
    }
    log('no active: machine + counts ✓');
    await removeDir(root, { budgetMs: 10_000 });
  },
  { userDataDir: fakeAgentProfile('status-bar') },
);
