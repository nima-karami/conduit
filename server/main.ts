import { appendFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { version } from '../package.json';
import { SHIM_LEAF } from '../src/conduit-mcp/install-entries';
import type { InstanceNames } from '../src/contracts/session-identity';
import { instanceNames } from '../src/instance-names';
import { formatRecord } from '../src/logging';
import { runtimeBinaryName } from '../src/runtime-binary';
import { trayCounts } from '../src/tray-counts';
import { compose } from './compose';
import { directStopAll, hcBinaryOf, hcClient, serverChildEnv, startCore, stopCore } from './hc-cli';
import { argValue, requireUserData } from './lifecycle/cli-args';
import type { ShellCore } from './lifecycle/shell';
import { stopAll } from './lifecycle/stop-all';
import type { PreviousShim } from './mcp/install';
import { createServices, type Services } from './services';
import { PipeTransport, type RpcHandler } from './transport/pipe';
import { createEventTap, startTrayChannel, type TrayProc } from './tray-channel';

export interface MainDependencies {
  /** Keeps the native IPC transport usable when exercising services for another OS. */
  platform?: NodeJS.Platform;
  core?: ShellCore;
  directFallback?: () => Promise<number>;
  exit?: (code: number) => Promise<void> | void;
  /** The supervisor's IPC. Defaults to this process when it runs the real services (spec C8a). */
  trayProc?: TrayProc | null;
}

export async function runServer(
  args: string[],
  dependencies: MainDependencies = {},
): Promise<{
  code?: number;
  transport?: PipeTransport;
  close?(): Promise<void>;
}> {
  const userData = requireUserData(args);
  const serverVersion =
    args.includes('--e2e') && !argValue(args, '--shim-dir')
      ? argValue(args, '--e2e-app-version') || version
      : version;
  const platform = process.platform === 'win32' ? 'win32' : 'posix';
  const names = instanceNames(userData, process.platform, tmpdir());
  const hcEnv = serverChildEnv(process.env, names);
  const hcBin = hcBinaryOf(argValue(args, '--hc'), names);
  if (args.includes('--stop-all')) {
    const result = await stopAll({
      endpoint: names.serverEndpoint,
      version,
      directFallback:
        dependencies.directFallback ??
        (() =>
          directStopAll(
            hcClient(names, hcEnv, (m) => process.stderr.write(`${m}\n`)),
            names,
            () => stopCore(hcBin, hcEnv),
          )),
    });
    if (!result.ok) process.stderr.write(`${result.reason}\n`);
    return { code: result.ok ? 0 : 1 };
  }
  let logError = (error: unknown) => console.error(error);
  const transport = new PipeTransport(names.serverEndpoint, platform, (error) => logError(error));
  let handle: RpcHandler = async () => {
    throw new Error('Server composition pending');
  };
  if (!(await transport.listen((request, peer) => handle(request, peer)))) return { code: 0 };
  const logPath = path.join(userData, 'server.log');
  const supervisorTerminal = argValue(args, '--supervisor-terminal');
  const trayProc =
    dependencies.trayProc === undefined
      ? dependencies.core
        ? null
        : process
      : dependencies.trayProc;
  const tapped = trayProc ? createEventTap(transport.emit) : null;
  if (tapped) transport.emit = tapped.emit;
  let services: Services | undefined;
  let composed: ReturnType<typeof compose> | undefined;
  if (!dependencies.core) {
    const previousExe = argValue(args, '--previous-exe');
    const previousShim = argValue(args, '--previous-shim');
    services = createServerServices({
      platform: dependencies.platform ?? process.platform,
      userData,
      names,
      logPath,
      appVersion: serverVersion,
      e2e: args.includes('--e2e'),
      shimDir: argValue(args, '--shim-dir'),
      previousShims:
        previousExe && previousShim ? [{ execPath: previousExe, shimPath: previousShim }] : [],
      hcEnv,
      hcBin,
      transport,
      shell: () => composed,
    });
  }
  const core = dependencies.core ?? services?.core;
  if (!core) throw new Error('Server core composition failed');
  const shell = compose({
    transport,
    core,
    ...(services
      ? {
          dispatch: services.dispatch,
          disconnected: services.disconnected,
          connected: services.connected,
        }
      : {}),
    version: serverVersion,
    instance: names.instance,
    logPath,
    ...(supervisorTerminal
      ? { supervisor: { name: names.supervisorName, terminal: supervisorTerminal } }
      : {}),
    writeLog: (line) => appendFileSync(logPath, `${line}\n`),
    exit: async (code) => {
      shell.lifecycle.dispose();
      try {
        await services?.close();
        await transport.close();
      } catch (error) {
        logError(error);
      } finally {
        // A handle a service left open must not keep a stopped server alive; the supervisor waits on it.
        if (dependencies.exit) await dependencies.exit(code);
        else process.exit(code);
      }
    },
  });
  composed = shell;
  handle = shell.handle;
  logError = (error) => shell.log('error', String(error));
  shell.log('info', 'server listening');
  shell.lifecycle.start();
  const channel =
    trayProc && tapped
      ? startTrayChannel({
          proc: trayProc,
          tap: tapped.tap,
          initial: () => trayCounts(core.snapshot().sessions, shell.lifecycle.runtime.state, null),
          stopAll: shell.stopAll,
          log: (message) => shell.log('warn', message),
        })
      : null;
  channel?.ready();
  return {
    transport,
    close: async () => {
      channel?.dispose();
      shell.lifecycle.dispose();
      await services?.close();
      await transport.close();
    },
  };
}

/** The real services over our hc core; tests pass a ShellCore instead. */
function createServerServices(o: {
  platform: NodeJS.Platform;
  userData: string;
  names: InstanceNames;
  logPath: string;
  appVersion: string;
  e2e: boolean;
  shimDir?: string;
  previousShims: readonly PreviousShim[];
  hcEnv: Record<string, string>;
  hcBin: string;
  transport: PipeTransport;
  /** Undefined while the services are being built, before compose exists. */
  shell: () => ReturnType<typeof compose> | undefined;
}): Services {
  const at =
    (level: 'debug' | 'info' | 'warn' | 'error') =>
    (scope: string, msg: string, data?: Record<string, unknown>) => {
      const shell = o.shell();
      // Load-time warnings come before compose and its logging settings: written at the default.
      if (shell) shell.record(level, scope, msg, data);
      else
        appendFileSync(
          o.logPath,
          `${formatRecord({ ts: Date.now(), level, scope, msg, ...(data ? { data } : {}) })}\n`,
        );
    };
  const log = { debug: at('debug'), info: at('info'), warn: at('warn'), error: at('error') };
  return createServices({
    userData: o.userData,
    names: o.names,
    platform: o.platform,
    e2e: o.e2e,
    appVersion: o.appVersion,
    logPath: o.logPath,
    env: process.env,
    homeDir: homedir(),
    hc: hcClient(o.names, o.hcEnv, (m) => log.warn('hc', m)),
    startCore: () => startCore(o.hcBin, o.names, o.hcEnv),
    packaged: o.shimDir !== undefined,
    previousShims: o.previousShims,
    shim: o.shimDir
      ? {
          execPath: path.join(o.shimDir, runtimeBinaryName('node', o.platform)),
          shimPath: path.join(o.shimDir, SHIM_LEAF),
        }
      : {
          execPath: process.execPath,
          shimPath: path.join(__dirname, '..', '..', 'resources', 'conduit-mcp', SHIM_LEAF),
        },
    emit: o.transport.emit,
    emitTo: o.transport.emitTo,
    stopping: () => o.shell()?.lifecycle.stopping ?? false,
    onHealth: (health) => {
      const shell = o.shell();
      if (shell) shell.lifecycle.runtime = health;
      o.transport.emit('runtime.changed', health);
    },
    log,
  });
}

if (require.main === module) {
  void runServer(process.argv.slice(2))
    .then((result) => {
      if (result.code !== undefined) process.exitCode = result.code;
    })
    .catch((error: unknown) => {
      process.stderr.write(`${String(error)}\n`);
      process.exitCode = 1;
    });
}
