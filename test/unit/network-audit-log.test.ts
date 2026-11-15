import { describe, expect, it, vi } from 'vitest';
import { openAuditLog } from '../../server/network/audit-log';

const FILE = '/mem/network/audit.jsonl';
const NOW = Date.parse('2026-11-14T12:00:00.000Z');

describe('audit log', () => {
  it('appends one JSON line with v:1 and the ISO time from now()', () => {
    const lines: string[] = [];
    const sink = openAuditLog(FILE, {
      now: () => NOW,
      append: (_path, line) => lines.push(line),
      onError: vi.fn(),
    });
    sink.record({ kind: 'link.revoked', peer: 'm-0000000a', detail: { reason: 'user' } });
    expect(lines).toHaveLength(1);
    expect(lines[0].endsWith('\n')).toBe(true);
    expect(JSON.parse(lines[0])).toEqual({
      v: 1,
      at: '2026-11-14T12:00:00.000Z',
      kind: 'link.revoked',
      peer: 'm-0000000a',
      detail: { reason: 'user' },
    });
  });

  it('keeps the principal when one is given', () => {
    const lines: string[] = [];
    const sink = openAuditLog(FILE, {
      now: () => NOW,
      append: (_path, line) => lines.push(line),
      onError: vi.fn(),
    });
    sink.record({ kind: 'message.in', peer: null, principal: 'you@m-0000000a' });
    expect(JSON.parse(lines[0])).toMatchObject({ principal: 'you@m-0000000a', peer: null });
  });

  it('an append failure is reported to onError and never thrown to the caller', () => {
    const failure = new Error('disk full');
    const onError = vi.fn();
    const sink = openAuditLog(FILE, {
      now: () => NOW,
      append: () => {
        throw failure;
      },
      onError,
    });
    expect(() => sink.record({ kind: 'drive.start', peer: 'm-0000000a' })).not.toThrow();
    expect(onError).toHaveBeenCalledWith(failure);
  });

  it('rejects a kind outside the closed union at compile time', () => {
    const sink = openAuditLog(FILE, {
      now: () => NOW,
      append: () => undefined,
      onError: vi.fn(),
    });
    // @ts-expect-error 'link.bogus' is not an AuditKind
    sink.record({ kind: 'link.bogus', peer: null });
  });

  // CON-27 security review M2: a peer's text reaches detail and principal, so the log caps it.
  it('cuts every string in detail and principal to 128 chars, and leaves other values alone', () => {
    const lines: string[] = [];
    const sink = openAuditLog(FILE, {
      now: () => NOW,
      append: (_path, line) => lines.push(line),
      onError: vi.fn(),
    });
    sink.record({
      kind: 'message.refused',
      peer: 'm-0000000a',
      principal: 'p'.repeat(300),
      detail: { messageId: 'x'.repeat(300), to: 'a', count: 7, flag: true },
    });
    const parsed = JSON.parse(lines[0]);
    expect(parsed.principal).toBe('p'.repeat(128));
    expect(parsed.detail).toEqual({ messageId: 'x'.repeat(128), to: 'a', count: 7, flag: true });
  });
});
