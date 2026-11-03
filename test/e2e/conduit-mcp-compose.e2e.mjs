/**
 * conduit-mcp-compose — the human side of messaging, driven by real clicks (spec
 * docs/specs/2026-10-25-conduit-mcp-server.md §8–§9; plan T10.7; surfaces per
 * docs/specs/2026-11-02-sidebar-agent-tree.md §6–§7):
 *   1. Messages view → New message → fake-1 → Send: the thread appears and fake-1 is noticed.
 *   2. fake-1 sends to `you` with an attachment: the footer's need-you button names the reason,
 *      the Messages toggle's badge shows 1, opening the thread clears it, and Open attachment shows
 *      the snapshotted text. The row's tooltip names the handle the footer and threads use.
 *   2b. With the right panel closed, the footer button opens the thread and the row menu's Open
 *      messages opens the filtered list.
 *   3. Row menu → Pause notices: a send to the paused fake gives no notice for 8 s, and its row's
 *      tooltip says notices are held as paused. Resume delivers it.
 *   4. fake-2 shows `permit`: its row's tooltip names the held gate.
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  callTool,
  fakeAgentProfile,
  mcpState,
  notices,
  openFake,
  sleep,
  tapMcp,
  until,
} from './conduit-mcp-helpers.mjs';
import {
  assert,
  createProject,
  runScenario,
  selectSpace,
  showRightView,
  statusItem,
  typeLine,
} from './harness.mjs';

// Once a fake goes quiet the gate wants its busy window (1.5 s) + 3 s quiet + a 0.5 s tick, then
// text + gap + Enter; the slack covers polling and a loaded runner (see conduit-mcp-gate).
const NOTICE_WITHIN_MS = 15_000;
const ATTACHMENT_TEXT = 'compose check: the attachment the human opens\n';
const PAUSED_TIP = 'Notices held: paused';

await runScenario(
  'conduit-mcp-compose',
  async ({ page, log }) => {
    await tapMcp(page);
    const work = mkdtempSync(join(tmpdir(), 'conduit-mcp-compose-'));
    writeFileSync(join(work, 'note.txt'), ATTACHMENT_TEXT);
    const a = await openFake(page, work);
    const b = await openFake(page, work);
    log(`A=${a.handle} B=${b.handle}`);
    await sleep(4_000);

    const messagesToggle = page.locator('button[data-right-view="messages"]');
    const toggleBadge = messagesToggle.locator('.topbar__badge');
    const rightPane = page.locator('#right-pane');
    const attention = statusItem(page, 'attention');
    const attentionTitle = async () =>
      (await attention.count()) === 0 ? null : await attention.getAttribute('title');
    const card = (s) => page.locator(`[data-agent-tree] .session[data-sessionid="${s.sessionId}"]`);
    const tipLines = async (s) => ((await card(s).getAttribute('title')) ?? '').split('\n');
    const cardMenu = async (s, label) => {
      await card(s).click({ button: 'right' });
      await page.locator('.ctxmenu__item', { hasText: label }).click();
    };
    // The footer orders reason-bearing sessions before messages, and a session on screen never
    // gets a reason (the server's loose visibility), so keep A shown: the click must reach the thread.
    await card(a).locator('[data-agent-action="select"]').click();
    await page
      .locator(`[data-agent-tree] .session[data-sessionid="${a.sessionId}"][aria-selected="true"]`)
      .waitFor({ timeout: 5_000 });

    // 1. compose as you
    await showRightView(page, 'messages');
    await page.locator('.mcpmsg__bar button', { hasText: 'New message' }).click();
    await page.locator('.mcpmsg-compose__recipient', { hasText: a.handle }).click();
    await page.locator('.mcpmsg-compose__body').click();
    await page.keyboard.type('compose check from the human');
    await page.locator('.mcpmsg-compose button', { hasText: 'Send' }).click();
    await page.locator('.mcpmsg [role="option"]').first().waitFor({ timeout: 10_000 });
    const noticedA = await until(() => notices(a.sessionId).length > 0, NOTICE_WITHIN_MS);
    assert(noticedA, `${a.handle} was never noticed of the human's message`);

    // 2. a message for you, with an attachment
    const sent = await callTool(page, a.sessionId, 'send_message', {
      to: ['you'],
      subject: 'attachment for you',
      body: 'see the note',
      attachments: [{ path: 'note.txt' }],
    });
    assert(sent.recipients?.[0]?.status === 'queued', `send to you: ${JSON.stringify(sent)}`);
    const footerSaid = await until(
      async () => (await attentionTitle()) === 'a message for you',
      10_000,
    );
    assert(footerSaid, `footer attention title: ${await attentionTitle()}`);
    await toggleBadge.waitFor({ timeout: 5_000 });
    const badgeText = (await toggleBadge.textContent())?.trim() ?? '';
    assert(badgeText.startsWith('1'), `toggle badge: ${badgeText}`);
    // The toggle keeps its name "Messages" and carries the count as its description.
    const toggleName = await messagesToggle.getAttribute('aria-label');
    assert(toggleName === 'Messages', `toggle name: ${JSON.stringify(toggleName)}`);
    const described = await messagesToggle.evaluate((el) => {
      const id = el.getAttribute('aria-describedby');
      return id ? (document.getElementById(id)?.textContent ?? null) : null;
    });
    assert(
      described === '1 unread message; 0 unread messages outside current scope',
      `toggle description: ${JSON.stringify(described)}`,
    );
    // The row names the handle the footer and threads use.
    const connectedTip = `Connected to Conduit as ${a.handle}`;
    assert(
      (await tipLines(a)).includes(connectedTip),
      `row tooltip: ${JSON.stringify(await tipLines(a))}`,
    );
    await page.locator('.mcpmsg [role="option"]', { hasText: 'attachment for you' }).click();
    await toggleBadge.waitFor({ state: 'detached', timeout: 5_000 });
    await page.locator('button[aria-label="Open attachment: note.txt"]').click();
    const pre = page.locator('[role="dialog"] .mcpmsg-attview__text');
    await pre.waitFor({ timeout: 5_000 });
    const shown = await pre.textContent();
    assert(shown === ATTACHMENT_TEXT, `attachment view: ${JSON.stringify(shown)}`);
    await page.locator('[role="dialog"] button', { hasText: 'Close' }).click();

    // 2b. the footer and the row menu reach Messages with the right panel closed
    const closePanel = async () => {
      await showRightView(page, 'files');
      await page.keyboard.press('Control+Shift+E');
      await rightPane.waitFor({ state: 'hidden', timeout: 5_000 });
    };
    await closePanel();
    const jump = await callTool(page, a.sessionId, 'send_message', {
      to: ['you'],
      subject: 'jump while collapsed',
      body: 'the footer opens this',
    });
    assert(jump.recipients?.[0]?.status === 'queued', `send to you: ${JSON.stringify(jump)}`);
    assert(
      await until(async () => (await attentionTitle()) === 'a message for you', 10_000),
      `footer attention title: ${await attentionTitle()}`,
    );
    await attention.click();
    const barTitle = page.locator('.mcpmsg__bartitle');
    await barTitle.waitFor({ timeout: 5_000 });
    const jumpedTo = (await barTitle.textContent())?.trim();
    assert(jumpedTo === 'jump while collapsed', `footer opened thread: ${jumpedTo}`);
    await closePanel();
    await cardMenu(a, 'Open messages');
    await page
      .locator('button[data-right-view="messages"][aria-pressed="true"]')
      .waitFor({ timeout: 5_000 });
    await page
      .locator('#right-pane[data-right-view="messages"]')
      .waitFor({ state: 'visible', timeout: 5_000 });
    await page.locator('.mcpmsg__scopetext', { hasText: a.handle }).waitFor({ timeout: 5_000 });

    // 3. pause notices from the row menu
    await cardMenu(b, `Pause notices for ${b.handle}`);
    assert(
      await until(async () => (await tipLines(b)).includes(PAUSED_TIP), 5_000),
      `paused row tooltip: ${JSON.stringify(await tipLines(b))}`,
    );
    const toPaused = await callTool(page, a.sessionId, 'send_message', {
      to: [b.handle],
      body: 'while paused',
    });
    assert(toPaused.recipients?.[0]?.status === 'queued', `send: ${JSON.stringify(toPaused)}`);
    await sleep(8_000);
    assert(notices(b.sessionId).length === 0, 'a paused session was noticed');
    await cardMenu(b, `Resume notices for ${b.handle}`);
    assert(
      await until(async () => !(await tipLines(b)).includes(PAUSED_TIP), 5_000),
      `resumed row tooltip: ${JSON.stringify(await tipLines(b))}`,
    );
    const noticedB = await until(() => notices(b.sessionId).length > 0, NOTICE_WITHIN_MS);
    assert(noticedB, `${b.handle} was not noticed after Resume`);

    // 4. the held gate's reason on the row
    await typeLine(page, b.sessionId, 'permit');
    const held = await until(
      async () => (await tipLines(b)).includes('Notices held: prompt on screen'),
      10_000,
    );
    assert(held, `row tooltip: ${JSON.stringify(await tipLines(b))}`);

    // 5. Messages follows the sidebar's Space, while This agent narrows the active scope.
    const scopeProject = await createProject(page, 'Conduit Space');
    await page.evaluate(
      ({ sid, pid }) =>
        window.agentDeck.post({ type: 'session:setProject', sessionId: sid, projectId: pid }),
      { sid: a.sessionId, pid: scopeProject },
    );
    await page.evaluate((sid) => {
      window.agentDeck.post({ type: 'session:setProject', sessionId: sid, projectId: null });
    }, b.sessionId);
    await page.waitForFunction(
      ({ aId, bId, pid }) => {
        const sessions = window.__sessions || [];
        return (
          sessions.find((s) => s.id === aId)?.projectId === pid &&
          sessions.find((s) => s.id === bId)?.projectId == null
        );
      },
      { aId: a.sessionId, bId: b.sessionId, pid: scopeProject },
      { timeout: 10000 },
    );

    const spaceOnlySubject = 'scope check: Space only';
    const noSpaceSubject = 'scope check: No space only';
    const crossSpaceSubject = 'scope check: A and B';
    const toYouFromA = await callTool(page, a.sessionId, 'send_message', {
      to: ['you'],
      subject: spaceOnlySubject,
      body: 'Space-only participant thread',
    });
    assert(
      toYouFromA.recipients?.[0]?.status === 'queued',
      `send A to you: ${JSON.stringify(toYouFromA)}`,
    );
    const toYou = await callTool(page, b.sessionId, 'send_message', {
      to: ['you'],
      subject: noSpaceSubject,
      body: 'No-space participant thread',
    });
    assert(toYou.recipients?.[0]?.status === 'queued', `send B to you: ${JSON.stringify(toYou)}`);
    const crossSpace = await callTool(page, b.sessionId, 'send_message', {
      to: ['you', a.handle],
      subject: crossSpaceSubject,
      body: 'Both Space and No-space participants',
    });
    assert(
      crossSpace.recipients?.every((r) => r.status === 'queued'),
      `send cross-Space thread: ${JSON.stringify(crossSpace)}`,
    );

    await showRightView(page, 'messages');
    const clearFilter = page.getByRole('button', { name: 'Clear filter', exact: true });
    if (await clearFilter.count()) await clearFilter.click();
    const messageRows = page.locator('.mcpmsg [role="option"]');
    const thread = (subject) => messageRows.filter({ hasText: subject });
    const waitForStateThread = async (subject, participants) => {
      const foundInState = await until(async () => {
        const state = await mcpState(page);
        return (state?.threads || []).some(
          (t) => t.subject === subject && participants.every((h) => t.participants.includes(h)),
        );
      }, 15_000);
      assert(
        foundInState,
        `MCP state lacks ${subject} with participants ${participants.join(', ')}`,
      );
      await thread(subject).waitFor({ state: 'visible', timeout: 10000 });
    };

    await waitForStateThread(spaceOnlySubject, ['you', a.handle]);
    await waitForStateThread(noSpaceSubject, ['you', b.handle]);
    await waitForStateThread(crossSpaceSubject, ['you', a.handle, b.handle]);

    await selectSpace(page, scopeProject);
    await page
      .locator('.mcpmsg__scopetext')
      .filter({ hasText: /^Space Conduit Space ·/ })
      .waitFor({ timeout: 10000 });
    await thread(spaceOnlySubject).waitFor({ state: 'visible', timeout: 5000 });
    await thread(crossSpaceSubject).waitFor({ state: 'visible', timeout: 5000 });
    assert((await thread(noSpaceSubject).count()) === 0, 'Space A excludes the B-only thread');
    const unreadOutsideA = (state) =>
      (state?.youUnreadByThread || []).reduce(
        (count, threadState) =>
          threadState.participants.includes(a.handle) ? count : count + threadState.count,
        0,
      );
    let scopedUnreadState;
    const unreadSnapshotReady = await until(async () => {
      const state = await mcpState(page);
      if (state?.youUnread >= 3 && unreadOutsideA(state) === 1) {
        scopedUnreadState = state;
        return true;
      }
      return false;
    }, 15000);
    assert(
      unreadSnapshotReady,
      `global unread snapshot did not settle: ${JSON.stringify(await mcpState(page))}`,
    );
    await toggleBadge.waitFor({ state: 'visible', timeout: 5000 });
    const globalBadgeCount = Number.parseInt((await toggleBadge.textContent())?.trim() ?? '', 10);
    assert(
      globalBadgeCount === scopedUnreadState.youUnread,
      `global badge ${globalBadgeCount} differs from MCP unread ${scopedUnreadState.youUnread}`,
    );
    await page.waitForFunction(
      () => {
        const toggle = document.querySelector('button[data-right-view="messages"]');
        const id = toggle?.getAttribute('aria-describedby');
        return id
          ? (document.getElementById(id)?.textContent ?? '').includes(
              '1 unread message outside current scope',
            )
          : false;
      },
      null,
      { timeout: 10000 },
    );
    const scopedDescription = await messagesToggle.evaluate((el) => {
      const id = el.getAttribute('aria-describedby');
      return id ? (document.getElementById(id)?.textContent ?? null) : null;
    });
    assert(
      scopedDescription?.includes('1 unread message outside current scope'),
      `Space A keeps the global outside-scope unread count: ${JSON.stringify(scopedDescription)}`,
    );
    assert(
      scopedDescription?.startsWith(`${scopedUnreadState.youUnread} unread message`),
      `tooltip preserves global unread count ${scopedUnreadState.youUnread}: ${JSON.stringify(scopedDescription)}`,
    );

    await selectSpace(page, 'all');
    await page
      .locator('.mcpmsg__scopetext')
      .filter({ hasText: /^All ·/ })
      .waitFor({ timeout: 10000 });
    await thread(spaceOnlySubject).waitFor({ state: 'visible', timeout: 5000 });
    await thread(noSpaceSubject).waitFor({ state: 'visible', timeout: 5000 });
    await thread(crossSpaceSubject).waitFor({ state: 'visible', timeout: 5000 });

    await card(b).locator('[data-agent-action="select"]').click();
    await page
      .locator(`[data-agent-tree] .session[data-sessionid="${b.sessionId}"][aria-selected="true"]`)
      .waitFor({ timeout: 5000 });
    const thisAgent = page.getByRole('button', { name: 'This agent', exact: true });
    await thisAgent.waitFor({ state: 'visible', timeout: 5000 });
    await thisAgent.click();
    await page
      .locator('.mcpmsg__scopetext')
      .filter({ hasText: `This agent · ${b.handle}` })
      .waitFor({ timeout: 10000 });
    await thread(noSpaceSubject).waitFor({ state: 'visible', timeout: 5000 });
    await thread(crossSpaceSubject).waitFor({ state: 'visible', timeout: 5000 });
    assert(
      (await thread(spaceOnlySubject).count()) === 0,
      'This agent B excludes the A-only thread',
    );
    await page.getByRole('button', { name: 'Clear filter', exact: true }).click();
    await page
      .locator('.mcpmsg__scopetext')
      .filter({ hasText: /^All ·/ })
      .waitFor({ timeout: 10000 });
    await thread(noSpaceSubject).waitFor({ state: 'visible', timeout: 5000 });
    await thread(crossSpaceSubject).waitFor({ state: 'visible', timeout: 5000 });
    await thread(spaceOnlySubject).waitFor({ state: 'visible', timeout: 5000 });

    await selectSpace(page, 'no-space');
    await page
      .locator('.mcpmsg__scopetext')
      .filter({ hasText: /^No space ·/ })
      .waitFor({ timeout: 10000 });
    await thread(noSpaceSubject).waitFor({ state: 'visible', timeout: 5000 });
    await thread(crossSpaceSubject).waitFor({ state: 'visible', timeout: 5000 });
    assert((await thread(spaceOnlySubject).count()) === 0, 'No space excludes the A-only thread');
  },
  { userDataDir: fakeAgentProfile('conduit-mcp-compose') },
);
