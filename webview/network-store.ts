// One shared copy of the network state for every component: the host pushes network:state on each
// change, and the first subscriber asks once for the current state (plan CON-41, Architecture).

import { useSyncExternalStore } from 'react';
import type { NetworkState } from '../src/contracts/network-state';
import type { Capability } from '../src/contracts/remote-principal';
import { post, subscribe as subscribeHost } from './bridge';
import { requestHost } from './host-request';

let state: NetworkState | null = null;
let started = false;
const listeners = new Set<() => void>();

function start(): void {
  if (started) return;
  started = true;
  subscribeHost((m) => {
    if (m.type !== 'network:state') return;
    state = m.state;
    for (const l of [...listeners]) l();
  });
  post({ type: 'network:get' });
}

/** Non-hook access, for stores outside React. Subscribing is what starts the one host feed. */
export function subscribeNetworkState(cb: () => void): () => void {
  listeners.add(cb);
  start();
  return () => {
    listeners.delete(cb);
  };
}

export const getNetworkState = (): NetworkState | null => state;

export function useNetworkState(): NetworkState | null {
  return useSyncExternalStore(subscribeNetworkState, getNetworkState, getNetworkState);
}

export async function setLinkCapability(
  machineId: string,
  capability: Capability,
  on: boolean,
  expectedToken: string,
): Promise<'ok' | 'conflict' | 'failed'> {
  const reply = await requestHost(
    (requestId) => ({
      type: 'network:setCapability',
      requestId,
      machineId,
      capability,
      on,
      expectedToken,
    }),
    ['network:capabilityResult'],
    15_000,
  );
  if (reply?.result === 'conflict') post({ type: 'network:get' });
  return reply?.result ?? 'failed';
}
