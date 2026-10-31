/**
 * conduit-mcp-policy — tool policies end to end (spec docs/specs/2026-10-30-conduit-mcp-tool-policy.md
 * §2, §7; plan T3.3). Two fake agents, A and B, so the real shim, gate, call flow and approval
 * card are in the path:
 *   - off: the global layer drops open_session from A's live tool list, and a call is refused;
 *   - ask: the card shows in A's window without taking focus, the chip counts it, and Deny,
 *     Approve and Always for this session each end the call as they say;
 *   - a double-click on Deny over two asks answers one: the buttons stay put as the card swaps
 *     to the next ask (no pager, shorter summary), read disabled for the guard, and no click
 *     reaches the app behind the card (QA L2, L3);
 *   - the chip focuses the card and Esc hands focus back, answering nothing;
 *   - viewing: open_file from A while B is on screen is refused and opens nothing;
 *   - move:no: a focus:true open leaves A on screen;
 *   - a CLI's notifications/cancelled removes the card and gets no reply;
 *   - a reload cancels the waiting ask (reply `cancelled`) and leaves no card or toast behind.
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  activeSessionId,
  callTool,
  clickAskAnswer,
  FAKE_AGENT_ID,
  fakeAgentProfile,
  openFake,
  records,
  resultAfter,
  sessions,
  setGlobalPolicy,
  setSessionPolicy,
  sleep,
  startCall,
  tapMcp,
  toolsSeen,
  until,
} from './conduit-mcp-helpers.mjs';
import { assert, phase, removeDir, runScenario, typeLine } from './harness.mjs';

const errCode = (r) => r?.error?.code;

await runScenario(
  'conduit-mcp-policy',
  async ({ page, log }) => {
    await tapMcp(page);
    const temp = (label) => mkdtempSync(join(tmpdir(), `conduit-mcp-policy-${label}-`));
    const dirA = temp('a');
    const dirB = temp('b');
    const target = temp('target');
    // Long enough that its summary wraps where the short one doesn't (QA L2).
    const longTarget = temp(`target-${'long-summary-'.repeat(6)}`);
    writeFileSync(join(dirA, 'fixture.txt'), 'policy fixture\n');

    const makeActive = async (sessionId) => {
      await page.locator(`.session[data-sessionid="${sessionId}"]`).click();
      assert(
        await until(async () => (await activeSessionId(page)) === sessionId, 5_000),
        `${sessionId} never became active`,
      );
    };
    const card = page.locator('.askcard');
    const waitCard = async (handle) => {
      await card.waitFor({ timeout: 10_000 });
      const text = await card.textContent();
      assert(
        text?.includes(`${handle} requests open_session`),
        `card text: ${JSON.stringify(text)}`,
      );
    };
    const openArgs = (focus) => ({ path: target, agent: FAKE_AGENT_ID, focus });

    phase('setup');
    const a = await openFake(page, dirA);
    const b = await openFake(page, dirB);
    await makeActive(a.sessionId);

    phase('off');
    await setGlobalPolicy(page, 'open_session', { access: 'off' });
    assert(
      await until(() => !toolsSeen(a.sessionId).includes('open_session'), 15_000),
      `A still lists open_session: ${JSON.stringify(toolsSeen(a.sessionId))}`,
    );
    assert(records(a.sessionId, 'LIST_CHANGED').length > 0, 'A never got tools/list_changed');
    const off = await callTool(page, a.sessionId, 'open_session', openArgs(false));
    assert(errCode(off) === 'tool_disabled', `off: ${JSON.stringify(off)}`);
    log('off refuses tool_disabled ✓');

    phase('ask deny');
    await setGlobalPolicy(page, 'open_session', { access: 'ask', when: 'viewing', move: 'yes' });
    assert(
      await until(() => toolsSeen(a.sessionId).includes('open_session'), 15_000),
      'A never re-listed open_session',
    );
    const count = (await sessions(page)).length;
    let before = await startCall(page, a.sessionId, 'open_session', openArgs(false));
    await waitCard(a.handle);
    assert(
      !(await page.evaluate(() => !!document.activeElement?.closest('.askcard'))),
      'the card took focus on arrival',
    );
    const chip = () =>
      page.evaluate(() => document.querySelector('.attnchip')?.textContent ?? null);
    assert(
      await until(async () => (await chip())?.startsWith('1 needs you'), 5_000),
      `chip: ${await chip()}`,
    );
    // The chip is the keyboard way in: it focuses the card, and Esc hands focus back.
    const focusIn = (sel) => page.evaluate((s) => !!document.activeElement?.closest(s), sel);
    await page.locator('.attnchip').click();
    assert(await until(() => focusIn('.askcard'), 5_000), 'the chip did not focus the card');
    await page.keyboard.press('Escape');
    assert(
      await until(async () => !(await focusIn('.askcard')) && (await focusIn('.attnchip')), 5_000),
      'Esc did not return focus to the chip',
    );
    assert((await card.count()) === 1, 'Esc answered or closed the card');
    log('chip → card → Esc ✓');
    await page
      .locator(`.session[data-sessionid="${a.sessionId}"] .session__ask`)
      .waitFor({ timeout: 5_000 });
    await clickAskAnswer(page, 'deny');
    const denied = await resultAfter(a.sessionId, before, 10_000);
    assert(errCode(denied) === 'denied', `deny: ${JSON.stringify(denied)}`);
    await card.waitFor({ state: 'detached', timeout: 5_000 });
    assert((await sessions(page)).length === count, 'a denied open still created a session');
    log('ask → deny ✓');

    phase('ask approve');
    before = await startCall(page, a.sessionId, 'open_session', openArgs(false));
    await waitCard(a.handle);
    await clickAskAnswer(page, 'approve');
    const approved = await resultAfter(a.sessionId, before, 15_000);
    assert(approved?.session_id, `approve: ${JSON.stringify(approved)}`);
    assert(
      await until(
        async () => (await sessions(page)).some((s) => s.id === approved.session_id),
        10_000,
      ),
      'the approved session never reached the renderer',
    );
    log('ask → approve ✓');

    phase('double-click two asks');
    const rects = () =>
      page.evaluate(() =>
        Array.from(document.querySelectorAll('.askcard button[data-answer]'), (b) => {
          const r = b.getBoundingClientRect();
          return [b.getAttribute('data-answer'), r.x, r.y, r.width, r.height].join(' ');
        }),
      );
    // The card's entrance animation moves its buttons; a rect read mid-animation compares nothing.
    const settled = () =>
      page.waitForFunction(
        () => document.querySelector('.askcard')?.getAnimations().length === 0,
        null,
        {
          timeout: 5_000,
        },
      );
    const disabledNow = () =>
      page.evaluate(() =>
        Array.from(document.querySelectorAll('.askcard button[data-answer]'), (b) =>
          b.getAttribute('aria-disabled'),
        ),
      );
    const tabBefore = await page.evaluate(
      () =>
        document
          .querySelector('.tabbar [role="tab"][aria-selected="true"]')
          ?.getAttribute('data-tabid') ?? null,
    );
    const first = await startCall(page, a.sessionId, 'open_session', {
      path: longTarget,
      agent: FAKE_AGENT_ID,
      focus: false,
    });
    await waitCard(a.handle);
    await startCall(page, a.sessionId, 'open_session', openArgs(false));
    await page.locator('.askcard', { hasText: '1 of 2' }).waitFor({ timeout: 10_000 });
    const summaryHeight = () =>
      page.evaluate(
        () => document.querySelector('.askcard__summary')?.getBoundingClientRect().height,
      );
    const tallSummary = await summaryHeight();
    await settled();
    const atTwo = await rects();
    // Every press from the first on: what it reached outside the card, and how each button it
    // reached inside the card read at that moment.
    await page.evaluate(() => {
      window.__behindCard = [];
      window.__cardPresses = [];
      window.__pressProbe = (e) => {
        const t = e.target instanceof Element ? e.target : null;
        if (t?.closest('.askcard')) {
          window.__cardPresses.push(t.closest('button')?.getAttribute('aria-disabled') ?? 'none');
          return;
        }
        window.__behindCard.push(t ? `${t.tagName}.${t.className}` : 'null');
      };
      document.addEventListener('click', window.__pressProbe, { capture: true });
    });
    await page.locator('.askcard button[data-answer="deny"]').dblclick();
    await page.locator('.askcard', { hasNotText: '1 of 2' }).waitFor({ timeout: 5_000 });
    await settled();
    const atOne = await rects();
    const shortSummary = await summaryHeight();
    const firstDenied = await resultAfter(a.sessionId, first, 10_000);
    assert(errCode(firstDenied) === 'denied', `double-click: ${JSON.stringify(firstDenied)}`);
    assert(
      tallSummary > shortSummary,
      `the summaries are the same height (${tallSummary}, ${shortSummary}): the swap tests nothing`,
    );
    assert(
      JSON.stringify(atTwo) === JSON.stringify(atOne),
      `the buttons moved on the swap: ${JSON.stringify(atTwo)} → ${JSON.stringify(atOne)}`,
    );
    const presses = await page.evaluate(() => window.__cardPresses);
    assert(
      JSON.stringify(presses) === JSON.stringify(['false', 'true']),
      `the double-click's presses read aria-disabled ${JSON.stringify(presses)}, want false then true`,
    );
    assert(
      await until(
        async () =>
          JSON.stringify(await disabledNow()) === JSON.stringify(['false', 'false', 'false']),
        2_000,
      ),
      `the buttons never re-enabled: ${JSON.stringify(await disabledNow())}`,
    );
    const behind = await page.evaluate(() => {
      document.removeEventListener('click', window.__pressProbe, { capture: true });
      return window.__behindCard;
    });
    assert(
      behind.length === 0,
      `a press reached the app behind the card: ${JSON.stringify(behind)}`,
    );
    const tabAfter = await page.evaluate(
      () =>
        document
          .querySelector('.tabbar [role="tab"][aria-selected="true"]')
          ?.getAttribute('data-tabid') ?? null,
    );
    assert(tabAfter === tabBefore, `the active tab changed: ${tabBefore} → ${tabAfter}`);
    assert((await card.count()) === 1, 'the second click answered the next ask');
    await clickAskAnswer(page, 'deny');
    await card.waitFor({ state: 'detached', timeout: 5_000 });
    const secondDenied = await resultAfter(a.sessionId, first + 1, 10_000);
    assert(errCode(secondDenied) === 'denied', `second ask: ${JSON.stringify(secondDenied)}`);
    log('a double-click answers one ask; the buttons hold still, read disabled, nothing behind ✓');

    phase('always');
    await makeActive(a.sessionId);
    before = await startCall(page, a.sessionId, 'open_session', openArgs(false));
    await waitCard(a.handle);
    await clickAskAnswer(page, 'always');
    const always = await resultAfter(a.sessionId, before, 15_000);
    assert(always?.session_id, `always: ${JSON.stringify(always)}`);
    const policyOf = async () =>
      (await sessions(page)).find((s) => s.id === a.sessionId)?.mcpToolPolicy?.open_session;
    assert(
      await until(async () => (await policyOf())?.access === 'on', 5_000),
      `A's session layer: ${JSON.stringify(await policyOf())}`,
    );
    before = await startCall(page, a.sessionId, 'open_session', openArgs(false));
    const quiet = await until(async () => (await card.count()) > 0, 1_000);
    assert(!quiet, 'a card showed after Always for this session');
    const unasked = await resultAfter(a.sessionId, before, 15_000);
    assert(unasked?.session_id, `after Always: ${JSON.stringify(unasked)}`);
    log('Always writes access:on and stops asking ✓');

    phase('viewing refusal');
    await makeActive(b.sessionId);
    const hidden = await callTool(page, a.sessionId, 'open_file', { path: 'fixture.txt' });
    assert(errCode(hidden) === 'caller_not_visible', `open_file: ${JSON.stringify(hidden)}`);
    await sleep(1_000);
    const tabs = await page.locator('.tabbar [role="tab"]', { hasText: 'fixture.txt' }).count();
    assert(tabs === 0, 'a refused open_file still opened a tab');
    assert((await activeSessionId(page)) === b.sessionId, 'the refusal moved the view');
    log('viewing refuses caller_not_visible ✓');

    phase('move:no');
    await makeActive(a.sessionId);
    await setSessionPolicy(page, a.sessionId, 'open_session', { move: 'no' });
    const stay = await callTool(page, a.sessionId, 'open_session', openArgs(true));
    assert(stay?.session_id, `move:no open: ${JSON.stringify(stay)}`);
    // A focus switch would land within a frame of the state; give it well over that.
    await sleep(1_500);
    assert(
      (await activeSessionId(page)) === a.sessionId,
      `move:no moved the view to ${await activeSessionId(page)}`,
    );
    log('move:no keeps A on screen ✓');

    phase('CLI cancel');
    await setSessionPolicy(page, a.sessionId, 'open_session', { access: 'ask' });
    const beforeCancel = (await sessions(page)).length;
    before = await startCall(page, a.sessionId, 'open_session', openArgs(false));
    await waitCard(a.handle);
    await typeLine(page, a.sessionId, 'cancel');
    assert(
      await until(() => records(a.sessionId, 'CANCEL').length > 0, 5_000),
      'the fake never sent notifications/cancelled',
    );
    await card.waitFor({ state: 'detached', timeout: 5_000 });
    const replied = await resultAfter(a.sessionId, before, 2_000);
    assert(replied === null, `a cancelled request got a reply: ${JSON.stringify(replied)}`);
    assert((await sessions(page)).length === beforeCancel, 'a cancelled ask created a session');
    log('CLI cancel removes the card, no reply ✓');

    phase('reload cancels');
    before = await startCall(page, a.sessionId, 'open_session', openArgs(false));
    await waitCard(a.handle);
    await page.reload();
    await page.locator('.session').first().waitFor({ timeout: 15_000 });
    await tapMcp(page);
    const reset = await resultAfter(a.sessionId, before, 10_000);
    assert(errCode(reset) === 'cancelled', `reload: ${JSON.stringify(reset)}`);
    await sleep(2_000);
    assert((await card.count()) === 0, 'a card survived the reload');
    const toasts = await page.locator('.toast', { hasText: 'Request from' }).count();
    assert(toasts === 0, 'the reloaded window toasted a request it never showed');
    log('reload cancels with reply cancelled ✓');

    phase('cleanup');
    // The sessions hold their folders as cwd; close them before removing the folders.
    for (const s of await sessions(page)) {
      await page.evaluate((id) => window.agentDeck.post({ type: 'kill', id }), s.id);
    }
    assert(
      await until(async () => (await sessions(page)).length === 0, 15_000),
      'sessions survived kill',
    );
    for (const d of [dirA, dirB, target]) await removeDir(d, { budgetMs: 10_000 });
  },
  { userDataDir: fakeAgentProfile('policy') },
);
