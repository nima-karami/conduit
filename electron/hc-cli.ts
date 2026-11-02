import { CORE_START_RUN_FLAGS, type InstanceNames } from '../src/contracts/session-identity';

/** hc CLI calls that may start a core: env = coreStartEnv, cwd = coreStartCwd (D16, D23, M21). */
export interface HcCliDeps {
  hcExe: string;
  env: Record<string, string>;
  coreCwd: string;
  execFile(
    file: string,
    args: string[],
    o: { env: Record<string, string>; cwd: string; timeoutMs: number },
  ): Promise<{ code: number; stdout: string; stderr: string }>;
}

const HC_CLI_TIMEOUT_MS = 20_000;

export function supervisorArgs(
  hcExe: string,
  a: { superviseJs: string; userData: string; serverArgs: string[] },
): string[] {
  return [a.superviseJs, '--user-data', a.userData, '--hc', hcExe, ...a.serverArgs];
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

export async function startSupervisor(
  d: HcCliDeps,
  a: {
    names: InstanceNames;
    nodeExe: string;
    superviseJs: string;
    userData: string;
    serverArgs: string[];
  },
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const r = await runCli(d, [
    'run',
    ...CORE_START_RUN_FLAGS,
    '--name',
    a.names.supervisorName,
    '--label',
    'conduit.role=server',
    '--label',
    `conduit.instance=${a.names.instance}`,
    '--',
    a.nodeExe,
    ...supervisorArgs(d.hcExe, a),
  ]);
  return r.ok ? { ok: true } : { ok: false, reason: r.reason ?? 'hc run failed' };
}

/** By the unique name only, never a pid or a label. */
export function killSupervisor(
  d: HcCliDeps,
  names: InstanceNames,
): Promise<{ ok: boolean; reason?: string }> {
  return runCli(d, ['kill', names.supervisorName]);
}
