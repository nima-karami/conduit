import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { until } from './conduit-mcp-helpers.mjs';
import { assert, finishScenario, makeLog, phase, REPO } from './harness.mjs';
import { networkState, startServer } from './net-helpers.mjs';

const log = makeLog('permissions-native');
const ENV_KEYS = ['CONDUIT_SSH_PATH', 'CONDUIT_E2E_SSH_ARGS_PREFIX'];
const snapshot = (server) => server.c2.call('events.subscribe');
const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));
const policyPath = (server) => join(server.userData, 'conduit-mcp', 'policy.json');
const draftsPath = (server) => join(server.userData, 'conduit-mcp', 'remote-policy.json');
const nativeOf = async (server, id) => (await snapshot(server)).mcp.native?.[id];

async function eventually(message, check) {
  assert(await until(check, 30_000), message);
}

function launchProbe(server, cli, label) {
  const dir = join(server.work, label);
  mkdirSync(dir, { recursive: true });
  const record = join(dir, 'args.json');
  const script = join(dir, 'probe.cjs');
  const command = join(dir, process.platform === 'win32' ? `${cli}.cmd` : cli);
  writeFileSync(
    script,
    `
const { writeFileSync } = require('node:fs');
const args = process.argv.slice(2);
const modeFlag = ${JSON.stringify(cli === 'claude' ? '--permission-mode' : '--sandbox')};
const get = (flag) => { const i = args.indexOf(flag); return i === -1 ? null : args[i + 1]; };
writeFileSync(${JSON.stringify(record)}, JSON.stringify({
  mode: get(modeFlag),
  approval: get('--ask-for-approval'),
  first: args[0] === modeFlag,
  model: get(${JSON.stringify(cli === 'claude' ? '--model' : '-m')}) === 'owned-test-model',
  claudeMcpSuffix: args.includes('--mcp-config') && args.indexOf('--mcp-config') > args.indexOf(modeFlag),
}));
process.stdin.resume();
`,
  );
  if (process.platform === 'win32') {
    writeFileSync(command, `@"${process.execPath}" "${script}" %*\r\n`);
  } else {
    const shQuote = (value) => `'${value.replaceAll("'", "'\"'\"'")}'`;
    writeFileSync(
      command,
      `#!/bin/sh\nexec ${shQuote(process.execPath)} ${shQuote(script)} "$@"\n`,
      {
        mode: 0o700,
      },
    );
  }
  return { command, record };
}

async function owner(server, message) {
  const result = await server.c2.call('mcp.fromRenderer', {
    windowId: 1,
    message: { requestId: 1, ...message },
  });
  return result.reply?.result;
}

async function assign(server, point, profileId, applyNative, nativeConsent) {
  return owner(server, {
    type: 'mcp:saveAssignment',
    point,
    expectedToken: (await snapshot(server)).mcp.policy.editToken,
    assignment: { profileId, applyNative, exceptions: [], onScreenOnly: false },
    nativeConsent,
  });
}

async function create(server, probe, args) {
  const session = await server.c2.call('sessions.create', {
    agentId: 'conduit:command',
    home: server.work,
    command: { command: probe.command, args },
    brief: { kind: 'none' },
    placement: { focus: false },
  });
  return session.sessionId;
}

async function start(server, sessionId) {
  return server.c2.call('sessions.start', { sessionId });
}

async function actualArgs(probe) {
  let facts;
  await eventually('the owned CLI probe did not record the expected argument facts', () => {
    if (!existsSync(probe.record)) return false;
    try {
      facts = readJson(probe.record);
      return true;
    } catch {
      return false;
    }
  });
  return facts;
}

