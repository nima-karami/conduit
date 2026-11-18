import { execFile as execFileCallback, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { connect, createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { c2AuthIfRunning } from './c2-auth.mjs';
import { C2 } from './c2-peer.mjs';
import { FAKE_AGENT, until } from './conduit-mcp-helpers.mjs';
import { assert, makeLog, profileDir, REPO, resolveHcBinary } from './harness.mjs';
import { assertOwnSession, hcEnv, stopHc, teardownNames } from './harness-server-teardown.mjs';

// Shared by every net-*.e2e.mjs: N standalone servers, each in its own private hc session and
// temp userData (the same bring-up as server-standalone.e2e.mjs, which exports nothing to reuse),
// plus the pairing driver and a TCP relay for scenarios that cut a link.

const execFile = promisify(execFileCallback);
const log = makeLog('net');
// Absolute, as the app passes it: the supervisor's terminal gets the PATH hc rebuilds.
const HC = resolveHcBinary();
const HC_VERSION = '0.1.16';
const APP_VERSION = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8')).version;
export const ECHO_AGENT = 'e2e-echo';
const FAKE_AGENT_ID = 'e2e-fake-mcp';
// Raw mode, as fixtures/echo-probe.cjs: on Windows a line-mode stdin reader never learns of a
// ConPTY resize, so `size` would report the spawn size.
const ECHO_PROGRAM = String.raw`if(process.stdin.isTTY)process.stdin.setRawMode(true);process.stdout.write('E2E-READY\n');process.stdin.on('data',d=>{const s=d.toString().trim();if(s==='exit-23'){process.exitCode=23;process.stdin.destroy();process.stdout.write('E2E-EXITING\n')}else if(s==='size')process.stdout.write('SIZE:'+process.stdout.columns+'x'+process.stdout.rows+'\n');else process.stdout.write('ECHO:'+s+'\n')})`;
const PAIRING_TIMEOUT_MS = 15_000;

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

/** The app's connect: hello, logging, subscribe, a ready window (no panes). */
async function attachApp(endpoint, userData, previousSecret) {
  for (let attempt = 0; attempt < 2; attempt++) {
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
    let authenticated = false;
    try {
      let secret;
      assert(
        await until(
          () => {
            secret = c2AuthIfRunning(userData);
            return secret !== undefined && secret !== previousSecret;
          },
          30_000,
          250,
        ),
        'the server secret never rotated',
      );
      const hello = await c2.call('hello', {
        appVersion: APP_VERSION,
        generation: 1,
        auth: secret,
      });
      await c2.call('server.setLogging', { logging: true, logLevel: 'debug' });
      const snapshot = await c2.call('events.subscribe');
      authenticated = true;
      await c2.call('ui.presence', {
        windows: [
          {
            windowId: 1,
            focused: true,
            ready: true,
            visibleSessionIds: [],
            ownedSessionIds: [],
          },
        ],
      });
      return { c2, hello, snapshot, secret };
    } catch (error) {
      c2.close();
      // A listening pipe can outlive the server whose secret was just replaced.
      if (
        attempt === 0 &&
        !authenticated &&
        error instanceof Error &&
        error.message.startsWith('auth required (')
      )
        continue;
      throw error;
    }
  }
}

/**
 * Starts one standalone server: temp userData/work/records, the echo and fake MCP agents, a
 * private hc session, the supervisor through `hc run`, and a C2 connection.
 * @param {string} label
 * @param {{ electronProfile?: boolean }} [options]
 */
export async function startServer(label, { electronProfile = false } = {}) {
  const version = await execFile(HC, ['--version'], { windowsHide: true });
  const versionText = `${version.stdout}${version.stderr}`;
  assert(versionText.includes(HC_VERSION), `expected hc ${HC_VERSION}, got ${versionText.trim()}`);
  const supervise = join(REPO, 'out', 'server', 'supervise.js');
  assert(existsSync(supervise), 'out/server/supervise.js missing: run `npm run build` first');

  const directory = electronProfile
    ? profileDir()
    : await mkdtemp(join(tmpdir(), `net-${label}-e2e-`));
  const userData = electronProfile ? directory : join(directory, 'user-data');
  const work = join(directory, 'work');
  const recordsDir = join(directory, 'records');
  for (const d of [userData, work, recordsDir]) mkdirSync(d, { recursive: true });
  writeAgents(userData, recordsDir);
  const names = teardownNames(userData, process.platform, tmpdir());
  assertOwnSession(names.hcSession, process.env.HC_SESSION);
  // coreStartEnv with isolation: the user's XDG captured for the sessions, ours for hc.
  const env = {
    ...hcEnv(process.env, names),
    CONDUIT_USER_XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME ?? '',
    CONDUIT_USER_XDG_STATE_HOME: process.env.XDG_STATE_HOME ?? '',
    CONDUIT_USER_XDG_CAPTURED: '1',
  };
  const coreCwd = join(userData, 'runtime', 'conduit-hc', HC_VERSION);
  mkdirSync(coreCwd, { recursive: true });

  let c2;
  let stopped;
  const stopOne = () =>
    (stopped ??= (async () => {
      c2?.close();
      try {
        stopHc({
          exec: (bin, args, o) =>
            spawnSync(bin, args, { ...o, encoding: 'utf8', windowsHide: true }),
          bin: HC,
          names,
          inheritedEnv: process.env,
          log,
        });
      } finally {
        await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      }
    })());

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
      { env, windowsHide: true, timeout: 20_000, cwd: coreCwd },
    );

  try {
    await startSupervisor();
    const app = await attachApp(names.serverEndpoint, userData);
    c2 = app.c2;
    let secret = app.secret;
    assert(
      app.hello.supervisor?.name === names.supervisorName,
      `hello.supervisor (${label}): ${JSON.stringify(app.hello)}`,
    );
    assert(
      await until(() => runtimeState(app.c2, app.snapshot) === 'ready', 30_000),
      `runtime never ready (${label}): ${runtimeState(app.c2, app.snapshot)}`,
    );
    const server = {
      label,
      userData,
      work,
      names,
      c2,
      recordsDir,
      stop: stopOne,
      restart: async (afterStop) => {
        const old = server.c2;
        await old.call('server.restart', { reason: 'user' });
        assert(await until(() => old.closed, 15_000), 'server did not close');
        assert(
          await until(async () => {
            const result = await execFile(HC, ['get', names.supervisorName, '--json'], {
              env,
              windowsHide: true,
              timeout: 5_000,
            });
            return JSON.parse(result.stdout).state !== 'live';
          }, 15_000),
          'supervisor did not stop',
        );
        await afterStop?.();
        await startSupervisor();
        const next = await attachApp(names.serverEndpoint, userData, secret);
        secret = next.secret;
        c2 = next.c2;
        server.c2 = c2;
        assert(
          await until(() => runtimeState(c2, next.snapshot) === 'ready', 15_000),
          'runtime did not recover',
        );
      },
    };
    return server;
  } catch (error) {
    await stopOne();
    throw error;
  }
}

/**
 * Two servers, 'a' and 'b', each listening on loopback with an OS-picked port. Either both start
 * or none stays running.
 */
export async function startServerPair() {
  const settled = await Promise.allSettled([startServer('a'), startServer('b')]);
  const started = settled.filter((s) => s.status === 'fulfilled').map((s) => s.value);
  const failed = settled.find((s) => s.status === 'rejected');
  const stopAll = () => Promise.all(started.map((s) => s.stop()));
  if (failed) {
    await stopAll();
    throw failed.reason;
  }
  const [a, b] = started;
  try {
    await Promise.all([
      a.c2.call('serverSettings.patch', {
        patch: { networkBindHost: '127.0.0.1', networkPort: 0, networkSelfName: 'net-a' },
      }),
      b.c2.call('serverSettings.patch', {
        patch: { networkBindHost: '127.0.0.1', networkPort: 0, networkSelfName: 'net-b' },
      }),
    ]);
  } catch (error) {
    await stopAll();
    throw error;
  }
  return { a, b, stopAll };
}

/** The NetworkState of one server (`link.list`). */
export const networkState = (server) => server.c2.call('link.list', {});

/** This link's state on `c2`'s server, or null when it is not listed. */
export async function linkState(c2, machineId) {
  const state = await c2.call('link.list', {});
  return state.links.find((l) => l.machineId === machineId)?.state ?? null;
}

/** This link's view on `c2`'s server, or null when it is not listed. */
export async function linkView(c2, machineId) {
  const state = await c2.call('link.list', {});
  return state.links.find((l) => l.machineId === machineId) ?? null;
}

/**
 * Drives one pairing from `a` (opener) and `b` (joiner) to a linked state on both sides.
 * @param {{ c2: C2, label: string }} a
 * @param {{ c2: C2, label: string }} b
 * @returns {Promise<{ aId: string, bId: string, fingerprint: string }>}
 */
export async function pairServers(a, b) {
  const opened = await a.c2.call('pairing.start', {});
  const joined = await b.c2.call('pairing.join', {
    code: opened.code.join(' '),
    address: opened.addresses[0],
  });
  const aId = (await networkState(a)).machineId;
  const bId = (await networkState(b)).machineId;

  const pairingOf = async (server) => (await networkState(server)).pairing;
  let lastStates = '';
  assert(
    await until(async () => {
      const [pa, pb] = await Promise.all([pairingOf(a), pairingOf(b)]);
      lastStates = `a=${pa?.state} b=${pb?.state}`;
      return pa?.state === 'confirm' && pb?.state === 'confirm';
    }, PAIRING_TIMEOUT_MS),
    `pairing never reached confirm on both sides (${lastStates})`,
  );
  const [pa, pb] = await Promise.all([pairingOf(a), pairingOf(b)]);
  assert(
    pa.fingerprint === pb.fingerprint,
    `fingerprints differ: a=${pa.fingerprint} b=${pb.fingerprint}`,
  );
  await a.c2.call('pairing.confirm', { pairingId: opened.pairingId });
  await b.c2.call('pairing.confirm', { pairingId: joined.pairingId });

  lastStates = '';
  assert(
    await until(async () => {
      const [sa, sb] = await Promise.all([networkState(a), networkState(b)]);
      const linkedUp =
        sa.links.some((l) => l.machineId === bId && l.state === 'up') &&
        sb.links.some((l) => l.machineId === aId && l.state === 'up');
      lastStates = `a=${sa.pairing?.state} b=${sb.pairing?.state}`;
      return sa.pairing?.state === 'done' && sb.pairing?.state === 'done' && linkedUp;
    }, PAIRING_TIMEOUT_MS),
    `pairing never completed (${lastStates})`,
  );
  return { aId, bId, fingerprint: pa.fingerprint };
}

/**
 * The audit log of one server, parsed line by line (`<userData>/network/audit.jsonl`). Empty
 * while nothing has been written.
 * @param {string} userData
 * @returns {Array<Record<string, unknown>>}
 */
export function readAudit(userData) {
  const file = join(userData, 'network', 'audit.jsonl');
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line));
}

