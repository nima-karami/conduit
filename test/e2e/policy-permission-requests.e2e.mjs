/**
 * policy-permission-requests — an ask is a permission request (plan
 * docs/plans/2026-11-14-policy-permissions-machinery.plan.md, Task 3.2 e2e). Fake sessions stand
 * in for the Worker callers and the close targets; this page is the owner window, so its
 * mcp:permissionAnswer is the card's answer:
 *   - an unanswered close_session ask ends approval_timeout and the target stays open;
 *   - a later identical ask answered with a session/target/1h grant closes the target, and its
 *     Activity row reads "allowed by grant";
 *   - a session-level access off (an anywhere deny exception) refuses; mcp:allowOnce on that
 *     refusal's row lets one close through, and the next target is refused again;
 *   - mcp:revokeGrant marks the grant revoked, and the next close asks again.
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
              r.outcome === 'expired',
          ),
        10_000,
      ),
      'no expired Activity row for the timed-out close',
    );
    await until(async () => (await page.locator('.askcard').count()) === 0, 5_000);
    log('unanswered close_session → approval_timeout, target open ✓');

    phase('later identical ask answered with a grant');
    const secondBefore = await startCall(page, w.sessionId, 'close_session', {
      session: t1.handle,
    });
    const ask2 = await nextAsk(page, w.sessionId, new Set([ask1.askId]), 15_000);
    const answered = await permissionAnswer(page, ask2.askId, {
      outcome: 'allowed',
      grant: { who: 'session', on: 'target', for: '1h' },
    });
    assert(answered.ok === true, `mcp:permissionAnswer: ${JSON.stringify(answered)}`);
    const closed = await resultAfter(w.sessionId, secondBefore, 15_000);
    assert(closed?.closed === t1.sessionId, `retry after the grant: ${JSON.stringify(closed)}`);
    assert(
      await until(async () => !(await stillOpen(t1.sessionId)), 10_000),
      'the granted close never removed its target',
    );
    assert(
      await until(
        () =>
          activityRows().some(
            (r) =>
              r.action === 'close_session' &&
              r.principal?.sessionId === w.sessionId &&
              r.outcome === 'ok' &&
              typeof r.decidedBy === 'string' &&
              r.decidedBy.startsWith('allowed by grant'),
          ),
        10_000,
      ),
      `no "allowed by grant" Activity row: ${JSON.stringify(
        activityRows().filter((r) => r.action === 'close_session'),
      )}`,
    );
    const grantOfW = () =>
      mcpState(page).then((st) =>
        st?.policy?.grants?.find(
          (g) =>
            g.state === 'active' &&
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
    log('later ask answered allowed+grant → close runs, row "allowed by grant" ✓');

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

    phase('revoke a grant; the next close asks again');
    // The step-2 grant's only target (t1) was closed by the retry that created it, so no later
    // close can match it. t4 is a target the grant never covered: the check is that the revoked
    // grant leaves W asking on a fresh close, not that a matching target is re-closed.
    const grant = await grantOfW();
    assert(
      grant,
      `no active grant to revoke: ${JSON.stringify((await mcpState(page))?.policy?.grants)}`,
    );
    const revoked = await policyRequest(page, { type: 'mcp:revokeGrant', grantId: grant.id });
    assert(revoked.ok === true, `mcp:revokeGrant ${grant.id}: ${JSON.stringify(revoked)}`);
    assert(
      await until(async () => {
        const st = await mcpState(page);
        return st?.policy?.grants?.find((g) => g.id === grant.id)?.state === 'revoked';
      }, 5_000),
      `grant ${grant.id} never reached state revoked: ${JSON.stringify(
        (await mcpState(page))?.policy?.grants,
      )}`,
    );

    await makeActive(w.sessionId);
    const afterRevoke = await startCall(page, w.sessionId, 'close_session', {
      session: t4.handle,
    });
    const ask4 = await nextAsk(page, w.sessionId, new Set([ask1.askId, ask2.askId]), 15_000);
    assert(
      await until(async () => (await page.locator('.askcard').count()) > 0, 5_000),
      `no card after revoke for ${ask4.askId}`,
    );
    await clickAskAnswer(page, 'deny');
    const denied4 = await resultAfter(w.sessionId, afterRevoke, 10_000);
    assert(errCode(denied4) === 'denied', `answer after revoke: ${JSON.stringify(denied4)}`);
    assert(await stillOpen(t4.sessionId), 'a denied close still closed its target');
    log('revoked grant → the next close asks again, card shown ✓');

    phase('cleanup');
    // The sessions hold their folders as cwd; close them before removing the folders.
    for (const s of await sessions(page)) {
      await page.evaluate((id) => window.agentDeck.post({ type: 'kill', id }), s.id);
    }
    assert(
      await until(async () => (await sessions(page)).length === 0, 15_000),
      'sessions survived kill',
    );
    for (const d of [dirW, dirT1, dirT2, dirT3, dirX, dirT4]) {
      await removeDir(d, { budgetMs: 10_000 });
    }
  },
  { userDataDir },
);
