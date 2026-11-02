import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { access, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  coreStartEnv,
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

export interface SupervisorMarker {
  write(exhaustion: ServerExhaustion): Promise<void>;
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
}

function defaultMarker(userData: string): SupervisorMarker {
  const markerPath = path.join(userData, SERVER_EXHAUSTED_FILE);
  return {
    async write(exhaustion) {
      await mkdir(userData, { recursive: true });
      try {
        const current = JSON.parse(await readFile(markerPath, 'utf8')) as { version?: unknown };
        if (judgePersistedVersion(SERVER_EXHAUSTED_FILE, current.version) === 'newer') {
          throw new Error(`Refusing to overwrite newer ${SERVER_EXHAUSTED_FILE}`);
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && !(error instanceof SyntaxError))
          throw error;
      }
      const temporaryPath = `${markerPath}.${process.pid}.${randomUUID()}.tmp`;
      const payload = {
        version: SERVER_FILE_VERSION[SERVER_EXHAUSTED_FILE],
        ...exhaustion,
      };
      await writeFile(temporaryPath, `${JSON.stringify(payload, null, 2)}\n`, { flag: 'wx' });
      try {
        await rename(temporaryPath, markerPath);
      } catch (error) {
        try {
          await unlink(temporaryPath);
        } catch (cleanupError) {
          if ((cleanupError as NodeJS.ErrnoException).code !== 'ENOENT') {
            throw new AggregateError(
              [error, cleanupError],
              'Could not publish exhaustion marker or remove its temporary file',
            );
          }
        }
        throw error;
      }
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

async function waitForMarker(
  marker: SupervisorMarker,
  retryAt: number,
  now: () => number,
  sleep: (ms: number) => Promise<void>,
): Promise<void> {
  while (now() < retryAt && (await marker.exists())) {
    await sleep(Math.min(SUPERVISOR_MARKER_POLL_MS, retryAt - now()));
  }
  if (await marker.exists()) await marker.remove();
}

export async function supervise(options: SuperviseOptions): Promise<number> {
  const sleep = options.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = options.now ?? Date.now;
  const marker = options.marker ?? defaultMarker(options.userData);
  let crashTimes: number[] = [];
  let streak = 0;

  for (;;) {
    const exitCode = await options.spawnChild();
    if (exitCode === SERVER_EXIT.done) return 0;
    if (exitCode === SERVER_EXIT.doneCoreIdle) {
      if (options.core && !(await options.core.hasOtherLiveTerminals())) await options.core.stop();
      return 0;
    }

    const crashedAt = now();
    crashTimes = crashTimes.filter((at) => crashedAt - at < SUPERVISOR_GIVE_UP.windowMs);
    crashTimes.push(crashedAt);
    streak += 1;

    if (crashTimes.length >= SUPERVISOR_GIVE_UP.crashes) {
      const retryAt = crashedAt + SUPERVISOR_EXHAUSTED_COOLDOWN_MS;
      await marker.write({
        at: new Date(crashedAt).toISOString(),
        retryAt: new Date(retryAt).toISOString(),
        lastExitCode: exitCode,
        logPath: options.logPath,
      });
      await waitForMarker(marker, retryAt, now, sleep);
      crashTimes = [];
      streak = 0;
      continue;
    }

    const backoff = SUPERVISOR_BACKOFF_MS[Math.min(streak - 1, SUPERVISOR_BACKOFF_MS.length - 1)];
    await sleep(backoff);
  }
}

function parseUserData(args: string[]): string {
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--user-data' && args[i + 1]) return args[i + 1];
    if (args[i].startsWith('--user-data=')) return args[i].slice('--user-data='.length);
  }
  throw new Error('Missing required --user-data argument');
}

async function spawnServer(
  args: string[],
  userData: string,
  supervisorTerminal: string | undefined,
): Promise<number | null> {
  const runtimeDir = __dirname;
  const entry = path.join(runtimeDir, 'main.js');
  const childArgs = [...args];
  if (supervisorTerminal) childArgs.push('--supervisor-terminal', supervisorTerminal);

  return await new Promise<number | null>((resolve, reject) => {
    const child = spawn(process.execPath, [entry, ...childArgs], {
      cwd: runtimeDir,
      detached: false,
      stdio: 'inherit',
      env: coreStartEnv(
        process.env,
        instanceNames(userData, process.platform === 'win32' ? 'win32' : 'posix', tmpdir()),
        false,
      ),
    });
    child.once('error', reject);
    child.once('close', (code) => resolve(code));
  });
}

async function runCli(): Promise<void> {
  const args = process.argv.slice(2);
  const userData = parseUserData(args);
  const supervisorTerminal = process.env.HC_TERMINAL_ID;
  await supervise({
    userData,
    logPath: path.join(userData, 'server.log'),
    spawnChild: () => spawnServer(args, userData, supervisorTerminal),
  });
}

if (require.main === module) {
  void runCli().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
