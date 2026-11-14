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
});
