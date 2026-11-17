import { mkdirSync, readFileSync, renameSync, rmdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  callTool,
  fakeAgentProfile,
  isolatedHome,
  mcpState,
  openFake,
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

async function ownerEdits(page, edits) {
  return page.evaluate(
    (commands) =>
      Promise.all(
        commands.map(
          (command) =>
            new Promise((resolve, reject) => {
              window.__permissionEditSeq = (window.__permissionEditSeq ?? 0) + 1;
              const requestId = window.__permissionEditSeq;
              const timer = setTimeout(() => {
                off();
                reject(new Error(`No owner reply for ${command.type}`));
              }, 10_000);
              const off = window.agentDeck.subscribe((message) => {
                if (message.type !== 'mcp:policyEditResult' || message.requestId !== requestId)
                  return;
                clearTimeout(timer);
                off();
                resolve(message.result);
              });
              window.agentDeck.post({ ...command, requestId });
            }),
        ),
      ),
    edits,
  );
}

async function ownerEdit(page, edit) {
  return (await ownerEdits(page, [edit]))[0];
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
  async ({ app, page, log }) => {
    await tapMcp(page);
    const caller = await openFake(page, work);
    const initial = await policyWhen(
      page,
      (policy) => policy.editToken.length > 0,
      'initial token',
    );
    const worker = initial.profiles.find((profile) => profile.id === 'worker');
    assert(worker, 'Worker profile missing');
    const custom = { ...worker, id: 'p-persistence-e2e', name: 'Persistence copy', builtIn: false };
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
        restarted.profiles.find((profile) => profile.id === custom.id)?.name === failedDraft.name &&
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
  },
  { userDataDir, env },
);
