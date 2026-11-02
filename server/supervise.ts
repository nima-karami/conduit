import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { access, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  judgePersistedVersion,
  SERVER_EXHAUSTED_FILE,
  SERVER_EXIT,
  SERVER_FILE_VERSION,
  type ServerExhaustion,
  SUPERVISOR_BACKOFF_MS,
  SUPERVISOR_EXHAUSTED_COOLDOWN_MS,
  SUPERVISOR_GIVE_UP,
  SUPERVISOR_MARKER_POLL_MS,
} from '../src/contracts/session-identity';
import { instanceNames } from '../src/instance-names';
import { hcBinaryOf, hcClient, serverChildEnv, stopCore, supervisorCore } from './hc-cli';
import { argValue, requireUserData } from './lifecycle/cli-args';

export { serverChildEnv } from './hc-cli';

export interface SupervisorMarker {
  /** `newer`: a newer supervisor's marker is already there; it stands for ours and is never touched. */
  write(exhaustion: ServerExhaustion): Promise<'written' | 'newer'>;
  exists(): Promise<boolean>;
  remove(): Promise<void>;
}

export interface SuperviseOptions {
  userData: string;
  logPath: string;
  spawnChild: () => Promise<number | null>;
  core?: {
    hasOtherLiveTerminals(): Promise<boolean>;
    stop(): Promise<void>;
  };
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  marker?: SupervisorMarker;
  log?: (message: string) => void;
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
const logToStderr = (line: string) => {
  process.stderr.write(`${line}\n`);
};

function defaultMarker(userData: string, log: (line: string) => void): SupervisorMarker {
  const markerPath = path.join(userData, SERVER_EXHAUSTED_FILE);
  return {
    async write(exhaustion) {
      await mkdir(userData, { recursive: true });
      try {
        const current = JSON.parse(await readFile(markerPath, 'utf8')) as { version?: unknown };
        if (judgePersistedVersion(SERVER_EXHAUSTED_FILE, current.version) === 'newer')
          return 'newer';
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && !(error instanceof SyntaxError))
          throw error;
      }
      const temporaryPath = `${markerPath}.${process.pid}.${randomUUID()}.tmp`;
      const payload = { version: SERVER_FILE_VERSION[SERVER_EXHAUSTED_FILE], ...exhaustion };
      await writeFile(temporaryPath, `${JSON.stringify(payload, null, 2)}\n`, { flag: 'wx' });
      try {
        await rename(temporaryPath, markerPath);
      } catch (error) {
        await unlink(temporaryPath).catch((cleanup: unknown) => {
          log(`could not remove ${temporaryPath}: ${message(cleanup)}`);
        });
        throw error;
      }
      return 'written';
    },
    async exists() {
      try {
        await access(markerPath, fsConstants.F_OK);
        return true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
        throw error;
      }
    },
    async remove() {
      try {
        await unlink(markerPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    },
  };
}

interface Clock {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  log: (line: string) => void;
}

/** D17/F9: the supervisor never exits for good, so no marker failure may end the cooldown early. */
async function coolDown(
  marker: SupervisorMarker,
  exhaustion: ServerExhaustion,
  retryAt: number,
  { now, sleep, log }: Clock,
): Promise<void> {
  let state: 'written' | 'newer';
  try {
    state = await marker.write(exhaustion);
  } catch (error) {
    log(`could not write ${SERVER_EXHAUSTED_FILE}: ${message(error)}`);
    await sleep(Math.max(0, retryAt - now()));
    return;
  }
  const present = async () => {
    try {
      return await marker.exists();
    } catch (error) {
      log(`could not check ${SERVER_EXHAUSTED_FILE}: ${message(error)}`);
      return true;
    }
  };
  while (now() < retryAt && (await present())) {
    await sleep(Math.min(SUPERVISOR_MARKER_POLL_MS, retryAt - now()));
  }
  if (state !== 'written') return;
  try {
    await marker.remove();
  } catch (error) {
    log(`could not remove ${SERVER_EXHAUSTED_FILE}: ${message(error)}`);
  }
}

export async function supervise(options: SuperviseOptions): Promise<number> {
  const log = options.log ?? logToStderr;
  const clock: Clock = {
    now: options.now ?? Date.now,
    sleep: options.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms))),
    log,
  };
  const marker = options.marker ?? defaultMarker(options.userData, log);
  let crashTimes: number[] = [];

  for (;;) {
    let exitCode: number | null;
    try {
      exitCode = await options.spawnChild();
    } catch (error) {
      log(`server spawn failed: ${message(error)}`);
      exitCode = null;
    }
    if (exitCode === SERVER_EXIT.done) return 0;
    if (exitCode === SERVER_EXIT.doneCoreIdle) {
      if (options.core && !(await options.core.hasOtherLiveTerminals())) await options.core.stop();
      return 0;
    }

    const crashedAt = clock.now();
    crashTimes = crashTimes.filter((at) => crashedAt - at < SUPERVISOR_GIVE_UP.windowMs);
    crashTimes.push(crashedAt);

    if (crashTimes.length >= SUPERVISOR_GIVE_UP.crashes) {
      const retryAt = crashedAt + SUPERVISOR_EXHAUSTED_COOLDOWN_MS;
      const exhaustion: ServerExhaustion = {
        at: new Date(crashedAt).toISOString(),
        retryAt: new Date(retryAt).toISOString(),
        lastExitCode: exitCode,
        logPath: options.logPath,
      };
      await coolDown(marker, exhaustion, retryAt, clock);
      crashTimes = [];
      continue;
    }

    await clock.sleep(
      SUPERVISOR_BACKOFF_MS[Math.min(crashTimes.length - 1, SUPERVISOR_BACKOFF_MS.length - 1)],
    );
  }
}

/** A spawn `error` resolves as a crash (null), so the supervisor backs off instead of exiting. */
export function spawnServerChild(
  command: string,
  argv: string[],
  env: Record<string, string>,
  cwd: string,
  log: (line: string) => void = logToStderr,
): Promise<number | null> {
  return new Promise<number | null>((resolve) => {
    const child = spawn(command, argv, { cwd, detached: false, stdio: 'inherit', env });
    child.once('error', (error) => {
      log(`server spawn error: ${message(error)}`);
      resolve(null);
    });
    child.once('close', (code) => resolve(code));
  });
}

async function runCli(): Promise<void> {
  // hc run starts us with cwd = coreStartCwd; a cwd there would block that dir's GC rename (D23, M21).
  process.chdir(__dirname);
  const args = process.argv.slice(2);
  const userData = requireUserData(args);
  const supervisorTerminal = process.env.HC_TERMINAL_ID;
  const names = instanceNames(userData, process.platform === 'win32' ? 'win32' : 'posix', tmpdir());
  const env = serverChildEnv(process.env, names);
  const hc = hcBinaryOf(argValue(args, '--hc'));
  const childArgs = [path.join(__dirname, 'main.js'), ...args];
  if (supervisorTerminal) childArgs.push('--supervisor-terminal', supervisorTerminal);
  await supervise({
    userData,
    logPath: path.join(userData, 'server.log'),
    spawnChild: () => spawnServerChild(process.execPath, childArgs, env, __dirname),
    // Without an hc terminal of our own we run as a plain spawn and there is no core of ours.
    ...(supervisorTerminal
      ? {
          core: supervisorCore(
            () => hcClient(names, env, logToStderr),
            names,
            () => stopCore(hc, env),
            logToStderr,
          ),
        }
      : {}),
  });
}

if (require.main === module) {
  void runCli().catch((error: unknown) => {
    process.stderr.write(`${message(error)}\n`);
    process.exitCode = 1;
  });
}
