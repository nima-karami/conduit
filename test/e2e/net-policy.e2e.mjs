import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmdirSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { c2Auth } from './c2-auth.mjs';
import { tapMcp, until } from './conduit-mcp-helpers.mjs';
import { assert, finishScenario, launchApp, makeLog, phase, REPO } from './harness.mjs';
import {
  callTool,
  ECHO_AGENT,
  linkView,
  networkState,
  startAgent,
  startServer,
} from './net-helpers.mjs';
import { assignProfileCas } from './permissions-policy-helpers.mjs';

// Remote rules over one ssh link, on fake-ssh (CON-46 L5; plan
// docs/plans/2026-11-16-remote-ssh-rules.plan.md, slice L5 steps 1-4):
//   1. A sets B's default point to observer; A applies it, B's rev is +1 and B's default is observer.
//   2. The link is down: A's edit to worker waits as a draft; the link comes back; A pushes it.
//   3. The link is down: A's edit to lead is a draft; B changes its own default; the link comes back:
//      A shows conflict and B keeps its copy; A re-applies on top and B has lead.
//   4. A peer grant made on B shows on A, and A's revoke removes it on B.
// B's rules are read from its own policy.json (rev, default assignment); B's grants from its C2
// state. Links go down and up with disconnect_machine / connect_machine, as net-requests does.

const log = makeLog('net-policy');
const WAIT_MS = 30_000;
const FAKE_SSH = join(REPO, 'test', 'e2e', 'fixtures', 'fake-ssh.cjs');
const ENV_KEYS = ['CONDUIT_SSH_PATH', 'CONDUIT_E2E_SSH_ARGS_PREFIX'];

async function eventually(what, check) {
  assert(await until(check, WAIT_MS), `timed out waiting for: ${what}`);
}

/** The mcp UI state of one server, as its C2 snapshot shows it. */
async function mcpOf(server) {
  const snapshot = await server.c2.call('events.subscribe');
  return snapshot.mcp ?? {};
}

/** This machine's row in A's policy.machines (its mirror, status, and grants), or null. */
async function machineRow(server, machineId) {
  const mcp = await mcpOf(server);
  return mcp.policy?.machines?.find((m) => m.machineId === machineId) ?? null;
}

/** B's own policy.json: its rev and assignments. */
function policyFileOf(server) {
  const file = join(server.userData, 'conduit-mcp', 'policy.json');
  assert(existsSync(file), `no policy.json on ${server.label}`);
  return JSON.parse(readFileSync(file, 'utf8'));
}

/** The profile on B's default point, or null when it has none. */
function defaultProfileOf(server) {
  const entry = policyFileOf(server).assignments.find((a) => a.point.kind === 'default');
  return entry?.assignment.profileId ?? null;
}

/** Sends one renderer message to a server's MCP host and returns the reply envelope. */
function fromRenderer(server, message) {
  return server.c2.call('mcp.fromRenderer', { windowId: 1, message });
}

/** Gives one agent session a policy profile through CON-24's assignment message, as the renderer sends it. */
async function assignProfile(server, sessionId, profileId) {
  const r = await assignProfileCas(server.c2, { kind: 'session', sessionId }, profileId, {
    claimSessions: true,
  });
  assert(
    r.reply?.result?.ok === true,
    `assign ${profileId} on ${server.label}: ${JSON.stringify(r)}`,
  );
}

/** Edits the default point's profile on a server; `machine` makes it an edit of that remote machine. */
async function setDefault(server, profileId, machine) {
  const r = await assignProfileCas(server.c2, { kind: 'default' }, profileId, { machine });
  assert(
    r.reply?.result?.ok === true,
    `assign default ${profileId} on ${server.label}: ${JSON.stringify(r)}`,
  );
}

