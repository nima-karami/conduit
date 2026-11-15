import { describe, expect, it } from 'vitest';
import { type ActivityNote, activityAuditSink } from '../../server/mcp/activity-audit-sink';
import type { AuditEvent, AuditKind } from '../../server/network/audit-log';

function fakeNotes(): { notes: ActivityNote[]; write(n: ActivityNote): void } {
  const notes: ActivityNote[] = [];
  return { notes, write: (n) => notes.push(n) };
}

describe('activityAuditSink', () => {
  it('writes one note per audit event, carrying the kind and the peer machine', () => {
    const fake = fakeNotes();
    activityAuditSink(fake.write).record({
      kind: 'link.revoked',
      peer: 'm-7',
      detail: { by: 'me' },
    });
    expect(fake.notes).toEqual([{ action: 'link.revoked', machineId: 'm-7', handle: null }]);
  });

  it('carries the principal as the handle and a null peer as a null machine', () => {
    const fake = fakeNotes();
    activityAuditSink(fake.write).record({
      kind: 'message.out',
      peer: null,
      principal: 'alpha@m-7',
    });
    expect(fake.notes).toEqual([{ action: 'message.out', machineId: null, handle: 'alpha@m-7' }]);
  });

  it('never copies detail, so message bodies, file contents and keystrokes stay out', () => {
    const fake = fakeNotes();
    const event: AuditEvent = {
      kind: 'message.out',
      peer: 'm-7',
      principal: 'alpha',
      detail: { messageId: 'msg-1', to: 'beta@m-7', body: 'SECRET BODY', keys: 'SECRET KEYS' },
    };
    activityAuditSink(fake.write).record(event);
    const wire = JSON.stringify(fake.notes);
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
    const fake = fakeNotes();
    const sink = activityAuditSink(fake.write);
    for (const kind of kinds) sink.record({ kind, peer: 'm-1' });
    expect(fake.notes.map((n) => n.action)).toEqual(kinds);
  });
});
