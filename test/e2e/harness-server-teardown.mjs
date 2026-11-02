// Per-scenario Conduit server + hc session teardown (program W8, architecture F12). Pure parts are
// exported for test/unit/e2e-harness-teardown.test.ts; node cannot import src/*.ts, so the name
// derivation is mirrored here and pinned to src/instance-names.ts by that test.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { connect as netConnect } from 'node:net';
import { posix, win32 } from 'node:path';

// Mirror STOP_ALL_*_TIMEOUT_MS and SERVER_PROTOCOL_GENERATION in src/contracts/server-protocol.ts
// (pinned by the unit test).
export const STOP_ALL_CONNECT_TIMEOUT_MS = 5_000;
export const STOP_ALL_ANSWER_TIMEOUT_MS = 20_000;
export const SERVER_PROTOCOL_GENERATION = 1;

const MAX_SOCKET_PATH_BYTES = 100;
const HC_CALL_TIMEOUT_MS = 20_000;

/** @param {string} userData @param {'win32'|'posix'} platform @param {string} tmpdir */
export function teardownNames(userData, platform, tmpdir) {
  const identity = platform === 'win32' ? userData.toLowerCase() : userData;
  const instance = createHash('sha256').update(identity).digest('hex').slice(0, 16);
  const path = platform === 'win32' ? win32 : posix;
  const profileEndpoint = path.join(userData, 'conduit-server.sock');
  return {
    serverEndpoint:
      platform === 'win32'
        ? `\\\\.\\pipe\\conduit-server-${instance}`
        : Buffer.byteLength(profileEndpoint, 'utf8') > MAX_SOCKET_PATH_BYTES
          ? posix.join(tmpdir, `conduit-server-${instance}.sock`)
          : profileEndpoint,
    supervisorName: `conduit-server-${instance}`,
    hcConfigHome: path.join(userData, 'hc', 'config'),
    hcStateHome: path.join(userData, 'hc', 'state'),
    hcSession: `conduit-${instance}`,
  };
}

/**
 * The only hc session this teardown may touch is one a scenario's own profile derives; refusing
 * anything else keeps a bug here from killing the runner's or the developer's real session.
 */
export function assertOwnSession(hcSession, inheritedSession) {
  if (!hcSession.startsWith('conduit-')) {
    throw new Error(`teardown: refusing hc session ${hcSession} (not conduit-*)`);
  }
  if (inheritedSession && hcSession === inheritedSession) {
    throw new Error(`teardown: refusing the runner's own hc session ${hcSession}`);
  }
}

/** Every inherited HC_* dropped (hc would otherwise address the runner's core), then our session and the XDG dirs the app starts its core with. */
export function hcEnv(inherited, names) {
  const env = {};
  for (const [k, v] of Object.entries(inherited)) {
    if (!k.toUpperCase().startsWith('HC_')) env[k] = v;
  }
  env.HC_SESSION = names.hcSession;
  env.XDG_CONFIG_HOME = names.hcConfigHome;
  env.XDG_STATE_HOME = names.hcStateHome;
  return env;
}

export function hcCalls(supervisorName) {
  return [
    { args: ['kill', supervisorName], ignore: /not[ _-]?found/i },
    { args: ['server', 'stop'], ignore: /not running/i },
  ];
}

/**
 * @typedef {(bin: string, args: string[], opts: { env: Record<string, string>, timeout: number }) =>
 *   { status: number | null, stdout?: string, stderr?: string, error?: { code?: string } }} Exec
 */

/** @param {{ exec: Exec, bin: string, names: ReturnType<typeof teardownNames>, inheritedEnv: Record<string, string | undefined>, log: (...a: any[]) => void }} o */
export function stopHc({ exec, bin, names, inheritedEnv, log }) {
  assertOwnSession(names.hcSession, inheritedEnv.HC_SESSION);
  const env = hcEnv(inheritedEnv, names);
  for (const { args, ignore } of hcCalls(names.supervisorName)) {
    const r = exec(bin, args, { env, timeout: HC_CALL_TIMEOUT_MS });
    const label = `hc ${args.join(' ')}`;
    if (r.error?.code === 'ENOENT') {
      log(`teardown: hc unavailable (${bin}), skipped`);
      return;
    }
    const text = `${r.stdout ?? ''}${r.stderr ?? ''}`;
    if (r.error) log(`teardown: ${label} failed: ${r.error.code ?? r.error}`);
    else if (r.status === 0) log(`teardown: ${label} ok`);
    else if (ignore.test(text)) log(`teardown: ${label}: nothing to stop`);
    else log(`teardown: ${label} exit ${r.status}: ${text.trim().slice(0, 200)}`);
  }
}

