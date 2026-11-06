import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RELAUNCH_MARKER, restoreScrollback } from '../../src/scrollback-persistence';
import { ScrollbackStore } from '../../src/scrollback-store';

const restored = (blob: string | undefined) => {
  const r = restoreScrollback(blob);
  return r.kind === 'ok' ? r.scrollback : undefined;
};

function harness() {
  const writes: string[] = [];
  const store = new ScrollbackStore((_id, blob) => writes.push(blob), {
    send: () => {},
    recording: () => true,
  });
  const lastWrite = () => restored(writes[writes.length - 1]);
  return { store, writes, lastWrite };
}

describe('ScrollbackStore', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('keeps the geometry when a session exits inside the debounce window', () => {
    const { store, writes, lastWrite } = harness();
    // Wired the way the server ring is: output stamped with the size it arrived at, and the
    // exit flushes.
    store.append('s1', 'last words\r\n', { cols: 144, rows: 73 });
    store.flush('s1');
    vi.advanceTimersByTime(1000);

    expect(writes).toHaveLength(1);
    expect(lastWrite()?.segments).toEqual([
      { data: 'last words\r\n', geometry: { cols: 144, rows: 73 } },
    ]);
  });

  it('debounces appends into one write', () => {
    const { store, writes, lastWrite } = harness();
    store.append('s1', 'a', { cols: 80, rows: 24 });
    store.append('s1', 'b', { cols: 80, rows: 24 });
    expect(writes).toHaveLength(0);
    vi.advanceTimersByTime(250);
    expect(writes).toHaveLength(1);
    expect(lastWrite()?.segments).toEqual([{ data: 'ab', geometry: { cols: 80, rows: 24 } }]);
  });

  it('records exactly what a cold replay shows, and keeps the restored ring segment by segment', () => {
    const { store, lastWrite } = harness();
    const replay = store.replayForColdStart('s1', () => [
      { data: 'old', geometry: { cols: 120, rows: 30 } },
    ]);
    store.append('s1', 'new', { cols: 90, rows: 20 });
    store.flush('s1');
    expect(lastWrite()?.segments).toEqual([
      { data: `old${replay?.tail?.data}`, geometry: { cols: 120, rows: 30 } },
      { data: 'new', geometry: { cols: 90, rows: 20 } },
    ]);
    expect(store.attachReplay('s1').data).toBe(`${replay?.data}new`);
  });

  it("replays this app run's ring over the one on disk, and nothing when there is neither", () => {
    const { store } = harness();
    expect(store.replayForColdStart('s1', () => undefined)).toBeUndefined();
    store.append('s1', 'live', { cols: 80, rows: 24 });
    const replay = store.replayForColdStart('s1', () => [{ data: 'stale disk copy' }]);
    expect(replay?.data.startsWith('live')).toBe(true);
  });

  it('show sends a host line and records it while recording, sends only while not', () => {
    const sent: string[] = [];
    const writes: string[] = [];
    let recording = true;
    const store = new ScrollbackStore((_id, blob) => writes.push(blob), {
      send: (_id, data) => sent.push(data),
      recording: () => recording,
    });
    store.show('s1', 'marker', { cols: 80, rows: 24 });
    recording = false;
    store.show('s1', 'unrecorded', { cols: 80, rows: 24 });
    expect(sent).toEqual(['marker', 'unrecorded']);
    store.flush('s1');
    expect(restored(writes[writes.length - 1])?.segments).toEqual([
      { data: 'marker', geometry: { cols: 80, rows: 24 } },
    ]);
  });

  it('records nothing for an empty restored ring', () => {
    const { store, writes } = harness();
    expect(store.replayForColdStart('s1', () => [])?.data).toBe('');
    vi.advanceTimersByTime(1000);
    expect(writes).toHaveLength(0);
  });

  it('flushPending writes only sessions with a write still pending', () => {
    const { store, writes } = harness();
    store.append('s1', 'a', { cols: 80, rows: 24 });
    store.append('s2', 'b', { cols: 80, rows: 24 });
    store.flush('s2');
    writes.length = 0;
    store.flushPending();
    expect(writes.map((b) => restored(b)?.sessionId)).toEqual(['s1']);
    vi.advanceTimersByTime(1000);
    expect(writes).toHaveLength(1);
  });

  it('drop forgets the ring and its pending write', () => {
    const { store, writes } = harness();
    store.append('s1', 'a', { cols: 80, rows: 24 });
    store.drop('s1');
    vi.advanceTimersByTime(1000);
    store.flush('s1');
    expect(writes).toHaveLength(0);
    expect(store.attachReplay('s1').data).toBe('');
  });

  describe('replayBeforeLaunch', () => {
    const A = { cols: 80, rows: 24 };
    const B = { cols: 40, rows: 12 };

    it('is the ring before the current launch, run by run, recording nothing', () => {
      const { store } = harness();
      store.append('s1', 'run1', A);
      store.append('s1', 'marker', B);
      store.markLaunch('s1');
      store.append('s1', 'run2', B);
      expect(store.replayBeforeLaunch('s1')).toEqual({
        data: 'run1marker',
        runs: [
          { length: 4, geometry: A },
          { length: 6, geometry: B },
        ],
      });
      expect(store.attachReplay('s1').data).toBe('run1markerrun2');
    });

    it('is nothing for a first launch, and follows the latest mark', () => {
      const { store } = harness();
      store.markLaunch('s1');
      store.append('s1', 'run1', A);
      expect(store.replayBeforeLaunch('s1')).toBeUndefined();
      store.markLaunch('s1');
      store.append('s1', 'run2', A);
      expect(store.replayBeforeLaunch('s1')?.data).toBe('run1');
    });

    it('moves with the ring as its head is trimmed', () => {
      const writes: string[] = [];
      const store = new ScrollbackStore((_id, blob) => writes.push(blob), {
        send: () => {},
        recording: () => true,
        cap: 8,
      });
      store.append('s1', 'abcdef', A);
      store.markLaunch('s1');
      store.append('s1', 'XYZ', A);
      expect(store.replayBeforeLaunch('s1')?.data).toBe('bcdef');
      store.append('s1', 'QRSTUV', A);
      expect(store.replayBeforeLaunch('s1')).toBeUndefined();
    });

    it('persists the mark, and without one stops before the last relaunch marker', () => {
      const { store, lastWrite } = harness();
      store.append('s1', 'run1', A);
      store.markLaunch('s1');
      store.append('s1', 'run2', A);
      store.flush('s1');
      expect(lastWrite()?.beforeLaunch).toBe(4);
      // A file written without a mark: everything before the last cold start's marker line.
      const unmarked = harness().store;
      unmarked.append('s2', 'run1', A);
      unmarked.append('s2', RELAUNCH_MARKER, A);
      unmarked.append('s2', 'run2', A);
      expect(unmarked.replayBeforeLaunch('s2')?.data).toBe(`run1${RELAUNCH_MARKER.slice(0, 2)}`);
    });
  });

  it('does not re-serialise a ring that has not changed since the last write', () => {
    const { store, writes } = harness();
    store.append('s1', 'a', { cols: 80, rows: 24 });
    store.flush('s1');
    store.flush('s1');
    expect(writes).toHaveLength(1);
    store.append('s1', 'b', { cols: 80, rows: 24 });
    store.flush('s1');
    expect(writes).toHaveLength(2);
    store.markLaunch('s1');
    store.flush('s1');
    expect(writes).toHaveLength(3);
  });
});
