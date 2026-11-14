import { describe, expect, it, vi } from 'vitest';
import {
  ACTIVITY_MAX_BYTES,
  ACTIVITY_RETENTION_MS,
  type ActivityEntry,
  type ActivityIo,
  COUNTED_TOOLS,
  createActivityLog,
} from '../../src/conduit-mcp/activity-log';

interface Written {
  day: string;
  line: string;
}
interface FakeIo extends ActivityIo {
  written: Written[];
  args: string | null;
  failAppend: boolean;
}

function fakeIo(): FakeIo {
  const io: FakeIo = {
    written: [],
    args: null,
    failAppend: false,
    append(day, line) {
      if (io.failAppend) throw new Error('disk full');
      io.written.push({ day, line });
    },
    list() {
      const sums = new Map<string, number>();
      for (const w of io.written) {
        sums.set(w.day, (sums.get(w.day) ?? 0) + Buffer.byteLength(w.line));
      }
      return [...sums].map(([day, bytes]) => ({ day, bytes }));
    },
    remove(day) {
      io.written = io.written.filter((w) => w.day !== day);
    },
    readArgs() {
      return io.args;
    },
    writeArgs(text) {
      io.args = text;
    },
  };
  return io;
}

const rows = (io: FakeIo): ActivityEntry[] =>
  io.written.map((w) => JSON.parse(w.line) as ActivityEntry);
const days = (io: FakeIo): string[] =>
  io
    .list()
    .map((d) => d.day)
    .sort();
const seed = (io: FakeIo, day: string, bytes: number) => {
  io.written.push({ day, line: 'x'.repeat(bytes) });
};

const T0 = Date.parse('2026-11-14T10:05:00.000Z');
const MB = 1024 * 1024;

function harness(io: FakeIo, start = T0) {
  const clock = { now: start };
  let seq = 0;
  const warn = vi.fn();
  const log = createActivityLog({
    io,
    now: () => clock.now,
    newId: () => `id-${++seq}`,
    warn,
  });
  return { log, clock, warn };
}

const base = {
  lane: 'conduit' as const,
  principal: { handle: 'claude-3', sessionId: 's1', machineId: null },
  cli: 'claude' as const,
  action: 'list_sessions',
  target: null,
  summary: null,
  decision: 'allow' as const,
  decidedBy: 'observer',
  outcome: 'ok' as const,
  durationMs: null,
  requestId: null,
  count: null,
};

