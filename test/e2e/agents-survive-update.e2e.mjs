import { execFile as execFileCallback, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { C2 } from './c2-peer.mjs';
import { FAKE_AGENT, NOTICE, until } from './conduit-mcp-helpers.mjs';
import { assert, finishScenario, makeLog, REPO, resolveHcBinary } from './harness.mjs';
import { assertOwnSession, hcEnv, stopHc, teardownNames } from './harness-server-teardown.mjs';

const execFile = promisify(execFileCallback);
const require = createRequire(import.meta.url);
const log = makeLog('agents-survive-update');
const hc = resolveHcBinary();
const version = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8')).version;
const oldVersion = '0.0.0';
const size = { cols: 100, rows: 30 };

async function run() {
  assert(
    Number(version.split('.')[0]) > 0 || Number(version.split('.')[1]) > 0,
    `not newer: ${version}`,
  );
  const root = await mkdtemp(join(tmpdir(), 'agents-survive-update-'));
  const userData = join(root, 'profile');
  const work = join(root, 'work');
  const recordsDir = join(root, 'records');
  for (const dir of [userData, work, recordsDir]) mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(userData, 'agents.json'),
    JSON.stringify([
      {
        id: 'e2e-fake-mcp',
        label: 'Fake MCP',
        command: process.execPath,
        args: [FAKE_AGENT, '--records', recordsDir],
        icon: 'terminal',
        color: 'green',
        cwdStrategy: 'workspaceFolder',
      },
    ]),
  );
  const names = teardownNames(userData, process.platform, tmpdir());
  assertOwnSession(names.hcSession, process.env.HC_SESSION);
  const env = {
    ...hcEnv(process.env, names),
    CONDUIT_USER_XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME ?? '',
    CONDUIT_USER_XDG_STATE_HOME: process.env.XDG_STATE_HOME ?? '',
    CONDUIT_USER_XDG_CAPTURED: '1',
  };
  const cwd = join(userData, 'runtime', 'conduit-hc', '0.1.16');
  mkdirSync(cwd, { recursive: true });
  const supervisor = join(REPO, 'out', 'server', 'supervise.js');
  const start = (old) =>
    execFile(
      hc,
      [
        'run',
        '--bg',
        '--no-parent',
        '--name',
        names.supervisorName,
        '--label',
        'conduit.role=server',
        '--',
        process.execPath,
        supervisor,
        '--user-data',
        userData,
        '--e2e',
        '--hc',
        hc,
        ...(old ? ['--e2e-app-version', oldVersion] : []),
      ],
      { env, cwd, windowsHide: true, timeout: 20_000 },
    );
  const records = (sid, kind) => {
    const file = join(recordsDir, `${sid}.jsonl`);
    if (!existsSync(file)) return [];
    const lines = readFileSync(file, 'utf8').split('\n');
    lines.pop();
    return lines.map((line) => JSON.parse(line)).filter((r) => r.kind === kind);
  };
  let c2;
  let client;
  const streams = [];
  try {
    const bundle = join(root, 'hc-client.cjs');
    await require('esbuild').build({
      stdin: {
        contents: "export { NodeHcClient } from './src/hc-client/index.ts';",
        resolveDir: REPO,
        loader: 'ts',
      },
      outfile: bundle,
      bundle: true,
      platform: 'node',
      format: 'cjs',
    });
    const { NodeHcClient } = require(bundle);
    await start(true);
    client = new NodeHcClient({ session: names.hcSession, env, log: (m, e) => log(m, String(e)) });
    const connect = async () => {
      assert(
        await until(
          async () => {
            try {
              c2 = await C2.open(names.serverEndpoint);
              return true;
            } catch {
              return false;
            }
          },
          30_000,
          250,
        ),
        'server did not accept C2',
      );
      const hello = await c2.call('hello', { appVersion: version, generation: 1 });
      await c2.call('events.subscribe');
      return hello;
    };
    const old = await connect();
    assert(old.serverVersion === oldVersion, `old server: ${JSON.stringify(old)}`);
    const agents = [];
    for (let i = 0; i < 2; i++) {
      const { sessionId } = await c2.call('sessions.create', {
        agentId: 'e2e-fake-mcp',
        home: work,
      });
      c2.notify('term.resize', { sessionId, ...size });
      const started = await c2.call('sessions.start', { sessionId });
      assert(started.ok && started.spawned, `start: ${JSON.stringify(started)}`);
      assert(
        await until(
          () => records(sessionId, 'READY').some((r) => r.tools.includes('list_sessions')),
          30_000,
        ),
        'agent not ready',
      );
      const attached = await client.attach({ terminal: started.target.terminal, ...size });
      let output = '';
      attached.stream.onData((bytes) => {
        output += Buffer.from(bytes).toString('utf8');
        attached.stream.credit(bytes.byteLength);
      });
      streams.push(attached.stream);
      agents.push({
        sessionId,
        stream: attached.stream,
        output: () => output,
        pid: records(sessionId, 'READY')[0].pid,
      });
    }
    const [a, b] = agents;
    const send = (agent, line) => agent.stream.write(Buffer.from(`${line}\r`));
    const call = async (agent, tool, args) => {
      const before = records(agent.sessionId, 'RESULT').length;
      send(agent, `call ${tool} ${JSON.stringify(args)}`);
      assert(
        await until(() => records(agent.sessionId, 'RESULT').length > before, 20_000),
        `no ${tool} result`,
      );
      return records(agent.sessionId, 'RESULT')[before].result;
    };
    const listed = await call(a, 'list_sessions', {});
    const peer = listed.sessions?.find((s) => !s.self);
    assert(peer?.handle, `peer missing: ${JSON.stringify(listed)}`);
    send(b, 'busy 30000');
    assert(await until(() => b.output().includes('working 1'), 10_000), 'B did not become busy');
    const sent = await call(a, 'send_message', {
      to: [peer.handle],
      body: 'message before update',
    });
    assert(sent.recipients?.[0]?.status === 'queued', `send: ${JSON.stringify(sent)}`);
    assert(
      records(b.sessionId, 'INPUT').every((r) => !r.line.startsWith('[conduit]')),
      'notice arrived before swap',
    );

    const closed = new Promise((resolve) => c2.socket.once('close', resolve));
    await c2.call('server.restart', { reason: 'update' }).catch(() => {});
    await closed;
    assert(
      await until(async () => {
        try {
          return (
            (await client.call('terminal.get', { terminal: old.supervisor.terminal })).state !==
            'live'
          );
        } catch (error) {
          return error?.kind === 'not_found';
        }
      }, 30_000),
      'old supervisor did not stop',
    );
    const before = records(a.sessionId, 'RESULT').length;
    const calls = records(a.sessionId, 'CALL').length;
    send(a, 'call list_sessions {}');
    assert(
      await until(() => records(a.sessionId, 'CALL').length > calls, 10_000),
      'gap call was not sent',
    );
    assert(
      // The fake agent's 100 ms interval drifts, so the last tick number is not fixed; the prompt it
      // writes straight after the final tick marks the end of the busy interval.
      await until(() => /working \d+\r+\nfake❯ /.test(b.output()), 40_000),
      'busy interval did not end in gap',
    );
    assert(
      records(b.sessionId, 'INPUT').every((r) => !r.line.startsWith('[conduit]')),
      'notice delivered while server down',
    );
    await start(false);
    const current = await connect();
    assert(
      current.serverVersion === version && current.pid !== old.pid,
      `replacement: ${JSON.stringify(current)}`,
    );
    await c2.call('ui.presence', {
      windows: [
        {
          windowId: 1,
          focused: true,
          ready: true,
          visibleSessionIds: agents.map((x) => x.sessionId),
          ownedSessionIds: agents.map((x) => x.sessionId),
        },
      ],
    });
    assert(
      await until(() => records(a.sessionId, 'RESULT').length > before, 30_000),
      'gap call never answered',
    );
    const gap = records(a.sessionId, 'RESULT')[before].result;
    assert(
      gap.sessions?.some((s) => s.self) ||
        (gap.rpcError?.data?.code === 'host_unavailable' && gap.rpcError.data.retryable === true),
      `gap call: ${JSON.stringify(gap)}`,
    );
    assert(
      await until(() => records(b.sessionId, 'INBOX').length > 0, 30_000),
      'notice/inbox missing after swap',
    );
    const notice = records(b.sessionId, 'INPUT').find((r) => r.line.startsWith('[conduit]'));
    assert(
      notice?.line.replace(/\s/g, '') === NOTICE.replace(/\s/g, ''),
      `notice: ${JSON.stringify(notice)}`,
    );
    const inbox = records(b.sessionId, 'INBOX')[0].result;
    assert(
      inbox.messages?.some((m) => m.body.includes('message before update')),
      `inbox: ${JSON.stringify(inbox)}`,
    );
    for (const agent of agents) {
      assert(
        records(agent.sessionId, 'READY').length === 1 &&
          records(agent.sessionId, 'INPUT').every((r) => r.pid === agent.pid),
        `agent restarted: ${agent.sessionId}`,
      );
    }
  } finally {
    for (const stream of streams) stream.close();
    c2?.close();
    client?.close();
    stopHc({
      exec: (bin, args, options) =>
        spawnSync(bin, args, { ...options, encoding: 'utf8', windowsHide: true }),
      bin: hc,
      names,
      inheritedEnv: process.env,
      log,
    });
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}

let code = 0;
try {
  await run();
  log('PASS');
} catch (error) {
  code = error?.name === 'AssertionError' ? 1 : 2;
  log('FAIL', error?.stack || String(error));
}
await finishScenario(code);
