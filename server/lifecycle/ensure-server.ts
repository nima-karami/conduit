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
import type { StartMethod } from '../../src/network/remote-scripts';
import { readServerSecret } from '../../src/server-secret';
import { hcBinaryOf, hcClient, serverChildEnv, startCore } from '../hc-cli';
import { collectRuntimeGarbage } from '../runtime-dir/gc';
import type { EnsureArgs } from './ensure-args';
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
  /**
   * `server.restart`. Null when it was sent: the server exits right after replying, so a lost reply
   * is normal. Otherwise the error the server replied with, which is the caller's failure detail.
   */
  restart(): Promise<string | null>;
  sleep(ms: number): Promise<void>;
  now(): number;
}

export interface EnsureRunOptions {
  method: StartMethod;
  survivesLogout: boolean;
  /** This build's version: the one ensure brings up, and the one a running server is compared to. */
  version: string;
  stdout: { write(chunk: string): unknown };
  /** Bounds the whole run, so a hc call that never returns still ends in a result line. */
  deadlineMs?: number;
}

type EnsureResult =
  | { ok: true; state: 'up'; version: string; survivesLogout: boolean }
  | { ok: false; step: 'start'; detail: string };

/** How long any wait for C2 (hello, the restart's exit, the supervisor's exit) may take. */
const WAIT_MS = 30_000;
const POLL_MS = 250;
/** The whole run, as a bound on any single hc call that never returns. */
const RUN_DEADLINE_MS = 90_000;
/** As electron/server-lifecycle.ts's SUPERVISOR_LOOKUP_TIMEOUT_MS: a lookup past this is a core not answering. */
const SUPERVISOR_LOOKUP_TIMEOUT_MS = 5_000;
/** A name_taken from hc means a supervisor of this instance is already live (plan decision 3). */
const NAME_TAKEN = /name_taken|already named/i;

const prefixOf = (method: StartMethod): readonly string[] =>
  method === 'scope' ? SCOPE_PREFIX : [];

/** The server's own argv from the ensure flags: the same `--shim-dir` the app passes its supervisor. */
export const ensureServerArgs = (a: Pick<EnsureArgs, 'shimDir'>): string[] =>
  a.shimDir ? ['--shim-dir', a.shimDir] : [];

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** The one result line. Written by whoever gets there first; the run may already have ended. */
function printResult(stdout: EnsureRunOptions['stdout'], result: EnsureResult): number {
  stdout.write(`CONDUIT_RESULT ${JSON.stringify(result)}\n`);
  return result.ok ? 0 : 3;
}

