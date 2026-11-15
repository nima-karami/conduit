import type { AuditSink } from '../../server/network/audit-log';
import type { ActivityLog } from './activity-log';

// Only the kind, the peer machine and the principal handle cross over. The event's detail
// carries reasons, fingerprints and message fields that the Activity log never shows, so it
// is dropped here rather than filtered per kind.
export function activityAuditSink(log: ActivityLog): AuditSink {
  return {
    record(e) {
      log.record({
        lane: 'note',
        principal: { handle: e.principal ?? null, sessionId: null, machineId: e.peer },
        cli: null,
        action: e.kind,
        target: null,
        summary: null,
        decision: null,
        decidedBy: 'conduit',
        outcome: null,
        durationMs: null,
        requestId: null,
        count: null,
      });
    },
  };
}
