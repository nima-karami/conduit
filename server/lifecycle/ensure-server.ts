import { execFile } from 'node:child_process';
import { readdir, rename, rm } from 'node:fs/promises';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { HC_PINNED_VERSION } from '../../src/contracts/hc';
import {
  SERVER_PROTOCOL_GENERATION,
  type ServerMethods,
  versionOrder,
} from '../../src/contracts/server-protocol';
import type { InstanceNames } from '../../src/contracts/session-identity';
import { HcDisconnectedError, HcRpcError } from '../../src/hc-client';
import { coreStartCwd, instanceNames } from '../../src/instance-names';
import { readServerSecret } from '../../src/server-secret';
import { hcBinaryOf, hcClient, serverChildEnv, startCore } from '../hc-cli';
import { collectRuntimeGarbage } from '../runtime-dir/gc';
import type { EnsureArgs, StartMethod } from './ensure-args';
import { type HcCliDeps, startSupervisor } from './hc-supervisor';

/** The wrapper `--start scope` puts in front of `hc server start` (argv, never a shell). */
export const SCOPE_PREFIX = ['systemd-run', '--user', '--scope', '--quiet', '--'] as const;

export type EnsureHello = ServerMethods['hello']['result'];

export interface EnsureDeps {
  /** Runs before any start. The real deps log a failed sweep and go on, as the app does. */
  collectGarbage(): Promise<void>;
  startCore(prefix: readonly string[]): Promise<void>;
  startSupervisor(): Promise<{ ok: true } | { ok: false; reason: string }>;
  /** True while the supervisor's unique-named terminal is live. */
  supervisorLive(): Promise<boolean>;
  /** Null when no server answers C2 hello with the secret. */
  hello(): Promise<EnsureHello | null>;
  /** `server.restart`. The server exits right after replying, so a lost reply is not an error. */
  restart(): Promise<void>;
  sleep(ms: number): Promise<void>;
  now(): number;
}

export interface EnsureRunOptions {
  method: StartMethod;
  survivesLogout: boolean;
  /** This build's version: the one ensure brings up, and the one a running server is compared to. */
  version: string;
  stdout: { write(chunk: string): unknown };
}

type EnsureResult =
  | { ok: true; state: 'up'; version: string; survivesLogout: boolean }
  | { ok: false; step: 'start'; detail: string };

/** How long any wait for C2 (hello, the restart's exit, the supervisor's exit) may take. */
const WAIT_MS = 30_000;
const POLL_MS = 250;
/** A name_taken from hc means a supervisor of this instance is already live (plan decision 3). */
const NAME_TAKEN = /name_taken|already named/i;

const prefixOf = (method: StartMethod): readonly string[] =>
  method === 'scope' ? SCOPE_PREFIX : [];

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * The headless start rule (plan decision 3, spec §4.2.4): gc, core, supervisor, then C2 hello. An
 * older server is restarted so the one this build ships takes over; a newer one is reported and
 * never downgraded. `windows-task` only waits, because the scheduled task was registered before.
 */
export async function runEnsureServer(o: EnsureRunOptions, d: EnsureDeps): Promise<number> {
  const finish = (result: EnsureResult) => {
    o.stdout.write(`CONDUIT_RESULT ${JSON.stringify(result)}\n`);
    return result.ok ? 0 : 3;
  };
  const fail = (detail: string) => finish({ ok: false, step: 'start', detail });
  const up = (version: string) =>
    finish({ ok: true, state: 'up', version, survivesLogout: o.survivesLogout });
  const startAll = async (): Promise<string | null> => {
    try {
      await d.startCore(prefixOf(o.method));
    } catch (error) {
      return `hc server start: ${message(error)}`;
    }
    const supervisor = await d.startSupervisor();
    if (!supervisor.ok && !NAME_TAKEN.test(supervisor.reason)) return supervisor.reason;
    return null;
  };
  const headless = o.method !== 'windows-task';

  try {
    if (headless) {
      await d.collectGarbage();
      const failure = await startAll();
      if (failure !== null) return fail(failure);
    }

    const first = await waitFor(d, WAIT_MS, () => d.hello());
    if (first === null) return fail(`no C2 hello within ${WAIT_MS / 1000} s`);
    const order = versionOrder(
      { generation: SERVER_PROTOCOL_GENERATION, version: o.version },
      { generation: first.generation, version: first.serverVersion },
    );
    if (order !== 'appNewer') return up(first.serverVersion);

    await d.restart();
    const gone = await waitFor(d, WAIT_MS, async () => ((await d.hello()) === null ? true : null));
    if (gone === null) return fail('the older server did not exit after server.restart');
    if (headless) {
      const exited = await waitFor(d, WAIT_MS, async () =>
        (await d.supervisorLive()) ? null : true,
      );
      if (exited === null) return fail('the old supervisor did not exit after server.restart');
      const failure = await startAll();
      if (failure !== null) return fail(failure);
    }
    const fresh = await waitFor(d, WAIT_MS, async () => {
      const hello = await d.hello();
      return hello !== null && hello.pid !== first.pid ? hello : null;
    });
    if (fresh === null) return fail('no fresh C2 hello after server.restart');
    return up(fresh.serverVersion);
  } catch (error) {
    return fail(message(error));
  }
}

/** Polls until `check` yields a value or the wait runs out (null). */
async function waitFor<T>(
  d: Pick<EnsureDeps, 'sleep' | 'now'>,
  timeoutMs: number,
  check: () => Promise<T | null>,
): Promise<T | null> {
  const deadline = d.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value !== null) return value;
    if (d.now() >= deadline) return null;
    await d.sleep(POLL_MS);
  }
}