/**
 * A plain TCP relay on loopback: forwards every byte both ways and never parses TLS. `pause()`
 * stops forwarding but keeps the sockets, `cut()` destroys them, so a scenario can make a link
 * look dead to its peer without the peer's process going away.
 */
export class LinkProxy {
  /** @param {{ host: string, port: number }} target */
  constructor(target) {
    this.target = target;
    this.pairs = new Set();
    this.paused = false;
    this.dropReplies = false;
    /** Socket errors seen while relaying, kept for the scenario to assert on or dump. */
    this.errors = [];
    this.server = createServer((client) => this.accept(client));
  }

  /** Listens on 127.0.0.1 at an OS-picked port; resolves with `host:port`. */
  listen() {
    return new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(0, '127.0.0.1', () => {
        this.server.off('error', reject);
        resolve(this.address());
      });
    });
  }

  /** `host:port` of the listening socket. */
  address() {
    const { address, port } = this.server.address();
    return `${address}:${port}`;
  }

  accept(client) {
    const upstream = connect(this.target);
    const pair = { client, upstream };
    this.pairs.add(pair);
    const drop = () => {
      client.destroy();
      upstream.destroy();
      this.pairs.delete(pair);
    };
    const fail = (error) => {
      this.errors.push(error);
      drop();
    };
    client.on('error', fail);
    upstream.on('error', fail);
    client.on('close', () => this.pairs.delete(pair));
    upstream.on('close', () => this.pairs.delete(pair));
    client.on('data', (chunk) => upstream.write(chunk));
    // dropReplies loses what the dialed side answers (acks) while its frames still arrive there.
    upstream.on('data', (chunk) => {
      if (!this.dropReplies) client.write(chunk);
    });
    if (this.paused) {
      client.pause();
      upstream.pause();
    }
  }

  pause() {
    this.paused = true;
    for (const { client, upstream } of this.pairs) {
      client.pause();
      upstream.pause();
    }
  }

  resume() {
    this.paused = false;
    for (const { client, upstream } of this.pairs) {
      client.resume();
      upstream.resume();
    }
  }

  /** Destroys every current socket; the listener keeps accepting. */
  cut() {
    for (const { client, upstream } of [...this.pairs]) {
      client.destroy();
      upstream.destroy();
    }
    this.pairs.clear();
  }

  /** Cuts every socket and stops listening. */
  close() {
    this.cut();
    return new Promise((resolve) => this.server.close(() => resolve()));
  }
}