async function launchCases(server) {
  phase('Native launch preserves old defaults and applies explicit modes');
  const workerProbe = launchProbe(server, 'codex', 'worker-probe');
  const workerId = await create(server, workerProbe, []);
  const worker = await start(server, workerId);
  assert(worker.ok && worker.spawned, `Worker probe did not start: ${JSON.stringify(worker)}`);
  assert(
    (await actualArgs(workerProbe)).mode === null,
    'an implicit Worker launch got native flags',
  );

  const offProbe = launchProbe(server, 'claude', 'optout-probe');
  const offId = await create(server, offProbe, []);
  const offEdit = await assign(server, { kind: 'session', sessionId: offId }, 'lead', false, false);
  assert(offEdit?.ok, `Conduit-only Lead assignment failed: ${JSON.stringify(offEdit)}`);
  const optOut = await start(server, offId);
  assert(optOut.ok && optOut.spawned, 'the opt-out probe did not start');
  assert(
    (await actualArgs(offProbe)).mode === null,
    'opt-out accidentally applied native Lead mode',
  );

  const claudeProbe = launchProbe(server, 'claude', 'observer-probe');
  const claudeId = await create(server, claudeProbe, ['--model', 'owned-test-model']);
  const refused = await assign(
    server,
    { kind: 'session', sessionId: claudeId },
    'observer',
    true,
    false,
  );
  assert(
    refused?.error === 'native-review-required',
    'an unreviewed native assignment was accepted',
  );
  const claudeEdit = await assign(
    server,
    { kind: 'session', sessionId: claudeId },
    'observer',
    true,
    true,
  );
  assert(claudeEdit?.ok, `reviewed Observer assignment failed: ${JSON.stringify(claudeEdit)}`);
  const claude = await start(server, claudeId);
  assert(claude.ok && claude.spawned, `Claude probe did not start: ${JSON.stringify(claude)}`);
  const cl = await actualArgs(claudeProbe);
  assert(
    cl.mode === 'plan' && cl.first && cl.model && cl.claudeMcpSuffix,
    `Claude argv order: ${JSON.stringify(cl)}`,
  );

  await server.c2.call('serverSettings.patch', { patch: { conduitMcp: false } });
  assert(
    (await snapshot(server)).settings.conduitMcp === false,
    'messaging setting did not turn off',
  );
  const codexProbe = launchProbe(server, 'codex', 'lead-probe');
  const codexId = await create(server, codexProbe, ['-m', 'owned-test-model']);
  const codexEdit = await assign(
    server,
    { kind: 'session', sessionId: codexId },
    'lead',
    true,
    true,
  );
  assert(codexEdit?.ok, `reviewed Lead assignment failed: ${JSON.stringify(codexEdit)}`);
  const codex = await start(server, codexId);
  assert(codex.ok && codex.spawned, `MCP-off Codex probe did not start: ${JSON.stringify(codex)}`);
  const co = await actualArgs(codexProbe);
  assert(
    co.mode === 'workspace-write' && co.approval === 'on-request' && co.first && co.model,
    `Codex argv order: ${JSON.stringify(co)}`,
  );

  const conflictProbe = launchProbe(server, 'codex', 'conflict-probe');
  const conflictId = await create(server, conflictProbe, ['--sandbox', 'read-only']);
  const conflictEdit = await assign(
    server,
    { kind: 'session', sessionId: conflictId },
    'lead',
    true,
    true,
  );
  assert(conflictEdit?.ok, 'failed to set the conflicting launch up');
  const conflict = await start(server, conflictId);
  assert(
    conflict.ok === false &&
      conflict.refusal?.reason === 'native_permissions' &&
      conflict.refusal.problem === 'conflict',
    `conflicting native flags did not produce a precise refusal: ${JSON.stringify(conflict)}`,
  );
  assert(!existsSync(conflictProbe.record), 'a refused native launch started the owned process');
  assert(
    !(await nativeOf(server, conflictId))?.atLaunch,
    'a refused launch reported current evidence',
  );

  phase('Evidence follows the actual adopted process across controller restarts');
  const state = await snapshot(server);
  const session = state.sessions.find((item) => item.id === codexId);
  assert(
    session && !('nativeLaunch' in session),
    'private native launch record escaped the session view',
  );
  const before = state.mcp.native[codexId].atLaunch;
  assert(
    before?.intent.requested?.sandbox === 'workspace-write',
    'current launch evidence is missing',
  );
  const changed = await assign(
    server,
    { kind: 'session', sessionId: codexId },
    'observer',
    true,
    true,
  );
  assert(changed?.ok, 'Observer relaunch selection failed');
  const changedRow = await nativeOf(server, codexId);
  assert(
    changedRow.atLaunch?.intent.requested?.sandbox === 'workspace-write' &&
      changedRow.next.intent.requested.sandbox === 'read-only',
    'current configured posture replaced the running launch evidence',
  );

  const file = join(server.userData, 'sessions.json');
  await server.restart(() => {
    const disk = readJson(file);
    const records = Array.isArray(disk) ? disk : disk.sessions;
    const record = records.find((item) => item.id === claudeId);
    assert(record?.nativeLaunch?.version === 1, 'persisted native launch evidence is missing');
    record.nativeLaunch.version = 99;
    writeFileSync(file, JSON.stringify(disk));
  });
  await eventually('matching native evidence did not survive adoption', async () => {
    const adopted = await snapshot(server);
    const matching = adopted.sessions.find((item) => item.id === codexId);
    const unknown = adopted.sessions.find((item) => item.id === claudeId);
    return (
      matching?.runtime?.generation === codex.generation &&
      unknown?.runtime?.generation === claude.generation &&
      adopted.mcp.native[codexId]?.atLaunch?.preparedAt === before.preparedAt &&
      adopted.mcp.native[codexId]?.atLaunch?.intent.requested?.sandbox === 'workspace-write' &&
      adopted.mcp.native[claudeId]?.atLaunch === null &&
      !('nativeLaunch' in unknown)
    );
  });
}

