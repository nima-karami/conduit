/**
 * policy-permission-requests — an ask is a permission request (plan
 * docs/plans/2026-11-14-policy-permissions-machinery.plan.md, Task 3.2 e2e). Fake sessions stand
 * in for the Worker callers and the close targets; this page is the owner window, so its
 * mcp:permissionAnswer is the card's answer:
 *   - an unanswered close_session ask ends approval_timeout and the target stays open;
 *   - a late answer to that timed-out ask keeps a session/target/1h grant but runs nothing: the
 *     target stays open and W's inbox gets the retry notice; the retry closes the target with no
 *     card, its row reads "allowed by grant", and the grant expires with its target;
 *   - a session-level access off (an anywhere deny exception) refuses; mcp:allowOnce on that
 *     refusal's row lets one close through, and the next target is refused again;
 *   - an anywhere/1h grant answered on a card closes that target, then covers the next close
 *     with no card; revoking it brings the card back, and a deny keeps the target open.
 */
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  activeSessionId,
  callTool,
  clickAskAnswer,
  fakeAgentProfile,
  mcpState,
  openFake,
  resultAfter,
  sessions,
  setSessionPolicy,
  startCall,
  tapMcp,
  until,
} from './conduit-mcp-helpers.mjs';
import { assert, phase, removeDir, runScenario } from './harness.mjs';

const errCode = (r) => r?.error?.code;
const temp = (label) => mkdtempSync(join(tmpdir(), `policy-permission-requests-${label}-`));
const DAY_FILE = /^\d{4}-\d{2}-\d{2}\.jsonl$/;

const userDataDir = fakeAgentProfile('policy-permission-requests');

/** Every Activity row written so far, from the day files under userData. */
function activityRows() {
  const dir = join(userDataDir, 'conduit-mcp', 'activity');
  let names = [];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  return names
    .filter((name) => DAY_FILE.test(name))
    .flatMap((name) => {
      const lines = readFileSync(join(dir, name), 'utf8').split('\n');
      // Only '\n'-terminated rows count: the last piece is a row the host is still appending.
      lines.pop();
      return lines.map((l) => JSON.parse(l));
    });
}

/**
 * The owner window's answer to a permission request, as the card sends it. Resolves the
 * mcp:permissionResult the host replies with.
 */
async function permissionAnswer(page, askId, answer) {
  return page.evaluate(
    ({ id, a, ms }) =>
      new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          off();
          reject(new Error(`mcp:permissionAnswer ${id}: no mcp:permissionResult in ${ms} ms`));
        }, ms);
        const off = window.agentDeck.subscribe((m) => {
          if (m.type !== 'mcp:permissionResult' || m.requestId !== id) return;
          clearTimeout(timer);
          off();
          resolve(m);
        });
        window.agentDeck.post({ type: 'mcp:permissionAnswer', requestId: id, answer: a });
      }),
    { id: askId, a: answer, ms: 10_000 },
  );
}

/** A policy edit from the owner window that the host answers with mcp:policyResult. */
async function policyRequest(page, message) {
  return page.evaluate(
    ({ m, ms }) =>
      new Promise((resolve, reject) => {
        window.__permReq = (window.__permReq ?? 700_000) + 1;
        const requestId = window.__permReq;
        const timer = setTimeout(() => {
          off();
          reject(new Error(`${m.type}: no mcp:policyResult in ${ms} ms`));
        }, ms);
        const off = window.agentDeck.subscribe((r) => {
          if (r.type !== 'mcp:policyResult' || r.requestId !== requestId) return;
          clearTimeout(timer);
          off();
          resolve(r);
        });
        window.agentDeck.post({ ...m, requestId });
      }),
    { m: message, ms: 10_000 },
  );
}

/** Every mcp:ask the owner window has received from this caller, oldest first. */
const asksFor = (page, callerId) =>
  page.evaluate((id) => (window.__asks ?? []).filter((a) => a.callerSessionId === id), callerId);

/** The next ask from this caller whose askId is not in `seen`. */
async function nextAsk(page, callerId, seen, ms) {
  let found = null;
  const ok = await until(async () => {
    found = (await asksFor(page, callerId)).find((a) => !seen.has(a.askId)) ?? null;
    return found !== null;
  }, ms);
  assert(ok, `no new permission ask from ${callerId} within ${ms} ms`);
  return found;
}

