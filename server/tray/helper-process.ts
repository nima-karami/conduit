import { spawn } from 'node:child_process';
import {
  HELPER_ENV_KEYS,
  type HelperToSupervisor,
  type SupervisorToHelper,
  TRAY_EXIT,
  TRAY_LIMITS,
} from '../../src/contracts/tray-protocol';
import type { HelperHandle, HelperLauncher, TrayLog } from './contracts';
import { encodeHelperLine, LineDecoder, parseHelperLine } from './framing';
import type { InstallResult } from './install';

/** A spawned helper as the launcher sees it; `nodeSpawnHelper` adapts a real child process. */
export interface HelperChild {
  readonly pid: number | undefined;
  write(line: string): void;
  end(): void;
  kill(): void;
  onStdout(cb: (chunk: Buffer) => void): void;
  onStderr(cb: (chunk: Buffer) => void): void;
  /** Once: the exit code, or null for a signal or a spawn error. */
  onExit(cb: (code: number | null) => void): void;
}

export interface HelperSpawnOptions {
  cwd: string;
  env: Record<string, string>;
  stdio: ['pipe', 'pipe', 'pipe'];
  windowsHide: true;
  detached: false;
}

export type HelperSpawn = (
  exe: string,
  args: readonly string[],
  options: HelperSpawnOptions,
) => HelperChild;

/** Spec §6 Env: nothing that reaches C2, MCP or hc. Windows env names are case-insensitive. */
export function helperEnv(
  env: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of HELPER_ENV_KEYS) {
    const found = Object.keys(env).find((k) => k.toUpperCase() === key.toUpperCase());
    const value = found === undefined ? undefined : env[found];
    if (value !== undefined) out[key] = value;
  }
  return out;
}

/**
 * 'exit' alone isn't enough: the last stdout lines (`hidden`) may still be in the pipe. 'close'
 * alone isn't safe: a process the helper launched could hold an inherited pipe open forever. So
 * whichever comes first of 'close', or 'exit' plus a short drain.
 */
const EXIT_DRAIN_MS = 250;

export function nodeSpawnHelper(
  exe: string,
  args: readonly string[],
  options: HelperSpawnOptions,
  log: (message: string) => void,
): HelperChild {
  const child = spawn(exe, args, options);
  const exitCbs: ((code: number | null) => void)[] = [];
  let code: number | null | undefined;
  let done = false;
  const finish = (c: number | null) => {
    if (done) return;
    done = true;
    for (const cb of exitCbs) cb(c);
  };
  child.once('error', (error) => {
    log(`tray helper spawn error: ${error.message}`);
    if (code === undefined) finish(null);
  });
  child.once('exit', (c) => {
    code = c;
    setTimeout(() => finish(c), EXIT_DRAIN_MS).unref();
  });
  child.once('close', (c) => finish(code ?? c));
  child.stdin.on('error', (error) => log(`tray helper stdin: ${error.message}`));
  return {
    get pid() {
      return child.pid;
    },
    write: (line) => {
      child.stdin.write(line);
    },
    end: () => child.stdin.end(),
    kill: () => {
      child.kill();
    },
    onStdout: (cb) => child.stdout.on('data', cb),
    onStderr: (cb) => child.stderr.on('data', cb),
    onExit: (cb) => {
      exitCbs.push(cb);
    },
  };
}

const NOT_RESTARTED: ReadonlySet<number | null> = new Set([
  TRAY_EXIT.asked,
  TRAY_EXIT.shellUnavailable,
  TRAY_EXIT.protocol,
]);

/**
 * F7: one logical helper across restarts. The handle replays the last `init` and `view` to each
 * restarted process, so the relay never needs to know a restart happened. A protocol violation
 * seen here is treated like the helper's own `protocol` exit: a restart can't fix a bad binary.
 */