describe('activity log', () => {
  it('record writes one JSON line with exactly the entry fields', () => {
    const io = fakeIo();
    const { log } = harness(io);
    const id = log.record({
      ...base,
      action: 'send_message',
      decision: null,
      decidedBy: 'conduit',
    });
    expect(id).toBe('id-1');
    expect(io.written).toHaveLength(1);
    expect(io.written[0]?.day).toBe('2026-11-14');
    const line = io.written[0]?.line ?? '';
    expect(line.endsWith('\n')).toBe(true);
    expect(Object.keys(JSON.parse(line)).sort()).toEqual(
      [
        'v',
        'id',
        'at',
        'lane',
        'principal',
        'cli',
        'action',
        'target',
        'summary',
        'decision',
        'decidedBy',
        'outcome',
        'durationMs',
        'requestId',
        'count',
      ].sort(),
    );
    expect(JSON.parse(line)).toMatchObject({ v: 1, id: 'id-1', at: '2026-11-14T10:05:00.000Z' });
  });

  it('counted tools aggregate per session per hour, denies still get rows', () => {
    expect(COUNTED_TOOLS).toEqual(['list_sessions', 'list_agents', 'wait_sessions', 'read_inbox']);
    const io = fakeIo();
    const { log, clock } = harness(io);
    for (let i = 0; i < 3; i++) log.record(base);
    log.record({ ...base, principal: { ...base.principal, sessionId: 's2' } });
    log.record({ ...base, decision: 'deny', outcome: 'denied' });
    log.record({ ...base, action: 'send_message' });
    expect(io.written).toHaveLength(2);

    clock.now = Date.parse('2026-11-14T10:59:59.000Z');
    log.flushCounts();
    expect(io.written).toHaveLength(2);

    clock.now = Date.parse('2026-11-14T11:00:01.000Z');
    log.flushCounts();
    const flushed = rows(io).filter((r) => r.decidedBy === 'counted');
    expect(flushed).toHaveLength(2);
    expect(flushed.find((r) => r.principal.sessionId === 's1')).toMatchObject({
      lane: 'conduit',
      action: 'list_sessions',
      decision: 'allow',
      decidedBy: 'counted',
      outcome: 'ok',
      count: 3,
      target: null,
      summary: null,
      durationMs: null,
      requestId: null,
    });
    expect(flushed.find((r) => r.principal.sessionId === 's2')?.count).toBe(1);
    expect(rows(io).filter((r) => r.decision === 'deny')).toHaveLength(1);

    log.flushCounts();
    expect(io.written).toHaveLength(4);

    clock.now = Date.parse('2026-11-14T11:30:00.000Z');
    log.record(base);
    log.flushCounts();
    expect(io.written).toHaveLength(4);
    clock.now = Date.parse('2026-11-14T12:00:01.000Z');
    log.flushCounts();
    expect(rows(io).at(-1)).toMatchObject({ decidedBy: 'counted', count: 1 });
  });

  it('failed append marks unwritable and the next success writes one gap row', () => {
    const io = fakeIo();
    const { log, clock, warn } = harness(io);
    io.failAppend = true;
    expect(() => log.record({ ...base, decision: 'deny', outcome: 'denied' })).not.toThrow();
    expect(log.writable()).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);

    clock.now = Date.parse('2026-11-14T10:06:00.000Z');
    log.record({ ...base, decision: 'deny', outcome: 'denied' });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(log.writable()).toBe(false);

    io.failAppend = false;
    clock.now = Date.parse('2026-11-14T10:07:00.000Z');
    const id = log.record({
      ...base,
      action: 'send_message',
      decision: null,
      decidedBy: 'conduit',
    });
    expect(log.writable()).toBe(true);
    expect(io.written).toHaveLength(2);
    expect(rows(io)[0]).toEqual({
      v: 1,
      id: rows(io)[0]?.id,
      at: '2026-11-14T10:07:00.000Z',
      lane: 'note',
      principal: { handle: null, sessionId: null, machineId: null },
      cli: null,
      action: 'gap',
      target: null,
      summary: '2026-11-14T10:05:00.000Z/2026-11-14T10:07:00.000Z',
      decision: null,
      decidedBy: 'conduit',
      outcome: null,
      durationMs: null,
      requestId: null,
      count: null,
    });
    expect(rows(io)[1]?.id).toBe(id);

    log.record({ ...base, action: 'send_message' });
    expect(io.written).toHaveLength(3);
    expect(rows(io).filter((r) => r.action === 'gap')).toHaveLength(1);
  });

  it('corrupt ask args start empty and warn', () => {
    const io = fakeIo();
    io.args = '{not json';
    const { log, warn } = harness(io);
    log.recordAskArgs('r1', { q: 1 });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(JSON.parse(io.args ?? 'null')).toMatchObject({ r1: { args: { q: 1 } } });
  });

  it('ask args purge after 24 h', () => {
    const io = fakeIo();
    const { log, clock } = harness(io);
    log.recordAskArgs('r1', { query: 'a' });
    clock.now = T0 + 23 * 3_600_000;
    log.recordAskArgs('r2', { query: 'b' });
    clock.now = T0 + 25 * 3_600_000;
    log.purge();
    expect(Object.keys(JSON.parse(io.args ?? '{}'))).toEqual(['r2']);
  });

  it('purge removes days older than 30 and oldest beyond 50 MB', () => {
    const aged = fakeIo();
    const agedLog = harness(aged).log;
    seed(aged, '2026-10-14', 10);
    seed(aged, '2026-10-15', 10);
    seed(aged, '2026-11-14', 1);
    agedLog.purge();
    expect(days(aged)).toEqual(['2026-10-15', '2026-11-14']);
    expect(ACTIVITY_RETENTION_MS).toBe(30 * 86_400_000);
    expect(ACTIVITY_MAX_BYTES).toBe(50 * MB);

    const sized = fakeIo();
    const sizedLog = harness(sized).log;
    seed(sized, '2026-11-08', 20 * MB);
    seed(sized, '2026-11-10', 20 * MB);
    seed(sized, '2026-11-12', 20 * MB);
    seed(sized, '2026-11-14', 1 * MB);
    sizedLog.purge();
    expect(days(sized)).toEqual(['2026-11-10', '2026-11-12', '2026-11-14']);

    const huge = fakeIo();
    const hugeLog = harness(huge).log;
    seed(huge, '2026-11-13', 1);
    seed(huge, '2026-11-14', 60 * MB);
    hugeLog.purge();
    expect(days(huge)).toEqual(['2026-11-14']);
  });

  it('recentDenies keeps the last 200', () => {
    const io = fakeIo();
    const { log, clock } = harness(io);
    const ids: string[] = [];
    for (let i = 0; i < 201; i++) {
      clock.now = T0 + i;
      ids.push(
        log.record({ ...base, action: 'send_message', decision: 'deny', outcome: 'denied' }),
      );
    }
    const denies = log.recentDenies();
    expect(denies.size).toBe(200);
    expect(denies.has(ids[0] ?? '')).toBe(false);
    expect(denies.get(ids[200] ?? '')?.decision).toBe('deny');
  });
});
