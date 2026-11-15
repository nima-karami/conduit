import { describe, expect, it } from 'vitest';
import type { AuditEvent, AuditKind } from '../../server/network/audit-log';
import { activityAuditSink } from '../../src/conduit-mcp/activity-audit-sink';
import type { ActivityEntry, ActivityLog } from '../../src/conduit-mcp/activity-log';

function fakeLog(): ActivityLog & { recorded: Omit<ActivityEntry, 'v' | 'id' | 'at'>[] } {
  const recorded: Omit<ActivityEntry, 'v' | 'id' | 'at'>[] = [];
  return {
    recorded,
    record(e) {
      recorded.push(e);
      return 'id';
    },
    recordAskArgs() {},
    flushCounts() {},
    purge() {},
    writable: () => true,
    recentDenies: () => new Map(),
  };
}

describe('activityAuditSink', () => {
  it('writes one note row per audit event, carrying the kind and the peer machine', () => {
    const log = fakeLog();
    const sink = activityAuditSink(log);
    sink.record({ kind: 'link.revoked', peer: 'm-7', detail: { by: 'me' } });
    expect(log.recorded).toEqual([
      {
        lane: 'note',
        principal: { handle: null, sessionId: null, machineId: 'm-7' },
        cli: null,
        action: 'link.revoked',
        target: null,
        summary: null,
        decision: null,
        decidedBy: 'conduit',
        outcome: null,
        durationMs: null,
        requestId: null,
        count: null,
      },
    ]);
  });

  it('carries the principal handle as the handle and leaves a null peer as a null machine', () => {
    const log = fakeLog();
    activityAuditSink(log).record({ kind: 'message.out', peer: null, principal: 'alpha@m-7' });
    expect(log.recorded[0]?.principal).toEqual({
      handle: 'alpha@m-7',
      sessionId: null,
      machineId: null,
    });
  });

  it('never copies detail, so message bodies, file contents and keystrokes stay out', () => {
    const log = fakeLog();
    const event: AuditEvent = {
      kind: 'message.out',
      peer: 'm-7',
      principal: 'alpha',
      detail: { messageId: 'msg-1', to: 'beta@m-7', body: 'SECRET BODY', keys: 'SECRET KEYS' },
    };
    activityAuditSink(log).record(event);
    const wire = JSON.stringify(log.recorded);
    expect(wire).not.toContain('SECRET');
    expect(wire).not.toContain('msg-1');
    expect(wire).not.toContain('beta@m-7');
  });

  it('maps every audit kind to its own action, so no kind collapses into another', () => {
    const kinds: AuditKind[] = [
      'pairing.linked',
      'pairing.failed',
      'link.state',
      'link.revoked',
      'link.capability',
      'message.in',
      'message.out',
      'message.refused',
      'drive.start',
      'drive.stop',
      'drive.refused',
    ];
    const log = fakeLog();
    const sink = activityAuditSink(log);
    for (const kind of kinds) sink.record({ kind, peer: 'm-1' });
    expect(log.recorded.map((r) => r.action)).toEqual(kinds);
    expect(log.recorded.every((r) => r.lane === 'note')).toBe(true);
  });
});
