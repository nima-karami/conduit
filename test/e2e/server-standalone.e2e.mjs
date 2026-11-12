import { execFile as execFileCallback, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { C2 } from './c2-peer.mjs';
import { FAKE_AGENT, sleep, until } from './conduit-mcp-helpers.mjs';
import { assert, finishScenario, makeLog, phase, REPO, resolveHcBinary } from './harness.mjs';
import { assertOwnSession, hcEnv, stopHc, teardownNames } from './harness-server-teardown.mjs';

// The integration lane's walking skeleton on real hc, with no Electron: the built supervisor runs
// the server inside an hc terminal of a private HC_SESSION (derived from a temp userData, with its
// own XDG dirs), and this file plays the app: a C2 client over the server pipe and a C5 observer
// attached to hc directly. Only that session is ever stopped.

const execFile = promisify(execFileCallback);
const requireFromRepo = createRequire(join(REPO, 'package.json'));
const requireFromHere = createRequire(import.meta.url);
const log = makeLog('server-standalone');
// Absolute, as the app passes it (runtime-layout.ts): the supervisor's terminal gets the PATH hc
// rebuilds, not ours, so a bare `--hc hc` would not resolve there.
const HC = resolveHcBinary();
const HC_VERSION = '0.1.16';
/** The app's own version: an older one may not restart the server (versionOrder, D26). */
const APP_VERSION = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8')).version;
const ECHO_AGENT = 'e2e-echo';
const FAKE_AGENT_ID = 'e2e-fake-mcp';
const ECHO_PROGRAM = String.raw`process.stdout.write('E2E-READY\n');process.stdin.on('data',d=>{const s=d.toString().trim();if(s==='exit-23'){process.exitCode=23;process.stdin.destroy();process.stdout.write('E2E-EXITING\n')}else process.stdout.write('ECHO:'+s+'\n')})`;
const SIZE = { cols: 100, rows: 30 };

/** The app's connect: hello, logging, subscribe, a ready window and its panes' sizes. */
async function attachApp(endpoint, sessionIds) {
  let c2;
  assert(
    await until(
      async () => {
        try {
          c2 = await C2.open(endpoint);
          return true;
        } catch {
          return false;
        }
      },
      30_000,
      250,
    ),
    'the server pipe never accepted a connection',
  );
  const hello = await c2.call('hello', { appVersion: APP_VERSION, generation: 1 });
  await c2.call('server.setLogging', { logging: true, logLevel: 'debug' });
  const snapshot = await c2.call('events.subscribe');
  await c2.call('ui.presence', {
    windows: [
      {
        windowId: 1,
        focused: true,
        ready: true,
        visibleSessionIds: sessionIds,
        ownedSessionIds: sessionIds,
      },
    ],
  });
  return { c2, hello, snapshot };
}

const runtimeState = (c2, snapshot) =>
  c2.events.filter((e) => e.type === 'runtime.changed').at(-1)?.data.state ??
  snapshot.runtime.state;

function writeAgents(userData, recordsDir) {
  writeFileSync(
    join(userData, 'agents.json'),
    JSON.stringify([
      {
        id: ECHO_AGENT,
        label: 'Echo',
        command: process.execPath,
        args: ['-e', ECHO_PROGRAM],
        icon: 'terminal',
        color: 'green',
        cwdStrategy: 'workspaceFolder',
      },
      {
        id: FAKE_AGENT_ID,
        label: 'Fake MCP',
        command: process.execPath,
        args: [FAKE_AGENT, '--records', recordsDir],
        icon: 'terminal',
        color: 'green',
        cwdStrategy: 'workspaceFolder',
      },
    ]),
  );
}

function fakeRecords(recordsDir, sessionId, kind) {
  const file = join(recordsDir, `${sessionId}.jsonl`);
  if (!existsSync(file)) return [];
  const lines = readFileSync(file, 'utf8').split('\n');
  lines.pop();
  return lines.map((l) => JSON.parse(l)).filter((r) => r.kind === kind);
}

async function run() {
  const version = await execFile(HC, ['--version'], { windowsHide: true });
  const versionText = `${version.stdout}${version.stderr}`;
  assert(versionText.includes(HC_VERSION), `expected hc ${HC_VERSION}, got ${versionText.trim()}`);
  const supervise = join(REPO, 'out', 'server', 'supervise.js');
  assert(existsSync(supervise), 'out/server/supervise.js missing: run `node esbuild.mjs` first');

  phase('private profile and hc session');
  const directory = await mkdtemp(join(tmpdir(), 'server-standalone-e2e-'));
  const userData = join(directory, 'user-data');
  const work = join(directory, 'work');
  const recordsDir = join(directory, 'records');
  for (const d of [userData, work, recordsDir]) mkdirSync(d, { recursive: true });
  writeAgents(userData, recordsDir);
  const names = teardownNames(userData, process.platform, tmpdir());
  assertOwnSession(names.hcSession, process.env.HC_SESSION);
  // coreStartEnv with isolation (M22): the user's XDG captured for the sessions, ours for hc.
  const env = {
    ...hcEnv(process.env, names),
    CONDUIT_USER_XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME ?? '',
    CONDUIT_USER_XDG_STATE_HOME: process.env.XDG_STATE_HOME ?? '',
    CONDUIT_USER_XDG_CAPTURED: '1',
  };
  const coreCwd = join(userData, 'runtime', 'conduit-hc', HC_VERSION);
  mkdirSync(coreCwd, { recursive: true });
  const hcOptions = { env, windowsHide: true, timeout: 20_000, cwd: coreCwd };
  const startSupervisor = () =>
    execFile(
      HC,
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
        supervise,
        '--user-data',
        userData,
        '--e2e',
        '--hc',
        HC,
      ],
      hcOptions,
    );

  let client;
  let app;
  const cleanup = async () => {
    app?.c2.close();
    client?.close();
    stopHc({
      exec: (bin, args, o) => spawnSync(bin, args, { ...o, encoding: 'utf8', windowsHide: true }),
      bin: HC,
      names,
      inheritedEnv: process.env,
      log,
    });
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  };

  try {
    // One bundle, so a stream's HcRpcError is the class this file checks against.
    const bundlePath = join(directory, 'hc-client.cjs');
    await requireFromRepo('esbuild').build({
      stdin: {
        contents: "export { NodeHcClient } from './src/hc-client/index.ts';",
        resolveDir: REPO,
        loader: 'ts',
      },
      outfile: bundlePath,
      bundle: true,
      platform: 'node',
      format: 'cjs',
    });
    const { NodeHcClient } = requireFromHere(bundlePath);

    phase('1. supervisor through hc; the server binds and serves C2');
    await startSupervisor();
    client = new NodeHcClient({ session: names.hcSession, env, log: (m, e) => log(m, String(e)) });
    app = await attachApp(names.serverEndpoint, []);
    assert(
      app.hello.supervisor?.name === names.supervisorName,
      `hello.supervisor: ${JSON.stringify(app.hello)}`,
    );
    const supervisorAddress = app.hello.supervisor.terminal;
    assert(
      await until(() => runtimeState(app.c2, app.snapshot) === 'ready', 30_000),
      `runtime never ready: ${runtimeState(app.c2, app.snapshot)}`,
    );

    phase('2. create, start, observe, type');
    const { sessionId: echo } = await app.c2.call('sessions.create', {
      agentId: ECHO_AGENT,
      home: work,
    });
    app.c2.notify('term.resize', { sessionId: echo, ...SIZE });
    const started = await app.c2.call('sessions.start', { sessionId: echo });
    assert(started.ok && started.spawned, `echo start: ${JSON.stringify(started)}`);
    assert(
      started.target.hcSession === names.hcSession,
      `target: ${JSON.stringify(started.target)}`,
    );
    const echoAddress = started.target.terminal;
    let observed = '';
    const observe = async () => {
      const { stream } = await client.attach({
        terminal: echoAddress,
        ...SIZE,
        observe: true,
        history: 2000,
      });
      stream.onData((bytes) => {
        observed += Buffer.from(bytes).toString('utf8');
      });
      return stream;
    };
    let observer = await observe();
    assert(
      await until(() => observed.includes('E2E-READY'), 15_000),
      `no READY: ${JSON.stringify(observed)}`,
    );
    app.c2.notify('term.input', {
      sessionId: echo,
      generation: started.generation,
      data: 'echo hi\r',
    });
    assert(
      await until(() => observed.includes('ECHO:echo hi'), 15_000),
      `observer missed the echo: ${JSON.stringify(observed)}`,
    );
    const ring = join(userData, `scrollback-${echo}.json`);
    assert(
      await until(
        () => existsSync(ring) && readFileSync(ring, 'utf8').includes('ECHO:echo hi'),
        15_000,
      ),
      'the server ring file never held the echo',
    );

    phase('3. messaging-off launch and MCP fake agent');
    await app.c2.call('serverSettings.patch', { patch: { conduitMcp: false } });
    const { sessionId: noMcp } = await app.c2.call('sessions.create', {
      agentId: ECHO_AGENT,
      home: work,
    });
    app.c2.notify('term.resize', { sessionId: noMcp, ...SIZE });
    const noMcpStart = await app.c2.call('sessions.start', { sessionId: noMcp });
    assert(
      noMcpStart.ok && noMcpStart.spawned,
      `messaging-off start: ${JSON.stringify(noMcpStart)}`,
    );
    const noMcpAddress = noMcpStart.target.terminal;
    await app.c2.call('serverSettings.patch', { patch: { conduitMcp: true } });

    const { sessionId: fake } = await app.c2.call('sessions.create', {
      agentId: FAKE_AGENT_ID,
      home: work,
    });
    app.c2.notify('term.resize', { sessionId: fake, ...SIZE });
    const fakeStart = await app.c2.call('sessions.start', { sessionId: fake });
    assert(fakeStart.ok, `fake start: ${JSON.stringify(fakeStart)}`);
    assert(
      await until(
        () => fakeRecords(recordsDir, fake, 'READY').some((r) => r.tools.includes('list_sessions')),
        30_000,
      ),
      `fake agent never READY with tools: ${JSON.stringify(fakeRecords(recordsDir, fake, 'READY'))}`,
    );
    app.c2.notify('term.input', {
      sessionId: fake,
      generation: fakeStart.generation,
      data: 'call list_sessions {}\r',
    });
    assert(
      await until(() => fakeRecords(recordsDir, fake, 'RESULT').length > 0, 20_000),
      'no list_sessions RESULT',
    );
    const listed = fakeRecords(recordsDir, fake, 'RESULT')[0].result;
    // Only MCP-connected sessions are listed, so the caller itself is the one to find.
    assert(
      listed?.sessions?.some((s) => s.self && s.messaging === 'connected'),
      `list_sessions has no connected self: ${JSON.stringify(listed)}`,
    );

    phase('4. server.restart: launches survive and an exit while down is reconciled');
    const { sessionId: exitsWhileDown } = await app.c2.call('sessions.create', {
      agentId: ECHO_AGENT,
      home: work,
    });
    app.c2.notify('term.resize', { sessionId: exitsWhileDown, ...SIZE });
    const exitStart = await app.c2.call('sessions.start', { sessionId: exitsWhileDown });
    assert(exitStart.ok && exitStart.spawned, `exit-test start: ${JSON.stringify(exitStart)}`);
    const exitAddress = exitStart.target.terminal;
    await app.c2.call('server.restart', { reason: 'user' });
    assert(await until(() => app.c2.closed, 20_000), 'the old server kept its connection');
    // F6.4: the supervisor exits with the server; the app waits for its terminal, then starts one.
    assert(
      await until(async () => {
        try {
          const t = await client.call('terminal.get', { terminal: supervisorAddress });
          return t.state !== 'live';
        } catch (error) {
          return error?.kind === 'not_found';
        }
      }, 30_000),
      'the supervisor terminal never finished',
    );
    const { stream: downStream } = await client.attach({
      terminal: exitAddress,
      ...SIZE,
    });
    downStream.onData((bytes) => downStream.credit(bytes.byteLength));
    downStream.write(Buffer.from('exit-23\r'));
    assert(
      await until(async () => {
        const terminal = await client.call('terminal.get', { terminal: exitAddress });
        return terminal.state === 'finished';
      }, 15_000),
      'the exit-test terminal did not finish while the server was down',
    );
    const exitedTerminal = await client.call('terminal.get', { terminal: exitAddress });
    assert(exitedTerminal.exit_code === 23, `exit while down: ${JSON.stringify(exitedTerminal)}`);
    downStream.close();

    await startSupervisor();
    app = await attachApp(names.serverEndpoint, [echo, fake, noMcp, exitsWhileDown]);
    assert(
      await until(() => runtimeState(app.c2, app.snapshot) === 'ready', 30_000),
      'runtime never ready after the restart',
    );
    // The subscribe snapshot may predate reconcile; the adoption arrives as sessions.changed.
    const echoView = () =>
      (
        app.c2.events.filter((e) => e.type === 'sessions.changed').at(-1)?.data.sessions ??
        app.snapshot.sessions
      ).find((s) => s.id === echo);
    assert(
      await until(() => echoView()?.runtime.spawn === 'live', 15_000),
      `echo after restart: ${JSON.stringify(echoView())}`,
    );
    const noMcpView = () =>
      (
        app.c2.events.filter((e) => e.type === 'sessions.changed').at(-1)?.data.sessions ??
        app.snapshot.sessions
      ).find((s) => s.id === noMcp);
    assert(
      await until(() => noMcpView()?.runtime.spawn === 'live', 15_000),
      `messaging-off launch after restart: ${JSON.stringify(noMcpView())}`,
    );
    const noMcpAgain = await app.c2.call('sessions.start', { sessionId: noMcp });
    assert(
      noMcpAgain.ok && !noMcpAgain.spawned && noMcpAgain.target.terminal === noMcpAddress,
      `messaging-off re-start after restart: ${JSON.stringify(noMcpAgain)}`,
    );
    const exitView = () =>
      (
        app.c2.events.filter((e) => e.type === 'sessions.changed').at(-1)?.data.sessions ??
        app.snapshot.sessions
      ).find((s) => s.id === exitsWhileDown);
    assert(
      await until(() => exitView()?.status === 'exited' && exitView()?.exitCode === 23, 15_000),
      `exit while server down was not recorded: ${JSON.stringify(exitView())}`,
    );
    app.c2.notify('term.resize', { sessionId: echo, ...SIZE });
    const again = await app.c2.call('sessions.start', { sessionId: echo });
    assert(
      again.ok && !again.spawned && again.target.terminal === echoAddress,
      `re-start after restart: ${JSON.stringify(again)}`,
    );
    observer.close();
    observed = '';
    observer = await observe();
    app.c2.notify('term.input', { sessionId: echo, generation: again.generation, data: 'again\r' });
    assert(
      await until(() => observed.includes('ECHO:again'), 15_000),
      `no echo after the restart: ${JSON.stringify(observed)}`,
    );
    observer.close();

    phase('5. server.stopAll: terminals, server, supervisor and core all end');
    // On Linux `hc server status` starts a core when none is running, so the core is identified
    // by pid before stopAll and only that pid is polled afterwards.
    const corePid = process.platform === 'win32' ? null : hcCorePid(env);
    const stopped = await app.c2.call('server.stopAll');
    assert(stopped.killed === 3, `stopAll: ${JSON.stringify(stopped)}`);
    assert(
      await until(() => app.c2.closed, 20_000),
      'the server kept its connection after stopAll',
    );
    client.close();
    client = undefined;
    if (process.platform === 'win32') {
      assert(
        await until(
          async () => {
            const r = spawnSync(HC, ['server', 'status'], {
              env,
              encoding: 'utf8',
              windowsHide: true,
              timeout: 10_000,
            });
            return r.status !== 0 || /not running/i.test(`${r.stdout}${r.stderr}`);
          },
          30_000,
          500,
        ),
        'our hc core is still running after stopAll',
      );
    } else {
      assert(
        await until(() => pidGone(corePid), 30_000, 500),
        `our hc core (pid ${corePid}) is still running after stopAll`,
      );
    }
    log(`PASS: hc ${versionText.trim()}`);
  } catch (error) {
    const serverLog = join(userData, 'server.log');
    if (existsSync(serverLog))
      log('server.log tail:\n', readFileSync(serverLog, 'utf8').slice(-6000));
    const screen = spawnSync(HC, ['read', names.supervisorName], {
      env,
      encoding: 'utf8',
      windowsHide: true,
      timeout: 10_000,
    });
    log('supervisor terminal:\n', `${screen.stdout}${screen.stderr}`.slice(-3000));
    throw error;
  } finally {
    await cleanup();
  }
}

/** The pid of the hc core this profile's session runs (`server.status`'s `pid`). */
function hcCorePid(env) {
  const r = spawnSync(HC, ['server', 'status', '--json'], {
    env,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 10_000,
  });
  const pid = r.status === 0 ? JSON.parse(r.stdout).pid : undefined;
  assert(
    Number.isInteger(pid) && pid > 0,
    `hc server status --json gave no core pid: exit ${r.status}: ${r.stdout}${r.stderr}`,
  );
  return pid;
}

/** True once no process has `pid` (signal 0 only probes). */
function pidGone(pid) {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return error?.code === 'ESRCH';
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
await sleep(0);
await finishScenario(code);
