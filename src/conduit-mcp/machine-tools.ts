// The three machine tools (spec 5.1) on the shared prepared() pipeline. Node-free: the network and
// the timer are deps, so the connect budget is testable with fake timers.
import type { ConnectMachineOk, ConnectMachineResult, MachineView } from '../contracts/machines';
import {
  type ControlCallContext,
  type ControlHandlers,
  type Fail,
  fail,
  isFail,
  type Prepared,
  parseKeys,
} from './control-tools';
import { machineToolError } from './machine-errors';
import { isKnownMachine, type NetworkPort } from './remote-routing';
import { MACHINE_ARG } from './tool-schemas';
import type { Caller } from './tools';
import type { Result } from './types';

/** spec 7: a connect_machine call's wall clock. A dial alone waits 30 s; first install may need the owner. */
export const CONNECT_BUDGET_MS = 120_000;

export interface MachineToolDeps {
  network(): NetworkPort | undefined;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
}

export interface MachineHandlers {
  prepareListMachines(caller: Caller, raw: unknown): Promise<Result<Prepared<MachineView[]>>>;
  prepareConnectMachine(
    caller: Caller,
    raw: unknown,
    ctx: ControlCallContext,
  ): Promise<Result<Prepared<ConnectMachineOk>>>;
  prepareDisconnectMachine(
    caller: Caller,
    raw: unknown,
  ): Promise<Result<Prepared<{ machine: string; state: 'down' }>>>;
}

/** The budget ran out: the same answer the network gives for a dial that never reached up. */
const TIMED_OUT: ConnectMachineResult = {
  ok: false,
  error: { code: 'ssh_unreachable', detail: { detail: 'timeout' } },
};

const noNetwork = (): Fail =>
  fail('host_unavailable', "machines aren't available: Conduit's network isn't running", {
    hint: 'try again once Conduit has started',
  });

function machineArg(raw: unknown): string | Fail {
  const o = parseKeys(raw, [MACHINE_ARG]);
  if (isFail(o)) return o;
  if (typeof o.machine !== 'string' || o.machine.length === 0)
    return fail('invalid_args', 'machine must be a non-empty string');
  return o.machine;
}

export function createMachineTools(
  deps: MachineToolDeps,
  prepared: ControlHandlers['prepared'],
): MachineHandlers {
  /** The dial under its own budget and the call's cancel; a budget expiry answers ssh_unreachable. */
  async function connect(
    network: NetworkPort,
    machine: string,
    cancel: AbortSignal,
  ): Promise<Result<ConnectMachineOk>> {
    const budget = new AbortController();
    const timer = deps.setTimer(() => budget.abort(), CONNECT_BUDGET_MS);
    const signal = AbortSignal.any([cancel, budget.signal]);
    // The port honours its signal, but the budget is the tool's promise, so it holds even if not.
    const expired = new Promise<ConnectMachineResult>((resolve) => {
      signal.addEventListener('abort', () => resolve(TIMED_OUT), { once: true });
    });
    try {
      const r = await Promise.race([network.connectMachine(machine, signal), expired]);
      return r.ok
        ? { ok: true, value: r.value }
        : { ok: false, error: machineToolError(r.error, machine) };
    } finally {
      deps.clearTimer(timer);
    }
  }

  return {
    prepareListMachines: (caller, raw) =>
      prepared('list_machines', caller, async () => {
        const o = parseKeys(raw, []);
        if (isFail(o)) return o;
        const network = deps.network();
        if (network === undefined) return noNetwork();
        return {
          summary: { tool: 'list_machines' },
          exec: async (token) => {
            token.keep();
            return { ok: true, value: network.listMachines() };
          },
        };
      }),

    prepareConnectMachine: (caller, raw, ctx) =>
      prepared('connect_machine', caller, async () => {
        const machine = machineArg(raw);
        if (isFail(machine)) return machine;
        const network = deps.network();
        if (network === undefined) return noNetwork();
        return {
          summary: {
            tool: 'connect_machine',
            machine,
            newMachine: !isKnownMachine(network.listMachines(), machine),
          },
          exec: async (token) => {
            token.keep();
            return connect(network, machine, ctx.signal);
          },
        };
      }),

    prepareDisconnectMachine: (caller, raw) =>
      prepared('disconnect_machine', caller, async () => {
        const machine = machineArg(raw);
        if (isFail(machine)) return machine;
        const network = deps.network();
        if (network === undefined) return noNetwork();
        return {
          summary: { tool: 'disconnect_machine', machine },
          exec: async (token) => {
            token.keep();
            const r = await network.disconnectMachine(machine);
            return r.ok
              ? { ok: true, value: r.value }
              : { ok: false, error: machineToolError(r.error, machine) };
          },
        };
      }),
  };
}
