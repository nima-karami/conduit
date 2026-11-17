import { mkdirSync, readFileSync, renameSync, rmdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  callTool,
  fakeAgentProfile,
  isolatedHome,
  mcpState,
  openFake,
  resultAfter,
  startCall,
  tapMcp,
  until,
} from './conduit-mcp-helpers.mjs';
import { assert, closeApp, launchApp, runScenario, stopServer } from './harness.mjs';

const userDataDir = fakeAgentProfile('permissions-persistence');
const { env } = isolatedHome(userDataDir);
const work = join(userDataDir, 'work');
mkdirSync(work);
writeFileSync(
  join(userDataDir, 'settings.json'),
  JSON.stringify({ version: 1, settings: { conduitMcp: true, restoreSessions: true } }),
);
const policyPath = join(userDataDir, 'conduit-mcp', 'policy.json');
const backupPath = `${policyPath}.persistence-e2e-backup`;
const savedPolicy = () => JSON.parse(readFileSync(policyPath, 'utf8'));

async function ownerEdits(page, edits, responseType = 'mcp:policyEditResult') {
  return page.evaluate(
    ({ commands, responseType }) =>
      Promise.all(
        commands.map(
          (command) =>
            new Promise((resolve, reject) => {
              window.__permissionEditSeq = (window.__permissionEditSeq ?? 0) + 1;
              const requestId = command.requestId ?? window.__permissionEditSeq;
              const timer = setTimeout(() => {
                off();
                reject(new Error(`No owner reply for ${command.type}`));
              }, 10_000);
              const off = window.agentDeck.subscribe((message) => {
                if (message.type !== responseType || message.requestId !== requestId) return;
                clearTimeout(timer);
                off();
                resolve(responseType === 'mcp:policyEditResult' ? message.result : message);
              });
              window.agentDeck.post({ ...command, requestId });
            }),
        ),
      ),
    { commands: edits, responseType },
  );
}

async function ownerEdit(page, edit, responseType = 'mcp:policyEditResult') {
  return (await ownerEdits(page, [edit], responseType))[0];
}

async function policyWhen(page, predicate, description) {
  let policy;
  const reached = await until(async () => {
    policy = (await mcpState(page))?.policy;
    return policy !== undefined && predicate(policy);
  }, 10_000);
  assert(reached, `${description}: ${JSON.stringify(policy)}`);
  return policy;
}

const assignmentOf = (policy, sessionId) =>
  policy.assignments.find(
    (entry) => entry.point.kind === 'session' && entry.point.sessionId === sessionId,
  )?.assignment;
const resultIs = (result, error) => result?.ok === false && result.error === error;

