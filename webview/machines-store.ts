// The Machines UI's owner actions (plan CON-41 decision 10). Every call is a C2 method behind the
// host, so the renderer keeps only the last connect error per machine, for the row to show.

import { useSyncExternalStore } from 'react';
import type { MachineActionResult, MachineError } from '../src/contracts/machines';
import type { NetworkState } from '../src/contracts/network-state';
import { requestHost } from './host-request';
import { getNetworkState, subscribeNetworkState } from './network-store';

// connect may run a 120 s ssh bootstrap on the server; everything else answers at once.
const CONNECT_TIMEOUT_MS = 135_000;
const ACTION_TIMEOUT_MS = 15_000;

/** A host that never answered is an unreachable machine as far as the owner can tell. */
const TIMED_OUT: MachineActionResult = {
  ok: false,
  error: { code: 'ssh_unreachable', detail: { reason: 'timeout' } },
};

let errors: ReadonlyMap<string, MachineError> = new Map();
const listeners = new Set<() => void>();
let stopNetwork: (() => void) | null = null;

function publish(next: Map<string, MachineError>): void {
  errors = next;
  for (const l of [...listeners]) l();
}

function setError(machine: string, error: MachineError | null): void {
  const next = new Map(errors);
  if (error) next.set(machine, error);
  else next.delete(machine);
  publish(next);
}

/** Decision 10: a row's kept error ends when its machine comes up, whatever made it come up. */
function clearUpMachines(state: NetworkState | null): void {
  if (!state) return;
  const next = new Map(errors);
  let changed = false;
  for (const m of state.machines) {
    if (m.state !== 'up') continue;
    for (const key of [m.machine, m.target]) {
      if (next.delete(key)) changed = true;
    }
  }
  if (changed) publish(next);
}

export async function connectMachine(machine: string): Promise<MachineActionResult> {
  const reply = await requestHost(
    (requestId) => ({ type: 'machines:connect', requestId, machine }),
    ['machines:result'],
    CONNECT_TIMEOUT_MS,
  );
  const result = reply?.result ?? TIMED_OUT;
  setError(machine, result.ok ? null : result.error);
  return result;
}

export async function disconnectMachine(machine: string): Promise<MachineActionResult> {
  const reply = await requestHost(
    (requestId) => ({ type: 'machines:disconnect', requestId, machine }),
    ['machines:result'],
    ACTION_TIMEOUT_MS,
  );
  return reply?.result ?? TIMED_OUT;
}

export async function renameMachine(machineId: string, name: string): Promise<MachineActionResult> {
  const reply = await requestHost(
    (requestId) => ({ type: 'machines:rename', requestId, machineId, name }),
    ['machines:result'],
    ACTION_TIMEOUT_MS,
  );
  return reply?.result ?? TIMED_OUT;
}

export async function removeMachine(machineId: string): Promise<MachineActionResult> {
  const reply = await requestHost(
    (requestId) => ({ type: 'machines:remove', requestId, machineId }),
    ['machines:result'],
    ACTION_TIMEOUT_MS,
  );
  return reply?.result ?? TIMED_OUT;
}

export async function openNeedsPerson(
  target: string,
): Promise<{ sessionId: string | null; error: string | null }> {
  const reply = await requestHost(
    (requestId) => ({ type: 'machines:openNeedsPerson', requestId, target }),
    ['machines:needsPersonOpened'],
    ACTION_TIMEOUT_MS,
  );
  return reply
    ? { sessionId: reply.sessionId, error: reply.error }
    : { sessionId: null, error: 'failed' };
}

export async function sshHosts(): Promise<string[]> {
  const reply = await requestHost(
    (requestId) => ({ type: 'machines:sshHosts', requestId }),
    ['machines:sshHosts'],
    ACTION_TIMEOUT_MS,
  );
  return reply?.hosts ?? [];
}

// The network feed is held only while someone reads the errors, so the store has no subscription
// of its own. network-store never imports this module, so the dependency is one way.
const subscribe = (cb: () => void): (() => void) => {
  listeners.add(cb);
  if (listeners.size === 1) {
    stopNetwork = subscribeNetworkState(() => clearUpMachines(getNetworkState()));
    // A machine may have come up while nobody was listening; don't wait for the next push.
    clearUpMachines(getNetworkState());
  }
  return () => {
    listeners.delete(cb);
    if (listeners.size === 0) {
      stopNetwork?.();
      stopNetwork = null;
    }
  };
};
const snapshot = (): ReadonlyMap<string, MachineError> => errors;

/** Last connect error per machine name or target, until a successful connect or an `up` state. */
export function useMachineErrors(): ReadonlyMap<string, MachineError> {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}