/**
 * C2 `server.stopAll`. Resolves with an outcome; never rejects.
 * @param {{ endpoint: string, appVersion: string, connect?: typeof netConnect,
 *   connectTimeoutMs?: number, answerTimeoutMs?: number }} o
 * @returns {Promise<{ outcome: 'no-server' | 'stopped' | 'closed' | 'timeout' | 'error', detail?: string }>}
 */
export function stopAllViaServer({
  endpoint,
  appVersion,
  connect = netConnect,
  connectTimeoutMs = STOP_ALL_CONNECT_TIMEOUT_MS,
  answerTimeoutMs = STOP_ALL_ANSWER_TIMEOUT_MS,
}) {
  return new Promise((resolve) => {
    let settled = false;
    let timer;
    let buf = '';
    const sock = connect(endpoint);
    const done = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      sock.destroy();
      resolve(value);
    };
    const send = (id, method, params) =>
      sock.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    timer = setTimeout(
      () => done({ outcome: 'timeout', detail: 'connect/hello' }),
      connectTimeoutMs,
    );
    sock.on('error', (e) => {
      const gone = e.code === 'ENOENT' || e.code === 'ECONNREFUSED';
      done(gone ? { outcome: 'no-server' } : { outcome: 'error', detail: e.code ?? String(e) });
    });
    sock.on('close', () => done({ outcome: 'closed' }));
    sock.on('connect', () =>
      send(1, 'hello', { appVersion, generation: SERVER_PROTOCOL_GENERATION }),
    );
    sock.on('data', (chunk) => {
      buf += chunk;
      let nl = buf.indexOf('\n');
      while (nl >= 0 && !settled) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        nl = buf.indexOf('\n');
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        if (msg.id === 1) {
          clearTimeout(timer);
          timer = setTimeout(
            () => done({ outcome: 'timeout', detail: 'stopAll answer' }),
            answerTimeoutMs,
          );
          if (msg.error) {
            done({ outcome: 'error', detail: `hello: ${msg.error.message}` });
            return;
          }
          send(2, 'server.stopAll', {});
        } else if (msg.id === 2) {
          done(
            msg.error
              ? { outcome: 'error', detail: msg.error.message }
              : { outcome: 'stopped', detail: `killed ${msg.result?.killed}` },
          );
        }
      }
    });
  });
}

const realExec = (bin, args, opts) =>
  spawnSync(bin, args, { ...opts, encoding: 'utf8', windowsHide: true });

/**
 * Stop the server and hc session a scenario's profile owns. Only the session guard throws; the
 * scenario's own result must survive a teardown failure.
 * @param {{ userDataDir: string, log: (...a: any[]) => void, platform?: string, tmpdir: string,
 *   env?: Record<string, string | undefined>, exec?: Exec, stopAll?: typeof stopAllViaServer,
 *   appVersion?: string }} o
 */
export async function teardownScenarioServer({
  userDataDir,
  log,
  tmpdir,
  platform = process.platform,
  env = process.env,
  exec = realExec,
  stopAll = stopAllViaServer,
  appVersion,
}) {
  const names = teardownNames(userDataDir, platform === 'win32' ? 'win32' : 'posix', tmpdir);
  assertOwnSession(names.hcSession, env.HC_SESSION);
  try {
    const version =
      appVersion ??
      JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version;
    const r = await stopAll({ endpoint: names.serverEndpoint, appVersion: version });
    log(`teardown: server.stopAll ${r.outcome}${r.detail ? ` (${r.detail})` : ''}`);
    stopHc({ exec, bin: env.CONDUIT_HC_BINARY || 'hc', names, inheritedEnv: env, log });
  } catch (e) {
    log(`teardown: failed: ${e?.message || e}`);
  }
}
