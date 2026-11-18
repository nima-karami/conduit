import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { until } from './conduit-mcp-helpers.mjs';
import { assert, finishScenario, makeLog, phase, REPO } from './harness.mjs';
import { networkState, startServer } from './net-helpers.mjs';

const log = makeLog('permissions-native');
const ENV_KEYS = ['CONDUIT_SSH_PATH', 'CONDUIT_E2E_SSH_ARGS_PREFIX', 'CODEX_HOME'];
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
const modelFlag = ${JSON.stringify(cli === 'claude' ? '--model' : '-m')};
const length = ${cli === 'claude' ? 2 : 4};
const nativeParts = new Set([
  '--permission-mode', '--sandbox', '--ask-for-approval',
  'plan', 'acceptEdits', 'read-only', 'workspace-write', 'on-request',
]);
const nativeFlags = new Set(['--permission-mode', '--sandbox', '--ask-for-approval', '-s', '-a']);
const modelIndex = args.indexOf(modelFlag);
writeFileSync(${JSON.stringify(record)}, JSON.stringify({
  prefix: args.slice(0, length).map((item) => nativeParts.has(item) ? item : null),
  nativeFlagCount: args.filter((item) => nativeFlags.has(item.split('=', 1)[0])).length,
  modelIndex: modelIndex >= 0 && args[modelIndex + 1] === 'owned-test-model' ? modelIndex : -1,
  claudeMcpIndex: args.indexOf('--mcp-config'),
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
    (await actualArgs(workerProbe)).nativeFlagCount === 0,
    'an implicit Worker launch got native flags',
  );

  const offProbe = launchProbe(server, 'claude', 'optout-probe');
  const offId = await create(server, offProbe, []);
  const offEdit = await assign(server, { kind: 'session', sessionId: offId }, 'lead', false, false);
  assert(offEdit?.ok, `Conduit-only Lead assignment failed: ${JSON.stringify(offEdit)}`);
  const optOut = await start(server, offId);
  assert(optOut.ok && optOut.spawned, 'the opt-out probe did not start');
  assert(
    (await actualArgs(offProbe)).nativeFlagCount === 0,
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
    JSON.stringify(cl.prefix) === JSON.stringify(['--permission-mode', 'plan']) &&
      cl.nativeFlagCount === 1 &&
      cl.modelIndex === 2 &&
      cl.claudeMcpIndex > cl.modelIndex + 1,
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
    JSON.stringify(co.prefix) ===
      JSON.stringify(['--sandbox', 'workspace-write', '--ask-for-approval', 'on-request']) &&
      co.nativeFlagCount === 2 &&
      co.modelIndex === 4,
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

async function postureCase(server, codexHome) {
  phase('Linked Codex posture follows the owned rollout');
  const threadId = '01a1d190-1af2-7db3-ae44-cb9dacc349ed';
  const competingId = '01a1d190-2af4-7db3-ae44-cb9dacc349ee';
  const nextThreadId = '01a1d190-3af4-7db3-ae44-cb9dacc349ef';
  const secret = 'FIXTURE-SECRET-posture';
  const probe = launchProbe(server, 'codex', 'posture-probe');
  const sessionId = await create(server, probe, []);
  await server.c2.call('ui.presence', {
    windows: [
      {
        windowId: 1,
        focused: true,
        ready: true,
        visibleSessionIds: [sessionId],
        ownedSessionIds: [sessionId],
      },
    ],
  });
  const started = await start(server, sessionId);
  assert(started.ok && started.spawned, 'posture probe did not start');
  await actualArgs(probe);
  const generation = started.generation;
  const request = async (type, extra = {}) => {
    const response = await server.c2.call('mcp.fromRenderer', {
      windowId: 1,
      message: { type, requestId: 1, sessionId, generation, ...extra },
    });
    assert(response.reply?.type === 'mcp:codexPostureResult', 'missing posture response');
    return response.reply.view;
  };
  const now = new Date();
  const two = (n) => String(n).padStart(2, '0');
  const folder = join(
    codexHome,
    'sessions',
    String(now.getFullYear()),
    two(now.getMonth() + 1),
    two(now.getDate()),
  );
  mkdirSync(folder, { recursive: true });
  const stamp = `${now.getFullYear()}-${two(now.getMonth() + 1)}-${two(now.getDate())}T${two(now.getHours())}-${two(now.getMinutes())}-${two(now.getSeconds())}`;
  const rollout = (id) => join(folder, `rollout-${stamp}-${id}.jsonl`);
  const line = (value) => `${JSON.stringify(value)}\n`;
  const meta = (id) =>
    line({
      timestamp: now.toISOString(),
      type: 'session_meta',
      payload: {
        id,
        timestamp: now.toISOString(),
        cwd: server.work,
        originator: 'codex_cli_rs',
        cli_version: '0.145.0',
        source: 'cli',
      },
    });
  const file = rollout(threadId);
  writeFileSync(file, meta(threadId));
  let linked;
  await eventually('the real watcher did not bind the owned rollout', async () => {
    linked = await request('mcp:linkCodexThread', { threadId });
    return linked.status === 'linked';
  });
  assert(
    linked.reading === null && linked.lastKnown === null,
    'empty rollout did not link pending',
  );
  writeFileSync(rollout(competingId), meta(competingId));
  const refused = await request('mcp:linkCodexThread', { threadId: competingId });
  assert(refused.status === 'unavailable', 'competing same-cwd rollout replaced the bound thread');

  const knownAt = '2026-11-17T12:00:00.000Z';
  const unknownAt = '2026-11-17T12:00:01.000Z';
  const eventStart = server.c2.events.length;
  appendFileSync(
    file,
    [
      {
        timestamp: knownAt,
        type: 'turn_context',
        payload: {
          approval_policy: 'on-request',
          sandbox_policy: { type: 'workspace-write' },
          secret,
        },
      },
      {
        timestamp: unknownAt,
        type: 'turn_context',
        payload: {
          approval_policy: 'future-mode',
          sandbox_policy: { type: 'workspace-write' },
          secret,
        },
      },
    ]
      .map(line)
      .join(''),
  );
  let changed;
  await eventually('the owner did not receive the folded posture batch', () => {
    changed = server.c2.events
      .slice(eventStart)
      .find(
        (event) =>
          event.type === 'ui.post' &&
          event.data.message.type === 'mcp:codexPostureChanged' &&
          event.data.message.sessionId === sessionId &&
          event.data.message.view.reading?.status === 'unknown',
      );
    return Boolean(changed);
  });
  const view = changed.data.message.view;
  assert(
    changed.data.route.kind === 'window' &&
      changed.data.route.windowId === 1 &&
      changed.data.message.generation === generation,
    'posture was not addressed to the current owner',
  );
  assert(
    view.freshness === 'current' &&
      view.reading.reportedAt === Date.parse(unknownAt) &&
      view.lastKnown?.reportedAt === Date.parse(knownAt) &&
      view.lastKnown.sandbox === 'workspace-write' &&
      view.lastKnown.approval === 'on-request',
    'batch lost the prior known reading',
  );
  const query = await request('mcp:codexPostureQuery');
  const projection = JSON.stringify({ view, query, snapshot: await snapshot(server) });
  assert(
    ![secret, threadId, competingId, file].some((value) => projection.includes(value)),
    'raw rollout data escaped into the projection',
  );
  const restart = await server.c2.call('sessions.restart', { sessionId });
  assert(restart.ok, 'posture probe did not retire');
  const retired = await request('mcp:codexPostureQuery');
  assert(retired.status === 'unavailable', 'retired launch retained its posture');
  rmSync(file);
  rmSync(rollout(competingId));
  const relaunched = await server.c2.call('sessions.relaunch', { sessionIds: [sessionId] });
  assert(relaunched.relaunched.includes(sessionId), 'posture session was not marked for relaunch');
  const next = await start(server, sessionId);
  assert(
    next.ok && next.spawned && next.generation > generation,
    'posture probe did not spawn a new generation',
  );
  const oldGeneration = await request('mcp:codexPostureQuery');
  assert(
    oldGeneration.status === 'unavailable',
    'old generation remained queryable after relaunch',
  );
  const pending = await request('mcp:codexPostureQuery', { generation: next.generation });
  assert(pending.status === 'unavailable', 'new launch inherited the old link');
  const oldLink = await request('mcp:linkCodexThread', { generation: next.generation, threadId });
  assert(oldLink.status === 'unavailable', 'new launch accepted the previous thread');
  const later = new Date();
  const nextMeta = line({
    timestamp: later.toISOString(),
    type: 'session_meta',
    payload: {
      id: nextThreadId,
      timestamp: later.toISOString(),
      cwd: server.work,
      originator: 'codex_cli_rs',
      cli_version: '0.145.0',
      source: 'cli',
    },
  });
  writeFileSync(rollout(nextThreadId), nextMeta);
  let nextLink;
  await eventually('the new launch did not link its own rollout', async () => {
    nextLink = await request('mcp:linkCodexThread', {
      generation: next.generation,
      threadId: nextThreadId,
    });
    return nextLink.status === 'linked';
  });
  assert(
    nextLink.reading === null && nextLink.lastKnown === null,
    'new launch inherited prior readings',
  );
  const staleLink = await request('mcp:linkCodexThread', { threadId: nextThreadId });
  assert(staleLink.status === 'unavailable', 'old generation could link the new thread');
  await server.c2.call('sessions.remove', { sessionId });
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
  const codexHome = mkdtempSync(join(tmpdir(), 'conduit-posture-e2e-'));
  try {
    process.env.CODEX_HOME = codexHome;
    process.env.CONDUIT_SSH_PATH = process.execPath;
    process.env.CONDUIT_E2E_SSH_ARGS_PREFIX = JSON.stringify([
      join(REPO, 'test', 'e2e', 'fixtures', 'fake-ssh.cjs'),
    ]);
    controller = await startServer('native-a', { electronProfile: true });
    receiver = await startServer('native-b');
    await postureCase(controller, codexHome);
    await launchCases(receiver);
    await upgradeCase(controller, receiver);
    log(
      'verified real launch arguments, adopted evidence, and explicit review of an older pending draft',
    );
  } finally {
    try {
      await Promise.all([controller?.stop(), receiver?.stop()]);
    } finally {
      rmSync(codexHome, { recursive: true, force: true });
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
