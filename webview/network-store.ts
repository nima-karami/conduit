// One shared copy of the network state for every component: the host pushes network:state on each
// change, and the first subscriber asks once for the current state (plan CON-41, Architecture).

import { useSyncExternalStore } from 'react';
import type { NetworkState } from '../src/contracts/network-state';
import { post, subscribe as subscribeHost } from './bridge';

let state: NetworkState | null = null;
let started = false;
const listeners = new Set<() => void>();

function emit(): void {
  for (const l of [...listeners]) l();
}

function start(): void {
  if (started) return;
  started = true;
  subscribeHost((m) => {
    if (m.type !== 'network:state') return;
    state = m.state;
    emit();
  });
  post({ type: 'network:get' });
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  start();
  return () => {
    listeners.delete(cb);
  };
}

const snapshot = (): NetworkState | null => state;

export function useNetworkState(): NetworkState | null {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}