await runScenario(
  'permissions-persistence',
  async ({ app: firstApp, page: firstPage, log }) => {
    let app = firstApp;
    let page = firstPage;
    const themedApps = [];
    try {
      await tapMcp(page);
      const caller = await openFake(page, work);
      const initial = await policyWhen(
        page,
        (policy) => policy.editToken.length > 0,
        'initial token',
      );
      const worker = initial.profiles.find((profile) => profile.id === 'worker');
      assert(worker, 'Worker profile missing');
      const custom = {
        ...worker,
        id: 'p-persistence-e2e',
        name: 'Persistence copy',
        builtIn: false,
      };
      custom.rules.open_session.decision = 'deny';
      const copied = await ownerEdit(page, {
        type: 'mcp:saveProfile',
        profile: custom,
        expectedToken: initial.editToken,
      });
      assert(copied?.ok === true, `save custom profile: ${JSON.stringify(copied)}`);
      assert(
        savedPolicy().profiles.some((profile) => profile.id === custom.id),
        'profile reply preceded durable primary write',
      );
      let policy = await policyWhen(
        page,
        (value) =>
          value.editToken !== initial.editToken && value.profiles.some((p) => p.id === custom.id),
        'custom profile broadcast',
      );
      const assignment = { profileId: custom.id, exceptions: [], onScreenOnly: false };
      const point = { kind: 'session', sessionId: caller.sessionId };
      const assigned = await ownerEdit(page, {
        type: 'mcp:saveAssignment',
        point,
        assignment,
        expectedToken: policy.editToken,
      });
      assert(assigned?.ok === true, `save assignment: ${JSON.stringify(assigned)}`);
      policy = await policyWhen(
        page,
        (value) => assignmentOf(value, caller.sessionId)?.profileId === custom.id,
        'assignment broadcast',
      );
      assert(
        assignmentOf(savedPolicy(), caller.sessionId)?.profileId === custom.id,
        'assignment reply preceded durable primary write',
      );
      log('custom profile and full assignment persisted before successful IPC replies');

      const invalidBuiltin = await ownerEdit(page, {
        type: 'mcp:saveProfile',
        profile: worker,
        expectedToken: policy.editToken,
      });
      const invalidSession = await ownerEdit(page, {
        type: 'mcp:saveAssignment',
        point: { kind: 'session', sessionId: 'missing-persistence-session' },
        assignment,
        expectedToken: policy.editToken,
      });
      assert(
        resultIs(invalidBuiltin, 'invalid-value'),
        `builtin accepted: ${JSON.stringify(invalidBuiltin)}`,
      );
      assert(
        resultIs(invalidSession, 'invalid-value'),
        `unknown session accepted: ${JSON.stringify(invalidSession)}`,
      );

      const deny = {
        ...assignment,
        exceptions: [
          { tool: 'open_session', scope: { kind: 'anywhere' }, rule: { decision: 'deny' } },
        ],
      };
      const competing = await ownerEdits(page, [
        { type: 'mcp:saveAssignment', point, assignment: deny, expectedToken: policy.editToken },
        {
          type: 'mcp:saveAssignment',
          point,
          assignment: { ...assignment, profileId: 'lead' },
          expectedToken: policy.editToken,
        },
      ]);
      assert(competing[0]?.ok === true, `first edit refused: ${JSON.stringify(competing)}`);
      assert(
        resultIs(competing[1], 'conflict'),
        `stale widening accepted: ${JSON.stringify(competing)}`,
      );
      policy = await policyWhen(
        page,
        (value) => assignmentOf(value, caller.sessionId)?.exceptions[0]?.rule.decision === 'deny',
        'winning deny broadcast',
      );
      assert(
        assignmentOf(savedPolicy(), caller.sessionId)?.exceptions[0]?.rule.decision === 'deny',
        'stale edit replaced persisted deny',
      );
      log('invalid edits refused; same-token competing edit preserves the first denial');

      const beforeFailure = structuredClone(policy);
      const failedDraft = { ...custom, name: 'Explicit retry copy' };
      const saveDraft = {
        type: 'mcp:saveProfile',
        profile: failedDraft,
        expectedToken: policy.editToken,
      };
      const savedBytes = readFileSync(policyPath, 'utf8');
      renameSync(policyPath, backupPath);
      let obstructed = false;
      try {
        mkdirSync(policyPath);
        obstructed = true;
        const failed = await ownerEdit(page, saveDraft);
        assert(resultIs(failed, 'save-failed'), `write failure hidden: ${JSON.stringify(failed)}`);
        const failurePolicy = await policyWhen(
          page,
          (value) => value.saveError !== null,
          'save failure broadcast',
        );
        assert(
          failurePolicy.editToken === beforeFailure.editToken,
          'failed draft changed editor token',
        );
        assert(
          JSON.stringify(failurePolicy.profiles) === JSON.stringify(beforeFailure.profiles) &&
            JSON.stringify(failurePolicy.assignments) === JSON.stringify(beforeFailure.assignments),
          'failed primary write published the human draft',
        );
        const beforeSessions = await page.evaluate(() =>
          window.__sessions.map((session) => session.id),
        );
        const refused = await callTool(page, caller.sessionId, 'open_session', {
          agent: 'e2e-fake-mcp',
          path: work,
          focus: false,
        });
        assert(refused?.error, `denied action executed: ${JSON.stringify(refused)}`);
        assert(
          JSON.stringify(
            await page.evaluate(() => window.__sessions.map((session) => session.id)),
          ) === JSON.stringify(beforeSessions),
          'failed edit created a session',
        );
        assert(
          JSON.stringify((await mcpState(page)).policy.grants) ===
            JSON.stringify(beforeFailure.grants),
          'failed edit or denied action created a grant',
        );
      } finally {
        if (obstructed) rmdirSync(policyPath);
        renameSync(backupPath, policyPath);
      }
      assert(
        readFileSync(policyPath, 'utf8') === savedBytes,
        'obstructed primary was not restored exactly',
      );
      const retriedCurrent = await ownerEdit(page, { type: 'mcp:policyRetry' });
      assert(retriedCurrent?.ok === true, `retry current rules: ${JSON.stringify(retriedCurrent)}`);
      assert(
        savedPolicy().profiles.find((profile) => profile.id === custom.id)?.name === custom.name,
        'generic retry resurrected the failed draft',
      );
      const explicitRetry = await ownerEdit(page, saveDraft);
      assert(explicitRetry?.ok === true, `explicit draft retry: ${JSON.stringify(explicitRetry)}`);
      policy = await policyWhen(
        page,
        (value) =>
          value.profiles.find((profile) => profile.id === custom.id)?.name === failedDraft.name,
        'explicit retry broadcast',
      );
      assert(policy.saveError === null, 'successful retry left save error');
      assert(
        assignmentOf(savedPolicy(), caller.sessionId)?.exceptions[0]?.rule.decision === 'deny',
        'retry lost committed denial',
      );
      log(
        'real primary write failure stayed visible without publishing a draft, grant or action; explicit retry persisted',
      );

      await page.evaluate(() => {
        window.__persistenceAsks = [];
        window.__persistenceClosed = [];
        window.agentDeck.subscribe((message) => {
          if (message.type === 'mcp:ask') window.__persistenceAsks.push(message);
          if (message.type === 'mcp:askClosed') window.__persistenceClosed.push(message.askId);
        });
      });
      const grantCaller = await openFake(page, work);
      const opening = await startCall(page, grantCaller.sessionId, 'open_session', {
        agent: 'e2e-fake-mcp',
        path: work,
        focus: false,
      });
      let ask;
      assert(
        await until(async () => {
          ask = await page.evaluate(
            (id) => window.__persistenceAsks.find((entry) => entry.callerSessionId === id),
            grantCaller.sessionId,
          );
          return ask !== undefined;
        }, 10_000),
        'no real open_session permission ask',
      );
      const allowed = await ownerEdit(
        page,
        {
          type: 'mcp:permissionAnswer',
          requestId: ask.askId,
          answer: { outcome: 'allowed', grant: { who: 'session', on: 'anywhere', for: '1h' } },
        },
        'mcp:permissionResult',
      );
      assert(allowed.ok === true, `grant answer failed: ${JSON.stringify(allowed)}`);
      const opened = await resultAfter(grantCaller.sessionId, opening, 15_000);
      assert(opened?.session_id, `granted action did not open session: ${JSON.stringify(opened)}`);
      const grantPolicy = await policyWhen(
        page,
        (value) =>
          value.grants.some((grant) => grant.requestId === ask.askId && grant.state === 'active'),
        'new durable permission grant',
      );
      const grant = grantPolicy.grants.find((entry) => entry.requestId === ask.askId);
      const grantsPath = join(userDataDir, 'conduit-mcp', 'grants.json');
      const grantsBackup = `${grantsPath}.hardening-e2e-backup`;
      const grantsBytes = readFileSync(grantsPath, 'utf8');
      renameSync(grantsPath, grantsBackup);
      let grantObstructed = false;
      try {
        mkdirSync(grantsPath);
        grantObstructed = true;
        await page.evaluate(() => {
          window.__permissionFocus = document.activeElement;
        });
        const revoked = await ownerEdit(
          page,
          { type: 'mcp:revokeGrant', grantId: grant.id },
          'mcp:policyResult',
        );
        assert(
          resultIs(revoked, 'save-failed') && revoked.applied === 'tightening',
          `failed revoke response: ${JSON.stringify(revoked)}`,
        );
        await policyWhen(
          page,
          (value) =>
            value.grants.some((entry) => entry.id === grant.id && entry.state === 'revoked') &&
            value.saveError !== null,
          'unsaved revoke remains active',
        );
        const notice = page.locator('.permission-store-notice');
        await notice.waitFor({ state: 'visible' });
        assert(
          await page.evaluate(() => document.activeElement === window.__permissionFocus),
          'outage notice stole focus',
        );
        assert(
          (await notice.textContent()).includes('active here'),
          'outage does not explain active restriction',
        );
        const retry = notice.getByRole('button', { name: 'Retry saving current rules' });
        assert(await retry.isEnabled(), 'manual retry inaccessible');
        await retry.click();
        assert(
          await until(
            async () =>
              (await notice.textContent()).includes('Permissions could not be saved (save-failed)'),
            5_000,
          ),
          'blocked manual retry hid the save failure',
        );
        const beforeSessions = await page.evaluate(() =>
          window.__sessions.map((session) => session.id),
        );
        const blockedCall = await startCall(page, grantCaller.sessionId, 'open_session', {
          agent: 'e2e-fake-mcp',
          path: work,
          focus: false,
        });
        let next;
        assert(
          await until(async () => {
            next = await page.evaluate(
              ({ id, seen }) =>
                window.__persistenceAsks.find(
                  (entry) => entry.callerSessionId === id && entry.askId !== seen,
                ),
              { id: grantCaller.sessionId, seen: ask.askId },
            );
            return next !== undefined;
          }, 10_000),
          'revoked grant silently authorized the next action',
        );
        const denied = await ownerEdit(
          page,
          { type: 'mcp:permissionAnswer', requestId: next.askId, answer: { outcome: 'denied' } },
          'mcp:permissionResult',
        );
        assert(denied.ok === true, `deny after revoke failed: ${JSON.stringify(denied)}`);
        assert(
          (await resultAfter(grantCaller.sessionId, blockedCall, 10_000))?.error,
          'revoked action executed',
        );
        assert(
          JSON.stringify(
            await page.evaluate(() => window.__sessions.map((session) => session.id)),
          ) === JSON.stringify(beforeSessions),
          'revoked grant created a session',
        );
        assert(
          (await mcpState(page)).policy.grants.filter((entry) => entry.state === 'active')
            .length === 0,
          'refused action created live authority',
        );
        mkdirSync(join('.autoloop', 'evidence'), { recursive: true });
        for (const theme of ['aero-dark', 'aero', 'neon']) {
          if (theme !== 'aero-dark') {
            await page.evaluate(
              (theme) =>
                new Promise((resolve) => {
                  const off = window.agentDeck.subscribe((message) => {
                    if (message.type !== 'state') return;
                    off();
                    window.agentDeck.post({
                      type: 'updateSettings',
                      settings: { ...message.settings, theme },
                    });
                    resolve();
                  });
                  window.agentDeck.post({ type: 'ready' });
                }),
              theme,
            );
            await page.waitForFunction(
              (theme) => document.documentElement.dataset.theme === theme,
              theme,
            );
            // A fresh hidden window avoids stale compositor layers after a CSS-variable theme switch.
            await closeApp(app, page);
            const nextApp = await launchApp({ userDataDir, env, openFolder: false });
            themedApps.push(nextApp);
            app = nextApp.app;
            page = nextApp.page;
            await tapMcp(page);
          }
          await page.locator('.permission-store-notice').waitFor({ state: 'visible' });
          assert(
            await page.evaluate(
              (expected) => document.documentElement.dataset.theme === expected,
              theme,
            ),
            `wrong screenshot theme ${theme}`,
          );
          for (const width of [1320, 1024]) {
            await app.evaluate(
              (electron, width) =>
                electron.BrowserWindow.getAllWindows()[0].setContentSize(width, 820),
              width,
            );
            await page.waitForFunction((width) => window.innerWidth === width, width);
            const button = page
              .locator('.permission-store-notice')
              .getByRole('button', { name: 'Retry saving current rules' });
            assert(await button.isVisible(), `retry hidden at ${theme}/${width}`);
            assert(
              await page
                .locator('.permission-store-notice')
                .evaluate((element) => element.scrollWidth <= element.clientWidth),
              `notice overflows ${theme}/${width}`,
            );
            await page.screenshot({
              path: join('.autoloop', 'evidence', `hardening-${theme}-${width}.png`),
            });
          }
        }
      } finally {
        if (grantObstructed) rmdirSync(grantsPath);
        renameSync(grantsBackup, grantsPath);
      }
      assert(
        readFileSync(grantsPath, 'utf8') === grantsBytes,
        'grant file not restored exactly before recovery',
      );
      policy = await policyWhen(
        page,
        (value) => value.grants.some((entry) => entry.id === grant.id && entry.state === 'revoked'),
        'revocation retained before recovery',
      );
      const recoveryMechanism = policy.saveError === null ? 'bounded-auto-retry' : 'manual-retry';
      writeFileSync(
        join('.autoloop', 'evidence', 'hardening-recovery.json'),
        JSON.stringify({ recoveryMechanism, profile: userDataDir, grantId: grant.id }),
      );
      if (policy.saveError === null)
        log('bounded conservative retry recovered immediately after storage restoration');
      else {
        await page
          .locator('.permission-store-notice')
          .getByRole('button', { name: 'Retry saving current rules' })
          .click();
        await policyWhen(
          page,
          (value) => value.saveError === null,
          'manual conservative retry recovery',
        );
        log('explicit Retry recovered the conservative revocation after storage restoration');
      }
      // A blocked manual Retry has a component-local error too; a successful Retry must clear it.
      if (await page.locator('.permission-store-notice').count()) {
        await page
          .locator('.permission-store-notice')
          .getByRole('button', { name: 'Retry saving current rules' })
          .click();
      }
      assert(
        await until(
          async () => (await page.locator('.permission-store-notice').count()) === 0,
          5_000,
        ),
        'outage notice remained after successful recovery',
      );
      assert(
        JSON.parse(readFileSync(grantsPath, 'utf8')).grants.find((entry) => entry.id === grant.id)
          ?.state === 'revoked',
        'recovered storage retained active revoked grant',
      );
      log(
        'grant revocation stayed restrictive during write outage; visible notice checked in three themes at two widths',
      );
      policy = (await mcpState(page)).policy;

      await page.evaluate(() => {
        window.__persistenceAsks = [];
        window.__persistenceClosed = [];
        window.agentDeck.subscribe((message) => {
          if (message.type === 'mcp:ask') window.__persistenceAsks.push(message);
          if (message.type === 'mcp:askClosed') window.__persistenceClosed.push(message.askId);
        });
      });
      const targetA = await openFake(page, work);
      const targetB = await openFake(page, work);
      const consumeCaller = await openFake(page, work);
      const consumePoint = { kind: 'session', sessionId: consumeCaller.sessionId };
      const baseAsk = {
        profileId: 'worker',
        onScreenOnly: false,
        exceptions: [
          {
            tool: 'close_session',
            scope: { kind: 'anywhere' },
            rule: { decision: 'ask', when: 'always', reach: 'any' },
          },
        ],
      };
      const denyA = {
        ...baseAsk,
        exceptions: [
          ...baseAsk.exceptions,
          {
            tool: 'close_session',
            scope: { kind: 'session', sessionId: targetA.sessionId },
            rule: { decision: 'deny' },
          },
        ],
      };
      const setConsumeAssignment = async (assignment) => {
        const before = await policyWhen(
          page,
          (value) => value.editToken.length > 0,
          'consume setup token',
        );
        const result = await ownerEdit(page, {
          type: 'mcp:saveAssignment',
          point: consumePoint,
          assignment,
          expectedToken: before.editToken,
        });
        assert(result.ok === true, `consume setup assignment refused: ${JSON.stringify(result)}`);
        return policyWhen(
          page,
          (value) => value.editToken !== before.editToken,
          'consume assignment broadcast',
        );
      };
      await setConsumeAssignment(denyA);
      const priorDenied = await callTool(page, consumeCaller.sessionId, 'close_session', {
        session: targetA.handle,
      });
      assert(
        priorDenied?.error?.code === 'tool_disabled',
        `missing prior explicit deny: ${JSON.stringify(priorDenied)}`,
      );
      const queried = await ownerEdit(
        page,
        {
          type: 'mcp:activity:get',
          query: { sessionId: consumeCaller.sessionId, action: 'close_session', decision: 'deny' },
        },
        'mcp:activity',
      );
      assert(
        queried.page.error === null,
        `denial Activity query failed: ${JSON.stringify(queried.page)}`,
      );
      const deniedRow = queried.page.rows.find((row) => row.outcome === 'denied');
      assert(deniedRow, 'prior explicit-deny Activity row missing');
      await setConsumeAssignment(baseAsk);
      const closeBefore = await startCall(page, consumeCaller.sessionId, 'close_session', {
        sessions: [targetA.handle, targetB.handle],
      });
      let consumeAsk;
      assert(
        await until(async () => {
          consumeAsk = await page.evaluate(
            (id) => window.__persistenceAsks.find((entry) => entry.callerSessionId === id),
            consumeCaller.sessionId,
          );
          return consumeAsk !== undefined;
        }, 10_000),
        'multi-target close did not ask',
      );
      const beforeOverrideIds = savedPolicy().overrides.map((entry) => entry.id);
      const once = await ownerEdit(
        page,
        { type: 'mcp:allowOnce', activityId: deniedRow.id },
        'mcp:policyResult',
      );
      assert(once.ok === true, `prior deny override refused: ${JSON.stringify(once)}`);
      const override = savedPolicy().overrides.find(
        (entry) => !beforeOverrideIds.includes(entry.id),
      );
      assert(
        override?.target.sessionId === targetA.sessionId,
        'one-use override missing or wrong target',
      );
      await setConsumeAssignment(denyA);
      assert(
        await until(
          () =>
            page.evaluate(
              ({ callerId, askId }) =>
                window.__mcp.awaitingApproval.includes(callerId) &&
                !window.__persistenceClosed.includes(askId) &&
                window.__persistenceAsks.filter((entry) => entry.callerSessionId === callerId)
                  .length === 1 &&
                window.__persistenceAsks.some((entry) => entry.askId === askId),
              { callerId: consumeCaller.sessionId, askId: consumeAsk.askId },
            ),
          5_000,
        ),
        'scoped deny withdrew the pending overridden ask',
      );
      const beforeConsumeGrants = (await mcpState(page)).policy.grants.map((entry) => entry.id);
      const beforeConsumeGrantsBytes = readFileSync(grantsPath, 'utf8');
      const consumePolicyBytes = readFileSync(policyPath, 'utf8');
      renameSync(policyPath, backupPath);
      let consumeObstructed = false;
      let consumeReceipt;
      let consumeResult;
      try {
        mkdirSync(policyPath);
        consumeObstructed = true;
        consumeReceipt = await ownerEdit(
          page,
          {
            type: 'mcp:permissionAnswer',
            requestId: consumeAsk.askId,
            answer: { outcome: 'allowed', grant: { who: 'session', on: 'anywhere', for: '1h' } },
          },
          'mcp:permissionResult',
        );
        assert(
          consumeReceipt.ok === false && consumeReceipt.message?.includes('save-failed'),
          `answered consume did not refuse with persistence error: ${JSON.stringify(consumeReceipt)}`,
        );
        consumeResult = await resultAfter(consumeCaller.sessionId, closeBefore, 10_000);
        assert(
          consumeResult?.error?.code === 'policy_unavailable' &&
            consumeResult.error.message.includes('save-failed'),
          `caller consume failure: ${JSON.stringify(consumeResult)}`,
        );
        const after = await policyWhen(
          page,
          (value) => value.saveError !== null,
          'consume failure snapshot',
        );
        assert(
          JSON.stringify(after.grants.map((entry) => entry.id)) ===
            JSON.stringify(beforeConsumeGrants),
          'refused answer left a new or partial grant',
        );
        assert(
          readFileSync(grantsPath, 'utf8') === beforeConsumeGrantsBytes,
          'refused answer wrote new grant authority',
        );
        const targetsPresent = await page.evaluate(
          (ids) => ids.every((id) => window.__sessions.some((session) => session.id === id)),
          [targetA.sessionId, targetB.sessionId],
        );
        assert(targetsPresent, 'failed consume closed a target or partially executed multi-close');
      } finally {
        if (consumeObstructed) rmdirSync(policyPath);
        renameSync(backupPath, policyPath);
      }
      assert(
        readFileSync(policyPath, 'utf8') === consumePolicyBytes,
        'consume obstruction was not restored exactly',
      );
      const consumeRecovery =
        (await mcpState(page)).policy.saveError === null ? 'bounded-auto-retry' : 'manual-retry';
      if (consumeRecovery === 'manual-retry') {
        const retried = await ownerEdit(page, { type: 'mcp:policyRetry' });
        assert(retried.ok === true, `consume retry failed: ${JSON.stringify(retried)}`);
      }
      await policyWhen(page, (value) => value.saveError === null, 'consumed override recovery');
      assert(
        !savedPolicy().overrides.some((entry) => entry.id === override.id),
        'failed answered consume was not conservatively persisted',
      );
      assert(
        JSON.stringify((await mcpState(page)).policy.grants.map((entry) => entry.id)) ===
          JSON.stringify(beforeConsumeGrants),
        'consume recovery resurrected failed-answer authority',
      );
      log(
        'real answered one-use consume write failure refused receipt and caller; zero grants and both targets intact',
      );

      const anchor = await openFake(page, work);
      const anchorBefore = await startCall(page, anchor.sessionId, 'open_session', {
        agent: 'e2e-fake-mcp',
        path: work,
        focus: false,
      });
      let anchorAsk;
      assert(
        await until(async () => {
          anchorAsk = await page.evaluate(
            (id) => window.__persistenceAsks.find((entry) => entry.callerSessionId === id),
            anchor.sessionId,
          );
          return anchorAsk !== undefined;
        }, 10_000),
        'anchor session grant did not ask',
      );
      const anchorAnswer = await ownerEdit(
        page,
        {
          type: 'mcp:permissionAnswer',
          requestId: anchorAsk.askId,
          answer: {
            outcome: 'allowed',
            grant: { who: 'session', on: 'anywhere', for: 'session-end' },
          },
        },
        'mcp:permissionResult',
      );
      assert(
        anchorAnswer.ok === true,
        `anchor grant answer failed: ${JSON.stringify(anchorAnswer)}`,
      );
      assert(
        (await resultAfter(anchor.sessionId, anchorBefore, 15_000))?.session_id,
        'anchor granted action did not execute',
      );
      const anchoredPolicy = await policyWhen(
        page,
        (value) =>
          value.grants.some(
            (entry) => entry.requestId === anchorAsk.askId && entry.state === 'active',
          ),
        'anchored grant creation',
      );
      const anchoredGrant = anchoredPolicy.grants.find(
        (entry) => entry.requestId === anchorAsk.askId,
      );
      assert(
        anchoredGrant.anchorSessionId === anchor.sessionId && anchoredGrant.for === 'session-end',
        'grant lacks actual session-end anchor',
      );
      const anchorGrantBytes = readFileSync(grantsPath, 'utf8');
      renameSync(grantsPath, grantsBackup);
      let anchorObstructed = false;
      try {
        mkdirSync(grantsPath);
        anchorObstructed = true;
        await page.evaluate((id) => window.agentDeck.post({ type: 'kill', id }), anchor.sessionId);
        assert(
          await until(
            async () =>
              !(await page.evaluate(
                (id) => window.__sessions.some((session) => session.id === id),
                anchor.sessionId,
              )),
            15_000,
          ),
          'owner removal did not delete anchor',
        );
        await policyWhen(
          page,
          (value) =>
            value.saveError !== null &&
            value.grants.some(
              (entry) => entry.id === anchoredGrant.id && entry.state === 'expired',
            ),
          'failed anchor cleanup remains expired in memory',
        );
      } finally {
        if (anchorObstructed) rmdirSync(grantsPath);
        renameSync(grantsBackup, grantsPath);
      }
      assert(
        readFileSync(grantsPath, 'utf8') === anchorGrantBytes,
        'anchor cleanup obstruction not restored exactly',
      );
      const anchorRecovery =
        (await mcpState(page)).policy.saveError === null ? 'bounded-auto-retry' : 'manual-retry';
      if (anchorRecovery === 'manual-retry') {
        const retried = await ownerEdit(page, { type: 'mcp:policyRetry' });
        assert(retried.ok === true, `anchor cleanup retry failed: ${JSON.stringify(retried)}`);
      }
      await policyWhen(
        page,
        (value) => value.saveError === null,
        'anchor cleanup durable recovery',
      );
      assert(
        JSON.parse(readFileSync(grantsPath, 'utf8')).grants.find(
          (entry) => entry.id === anchoredGrant.id,
        )?.state === 'expired',
        'anchor cleanup recovered an active grant',
      );
      writeFileSync(
        join('.autoloop', 'evidence', 'hardening-review-runtime-cases.json'),
        JSON.stringify({
          profile: userDataDir,
          consumeRecovery,
          anchorRecovery,
          consumeReceipt,
          consumeResult,
          overrideId: override.id,
          anchorId: anchor.sessionId,
          anchoredGrantId: anchoredGrant.id,
        }),
      );
      log(
        'real anchor removal during grant-store failure expired memory and recovery durably kept expiry',
      );
      policy = (await mcpState(page)).policy;

      const oldToken = policy.editToken;
      // Closing the window alone keeps the policy owner alive; stop its server before testing reload.
      await closeApp(app, page);
      await stopServer(app);
      const second = await launchApp({ userDataDir, env, openFolder: false });
      try {
        await tapMcp(second.page);
        const restarted = await policyWhen(
          second.page,
          (value) => value.editToken.length > 0,
          'restarted owner snapshot',
        );
        assert(restarted.editToken !== oldToken, 'relaunch adopted the old policy owner token');
        assert(
          !restarted.grants.some(
            (entry) => entry.id === anchoredGrant.id && entry.state === 'active',
          ),
          'cold restart resurrected failed anchor-cleanup grant',
        );
        assert(
          !(await second.page.evaluate(
            (id) => window.__sessions.some((session) => session.id === id),
            anchor.sessionId,
          )),
          'cold restart restored deleted anchor',
        );
        assert(
          !savedPolicy().overrides.some((entry) => entry.id === override.id),
          'cold restart restored failed-answer override',
        );
        assert(
          !restarted.grants.some((entry) => entry.id === grant.id && entry.state === 'active'),
          'cold restart resurrected revoked grant',
        );
        assert(
          restarted.profiles.find((profile) => profile.id === custom.id)?.name ===
            failedDraft.name &&
            assignmentOf(restarted, caller.sessionId)?.exceptions[0]?.rule.decision === 'deny',
          'cold restart lost committed profile or assignment',
        );
        const stale = await ownerEdit(second.page, {
          type: 'mcp:saveProfile',
          profile: { ...failedDraft, name: 'Old lifetime overwrite' },
          expectedToken: oldToken,
        });
        assert(resultIs(stale, 'conflict'), `old lifetime edit accepted: ${JSON.stringify(stale)}`);
        assert(
          savedPolicy().profiles.find((profile) => profile.id === custom.id)?.name ===
            failedDraft.name,
          'old lifetime request changed disk',
        );
        log('cold owner restart preserved committed data and refused the prior lifetime token');
      } finally {
        await second.cleanup();
      }
    } finally {
      for (const themed of themedApps) await themed.cleanup();
    }
  },
  { userDataDir, env },
);
