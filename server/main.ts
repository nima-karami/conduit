import { appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { version } from '../package.json';
import { instanceNames } from '../src/instance-names';
import { compose, emptyCore } from './compose';
import { argValue, requireUserData } from './lifecycle/cli-args';
import type { ShellCore } from './lifecycle/shell';
import { stopAll } from './lifecycle/stop-all';
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
  if (args.includes('--stop-all')) {
    const result = await stopAll({
      endpoint: names.serverEndpoint,
      version,
      directFallback:
        dependencies.directFallback ??
        (async () => {
          throw new Error('Direct hc fallback not composed');
        }),
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
  const shell = compose({
    transport,
    core: dependencies.core ?? emptyCore(logPath),
    version,
    instance: names.instance,
    logPath,
    ...(supervisorTerminal
      ? { supervisor: { name: names.supervisorName, terminal: supervisorTerminal } }
      : {}),
    writeLog: (line) => appendFileSync(logPath, `${line}\n`),
    exit: async (code) => {
      shell.lifecycle.dispose();
      await transport.close();
      // A handle a service left open must not keep a stopped server alive; the supervisor waits on it.
      if (dependencies.exit) await dependencies.exit(code);
      else process.exit(code);
    },
  });
  handle = shell.handle;
  logError = (error) => shell.log('error', String(error));
  shell.log('info', 'server listening');
  shell.lifecycle.start();
  return {
    transport,
    close: async () => {
      shell.lifecycle.dispose();
      await transport.close();
    },
  };
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
