import type { HcCliDeps } from '../server/lifecycle/hc-supervisor';
import type { InstanceNames } from '../src/contracts/session-identity';

const HC_CLI_TIMEOUT_MS = 20_000;

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

/** By the unique name only, never a pid or a label. */
export function killSupervisor(
  d: HcCliDeps,
  names: InstanceNames,
): Promise<{ ok: boolean; reason?: string }> {
  return runCli(d, ['kill', names.supervisorName]);
}
