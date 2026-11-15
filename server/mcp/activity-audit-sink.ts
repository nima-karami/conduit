import type { ActivityNote } from '../../src/conduit-mcp/host';
import type { AuditSink } from '../network/audit-log';

// Only the kind, the peer machine and the principal handle cross over: the event's detail
// carries reasons, fingerprints and message fields the Activity log never shows.
export function activityAuditSink(write: (note: ActivityNote) => void): AuditSink {
  return {
    record(e) {
      write({ action: e.kind, machineId: e.peer, handle: e.principal ?? null });
    },
  };
}
