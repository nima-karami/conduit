import type { ActivityNote } from '../../src/conduit-mcp/host';
import { stripUnprintable } from '../../src/network/addresses';
import type { AuditSink } from '../network/audit-log';

// Only the kind, the peer machine and the principal handle cross over: the event's detail
// carries reasons, fingerprints and message fields the Activity log never shows.
// see plan m5: the peer's own strings are shown in a log row, so they lose their control characters
export function activityAuditSink(write: (note: ActivityNote) => void): AuditSink {
  return {
    record(e) {
      write({
        action: e.kind,
        machineId: e.peer === null ? null : stripUnprintable(e.peer),
        handle: e.principal === undefined ? null : stripUnprintable(e.principal),
      });
    },
  };
}
