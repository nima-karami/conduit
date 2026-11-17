import { describe, expect, it, vi } from 'vitest';
import {
  ACTIVITY_MAX_BYTES,
  type ActivityEntry,
  type ActivityIo,
  createActivityLog,
} from '../../src/conduit-mcp/activity-log';

const NOW = Date.parse('2026-11-17T12:30:00.000Z');
const row = (id: string, over: Partial<ActivityEntry> = {}): ActivityEntry => ({
  v: 1,
  id,
  at: new Date(NOW).toISOString(),
  lane: 'conduit',
  principal: { handle: 'codex-1', sessionId: 's1', machineId: null },
  cli: 'codex',
  action: 'open_file',
  target: '/work/a',
  summary: null,
  decision: 'allow',
  decidedBy: 'Worker',
  outcome: 'ok',
  durationMs: 12,
  requestId: null,
  count: null,
  ...over,
});
function harness(entries: ActivityEntry[] = []) {
  const files = new Map<string, string>();
  for (const entry of entries) {
    const day = entry.at.slice(0, 10);
    files.set(day, `${files.get(day) ?? ''}${JSON.stringify(entry)}\n`);
  }
  const read = vi.fn((day: string, maxBytes: number) => {
    const value = files.get(day) ?? '';
    if (Buffer.byteLength(value) > maxBytes) throw new Error('Activity day exceeds read budget');
    return value;
  });
  const append = vi.fn((day: string, line: string) =>
    files.set(day, `${files.get(day) ?? ''}${line}`),
  );
  const io: ActivityIo = {
    append,
    read,
    list: () => [...files].map(([day, value]) => ({ day, bytes: Buffer.byteLength(value) })),
    remove: (day) => {
      files.delete(day);
    },
    readArgs: () => '{"raw":"SECRET"}',
    writeArgs: () => undefined,
  };
  let seq = 0;
  const log = createActivityLog({
    io,
    now: () => NOW,
    newId: () => `pending-${++seq}`,
    warn: vi.fn(),
  });
  return { log, io, read, append, files };
}

describe('Activity query', () => {
  it('returns newest rows with stable timestamp/id pages and owner filters', () => {
    const h = harness([
      row('b'),
      row('a'),
      row('c'),
      row('old', { at: '2026-11-16T12:00:00.000Z' }),
    ]);
    expect(h.log).toHaveProperty('query');
    const first = h.log.query({ limit: 2 });
    expect(first.rows.map((r) => r.id)).toEqual(['c', 'b']);
    expect(first.next).toBeTypeOf('string');
    const second = h.log.query({ limit: 2, before: first.next ?? undefined });
    expect(second.rows.map((r) => r.id)).toEqual(['a', 'old']);
    expect(second.next).toBeNull();
    expect(h.log.query({ sessionId: 'other' }).rows).toEqual([]);
    expect(h.log.query({ cli: 'claude' }).rows).toEqual([]);
    expect(h.log.query({ machineId: 'remote' }).rows).toEqual([]);
    expect(h.log.query({ decision: 'deny' }).rows).toEqual([]);
    expect(h.log.query({ action: 'close_session' }).rows).toEqual([]);
    expect(h.log.query({ lane: 'observed' }).rows).toEqual([]);
    expect(h.log.query({ since: new Date(NOW).toISOString() }).rows).toHaveLength(3);
  });

  it('includes current counts without writing or duplicating them after a flush', () => {
    const h = harness();
    expect(h.log).toHaveProperty('query');
    const { v: _v, id: _id, at: _at, ...entry } = row('unused', { action: 'read_inbox' });
    h.log.record(entry);
    h.log.record(entry);
    const first = h.log.query({});
    expect(first.rows).toHaveLength(1);
    expect(first.rows[0]).toMatchObject({ count: 2, decidedBy: 'counted' });
    expect(h.append).not.toHaveBeenCalled();
    expect(h.log.query({}).rows).toEqual(first.rows);
    h.log.flushCounts(true);
    expect(h.log.query({}).rows).toEqual(first.rows);
    expect(h.append).toHaveBeenCalledTimes(1);
  });

  it('projects only known entry fields, never raw args or unknown properties', () => {
    const h = harness();
    expect(h.log).toHaveProperty('query');
    h.files.set(
      '2026-11-17',
      `${JSON.stringify({ ...row('a'), rawArgs: 'SECRET', principal: { ...row('a').principal, extra: 'SECRET' } })}\n`,
    );
    expect(h.log.query({}).rows).toEqual([row('a')]);
    expect(JSON.stringify(h.log.query({}))).not.toContain('SECRET');
  });

  it('reports corrupt rows, malformed cursors, and read failures explicitly', () => {
    const h = harness();
    expect(h.log).toHaveProperty('query');
    h.files.set('2026-11-17', '{broken}\n');
    expect(h.log.query({}).error).toMatch(/corrupt/i);
    h.files.set('2026-11-17', `${JSON.stringify({ ...row('a'), count: -2 })}\n`);
    expect(h.log.query({}).error).toMatch(/corrupt/i);
    expect(h.log.query({ before: 'bad' }).error).toMatch(/query/i);
    h.read.mockImplementation(() => {
      throw new Error('disk unreadable');
    });
    expect(h.log.query({}).error).toMatch(/read/i);
  });

  it('scans only retained days and never reads an oversized file', () => {
    const h = harness([row('old', { at: '2026-10-01T12:00:00.000Z' }), row('fresh')]);
    expect(h.log).toHaveProperty('query');
    expect(h.log.query({}).rows.map((r) => r.id)).toEqual(['fresh']);
    expect(h.read.mock.calls.map(([day]) => day)).toEqual(['2026-11-17']);
    h.io.list = () => [{ day: '2026-11-17', bytes: ACTIVITY_MAX_BYTES + 1 }];
    h.read.mockClear();
    expect(h.log.query({}).error).toMatch(/budget|large/i);
    expect(h.read).not.toHaveBeenCalled();
  });

  it('passes the remaining cumulative byte budget even when a listed file grows', () => {
    const h = harness([row('a'), row('b', { at: '2026-11-16T12:00:00.000Z' })]);
    expect(h.log).toHaveProperty('query');
    h.io.list = () => [
      { day: '2026-11-17', bytes: 1 },
      { day: '2026-11-16', bytes: 1 },
    ];
    expect(h.log.query({}).error).toBeNull();
    expect(h.read.mock.calls[0]?.[1]).toBe(ACTIVITY_MAX_BYTES);
    expect(h.read.mock.calls[1]?.[1]).toBe(
      ACTIVITY_MAX_BYTES - Buffer.byteLength(h.files.get('2026-11-17') ?? ''),
    );
  });
});
