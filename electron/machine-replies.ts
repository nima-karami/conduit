import type {
  DisconnectMachineResult,
  MachineActionResult,
  MachineError,
} from '../src/contracts/machines';
import type { HostToWebview } from '../src/protocol';
import { faultCode } from './server-calls';
import { ServerCallError } from './server-client';

export const MACHINE_OK: MachineActionResult = { ok: true, value: null };

/** A C2 fault from a machine action, in the shape the Machines UI maps to its text (spec 9.1). */
export function machineFault(error: unknown): MachineError {
  return {
    code:
      error instanceof ServerCallError && error.kind === 'not_found'
        ? 'machine_unknown'
        : 'ssh_unreachable',
    detail: { reason: faultCode(error) },
  };
}

/** The disconnect's value has its own shape, which the reply does not carry. */
export function disconnectOutcome(r: DisconnectMachineResult): MachineActionResult {
  return r.ok ? MACHINE_OK : r;
}

/** The Machines UI always gets a typed result back, so a C2 fault is mapped rather than dropped. */
export async function machineActionReply(
  requestId: number,
  action: string,
  run: () => Promise<MachineActionResult>,
  warn: (message: string, data: Record<string, unknown>) => void,
): Promise<Extract<HostToWebview, { type: 'machines:result' }>> {
  let result: MachineActionResult;
  try {
    result = await run();
  } catch (error) {
    warn(`${action} failed`, { err: String(error) });
    result = { ok: false, error: machineFault(error) };
  }
  return { type: 'machines:result', requestId, result };
}

/** The setup pane's session id, or the fault code the Machines UI shows instead. */
export async function openSetupPaneReply(
  requestId: number,
  run: () => Promise<{ sessionId: string }>,
  warn: (message: string, data: Record<string, unknown>) => void,
): Promise<Extract<HostToWebview, { type: 'machines:paneOpened' }>> {
  try {
    const r = await run();
    return { type: 'machines:paneOpened', requestId, sessionId: r.sessionId, error: null };
  } catch (error) {
    warn('openSetupPane failed', { err: String(error) });
    return { type: 'machines:paneOpened', requestId, sessionId: null, error: faultCode(error) };
  }
}

/** The probe's CLI list, or the fault code; the dialog keeps its last list on a fault. */
export async function probeAgentsReply(
  requestId: number,
  run: () => Promise<{ agents: string[] }>,
  warn: (message: string, data: Record<string, unknown>) => void,
): Promise<Extract<HostToWebview, { type: 'machines:agents' }>> {
  try {
    const r = await run();
    return { type: 'machines:agents', requestId, agents: r.agents, error: null };
  } catch (error) {
    warn('probeAgents failed', { err: String(error) });
    return { type: 'machines:agents', requestId, agents: null, error: faultCode(error) };
  }
}