/** `main.js --ensure-server`: the real deps for `runEnsureServer`; the caller prints nothing else. */
export async function runEnsureServerMain(
  a: EnsureArgs,
  o: {
    version: string;
    stdout: EnsureRunOptions['stdout'];
    stderr: { write(chunk: string): unknown };
  },
): Promise<number> {
  const names = instanceNames(a.userData, process.platform, tmpdir());
  const env = serverChildEnv(process.env, names);
  const hcBin = hcBinaryOf(a.hc, names);
  const log = (line: string) => {
    o.stderr.write(`${line}\n`);
  };
  const cli: HcCliDeps = {
    hcExe: hcBin,
    env,
    coreCwd: coreCwdOf(names),
    execFile: runExecFile,
    startCore: () => startCore(hcBin, names, env, prefixOf(a.method)),
    connect: () => hcClient(names, env, log),
  };
  const deps: EnsureDeps = {
    collectGarbage: async () => {
      // Not fatal, as in the app: a failed sweep is a warning and the start goes on.
      try {
        const gc = await collectRuntimeGarbage(
          names.runtimeRoot,
          { appVersion: o.version, hcVersion: HC_PINNED_VERSION },
          {
            readdir: (dir) => readdir(dir),
            rename: (from, to) => rename(from, to),
            rmrf: (dir) => rm(dir, { recursive: true, force: true }),
          },
        );
        if (gc.removed.length || gc.inUse.length) log(`runtime gc: ${JSON.stringify(gc)}`);
      } catch (error) {
        log(`runtime gc failed: ${message(error)}`);
      }
    },
    startCore: (prefix) => startCore(hcBin, names, env, prefix),
    startSupervisor: () =>
      startSupervisor(cli, {
        names,
        nodeExe: process.execPath,
        superviseJs: superviseJsOf(),
        userData: a.userData,
        serverArgs: [],
      }),
    supervisorLive: () => supervisorLive(names, env, log),
    hello: async () => {
      const secret = readServerSecret(a.userData);
      return secret === null ? null : oneShot(names.serverEndpoint, secret, o.version);
    },
    restart: async () => {
      const secret = readServerSecret(a.userData);
      if (secret !== null) await oneShot(names.serverEndpoint, secret, o.version, 'server.restart');
    },
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: Date.now,
  };
  return runEnsureServer(
    { method: a.method, survivesLogout: a.survivesLogout, version: o.version, stdout: o.stdout },
    deps,
  );
}

/** The supervisor runs from the same build as this server: supervise.js sits beside main.js. */
const superviseJsOf = () => join(dirname(__filename), 'supervise.js');

const coreCwdOf = (names: InstanceNames) => coreStartCwd(names.runtimeRoot, HC_PINNED_VERSION);

function runExecFile(
  file: string,
  args: string[],
  o: { env: Record<string, string>; cwd: string; timeoutMs: number },
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(
      file,
      args,
      { env: o.env, cwd: o.cwd, windowsHide: true, timeout: o.timeoutMs },
      (error, stdout, stderr) => {
        const code = error ? (typeof error.code === 'number' ? error.code : 1) : 0;
        resolve({ code, stdout, stderr });
      },
    );
  });
}

/** A supervisor the hc core no longer has is gone; a core that is down has none. */
async function supervisorLive(
  names: InstanceNames,
  env: Record<string, string>,
  log: (line: string) => void,
): Promise<boolean> {
  const hc = hcClient(names, env, log);
  try {
    const terminal = await hc.call('terminal.get', { terminal: names.supervisorName });
    return terminal.state === 'live';
  } catch (error) {
    if (error instanceof HcRpcError && error.kind === 'not_found') return false;
    if (error instanceof HcDisconnectedError) return false;
    throw error;
  } finally {
    hc.close();
  }
}

const C2_ATTEMPT_MS = 2_000;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isHello = (value: unknown): value is EnsureHello =>
  isRecord(value) &&
  typeof value.serverVersion === 'string' &&
  typeof value.generation === 'number' &&
  typeof value.instance === 'string' &&
  typeof value.pid === 'number';

/**
 * One C2 connection: hello with the secret, then optionally `server.restart`. Null when nothing
 * answers hello; the waits in runEnsureServer decide what a null means. A gated method needs the
 * authenticated hello on the same connection (the stop-all client does the same).
 */
function oneShot(
  endpoint: string,
  auth: string,
  appVersion: string,
  method?: 'server.restart',
): Promise<EnsureHello | null> {
  return new Promise((resolve) => {
    const socket = connect(endpoint);
    let hello: EnsureHello | null = null;
    let buffer = '';
    const finish = () => {
      clearTimeout(timer);
      socket.destroy();
      resolve(hello);
    };
    const timer = setTimeout(finish, C2_ATTEMPT_MS);
    socket.on('connect', () => {
      socket.write(frame(1, 'hello', { appVersion, generation: SERVER_PROTOCOL_GENERATION, auth }));
    });
    socket.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      for (let end = buffer.indexOf('\n'); end >= 0; end = buffer.indexOf('\n')) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        let reply: unknown;
        try {
          reply = JSON.parse(line);
        } catch {
          return finish();
        }
        if (!isRecord(reply)) continue;
        if (reply.id === 1) {
          if (!isHello(reply.result)) return finish();
          hello = reply.result;
          if (method === undefined) return finish();
          socket.write(frame(2, method, { reason: 'update' }));
        } else if (reply.id === 2) {
          return finish();
        }
      }
    });
    socket.on('error', finish);
    socket.on('close', finish);
  });
}

const frame = (id: number, method: string, params: Record<string, unknown>) =>
  `${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`;
