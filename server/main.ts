import { appendFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { version } from '../package.json';
import { SHIM_LEAF } from '../src/conduit-mcp/install-entries';
import type { InstanceNames } from '../src/contracts/session-identity';
import { instanceNames } from '../src/instance-names';
import { formatRecord } from '../src/logging';
import { compose } from './compose';
import { directStopAll, hcBinaryOf, hcClient, serverChildEnv, startCore, stopCore } from './hc-cli';
import { argValue, requireUserData } from './lifecycle/cli-args';
import type { ShellCore } from './lifecycle/shell';
import { stopAll } from './lifecycle/stop-all';
import type { PreviousShim } from './mcp/install';
import { createServices, type Services } from './services';
import { PipeTransport, type RpcHandler } from './transport/pipe';

export interface MainDependencies {
  core?: ShellCore;
  directFallback?: () => Promise<number>;
  exit?: (code: number) => Promise<void> | void;
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
  const platform = process.platform === 'win32' ? 'win32' : 'posix';
  const names = instanceNames(userData, platform, tmpdir());
  const hcEnv = serverChildEnv(process.env, names);
  const hcBin = hcBinaryOf(argValue(args, '--hc'));
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
  let services: Services | undefined;
  let composed: ReturnType<typeof compose> | undefined;
  if (!dependencies.core) {
    const previousExe = argValue(args, '--previous-exe');
    const previousShim = argValue(args, '--previous-shim');
    services = createServerServices({
      userData,
      names,
      logPath,
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
    version,
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
  return {
    transport,
    close: async () => {
      shell.lifecycle.dispose();
      await services?.close();
      await transport.close();
    },
  };
}

/** The real services over our hc core; tests pass a ShellCore instead. */
function createServerServices(o: {
  userData: string;
  names: InstanceNames;
  logPath: string;
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
    platform: process.platform,
    e2e: o.e2e,
    appVersion: version,
    logPath: o.logPath,
    env: process.env,
    homeDir: homedir(),
    hc: hcClient(o.names, o.hcEnv, (m) => log.warn('hc', m)),
    startCore: () => startCore(o.hcBin, o.names, o.hcEnv),
    packaged: o.shimDir !== undefined,
    previousShims: o.previousShims,
    shim: o.shimDir
      ? {
          execPath: path.join(o.shimDir, 'node.exe'),
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
