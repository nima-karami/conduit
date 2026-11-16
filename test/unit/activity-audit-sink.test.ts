import { describe, expect, it } from 'vitest';
import { activityAuditSink } from '../../server/mcp/activity-audit-sink';
import type { AuditEvent, AuditKind } from '../../server/network/audit-log';
import type { ActivityNote } from '../../src/conduit-mcp/host';

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

  it('writes the peer machine and principal with control, C1 and bidi characters stripped', () => {
    const fake = fakeNotes();
    activityAuditSink(fake.write).record({
      kind: 'message.in',
      peer: 'm\u0007-7\u202E',
      principal: 'al\u0000pha\u009B\u200Bx\u2028',
    });
    expect(fake.notes).toEqual([{ action: 'message.in', machineId: 'm-7', handle: 'alphax' }]);
  });

  it('writes a peer string that is all control characters as null, not as an empty string', () => {
    const fake = fakeNotes();
    activityAuditSink(fake.write).record({
      kind: 'link.state',
      peer: '\u0007\u009B',
      principal: '\u202E\u200B',
    });
    expect(fake.notes).toEqual([{ action: 'link.state', machineId: null, handle: null }]);
  });

  it('writes a whitespace-only peer string as null', () => {
    const fake = fakeNotes();
    activityAuditSink(fake.write).record({ kind: 'link.state', peer: '   ', principal: ' \t ' });
    expect(fake.notes).toEqual([{ action: 'link.state', machineId: null, handle: null }]);
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
