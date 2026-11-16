import type { ActivityNote } from '../../src/conduit-mcp/host';
import { stripUnprintable } from '../../src/network/addresses';
import type { AuditSink } from '../network/audit-log';

// Only the kind, the peer machine and the principal handle cross over: the event's detail
// carries reasons, fingerprints and message fields the Activity log never shows.
// see plan m5: the peer's own strings are shown in a log row, so they lose their control characters
const keptText = (s: string | null | undefined): string | null => {
  if (s === null || s === undefined) return null;
  const kept = stripUnprintable(s);
  return kept === '' ? null : kept;
};

export function activityAuditSink(write: (note: ActivityNote) => void): AuditSink {
  return {
    record(e) {
      write({ action: e.kind, machineId: keptText(e.peer), handle: keptText(e.principal) });
    },
  };
}