export function createHelperLauncher(deps: {
  install: () => Promise<InstallResult>;
  spawn: HelperSpawn;
  env: Readonly<Record<string, string | undefined>>;
  cwd: string;
  log: TrayLog;
  now: () => number;
  setTimer: (ms: number, cb: () => void) => () => void;
}): HelperLauncher {
  const info = (m: string) => deps.log.write('info', 'supervisor', m);
  const warn = (m: string) => deps.log.write('warn', 'supervisor', m);
  const error = (m: string) => deps.log.write('error', 'supervisor', m);

  return {
    async start(onMessage) {
      let child: HelperChild | null = null;
      let init: SupervisorToHelper | null = null;
      let view: SupervisorToHelper | null = null;
      let exitAsked = false;
      let cancelRestart: (() => void) | null = null;
      let crashes: number[] = [];
      let settle: (code: number | null) => void = () => {};
      let settled = false;
      const exited = new Promise<number | null>((resolve) => {
        settle = resolve;
      });
      const end = (code: number | null) => {
        if (settled) return;
        settled = true;
        child = null;
        settle(code);
      };

      const write = (c: HelperChild, m: SupervisorToHelper) => {
        try {
          c.write(encodeHelperLine(m));
        } catch (e) {
          error(`tray helper: could not send ${m.type}: ${String(e)}`);
        }
      };

      const deliver = (m: HelperToSupervisor) => {
        try {
          onMessage(m);
        } catch (e) {
          error(`tray relay failed on ${m.type}: ${String(e)}`);
        }
      };

      const run = async (): Promise<boolean> => {
        let installed: InstallResult;
        try {
          installed = await deps.install();
        } catch (e) {
          error(`tray helper install failed: ${String(e)}`);
          return false;
        }
        if (installed.swapped) info(`tray helper swap: installed ${installed.exe}`);
        if (installed.note) warn(`tray helper install: ${installed.note}`);
        let c: HelperChild;
        try {
          c = deps.spawn(installed.exe, [], {
            cwd: deps.cwd,
            env: helperEnv(deps.env),
            stdio: ['pipe', 'pipe', 'pipe'],
            windowsHide: true,
            detached: false,
          });
        } catch (e) {
          error(`tray helper spawn failed: ${String(e)}`);
          onExit(null, false);
          return true;
        }
        child = c;
        info(`tray helper spawn pid=${c.pid ?? '?'} exe=${installed.exe}`);
        let protocolFailed = false;
        const out = new LineDecoder(TRAY_LIMITS.maxLineBytes);
        c.onStdout((chunk) => {
          if (protocolFailed) return;
          const { lines, error: tooLong } = out.push(chunk);
          for (const line of lines) {
            if (!line) continue;
            const m = parseHelperLine(line);
            if (m instanceof Error) {
              protocolFailed = true;
              break;
            }
            if (m.type === 'unknown') warn(`tray helper: ignored unknown message ${line}`);
            else deliver(m);
          }
          if (tooLong) protocolFailed = true;
          if (protocolFailed) {
            error(`tray helper protocol error: ${tooLong?.message ?? 'invalid message'}; killing`);
            c.kill();
          }
        });
        const err = new LineDecoder(1_024, 'truncate');
        c.onStderr((chunk) => {
          for (const line of err.push(chunk).lines)
            if (line) deps.log.write('warn', 'helper', line);
        });
        c.onExit((code) => onExit(code, protocolFailed));
        if (init) write(c, init);
        if (view) write(c, view);
        // `exit` can land while a restart's install is still running.
        if (exitAsked) {
          write(c, { type: 'exit' });
          c.end();
        }
        return true;
      };

      function onExit(code: number | null, protocolFailed: boolean) {
        info(`tray helper exit code=${code}`);
        child = null;
        if (exitAsked || protocolFailed || NOT_RESTARTED.has(code)) return end(code);
        const at = deps.now();
        crashes = crashes.filter((t) => at - t < TRAY_LIMITS.helperGiveUp.windowMs);
        crashes.push(at);
        if (crashes.length > TRAY_LIMITS.helperGiveUp.crashes) {
          error(
            `tray helper: gave up after ${crashes.length} crashes in ${TRAY_LIMITS.helperGiveUp.windowMs / 60_000} min`,
          );
          return end(code);
        }
        const delays = TRAY_LIMITS.helperRestartMs;
        const ms = delays[Math.min(crashes.length, delays.length) - 1];
        info(`tray helper restart in ${ms} ms`);
        cancelRestart = deps.setTimer(ms, () => {
          cancelRestart = null;
          void run().then(
            (ok) => {
              if (!ok) end(code);
            },
            (e: unknown) => {
              error(`tray helper restart failed: ${String(e)}`);
              end(code);
            },
          );
        });
      }

      if (!(await run())) return null;

      const handle: HelperHandle = {
        get pid() {
          return child?.pid ?? 0;
        },
        exited,
        send(m) {
          if (m.type === 'init') init = m;
          if (m.type === 'view') view = m;
          if (m.type === 'exit') {
            exitAsked = true;
            if (cancelRestart) {
              cancelRestart();
              cancelRestart = null;
              end(null);
              return;
            }
          }
          const c = child;
          if (!c) return;
          write(c, m);
          if (m.type === 'exit') c.end();
        },
      };
      return handle;
    },
  };
}
