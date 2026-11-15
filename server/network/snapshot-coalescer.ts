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

interface Slot {
  latest: MonitorSnapshot;
  last: number;
  cancel: (() => void) | null;
}

/**
 * A peer that pushes snapshots in bursts would otherwise recompute and re-broadcast the whole
 * directory for every frame. Each peer applies at most once per window, and the newest snapshot
 * always lands at the window's end.
 */
export function createSnapshotCoalescer(deps: SnapshotCoalescerDeps): SnapshotCoalescer {
  const slots = new Map<string, Slot>();

  const applyNow = (machineId: string, slot: Slot): void => {
    slot.last = deps.now();
    deps.apply(machineId, slot.latest);
  };

  return {
    offer(machineId, snapshot) {
      const slot = slots.get(machineId) ?? {
        latest: snapshot,
        last: Number.NEGATIVE_INFINITY,
        cancel: null,
      };
      slots.set(machineId, slot);
      slot.latest = snapshot;
      if (slot.cancel) return;
      const wait = slot.last + SNAPSHOT_COALESCE_MS - deps.now();
      if (wait <= 0) {
        applyNow(machineId, slot);
        return;
      }
      slot.cancel = deps.after(() => {
        slot.cancel = null;
        applyNow(machineId, slot);
      }, wait);
    },
    stop() {
      for (const slot of slots.values()) slot.cancel?.();
      slots.clear();
    },
  };
}
