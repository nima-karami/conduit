import { HC_XDG_ISOLATED_ENV } from '../server/hc-cli';
import type { HcClient } from '../src/contracts/hc';
import { type InstanceNames, USER_XDG_PASSTHROUGH } from '../src/contracts/session-identity';
import type { AppLaunch } from '../src/contracts/tray-protocol';
import { HcDisconnectedError, HcRpcError } from '../src/hc-client';

/** hc calls that may start a core: env = coreStartEnv, cwd = coreStartCwd (D16, D23, M21). */
export interface HcCliDeps {
  hcExe: string;
  env: Record<string, string>;
  coreCwd: string;
  execFile(
    file: string,
    args: string[],
    o: { env: Record<string, string>; cwd: string; timeoutMs: number },
  ): Promise<{ code: number; stdout: string; stderr: string }>;
  /** `hc server start` with `env` and `coreCwd`; a no-op on a running core. */
  startCore(): Promise<void>;
  /**
   * A client of its own for the supervisor run: one made after startCore dials at once, where the
   * app's long-lived client may sit in its reconnect backoff.
   */
  connect(): Pick<HcClient, 'call' | 'close'>;
}

const HC_CLI_TIMEOUT_MS = 20_000;

export function supervisorArgs(
  hcExe: string,
  a: {
    superviseJs: string;
    userData: string;
    serverArgs: string[];
    tray?: { source: string; app: AppLaunch };
  },
): string[] {
  const args = [a.superviseJs, '--user-data', a.userData, '--hc', hcExe, ...a.serverArgs];
  if (a.tray) {
    args.push('--tray', a.tray.source, '--app-exe', a.tray.app.exe);
    for (const arg of a.tray.app.args) args.push('--app-arg', arg);
    args.push('--app-cwd', a.tray.app.cwd);
  }
  return args;
}

/**
 * The supervisor's env, from the app's hc env (coreStartEnv). terminal.run sets it over the core's
 * own and can only set, so: no HC_*, and the user's XDG values in place of our core's, `""` for one
 * the user has unset. The server never sees our hc dirs; serverChildEnv rebuilds its hc env from
 * HC_XDG_ISOLATED_ENV (D24, M22). The detached fallback gets the same env.
 */
export function supervisorEnv(
  hcEnv: Readonly<Record<string, string>>,
  names: Pick<InstanceNames, 'hcConfigHome' | 'hcStateHome'>,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(hcEnv)) {
    const upper = k.toUpperCase();
    if (upper.startsWith('HC_') || upper in USER_XDG_PASSTHROUGH) continue;
    env[k] = v;
  }
  for (const [xdg, passthrough] of Object.entries(USER_XDG_PASSTHROUGH))
    env[xdg] = hcEnv[passthrough] ?? '';
  if (hcEnv.XDG_CONFIG_HOME === names.hcConfigHome || hcEnv.XDG_STATE_HOME === names.hcStateHome)
    env[HC_XDG_ISOLATED_ENV] = '1';
  return env;
}

async function runCli(d: HcCliDeps, args: string[]): Promise<{ ok: boolean; reason?: string }> {
  try {
    const r = await d.execFile(d.hcExe, args, {
      env: d.env,
      cwd: d.coreCwd,
      timeoutMs: HC_CLI_TIMEOUT_MS,
    });
    if (r.code === 0) return { ok: true };
    return { ok: false, reason: (r.stderr || r.stdout).trim() || `hc exited ${r.code}` };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

const reasonOf = (error: unknown) =>
  error instanceof HcRpcError && error.rawKind
    ? `${error.rawKind}: ${error.message}`
    : error instanceof Error
      ? error.message
      : String(error);

/**
 * Over JSON-RPC, not `hc run`: only terminal.run takes an env, and the CLI's terminal gets the
 * core's env (spike M10). `no_parent` is CORE_START_RUN_FLAGS' `--no-parent`; an RPC run is always
 * in the background.
 */
export async function startSupervisor(
  d: HcCliDeps,
  a: {
    names: InstanceNames;
    nodeExe: string;
    superviseJs: string;
    userData: string;
    serverArgs: string[];
    tray?: { source: string; app: AppLaunch };
  },
): Promise<{ ok: true } | { ok: false; reason: string }> {
  try {
    await d.startCore();
  } catch (error) {
    return { ok: false, reason: `hc server start: ${reasonOf(error)}` };
  }
  const params = {
    argv: [a.nodeExe, ...supervisorArgs(d.hcExe, a)],
    cwd: d.coreCwd,
    env: supervisorEnv(d.env, a.names),
    labels: { 'conduit.role': 'server', 'conduit.instance': a.names.instance },
    name: a.names.supervisorName,
    no_parent: true,
  };
  // A dial racing the core's first listen fails once; the second finds it up.
  for (let attempt = 0; ; attempt++) {
    const hc = d.connect();
    try {
      await hc.call('terminal.run', params);
      return { ok: true };
    } catch (error) {
      if (error instanceof HcDisconnectedError && attempt === 0) continue;
      return { ok: false, reason: reasonOf(error) };
    } finally {
      hc.close();
    }
  }
}

/** By the unique name only, never a pid or a label. */
export function killSupervisor(
  d: HcCliDeps,
  names: InstanceNames,
): Promise<{ ok: boolean; reason?: string }> {
  return runCli(d, ['kill', names.supervisorName]);
}
