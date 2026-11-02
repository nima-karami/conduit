import type { OwnerMap } from '../src/window-registry';

export async function closeWindowSessions(d: {
  sessionIds: string[];
  remove(id: string): Promise<void>;
  close(): void;
  failed(reason: string): void;
}): Promise<void> {
  const results = await Promise.allSettled(d.sessionIds.map((id) => d.remove(id)));
  const failed = results.find((r) => r.status === 'rejected');
  if (failed?.status === 'rejected') {
    d.failed(failed.reason instanceof Error ? failed.reason.message : String(failed.reason));
    return;
  }
  d.close();
}

export function reconcileSessionOwners(
  owners: OwnerMap,
  sessionIds: string[],
  isLiveWindow: (id: number) => boolean,
  fallback: number,
  isPending: (id: string) => boolean,
): boolean {
  let changed = false;
  for (const id of sessionIds) {
    const owner = owners.get(id);
    if ((owner === undefined || !isLiveWindow(owner)) && !isPending(id)) {
      owners.set(id, fallback);
      changed = true;
    }
  }
  return changed;
}
