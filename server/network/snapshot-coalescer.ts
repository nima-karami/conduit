import type { MonitorSnapshot } from '../../src/contracts/link-protocol';

export interface SnapshotCoalescer {
  /** A snapshot arrived from a peer: applied now, or once the peer's window has passed. */
  offer(machineId: string, snapshot: MonitorSnapshot): void;
  stop(): void;
}

export interface SnapshotCoalescerDeps {
  now(): number;
  /** Runs fn after ms; returns its cancel. */
  after(fn: () => void, ms: number): () => void;
  apply(machineId: string, snapshot: MonitorSnapshot): void;
}

export const SNAPSHOT_COALESCE_MS = 250;

/** Stub for the red step: applies every frame at once, which is the behaviour being replaced. */
export function createSnapshotCoalescer(deps: SnapshotCoalescerDeps): SnapshotCoalescer {
  return {
    offer(machineId, snapshot) {
      deps.apply(machineId, snapshot);
    },
    stop() {},
  };
}