/** Rejects with `what timed out` when `p` has not settled in `ms`: a bound on a call that may never return. */
export function bounded<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} timed out`)), ms);
  });
  return Promise.race([p, expired]).finally(() => clearTimeout(timer));
}

/**
 * The headless start rule (plan decision 3, spec §4.2.4): gc, core, supervisor, then C2 hello. An
 * older server is restarted so the one this build ships takes over; a newer one is reported and
 * never downgraded. `windows-task` only waits, because the scheduled task was registered before.
 */
export async function runEnsureServer(o: EnsureRunOptions, d: EnsureDeps): Promise<number> {
  let printed = false;
  const finish = (result: EnsureResult) => {
    if (printed) return result.ok ? 0 : 3;
    printed = true;
    return printResult(o.stdout, result);
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
  const ours = { generation: SERVER_PROTOCOL_GENERATION, version: o.version };
  const theirs = (hello: EnsureHello) => ({
    generation: hello.generation,
    version: hello.serverVersion,
  });

  const body = async (): Promise<number> => {
    if (headless) {
      await d.collectGarbage();
      const failure = await startAll();
      if (failure !== null) return fail(failure);
    }

    const first = await waitFor(d, WAIT_MS, () => d.hello());
    if (first === null) return fail(`no C2 hello within ${WAIT_MS / 1000} s`);
    if (versionOrder(ours, theirs(first)) !== 'appNewer') return up(first.serverVersion);
    // Plan decision 5: on this path nothing starts a server after server.restart, so restarting
    // would only wait out the timeout. Refused now; the scheduled task has to be re-registered.
    if (o.method === 'windows-task') return fail('windows_upgrade_pending');

    const restartError = await d.restart();
    if (restartError !== null) return fail(restartError);
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
    // The restart can lose the race to an older app that relaunched its own supervisor first
    // (name_taken). The server that answers now is the one that counts.
    if (versionOrder(ours, theirs(fresh)) === 'appNewer') return fail('older_server_relaunched');
    return up(fresh.serverVersion);
  };

  const run = async (): Promise<number> => {
    try {
      return await body();
    } catch (error) {
      return fail(message(error));
    }
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<number>((resolve) => {
    timer = setTimeout(() => resolve(fail('timeout')), o.deadlineMs ?? RUN_DEADLINE_MS);
  });
  try {
    return await Promise.race([run(), deadline]);
  } finally {
    clearTimeout(timer);
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

/** `main.js --ensure-server`: the real deps for `runEnsureServer`. Any throw here is still one result line. */
export async function runEnsureServerMain(
  a: EnsureArgs,
  o: {
    version: string;
    stdout: EnsureRunOptions['stdout'];
    stderr: { write(chunk: string): unknown };
  },
): Promise<number> {
  const clients: { close(): void }[] = [];
  try {
    const names = instanceNames(a.userData, process.platform, tmpdir());
    const env = serverChildEnv(process.env, names);
    const hcBin = hcBinaryOf(a.hc, names);
    const log = (line: string) => {
      o.stderr.write(`${line}\n`);
    };
    // Every client is closed when the run ends, so a call that never returns cannot keep the process up.
    const open = () => {
      const client = hcClient(names, env, log);
      clients.push(client);
      return client;
    };
    const cli: HcCliDeps = {
      hcExe: hcBin,
      env,
      coreCwd: coreCwdOf(names),
      execFile: runExecFile,
      startCore: () => startCore(hcBin, names, env, prefixOf(a.method)),
      connect: open,
    };
    const deps: EnsureDeps = {
      collectGarbage: async () => {
        // Not fatal, as in the app: a failed sweep is a warning and the start goes on. Staging
        // dirs are not swept: another writer may be filling one.
        try {
          const gc = await collectRuntimeGarbage(
            names.runtimeRoot,
            { appVersion: o.version, hcVersion: HC_PINNED_VERSION },
            {
              readdir: (dir) => readdir(dir),
              rename: (from, to) => rename(from, to),
              rmrf: (dir) => rm(dir, { recursive: true, force: true }),
            },
            { sweepStaging: false },
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
          serverArgs: ensureServerArgs(a),
        }),
      supervisorLive: () => supervisorLive(names.supervisorName, open),
      hello: async () => {
        const secret = readServerSecret(a.userData);
        return secret === null
          ? null
          : (await oneShot(names.serverEndpoint, secret, o.version)).hello;
      },
      restart: async () => {
        const secret = readServerSecret(a.userData);
        if (secret === null) return 'server secret is gone before server.restart';
        return (await oneShot(names.serverEndpoint, secret, o.version, 'server.restart')).error;
      },
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      now: Date.now,
    };
    return await runEnsureServer(
      { method: a.method, survivesLogout: a.survivesLogout, version: o.version, stdout: o.stdout },
      deps,
    );
  } catch (error) {
    return printResult(o.stdout, { ok: false, step: 'start', detail: message(error) });
  } finally {
    for (const client of clients) client.close();
  }
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
  supervisorName: string,
  open: () => ReturnType<typeof hcClient>,
): Promise<boolean> {
  const hc = open();
  try {
    const terminal = await bounded(
      hc.call('terminal.get', { terminal: supervisorName }),
      SUPERVISOR_LOOKUP_TIMEOUT_MS,
      'supervisor lookup',
    );
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

interface C2Reply {
  hello: EnsureHello | null;
  /** Set when `server.restart` was asked and the server replied with an error (or never said hello). */
  error: string | null;
}

/**
 * One C2 connection: hello with the secret, then optionally `server.restart`. A gated method needs the
 * authenticated hello on the same connection (the stop-all client does the same).
 */
function oneShot(
  endpoint: string,
  auth: string,
  appVersion: string,
  method?: 'server.restart',
): Promise<C2Reply> {
  return new Promise((resolve) => {
    const socket = connect(endpoint);
    let hello: EnsureHello | null = null;
    let error: string | null = null;
    let buffer = '';
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      socket.destroy();
      if (method !== undefined && hello === null && error === null)
        error = 'C2 hello failed before server.restart';
      resolve({ hello, error });
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
          if (reply.error !== undefined)
            error =
              isRecord(reply.error) && typeof reply.error.message === 'string'
                ? reply.error.message
                : `${method} failed`;
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