await runScenario(
  'policy-permission-requests',
  async ({ page, log }) => {
    await tapMcp(page);
    // Installed before any ask can arrive, so every mcp:ask the owner window gets is kept.
    await page.evaluate(() => {
      window.__asks = [];
      window.agentDeck.subscribe((m) => {
        if (m.type === 'mcp:ask') window.__asks.push(m);
      });
    });

    const dirW = temp('worker');
    const dirT1 = temp('target1');
    const dirT2 = temp('target2');
    const dirT3 = temp('target3');
    const dirX = temp('exception');
    const dirT4 = temp('target4');
    const dirT5 = temp('target5');
    const dirT6 = temp('target6');

    const makeActive = async (sessionId) => {
      await page
        .locator(
          `[data-agent-tree] .session[data-sessionid="${sessionId}"] [data-agent-action="select"]`,
        )
        .click();
      assert(
        await until(async () => (await activeSessionId(page)) === sessionId, 5_000),
        `${sessionId} never became active`,
      );
    };

    phase('setup');
    // W is the Worker caller. Its close_session asks only while it is on screen (viewing), so it
    // is made active before each call.
    const w = await openFake(page, dirW);
    const t1 = await openFake(page, dirT1);
    const t2 = await openFake(page, dirT2);
    const t3 = await openFake(page, dirT3);
    const x = await openFake(page, dirX);
    const t4 = await openFake(page, dirT4);
    const t5 = await openFake(page, dirT5);
    const t6 = await openFake(page, dirT6);
    const stillOpen = async (sessionId) => (await sessions(page)).some((s) => s.id === sessionId);

    phase('unanswered ask times out; the target stays open');
    await makeActive(w.sessionId);
    const firstBefore = await startCall(page, w.sessionId, 'close_session', {
      session: t1.handle,
    });
    const ask1 = await nextAsk(page, w.sessionId, new Set(), 15_000);
    assert(ask1.tool === 'close_session', `first ask tool: ${JSON.stringify(ask1)}`);
    const card = page.locator('.askcard');
    await card.waitFor({ timeout: 5_000 });
    assert(
      (await card.textContent())?.includes(`${w.handle} requests close_session`),
      `the first ask's card: ${await card.textContent()}`,
    );
    // The ask budget is the CLI's (25 s for a fake client) and is not configurable from the
    // harness, so the timeout is waited for in full.
    const timedOut = await resultAfter(w.sessionId, firstBefore, 40_000);
    assert(
      errCode(timedOut) === 'approval_timeout',
      `unanswered close: ${JSON.stringify(timedOut)}`,
    );
    assert(await stillOpen(t1.sessionId), 'an unanswered close still closed its target');
    assert(
      await until(
        () =>
          activityRows().some(
            (r) =>
              r.action === 'close_session' &&
              r.principal?.sessionId === w.sessionId &&
              r.outcome === 'expired' &&
              r.requestId === ask1.askId,
          ),
        10_000,
      ),
      'no expired Activity row for the timed-out close',
    );
    assert(
      await until(async () => (await page.locator('.askcard').count()) === 0, 5_000),
      'the timed-out card did not clear',
    );
    assert(
      activityRows().some(
        (r) => r.action === 'close_session' && r.requestId === ask1.askId && r.outcome === 'asked',
      ),
      'no asked Activity row carrying the permission id',
    );
    log('unanswered close_session → approval_timeout, target open ✓');

    phase('late answer on the timed-out ask: the grant is kept, the call does not run');
    const late = await permissionAnswer(page, ask1.askId, {
      outcome: 'allowed',
      grant: { who: 'session', on: 'target', for: '1h' },
    });
    assert(late.ok === true, `late mcp:permissionAnswer: ${JSON.stringify(late)}`);
    assert(await stillOpen(t1.sessionId), 'a late answer ran the call');
    const hasRetryNotice = async () => {
      const inbox = await callTool(page, w.sessionId, 'read_inbox', {});
      return (inbox.messages ?? []).some(
        (m) =>
          typeof m.body === 'string' &&
          m.body.includes('You can retry close_session now') &&
          m.request_id === ask1.askId,
      );
    };
    assert(
      await until(hasRetryNotice, 15_000),
      "W's inbox never got 'You can retry close_session now'",
    );
    assert(await stillOpen(t1.sessionId), 'the late answer ran the call after the inbox wait');
    log('late allowed+grant → t1 still open, retry notice in W’s inbox ✓');

    phase('retry after the late grant closes t1 with no card');
    const retryBefore = await startCall(page, w.sessionId, 'close_session', {
      session: t1.handle,
    });
    const retryCard = await until(async () => (await card.count()) > 0, 1_500);
    assert(!retryCard, 'the retry after a late grant showed a card');
    const closed = await resultAfter(w.sessionId, retryBefore, 15_000);
    assert(
      closed?.closed === t1.sessionId,
      `retry after the late grant: ${JSON.stringify(closed)}`,
    );
    assert(
      await until(async () => !(await stillOpen(t1.sessionId)), 10_000),
      'the retry after the late grant never removed its target',
    );
    assert(
      await until(
        () =>
          activityRows().some(
            (r) =>
              r.action === 'close_session' &&
              r.principal?.sessionId === w.sessionId &&
              r.target === t1.sessionId &&
              r.outcome === 'ok' &&
              typeof r.decidedBy === 'string' &&
              r.decidedBy.startsWith('allowed by grant'),
          ),
        10_000,
      ),
      `no "allowed by grant" row for the retry: ${JSON.stringify(
        activityRows().filter((r) => r.target === t1.sessionId),
      )}`,
    );
    // A grant on a session target ends with that session: closing t1 expires it at once.
    const grantOfW = () =>
      mcpState(page).then((st) =>
        st?.policy?.grants?.find(
          (g) =>
            g.state === 'expired' &&
            g.requestId === ask1.askId &&
            g.tool === 'close_session' &&
            g.who?.kind === 'session' &&
            g.who?.sessionId === w.sessionId &&
            g.on?.kind === 'session' &&
            g.on?.sessionId === t1.sessionId &&
            g.for === '1h',
        ),
      );
    assert(
      await until(async () => (await grantOfW()) !== undefined, 10_000),
      `the session/target/1h grant never reached McpUiState: ${JSON.stringify(
        (await mcpState(page))?.policy?.grants,
      )}`,
    );
    log('retry closes t1 with no card; its target grant ends with it ✓');

    phase('exception deny refuses; allowOnce lets one close through');
    // Scoped exceptions cannot be written at runtime, so the deny is the session's own legacy
    // access off, which is an anywhere deny exception for that caller.
    await makeActive(x.sessionId);
    await setSessionPolicy(page, x.sessionId, 'close_session', { access: 'off' });
    const refused = await callTool(page, x.sessionId, 'close_session', { session: t2.handle });
    assert(errCode(refused) === 'tool_disabled', `exception deny: ${JSON.stringify(refused)}`);
    assert(await stillOpen(t2.sessionId), 'a refused close still closed its target');
    const isRefusal = (r) =>
      r.action === 'close_session' &&
      r.principal?.sessionId === x.sessionId &&
      r.decision === 'deny' &&
      r.outcome === 'denied';
    assert(
      await until(() => activityRows().some(isRefusal), 10_000),
      'no denied Activity row for the exception refusal',
    );
    const refusal = activityRows().find(isRefusal);
    const once = await policyRequest(page, { type: 'mcp:allowOnce', activityId: refusal.id });
    assert(once.ok === true, `mcp:allowOnce ${refusal.id}: ${JSON.stringify(once)}`);

    const retried = await callTool(page, x.sessionId, 'close_session', { session: t2.handle });
    assert(retried?.closed === t2.sessionId, `allowed once: ${JSON.stringify(retried)}`);
    assert(
      await until(
        () =>
          activityRows().some(
            (r) =>
              r.action === 'close_session' &&
              r.principal?.sessionId === x.sessionId &&
              r.decidedBy === 'allowed once',
          ),
        10_000,
      ),
      'no "allowed once" Activity row for the retry',
    );

    const second = await callTool(page, x.sessionId, 'close_session', { session: t3.handle });
    assert(errCode(second) === 'tool_disabled', `second target: ${JSON.stringify(second)}`);
    assert(await stillOpen(t3.sessionId), 'the second target was closed despite its deny');
    log('exception deny → allowOnce closes one target, the second is refused ✓');

    phase('anywhere grant covers calls; revoking it brings the card back');
    const grantWhere = async (pred) => (await mcpState(page))?.policy?.grants?.find(pred);
    const anywhereOfW = () =>
      grantWhere(
        (g) =>
          g.state === 'active' &&
          g.tool === 'close_session' &&
          g.who?.kind === 'session' &&
          g.who?.sessionId === w.sessionId &&
          g.on?.kind === 'anywhere' &&
          g.for === '1h',
      );
    const seen = new Set([ask1.askId]);

    // (a) A card is answered with an anywhere grant; the call that asked closes its target.
    await makeActive(w.sessionId);
    const beforeA = await startCall(page, w.sessionId, 'close_session', { session: t4.handle });
    const askA = await nextAsk(page, w.sessionId, seen, 15_000);
    seen.add(askA.askId);
    assert(
      await until(async () => (await card.count()) > 0, 5_000),
      `no card for T4's ask ${askA.askId}`,
    );
    const grantedA = await permissionAnswer(page, askA.askId, {
      outcome: 'allowed',
      grant: { who: 'session', on: 'anywhere', for: '1h' },
    });
    assert(grantedA.ok === true, `anywhere grant answer: ${JSON.stringify(grantedA)}`);
    assert(
      await until(async () => (await card.count()) === 0, 5_000),
      'the card for T4 did not clear after its answer',
    );
    const closedA = await resultAfter(w.sessionId, beforeA, 15_000);
    assert(
      closedA?.closed === t4.sessionId,
      `T4 after the anywhere grant: ${JSON.stringify(closedA)}`,
    );
    assert(
      await until(async () => !(await stillOpen(t4.sessionId)), 10_000),
      'T4 survived its granted close',
    );
    assert(
      await until(async () => (await anywhereOfW()) !== undefined, 10_000),
      `the anywhere/1h grant never reached McpUiState: ${JSON.stringify(
        (await mcpState(page))?.policy?.grants,
      )}`,
    );
    assert(
      await until(
        () =>
          activityRows().some(
            (r) =>
              r.action === 'close_session' &&
              r.principal?.sessionId === w.sessionId &&
              r.target === t4.sessionId &&
              r.requestId === askA.askId &&
              r.outcome === 'ok' &&
              typeof r.decidedBy === 'string' &&
              r.decidedBy.startsWith('Ask:') &&
              !r.decidedBy.startsWith('allowed by grant'),
          ),
        10_000,
      ),
      `no ask-decided row for T4 carrying ${askA.askId}: ${JSON.stringify(
        activityRows().filter((r) => r.target === t4.sessionId),
      )}`,
    );
    log('anywhere grant answered → T4 closes, its row is the ask’s ✓');

    // (b) A later close under the grant runs with no card, and its row says so.
    await makeActive(w.sessionId);
    const beforeB = await startCall(page, w.sessionId, 'close_session', { session: t5.handle });
    const cardShown = await until(async () => (await card.count()) > 0, 1_500);
    assert(!cardShown, 'a close covered by the anywhere grant showed a card');
    const closedB = await resultAfter(w.sessionId, beforeB, 15_000);
    assert(closedB?.closed === t5.sessionId, `T5 under the grant: ${JSON.stringify(closedB)}`);
    assert(
      await until(async () => !(await stillOpen(t5.sessionId)), 10_000),
      'T5 survived its granted close',
    );
    assert(
      await until(
        () =>
          activityRows().some(
            (r) =>
              r.action === 'close_session' &&
              r.principal?.sessionId === w.sessionId &&
              r.target === t5.sessionId &&
              r.outcome === 'ok' &&
              typeof r.decidedBy === 'string' &&
              r.decidedBy.startsWith('allowed by grant'),
          ),
        10_000,
      ),
      `no "allowed by grant" row for T5: ${JSON.stringify(
        activityRows().filter((r) => r.target === t5.sessionId),
      )}`,
    );
    log('the anywhere grant covers the next close with no card ✓');

    // (c) Revoking the anywhere grant ends its coverage.
    const anyGrant = await anywhereOfW();
    assert(
      anyGrant,
      `no active anywhere grant: ${JSON.stringify((await mcpState(page))?.policy?.grants)}`,
    );
    const revokedAny = await policyRequest(page, { type: 'mcp:revokeGrant', grantId: anyGrant.id });
    assert(revokedAny.ok === true, `mcp:revokeGrant ${anyGrant.id}: ${JSON.stringify(revokedAny)}`);
    assert(
      await until(async () => {
        const revokedGrant = await grantWhere((g) => g.id === anyGrant.id);
        return revokedGrant?.state === 'revoked';
      }, 5_000),
      `anywhere grant ${anyGrant.id} never reached state revoked`,
    );

    // (d) After the revoke, a close asks again; the card is denied and the target stays open.
    await makeActive(w.sessionId);
    const beforeD = await startCall(page, w.sessionId, 'close_session', { session: t6.handle });
    const askD = await nextAsk(page, w.sessionId, seen, 15_000);
    assert(
      await until(async () => (await card.count()) > 0, 5_000),
      `no card after the revoke for ${askD.askId}`,
    );
    await clickAskAnswer(page, 'deny');
    const deniedD = await resultAfter(w.sessionId, beforeD, 10_000);
    assert(errCode(deniedD) === 'denied', `answer after revoke: ${JSON.stringify(deniedD)}`);
    assert(await stillOpen(t6.sessionId), 'a denied close still closed its target');
    log('revoked anywhere grant → the next close asks, deny keeps the target ✓');

    phase('cleanup');
    // The sessions hold their folders as cwd; close them before removing the folders.
    for (const s of await sessions(page)) {
      await page.evaluate((id) => window.agentDeck.post({ type: 'kill', id }), s.id);
    }
    assert(
      await until(async () => (await sessions(page)).length === 0, 15_000),
      'sessions survived kill',
    );
    for (const d of [dirW, dirT1, dirT2, dirT3, dirX, dirT4, dirT5, dirT6]) {
      await removeDir(d, { budgetMs: 10_000 });
    }
  },
  { userDataDir },
);