async function upgradeCase(controller, receiver) {
  phase('A restored older pending edit cannot acquire native authority on reconnect');
  for (const server of [controller, receiver]) {
    await server.c2.call('serverSettings.patch', {
      patch: {
        networkBindHost: '127.0.0.1',
        networkPort: 0,
        networkSelfName: `native-${server.label}`,
      },
    });
  }
  const prepared = await assign(receiver, { kind: 'default' }, 'observer', true, true);
  assert(prepared?.ok, 'receiver could not establish opted-in native assignment');
  const beforeBytes = readFileSync(policyPath(receiver));
  const before = JSON.parse(beforeBytes.toString('utf8'));
  const receiverId = (await networkState(receiver)).machineId;
  const added = await controller.c2.call('link.sshAdd', {
    ssh: {
      target: 'native',
      node: process.execPath,
      mainJs: join(REPO, 'out', 'server', 'main.js'),
      userData: receiver.userData,
    },
  });
  assert(
    added.ok && added.machineId === receiverId,
    `SSH pairing failed: ${JSON.stringify(added)}`,
  );
  const rowOf = async () =>
    (await snapshot(controller)).mcp.policy.machines.find((row) => row.machineId === receiverId);
  await eventually('controller never received the native-capable receiver baseline', async () => {
    const row = await rowOf();
    return row?.status === 'applied' && row.nativeSupport && row.rev === before.rev;
  });

  await controller.restart(() => {
    const file = draftsPath(controller);
    mkdirSync(join(controller.userData, 'conduit-mcp'), { recursive: true });
    const assignments = before.assignments
      .filter(({ point }) => point.kind !== 'session')
      .map(({ point, assignment }) => {
        const clone = { ...assignment };
        delete clone.applyNative;
        return { point, assignment: clone };
      });
    writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        drafts: {
          [receiverId]: {
            baseRev: before.rev,
            doc: { profiles: before.profiles, assignments },
            editedAt: Date.now(),
          },
        },
      }),
    );
  });
  let refusedRow;
  await eventually('old pending native change did not stop for review', async () => {
    refusedRow = await rowOf();
    return (
      refusedRow?.status === 'refused' &&
      refusedRow.nativeReviewRequired &&
      refusedRow.nativeSupport &&
      refusedRow.rev === before.rev
    );
  });
  assert(
    readFileSync(policyPath(receiver)).equals(beforeBytes),
    'proofless draft changed the actual receiver',
  );

  const reapply = (nativeConsent) =>
    owner(controller, {
      type: 'mcp:remotePolicy',
      machine: receiverId,
      action: 'reapply',
      expectedToken: refusedRow.policy.editToken,
      nativeConsent,
    });
  const unreviewed = await reapply(false);
  assert(unreviewed?.error === 'native-review-required', 'reapply minted approval without consent');
  assert(
    readFileSync(policyPath(receiver)).equals(beforeBytes),
    'unconfirmed reapply changed the receiver',
  );
  const confirmed = await reapply(true);
  assert(confirmed?.ok, `current native review was not accepted: ${JSON.stringify(confirmed)}`);
  await eventually('confirmed native change did not land on the receiver', async () => {
    const row = await rowOf();
    const saved = readJson(policyPath(receiver));
    return (
      row?.status === 'applied' &&
      saved.rev === before.rev + 1 &&
      saved.assignments.find(({ point }) => point.kind === 'default').assignment.applyNative !==
        true
    );
  });
}

async function run() {
  const saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  let controller;
  let receiver;
  try {
    process.env.CONDUIT_SSH_PATH = process.execPath;
    process.env.CONDUIT_E2E_SSH_ARGS_PREFIX = JSON.stringify([
      join(REPO, 'test', 'e2e', 'fixtures', 'fake-ssh.cjs'),
    ]);
    controller = await startServer('native-a', { electronProfile: true });
    receiver = await startServer('native-b');
    await launchCases(receiver);
    await upgradeCase(controller, receiver);
    log(
      'verified real launch arguments, adopted evidence, and explicit review of an older pending draft',
    );
  } finally {
    try {
      await Promise.all([controller?.stop(), receiver?.stop()]);
    } finally {
      for (const key of ENV_KEYS) {
        if (saved[key] === undefined) delete process.env[key];
        else process.env[key] = saved[key];
      }
    }
  }
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
