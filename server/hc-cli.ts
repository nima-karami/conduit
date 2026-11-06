import { execFile } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { HC_PINNED_VERSION, type HcClient } from '../src/contracts/hc';
import { type InstanceNames, USER_XDG_PASSTHROUGH } from '../src/contracts/session-identity';
import { HcDisconnectedError, HcRpcError, NodeHcClient } from '../src/hc-client';
import { coreStartCwd, coreStartEnv, ensureHcSocketDirectory } from '../src/instance-names';
import { runtimeBinaryName } from '../src/runtime-binary';

/**
 * See D24: legacy supervisor metadata never controls core isolation.
 */
export const HC_XDG_ISOLATED_ENV = 'CONDUIT_HC_XDG_ISOLATED';

/**
 * See D24: every server hc call uses Conduit's config and state, including standalone startup.
 */
export function serverChildEnv(
  parent: Readonly<Record<string, string | undefined>>,
  names: InstanceNames,
): Record<string, string> {
  const env = coreStartEnv(parent, names);
  delete env[HC_XDG_ISOLATED_ENV];
  delete env.NODE_CHANNEL_FD;
  delete env.NODE_CHANNEL_SERIALIZATION_MODE;
  return env;
}

/**
 * The server process's own env: its supervisor's without HC_*, and never our core's XDG values,
 * which would reach every CLI config path the server resolves. A supervisor still under them (one
 * started by `hc run`) has them swapped for the user's here.
 */
export function serverProcessEnv(
  parent: Readonly<Record<string, string | undefined>>,
  names: Pick<InstanceNames, 'hcConfigHome' | 'hcStateHome'>,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(parent))
    if (v !== undefined && !k.toUpperCase().startsWith('HC_')) env[k] = v;
  const ours: Record<string, string> = {
    XDG_CONFIG_HOME: names.hcConfigHome,
    XDG_STATE_HOME: names.hcStateHome,
  };
  for (const [xdg, passthrough] of Object.entries(USER_XDG_PASSTHROUGH)) {
    if (env[xdg] !== ours[xdg]) continue;
    env[xdg] = env[passthrough] ?? '';
    env[HC_XDG_ISOLATED_ENV] = '1';
  }
  return env;
}

/** See D2/D24: standalone and uninstall calls cannot fall through to a user executable. */
export const hcBinaryOf = (
  value: string | undefined,
  names: Pick<InstanceNames, 'runtimeRoot'>,
  platform: NodeJS.Platform = process.platform,
) =>
  value ??
  join(coreStartCwd(names.runtimeRoot, HC_PINNED_VERSION), runtimeBinaryName('hc', platform));

function runHc(
  bin: string,
  args: string[],
  env: Record<string, string>,
  cwd?: string,
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      bin,
      args,
      { env, cwd, windowsHide: true, timeout: 20_000 },
      (error, stdout, stderr) => {
        if (error) reject(new Error(`hc ${args.join(' ')}: ${stderr || error.message}`));
        else resolve(stdout);
      },
    );
  });
}

/** May start a core, so cwd = coreStartCwd (M21, D23): only a cwd blocks the GC rename. */
export async function startCore(bin: string, names: InstanceNames, env: Record<string, string>) {
  ensureHcSocketDirectory(names);
  const cwd = coreStartCwd(names.runtimeRoot, HC_PINNED_VERSION);
  await mkdir(cwd, { recursive: true });
  await runHc(bin, ['server', 'start'], env, cwd);
}

/** Only ever in our own HC_SESSION, which `env` carries (serverChildEnv). */
export async function stopCore(bin: string, env: Record<string, string>) {
  await runHc(bin, ['server', 'stop'], env);
}

export function hcClient(
  names: InstanceNames,
  env: Record<string, string>,
  log: (m: string) => void,
) {
  if (names.hcEndpointError) log(`hc endpoint unavailable: ${names.hcEndpointError}`);
  return new NodeHcClient({
    session: names.hcSession,
    env,
    ...(names.hcEndpointError
      ? {
          connect: () => {
            throw new Error(names.hcEndpointError);
          },
        }
      : {}),
    log: (message, error) => log(`${message}: ${String(error)}`),
  });
}

const notFound = (error: unknown) => error instanceof HcRpcError && error.kind === 'not_found';

function hasOtherLiveTerminal(
  terminals: readonly { name?: string | null; state: string }[],
  supervisorName: string,
): boolean {
  return terminals.some(
    (terminal) => terminal.state === 'live' && terminal.name !== supervisorName,
  );
}

/** See docs/specs/archive/2026-11-03-tray-helper.md §7a. */
export async function directStopSessions(hc: HcClient, names: InstanceNames): Promise<number> {
  let killed = 0;
  const { terminals } = await hc.call('terminal.list', {
    labels: { 'conduit.instance': names.instance, 'conduit.role': 'session' },
  });
  for (const terminal of terminals) {
    try {
      await hc.call('terminal.kill', { terminal: terminal.address });
      killed++;
    } catch (error) {
      if (!notFound(error)) throw error;
    }
  }
  return killed;
}

/**
 * `--stop-all` with no server answering (F12): kill every session terminal of this instance and
 * the supervisor by its unique name, then stop our core if no other live terminal remains.
 */
export async function directStopAll(
  hc: HcClient,
  names: InstanceNames,
  stop: () => Promise<void>,
): Promise<number> {
  let killed = 0;
  try {
    killed = await directStopSessions(hc, names);
    try {
      const supervisor = await hc.call('terminal.get', { terminal: names.supervisorName });
      if (supervisor.state === 'live')
        await hc.call('terminal.kill', { terminal: supervisor.address });
    } catch (error) {
      if (!notFound(error)) throw error;
    }
    const remaining = await hc.call('terminal.list', {});
    if (hasOtherLiveTerminal(remaining.terminals, names.supervisorName)) return killed;
  } catch (error) {
    if (error instanceof HcDisconnectedError) return 0;
    throw error;
  } finally {
    hc.close();
  }
  await stop();
  return killed;
}

/** SuperviseOptions.core: on doneCoreIdle, stop our core unless another terminal still lives. */
export function supervisorCore(
  connect: () => HcClient,
  names: InstanceNames,
  stop: () => Promise<void>,
  log: (m: string) => void,
) {
  return {
    async hasOtherLiveTerminals() {
      // Connected only here: a supervisor holding a core connection for its whole life would be
      // one more client every core restart has to drop.
      const hc = connect();
      try {
        const { terminals } = await hc.call('terminal.list', {});
        return hasOtherLiveTerminal(terminals, names.supervisorName);
      } catch (error) {
        // A core we can't read may be running anything: leave it.
        log(`supervisor: terminal.list failed: ${String(error)}`);
        return true;
      } finally {
        hc.close();
      }
    },
    async stop() {
      try {
        await stop();
      } catch (error) {
        log(`supervisor: hc server stop failed: ${String(error)}`);
      }
    },
  };
}
