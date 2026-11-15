import type { AuditSink } from '../network/audit-log';

export interface ActivityNote {
  action: string;
  machineId: string | null;
  handle: string | null;
}

// Only the kind, the peer machine and the principal handle cross over: the event's detail
// carries reasons, fingerprints and message fields the Activity log never shows.
export function activityAuditSink(write: (note: ActivityNote) => void): AuditSink {
  return {
    record(e) {
      write({ action: e.kind, machineId: e.peer, handle: e.principal ?? null });
    },
  };
}