/** Answers a request through the renderer message path, as a window does; resolves its result. */
async function answer(server, requestId, body) {
  const r = await fromRenderer(server, { type: 'mcp:requestAnswer', requestId, answer: body });
  assert(
    r.reply?.result !== undefined,
    `mcp:requestAnswer on ${server.label}: ${JSON.stringify(r)}`,
  );
  return r.reply.result;
}

/** The open permission ask from a machine, as A shows it, or null. */
async function permissionRow(server, machineId) {
  const mcp = await mcpOf(server);
  const rows = mcp.requests?.open ?? [];
  return rows.find((r) => r.machine === machineId && r.blocked === 'permission') ?? null;
}

/** Types a tool call into an agent without waiting for its answer. */
function typeCall(server, agent, tool, args) {
  server.c2.notify('term.input', {
    sessionId: agent.sessionId,
    generation: agent.generation,
    data: `call ${tool} ${JSON.stringify(args)}\r`,
  });
}

async function run() {
  const sshDir = mkdtempSync(join(tmpdir(), 'policy-ssh-'));
  const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  let pair;
  let launched;
  try {
    // Both servers inherit this; only A dials, so B never reads the stand-in settings.
    process.env.CONDUIT_SSH_PATH = process.execPath;
    process.env.CONDUIT_E2E_SSH_ARGS_PREFIX = JSON.stringify([FAKE_SSH]);
    pair = {
      a: null,
      b: null,
      stopAll: async () => {
        await Promise.all([pair.a?.stop(), pair.b?.stop()]);
      },
    };
    pair.a = await startServer('a', { electronProfile: true });
    pair.b = await startServer('b');
    const { a, b } = pair;
    await Promise.all(
      [a, b].map((server) =>
        server.c2.call('serverSettings.patch', {
          patch: {
            networkBindHost: '127.0.0.1',
            networkPort: 0,
            networkSelfName: `net-${server.label}`,
          },
        }),
      ),
    );

    phase('0. A adds B over fake-ssh; the link is up and A has its Lead agent');
    const added = await a.c2.call('link.sshAdd', {
      ssh: {
        target: 'fake',
        node: process.execPath,
        mainJs: join(REPO, 'out', 'server', 'main.js'),
        userData: b.userData,
      },
    });
    const bId = (await networkState(b)).machineId;
    const aId = (await networkState(a)).machineId;
    assert(added?.ok === true && added.machineId === bId, `link.sshAdd: ${JSON.stringify(added)}`);
    await eventually('A up to B over ssh', async () => {
      const view = await linkView(a.c2, bId);
      return view?.state === 'up' && view.transport === 'ssh';
    });
    const aa = await startAgent(a);
    await assignProfile(a, aa.sessionId, 'lead');

    phase('1. A sets B default to observer; A shows it applied; B has rev+1 and observer');
    let row;
    await eventually("A mirrors B's rules as applied", async () => {
      row = await machineRow(a, bId);
      return row?.status === 'applied' && typeof row.rev === 'number';
    });
    const r0 = row.rev;
    await setDefault(a, 'observer', bId);
    await eventually('A shows the edit applied on B at r0+1', async () => {
      row = await machineRow(a, bId);
      return row?.status === 'applied' && row.rev === r0 + 1;
    });
    // B's policy.json write is coalesced, so the disk copy can trail the snapshot A already has.
    await eventually('B stores the push at r0+1', async () => {
      return policyFileOf(b).rev === r0 + 1 && defaultProfileOf(b) === 'observer';
    });

    phase('2. the link is down: A edits to worker and waits; the link returns; A pushes');
    const down1 = await callTool(a, aa, 'disconnect_machine', { machine: bId });
    assert(down1.state === 'down', `disconnect_machine: ${JSON.stringify(down1)}`);
    await eventually('A no longer has B up', async () => {
      const view = await linkView(a.c2, bId);
      return view !== null && view.state !== 'up';
    });
    await setDefault(a, 'worker', bId);
    await eventually('A shows the edit waiting for B', async () => {
      row = await machineRow(a, bId);
      return row?.status === 'waiting';
    });
    assert(defaultProfileOf(b) === 'observer', `B changed while down: ${defaultProfileOf(b)}`);
    const up2 = await callTool(a, aa, 'connect_machine', { machine: 'fake' });
    assert(up2.state === 'up', `connect_machine: ${JSON.stringify(up2)}`);
    await eventually('A pushes the draft; B has worker at r0+2', async () => {
      row = await machineRow(a, bId);
      return row?.status === 'applied' && row.rev === r0 + 2 && defaultProfileOf(b) === 'worker';
    });

    phase(
      "3. B edits its own default while A's edit to lead waits; A shows conflict; A re-applies",
    );
    const down3 = await callTool(a, aa, 'disconnect_machine', { machine: bId });
    assert(down3.state === 'down', `disconnect_machine: ${JSON.stringify(down3)}`);
    await eventually('A no longer has B up again', async () => {
      const view = await linkView(a.c2, bId);
      return view !== null && view.state !== 'up';
    });
    await setDefault(a, 'lead', bId);
    await eventually('A shows the lead edit waiting', async () => {
      row = await machineRow(a, bId);
      return row?.status === 'waiting';
    });
    await setDefault(b, 'observer');
    await eventually("B's own edit lands at r0+3", async () => {
      return policyFileOf(b).rev === r0 + 3 && defaultProfileOf(b) === 'observer';
    });
    const up3 = await callTool(a, aa, 'connect_machine', { machine: 'fake' });
    assert(up3.state === 'up', `connect_machine: ${JSON.stringify(up3)}`);
    await eventually('A shows conflict with B rev r0+3', async () => {
      row = await machineRow(a, bId);
      return row?.status === 'conflict' && row.conflict !== null;
    });
    assert(
      defaultProfileOf(b) === 'observer' && policyFileOf(b).rev === r0 + 3,
      'a conflict must not push: B kept its own copy',
    );
    const reapply = await fromRenderer(a, {
      type: 'mcp:remotePolicy',
      requestId: 8,
      machine: bId,
      expectedToken: row.policy.editToken,
      action: 'reapply',
    });
    assert(
      reapply.reply?.type === 'mcp:policyEditResult' && reapply.reply.result.ok === true,
      `mcp:remotePolicy durable acknowledgement: ${JSON.stringify(reapply)}`,
    );
    await eventually('A re-applies on top; B has lead at r0+4', async () => {
      row = await machineRow(a, bId);
      return (
        row?.status === 'applied' &&
        defaultProfileOf(b) === 'lead' &&
        policyFileOf(b).rev === r0 + 4
      );
    });

    phase('4. a peer grant made on B shows on A; A revokes it and it is gone on B');
    const grantPeer = await assignProfileCas(b.c2, { kind: 'peer', machineId: aId }, 'worker');
    assert(
      grantPeer.reply?.result?.ok === true,
      `peer assignment on B: ${JSON.stringify(grantPeer)}`,
    );
    typeCall(a, aa, 'open_session', {
      machine: bId,
      agent: ECHO_AGENT,
      path: b.work,
      focus: false,
    });
    let ask = null;
    await eventually("A shows B's permission ask", async () => {
      ask = await permissionRow(a, bId);
      return ask !== null;
    });
    const granted = await answer(a, ask.id, {
      outcome: 'allowed',
      grant: { who: 'peer', on: 'anywhere', for: 'until-revoked' },
    });
    assert(granted.ok === true, `the grant answer was refused: ${JSON.stringify(granted)}`);
    let grant = null;
    await eventually("A's mirror of B shows the grant", async () => {
      row = await machineRow(a, bId);
      grant = row?.grants.find((g) => g.tool === 'open_session') ?? null;
      return grant !== null;
    });
    const onB = (await mcpOf(b)).policy?.grants ?? [];
    assert(
      onB.some((g) => g.id === grant.id),
      `B does not hold the grant A shows: ${JSON.stringify(onB)}`,
    );
    const revoked = await fromRenderer(a, {
      type: 'mcp:revokeGrant',
      requestId: 1,
      grantId: grant.id,
      machine: bId,
    });
    assert(revoked.reply?.ok === true, `revoke from A: ${JSON.stringify(revoked)}`);
    await eventually('the grant is gone from A and from B', async () => {
      row = await machineRow(a, bId);
      // B's own list keeps ended grants as history, so "gone" means no longer active there.
      const stillOnB = ((await mcpOf(b)).policy?.grants ?? []).some(
        (g) => g.id === grant.id && g.state === 'active',
      );
      return !row.grants.some((g) => g.id === grant.id) && !stillOnB;
    });

    phase('4b. a custom pending remote profile survives an actual controller restart');
    const restartDown = await callTool(a, aa, 'disconnect_machine', { machine: bId });
    assert(restartDown.state === 'down', `restart disconnect: ${JSON.stringify(restartDown)}`);
    await eventually(
      'B is disabled before controller restart',
      async () => (await linkView(a.c2, bId))?.state !== 'up',
    );
    const restartReceiverPath = join(b.userData, 'conduit-mcp', 'policy.json');
    const restartReceiverBytes = readFileSync(restartReceiverPath);
    const restartReceiverRev = policyFileOf(b).rev;
    const worker = (await machineRow(a, bId)).policy.profiles.find(
      (profile) => profile.id === 'worker',
    );
    assert(worker, 'remote Worker full rules missing');
    const restartProfile = {
      ...structuredClone(worker),
      id: 'p-restart',
      name: 'Restart copy',
      builtIn: false,
    };
    const restartEdit = async (edit, expectedToken) => {
      const currentToken = expectedToken ?? (await machineRow(a, bId)).policy.editToken;
      return fromRenderer(a, {
        type: 'mcp:remoteEdit',
        requestId: 90,
        machine: bId,
        expectedToken: currentToken,
        edit,
      });
    };
    const profileSaved = await restartEdit({ kind: 'profile', profile: restartProfile });
    assert(
      profileSaved.reply?.result?.ok === true,
      `pending custom profile refused: ${JSON.stringify(profileSaved)}`,
    );
    const assignmentSaved = await restartEdit({
      kind: 'assignment',
      point: { kind: 'cli', cli: 'codex' },
      assignment: { profileId: 'p-restart', exceptions: [], onScreenOnly: false },
    });
    assert(
      assignmentSaved.reply?.result?.ok === true,
      `pending CLI assignment refused: ${JSON.stringify(assignmentSaved)}`,
    );
    const restartPath = join(a.userData, 'conduit-mcp', 'remote-policy.json');
    const restartBytes = readFileSync(restartPath);
    const pendingDraft = JSON.parse(restartBytes.toString('utf8')).drafts[bId];
    const hasRestartCopy = (doc) =>
      doc.profiles.some(
        (profile) =>
          profile.id === 'p-restart' &&
          profile.name === 'Restart copy' &&
          JSON.stringify(profile.rules) === JSON.stringify(restartProfile.rules),
      ) &&
      doc.assignments.some(
        (entry) =>
          entry.point.kind === 'cli' &&
          entry.point.cli === 'codex' &&
          entry.assignment.profileId === 'p-restart',
      );
    assert(
      pendingDraft && hasRestartCopy(pendingDraft.doc),
      'custom pending copy not durably saved',
    );
    assert(
      readFileSync(restartReceiverPath).equals(restartReceiverBytes),
      'offline custom edit changed B',
    );
    const oldRestartToken = (await machineRow(a, bId)).policy.editToken;
    const restartHello = () =>
      a.c2.call('hello', {
        appVersion: JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8')).version,
        generation: 1,
        auth: c2Auth(a.userData),
      });
    const oldController = await restartHello();
    await a.restart();
    const newController = await restartHello();
    assert(
      newController.instance === oldController.instance && newController.pid !== oldController.pid,
      'controller restart changed profile identity or reused the old server process',
    );
    const loaded = await machineRow(a, bId);
    assert(
      loaded?.status === 'waiting' &&
        loaded.link !== 'up' &&
        loaded.policy.editToken !== oldRestartToken &&
        hasRestartCopy(loaded.policy),
      `controller did not load pending copy/new token: ${JSON.stringify(loaded)}`,
    );
    assert(
      readFileSync(restartPath).equals(restartBytes) &&
        readFileSync(restartReceiverPath).equals(restartReceiverBytes),
      'restart changed durable intent or B',
    );
    const stale = await restartEdit(
      { kind: 'profile', profile: { ...restartProfile, name: 'Wrong stale copy' } },
      oldRestartToken,
    );
    assert(
      stale.reply?.result?.ok === false && stale.reply.result.error === 'conflict',
      `old controller token was accepted: ${JSON.stringify(stale)}`,
    );
    assert(
      readFileSync(restartPath).equals(restartBytes) &&
        readFileSync(restartReceiverPath).equals(restartReceiverBytes),
      'stale token changed disk or B',
    );
    await eventually('preexisting A agent is adopted and connected', async () => {
      const snapshot = await a.c2.call('events.subscribe');
      const generation = snapshot.sessions.find((session) => session.id === aa.sessionId)?.runtime
        ?.generation;
      if (typeof generation !== 'number' || snapshot.mcp.sessions[aa.sessionId]?.connected !== true)
        return false;
      aa.generation = generation;
      return true;
    });
    const restartUp = await callTool(a, aa, 'connect_machine', { machine: 'fake' });
    assert(restartUp.state === 'up', `restart reconnect: ${JSON.stringify(restartUp)}`);
    await eventually(
      'reloaded custom profile and CLI assignment reach B exactly once',
      async () => {
        const current = await machineRow(a, bId);
        return (
          current?.status === 'applied' &&
          hasRestartCopy(current.policy) &&
          policyFileOf(b).rev === restartReceiverRev + 1 &&
          hasRestartCopy(policyFileOf(b)) &&
          JSON.parse(readFileSync(restartPath, 'utf8')).drafts[bId] === undefined
        );
      },
    );
    log(
      'actual controller restart retained custom profile/CLI assignment; stale token refused; explicit reconnect applied',
    );

    phase('5. hidden Electron adopts the same controller and acknowledges real Settings actions');
    const helloParams = {
      appVersion: JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8')).version,
      generation: 1,
      auth: c2Auth(a.userData),
    };
    const beforeHello = await a.c2.call('hello', helloParams);
    launched = await launchApp({ userDataDir: a.userData, openFolder: false });
    const { page } = launched;
    await tapMcp(page);
    const afterHello = await a.c2.call('hello', helloParams);
    assert(
      beforeHello.pid === afterHello.pid &&
        beforeHello.instance === afterHello.instance &&
        JSON.stringify(beforeHello.supervisor) === JSON.stringify(afterHello.supervisor),
      'Electron attachment replaced the existing controller server',
    );
    const rendererNetwork = await page.evaluate(
      () =>
        new Promise((resolve, reject) => {
          const timer = setTimeout(() => {
            off();
            reject(new Error('No renderer network reply'));
          }, 10_000);
          const off = window.agentDeck.subscribe((message) => {
            if (message.type !== 'network:state') return;
            clearTimeout(timer);
            off();
            resolve(message.state);
          });
          window.agentDeck.post({ type: 'network:get' });
        }),
    );
    assert(rendererNetwork.machineId === aId, 'renderer attached to another machine');
    await eventually('renderer shows the preexisting A session and B policy identity', async () => {
      const current = await machineRow(a, bId);
      return page.evaluate(
        ({ sessionId, handle, machineId, token, rev }) =>
          window.__mcp?.sessions[sessionId]?.handle === handle &&
          window.__mcp.policy.machines.some(
            (machine) =>
              machine.machineId === machineId &&
              machine.rev === rev &&
              machine.policy.editToken === token,
          ),
        {
          sessionId: aa.sessionId,
          handle: (await mcpOf(a)).sessions[aa.sessionId].handle,
          machineId: bId,
          token: current.policy.editToken,
          rev: current.rev,
        },
      );
    });
    const openSettings = () => page.locator('.footbtn[title^="Settings"]').click();
    await openSettings();
    await page.getByRole('button', { name: 'Links', exact: true }).click();
    const linked = await linkView(a.c2, bId);
    const permissions = page.getByRole('region', { name: `${linked.name} permissions` });
    await permissions.waitFor();
    const monitor = permissions.getByRole('button', { name: `monitor for ${linked.name}` });
    await monitor.click();
    await eventually(
      'Links changed the authority on A',
      async () =>
        (await linkView(a.c2, bId))?.capabilities.monitor === !linked.capabilities.monitor,
    );
    await monitor.click();
    await eventually(
      'Links restored the authority on A',
      async () => (await linkView(a.c2, bId))?.capabilities.monitor === linked.capabilities.monitor,
    );
    const linkEvidence = process.env.CONDUIT_PERMISSIONS_EVIDENCE_DIR;
    if (linkEvidence) {
      mkdirSync(linkEvidence, { recursive: true });
      await page.screenshot({ path: join(linkEvidence, '17-link-own.png') });
    }
    await permissions.getByRole('button', { name: `Activity involving ${linked.name}` }).click();
    const activity = page.getByRole('main', { name: 'Permissions Activity' });
    await activity.waitFor();
    const machineFilter = activity.getByPlaceholder('All machines (ID)');
    assert((await machineFilter.inputValue()) === bId, 'Activity opened outside the link scope');
    await page.locator('.footbtn[title^="Settings"]').click();
    await page
      .locator('.settings__navitem')
      .filter({ hasText: /^Links$/ })
      .click();
    const remoteName = (await machineRow(a, bId)).name;
    const links = page.locator('.settings-links');
    await links.getByRole('button', { name: remoteName, exact: true }).click();
    const remoteEditor = links.getByRole('region', {
      name: `${remoteName} permissions`,
      exact: true,
    });
    await remoteEditor.waitFor({ state: 'visible' });
    const evidence = join(REPO, '.autoloop', 'evidence');
    mkdirSync(evidence, { recursive: true });
    const draftPath = join(a.userData, 'conduit-mcp', 'remote-policy.json');
    const backup = `${draftPath}.net-policy-backup`;
    for (const action of ['discard', 'reapply']) {
      phase(`6. actual Settings ${action}: save failure and explicit retry`);
      const down = await callTool(a, aa, 'disconnect_machine', { machine: bId });
      assert(down.state === 'down', `UI conflict disconnect: ${JSON.stringify(down)}`);
      await eventually(
        'link down before UI draft',
        async () => (await linkView(a.c2, bId))?.state !== 'up',
      );
      const priorB = policyFileOf(b);
      const draftProfile = defaultProfileOf(b) === 'lead' ? 'worker' : 'lead';
      const ownProfile = defaultProfileOf(b) === 'observer' ? 'worker' : 'observer';
      const token = (await machineRow(a, bId)).policy.editToken;
      await remoteEditor.getByLabel('Default profile', { exact: true }).selectOption(draftProfile);
      await eventually('Links editor saves the offline draft', async () => {
        const pending = await machineRow(a, bId);
        return (
          pending?.status === 'waiting' &&
          pending.policy.editToken !== token &&
          pending.policy.assignments.find((entry) => entry.point.kind === 'default')?.assignment
            .profileId === draftProfile
        );
      });
      assert(
        defaultProfileOf(b) ===
          priorB.assignments.find((entry) => entry.point.kind === 'default')?.assignment.profileId,
        'offline renderer edit changed B',
      );
      await setDefault(b, ownProfile);
      const receiverBytes = readFileSync(join(b.userData, 'conduit-mcp', 'policy.json'), 'utf8');
      const receiverRev = policyFileOf(b).rev;
      const up = await callTool(a, aa, 'connect_machine', { machine: 'fake' });
      assert(up.state === 'up', `UI conflict reconnect: ${JSON.stringify(up)}`);
      let conflict;
      await eventually('independent real conflict is visible to the renderer', async () => {
        conflict = await machineRow(a, bId);
        return (
          conflict?.status === 'conflict' &&
          page.evaluate(
            (id) =>
              window.__mcp.policy.machines.some(
                (machine) => machine.machineId === id && machine.status === 'conflict',
              ),
            bId,
          )
        );
      });
      const button = remoteEditor.getByRole('button', {
        name: action === 'discard' ? "Use machine's rules" : 'Apply my changes',
        exact: true,
      });
      await button.waitFor({ state: 'visible' });
      await button.scrollIntoViewIfNeeded();
      await page.screenshot({
        path: join(evidence, `remote-editor-runtime-${action}-conflict.png`),
      });
      const bytes = readFileSync(draftPath);
      const beforeDoc = JSON.stringify(conflict.policy.assignments);
      renameSync(draftPath, backup);
      let obstructed = false;
      try {
        mkdirSync(draftPath);
        obstructed = true;
        await button.click();
        const failure = remoteEditor
          .getByRole('alert')
          .filter({ hasText: 'Remote pending rules could not be saved' });
        const actionFailure = remoteEditor
          .getByRole('alert')
          .filter({ hasText: 'The change could not be saved (save-failed).' });
        await failure.waitFor({ state: 'visible' });
        await actionFailure.waitFor({ state: 'visible' });
        await remoteEditor
          .getByRole('button', { name: 'Retry saving', exact: true })
          .waitFor({ state: 'visible' });
        const refused = await machineRow(a, bId);
        assert(
          refused.status === 'conflict' &&
            refused.policy.editToken === conflict.policy.editToken &&
            JSON.stringify(refused.policy.assignments) === beforeDoc,
          `${action} save failure changed draft/token`,
        );
        assert(
          readFileSync(join(b.userData, 'conduit-mcp', 'policy.json'), 'utf8') === receiverBytes,
          `${action} save failure pushed B`,
        );
        await failure.scrollIntoViewIfNeeded();
        await page.screenshot({
          path: join(evidence, `remote-editor-runtime-${action}-error.png`),
        });
        const originalTheme = await page.evaluate(() => document.documentElement.dataset.theme);
        const originalSize = await launched.app.evaluate((electron) =>
          electron.BrowserWindow.getAllWindows()[0].getContentSize(),
        );
        const setTheme = async (theme) => {
          await page.evaluate(
            (theme) =>
              new Promise((resolve, reject) => {
                const timer = setTimeout(() => {
                  off();
                  reject(new Error('No settings state'));
                }, 10_000);
                const off = window.agentDeck.subscribe((message) => {
                  if (message.type !== 'state') return;
                  clearTimeout(timer);
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
        };
        try {
          await launched.app.evaluate((electron) =>
            electron.BrowserWindow.getAllWindows()[0].setContentSize(1024, 820),
          );
          await page.waitForFunction(() => window.innerWidth === 1024);
          for (const theme of ['aero-dark', 'aero']) {
            await setTheme(theme);
            await failure.scrollIntoViewIfNeeded();
            assert(
              (await failure.isVisible()) && (await button.isVisible()),
              `save failure controls hidden at ${theme}/1024`,
            );
            await page.evaluate(
              () =>
                new Promise((resolve) =>
                  requestAnimationFrame(() => requestAnimationFrame(resolve)),
                ),
            );
            await page.screenshot({
              path: join(evidence, `remote-editor-runtime-${action}-error-${theme}-1024.png`),
            });
          }
        } finally {
          await setTheme(originalTheme);
          await launched.app.evaluate(
            (electron, size) => electron.BrowserWindow.getAllWindows()[0].setContentSize(...size),
            originalSize,
          );
        }
      } finally {
        if (obstructed) rmdirSync(draftPath);
        renameSync(backup, draftPath);
      }
      assert(readFileSync(draftPath).equals(bytes), 'restoring fault changed original draft bytes');
      await remoteEditor.getByRole('button', { name: 'Retry saving', exact: true }).click();
      await eventually(
        'explicit save retry clears the error without resolving conflict',
        async () => {
          const retried = await machineRow(a, bId);
          return (
            retried?.status === 'conflict' &&
            retried.policy.saveError === null &&
            retried.policy.editToken === conflict.policy.editToken &&
            JSON.stringify(retried.policy.assignments) === beforeDoc &&
            readFileSync(join(b.userData, 'conduit-mcp', 'policy.json'), 'utf8') === receiverBytes
          );
        },
      );
      await remoteEditor
        .getByRole('button', { name: 'Retry saving', exact: true })
        .waitFor({ state: 'hidden' });
      await button.click();
      await eventually('explicit UI retry applies the acknowledged choice', async () => {
        const current = await machineRow(a, bId);
        return (
          current?.status === 'applied' &&
          current.policy.editToken !== conflict.policy.editToken &&
          current.policy.assignments.find((entry) => entry.point.kind === 'default')?.assignment
            .profileId === (action === 'discard' ? ownProfile : draftProfile) &&
          defaultProfileOf(b) === (action === 'discard' ? ownProfile : draftProfile) &&
          policyFileOf(b).rev === receiverRev + (action === 'discard' ? 0 : 1) &&
          current.rev === receiverRev + (action === 'discard' ? 0 : 1)
        );
      });
      await remoteEditor
        .getByRole('status')
        .filter({ hasText: /^Rules applied$/ })
        .waitFor({ state: 'visible' });
      assert(
        (await remoteEditor
          .getByRole('alert')
          .filter({ hasText: 'Remote pending rules could not be saved' })
          .count()) === 0 &&
          (await remoteEditor
            .getByRole('alert')
            .filter({ hasText: 'The change could not be saved (save-failed).' })
            .count()) === 0,
        'successful explicit action retained its inline failure',
      );
      await links.getByRole('button', { name: remoteName, exact: true }).scrollIntoViewIfNeeded();
      await page.screenshot({
        path: join(evidence, `remote-editor-runtime-${action}-recovered.png`),
      });
      const savedDrafts = JSON.parse(readFileSync(draftPath, 'utf8')).drafts;
      assert(savedDrafts[bId] === undefined, `${action} left a pending draft after application`);
      log(`actual Electron Settings ${action} fault/retry verified; B ${defaultProfileOf(b)}`);
    }
  } catch (error) {
    if (pair) for (const server of [pair.a, pair.b]) if (server) dumpServerLog(server);
    throw error;
  } finally {
    await launched?.cleanup();
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    await pair?.stopAll();
    rmSync(sshDir, { recursive: true, force: true });
  }
}

function dumpServerLog(server) {
  const file = join(server.userData, 'server.log');
  if (existsSync(file))
    log(`${server.label} server.log tail:\n`, readFileSync(file, 'utf8').slice(-8000));
}

let code = 0;
try {
  await run();
  log('PASS ✓');
} catch (error) {
  code = error?.name === 'AssertionError' ? 1 : 2;
  log('FAIL ✗', error?.stack || error?.message || String(error));
}
await finishScenario(code);
