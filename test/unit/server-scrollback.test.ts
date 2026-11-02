import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GAP_MARKER, type ScrollbackFiles, ServerScrollback } from '../../server/scrollback';
import type { ServerEvent, ServerEvents } from '../../src/contracts/server-protocol';
import type { TermGeometry } from '../../src/protocol';
import { scrollbackFileName } from '../../src/scrollback-files';
import { restoreScrollback, serializeScrollback } from '../../src/scrollback-persistence';

const SIZE: TermGeometry = { cols: 80, rows: 24 };

let disk: Map<string, string>;
let shown: Array<{ type: ServerEvent; data: unknown }>;
let recording: boolean;
let size: TermGeometry | undefined;

function make() {
  const files: ScrollbackFiles = {
    read: (name) => disk.get(name),
    write: (name, blob) => disk.set(name, blob),
    remove: (name) => disk.delete(name),
  };
  return new ServerScrollback({
    files,
    emit: <E extends ServerEvent>(type: E, data: ServerEvents[E]) => shown.push({ type, data }),
    sizeOf: () => size,
    recording: () => recording,
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  disk = new Map();
  shown = [];
  recording = true;
  size = SIZE;
});
afterEach(() => vi.useRealTimers());

const onDisk = (id: string) => {
  const r = restoreScrollback(disk.get(scrollbackFileName(id)));
  return r.kind === 'ok' ? r.scrollback.segments : undefined;
};

describe('ServerScrollback', () => {
  it('appends to the ring and persists it debounced', () => {
    const s = make();
    s.append('a', 'one', SIZE);
    s.append('a', 'two', SIZE);
    vi.runAllTimers();
    expect(onDisk('a')).toEqual([{ data: 'onetwo', geometry: SIZE }]);
  });

  it('a gap appends a marker and the paint; the ring never resets', () => {
    const s = make();
    s.append('a', 'before', SIZE);
    s.gap('a', 'PAINT', { cols: 100, rows: 30 });
    s.flushPending();
    expect(onDisk('a')).toEqual([
      { data: 'before', geometry: SIZE },
      { data: `${GAP_MARKER}PAINT`, geometry: { cols: 100, rows: 30 } },
    ]);
  });

  it('show emits term.show and appends at the current size', () => {
    const s = make();
    s.append('a', 'out', SIZE);
    s.show('a', 'BANNER');
    expect(shown).toEqual([{ type: 'term.show', data: { sessionId: 'a', data: 'BANNER' } }]);
    s.flushPending();
    expect(onDisk('a')).toEqual([{ data: 'outBANNER', geometry: SIZE }]);
  });

  it('cold replay reads this run’s ring, else the file, and records its tail', () => {
    disk.set(
      scrollbackFileName('a'),
      serializeScrollback({
        version: 2,
        sessionId: 'a',
        segments: [{ data: 'old', geometry: SIZE }],
      }),
    );
    const s = make();
    const replay = s.replayForColdStart('a');
    expect(replay?.data.startsWith('old')).toBe(true);
    expect(replay?.replay).toEqual([{ length: replay?.data.length, geometry: SIZE }]);
    s.flushPending();
    expect(onDisk('a')?.[0].data).toBe(replay?.data);
    expect(make().replayForColdStart('none')).toBeNull();
  });

  it('a file a newer version wrote is never replayed or overwritten', () => {
    const newer = JSON.stringify({ version: 99, sessionId: 'a', segments: [] });
    disk.set(scrollbackFileName('a'), newer);
    const s = make();
    expect(s.replayForColdStart('a')).toBeNull();
    s.append('a', 'x', SIZE);
    s.flushPending();
    s.forget('a');
    expect(disk.get(scrollbackFileName('a'))).toBe(newer);
  });

  it('with persistence off the ring is kept in memory but never written', () => {
    recording = false;
    const s = make();
    s.append('a', 'mem', SIZE);
    s.flushPending();
    expect(disk.size).toBe(0);
    expect(s.replayForColdStart('a')?.data.startsWith('mem')).toBe(true);
  });

  it('forget drops the ring and its file', () => {
    const s = make();
    s.append('a', 'x', SIZE);
    s.flushPending();
    s.forget('a');
    expect(disk.has(scrollbackFileName('a'))).toBe(false);
    expect(s.replayForColdStart('a')).toBeNull();
  });
});