const SIZE = { cols: 100, rows: 30 };

/** One fake MCP agent session on a server, READY with Conduit's tools. */
export async function startAgent(server) {
  const { sessionId } = await server.c2.call('sessions.create', {
    agentId: FAKE_AGENT_ID,
    home: server.work,
  });
  server.c2.notify('term.resize', { sessionId, ...SIZE });
  const started = await server.c2.call('sessions.start', { sessionId });
  assert(started.ok, `fake start on ${server.label}: ${JSON.stringify(started)}`);
  assert(
    await until(
      () => agentRecords(server, sessionId, 'READY').some((r) => r.tools.includes('send_message')),
      15_000,
    ),
    `fake agent on ${server.label} never READY`,
  );
  return { sessionId, generation: started.generation };
}

export function agentRecords(server, sessionId, kind) {
  const file = join(server.recordsDir, `${sessionId}.jsonl`);
  if (!existsSync(file)) return [];
  const lines = readFileSync(file, 'utf8').split('\n');
  lines.pop();
  return lines.map((l) => JSON.parse(l)).filter((r) => r.kind === kind);
}

/** Types `call <tool> <json>` into the fake agent and returns that call's result. */
export async function callTool(server, agent, tool, args) {
  const before = agentRecords(server, agent.sessionId, 'CALL').length;
  server.c2.notify('term.input', {
    sessionId: agent.sessionId,
    generation: agent.generation,
    data: `call ${tool} ${JSON.stringify(args)}\r`,
  });
  let call;
  assert(
    await until(() => {
      call = agentRecords(server, agent.sessionId, 'CALL')
        .slice(before)
        .find((r) => r.tool === tool);
      return call !== undefined;
    }, 15_000),
    `no ${tool} call on ${server.label}`,
  );
  let result;
  assert(
    await until(() => {
      result = agentRecords(server, agent.sessionId, 'RESULT').find((r) => r.id === call.id);
      return result !== undefined;
    }, 15_000),
    `no ${tool} result on ${server.label}`,
  );
  return result.result;
}
