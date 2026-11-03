import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  diskScrollbackFiles,
  GAP_MARKER,
  type ScrollbackFiles,
  ServerScrollback,
} from '../../server/scrollback';
import type { ServerEvent, ServerEvents } from '../../src/contracts/server-protocol';
import type { TermGeometry } from '../../src/protocol';
import { scrollbackFileName } from '../../src/scrollback-files';
import {
  coldReplay,
  restoreScrollback,
  serializeScrollback,
} from '../../src/scrollback-persistence';

const SIZE: TermGeometry = { cols: 80, rows: 24 };

let disk: Map<string, string>;
let shown: Array<{ type: ServerEvent; data: unknown }>;
let recording: boolean;
let size: TermGeometry | undefined;

function make() {
  const files: ScrollbackFiles = {
    read: (name) => disk.get(name),
    write: (name, blob) => {
      disk.set(name, blob);
    },
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

  it('a view replay is the cold replay, neutralizer included, and records nothing', () => {
    const segments = [{ data: 'old\x1b[?1049h\x1b[?1000h', geometry: SIZE }];
    disk.set(
      scrollbackFileName('a'),
      serializeScrollback({ version: 2, sessionId: 'a', segments }),
    );
    const before = disk.get(scrollbackFileName('a'));
    const s = make();
    const viewed = s.replayForView('a');
    expect(viewed?.data).toBe(coldReplay(segments).data);
    expect(viewed?.data.length).toBeGreaterThan(segments[0].data.length);
    expect(s.replayForView('a')).toEqual(viewed);
    s.flushPending();
    vi.runAllTimers();
    expect(disk.get(scrollbackFileName('a'))).toBe(before);
    expect(shown).toEqual([]);
    expect(make().replayForView('none')).toBeNull();
  });

  it('hydrates the persisted ring before appending adoption output in a fresh instance', async () => {
    const scratch = path.join(os.tmpdir(), 'Codex-scratch');
    fs.mkdirSync(scratch, { recursive: true });
    const dir = fs.mkdtempSync(path.join(scratch, 'server-ring-'));
    const create = () =>
      new ServerScrollback({
        files: diskScrollbackFiles(dir, () => {}),
        emit: (type) => shown.push({ type, data: undefined }),
        sizeOf: () => SIZE,
        recording: () => true,
      });
    try {
      const first = create();
      first.append('a', 'persisted-before-restart', SIZE);
      await first.flushPending();
      const second = create();
      second.gap('a', 'adopted-after-restart', SIZE);
      await second.flushPending();
      const restored = restoreScrollback(
        fs.readFileSync(path.join(dir, scrollbackFileName('a')), 'utf8'),
      );
      expect(restored.kind === 'ok' ? restored.scrollback.segments[0]?.data : null).toBe(
        `persisted-before-restart${GAP_MARKER}adopted-after-restart`,
      );
      expect(shown).toEqual([]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('replays the ring before the launch, and a fresh instance reads the mark from disk', () => {
    const s = make();
    s.append('a', 'run1', SIZE);
    s.launchStarted('a');
    s.append('a', 'run2', SIZE);
    expect(s.replayBeforeLaunch('a')).toEqual({
      data: 'run1',
      replay: [{ length: 4, geometry: SIZE }],
    });
    s.flushPending();
    const after = make();
    after.gap('a', 'PAINT', SIZE);
    expect(after.replayBeforeLaunch('a')?.data).toBe('run1');
    expect(make().replayBeforeLaunch('none')).toBeNull();
  });

  it('flushPending waits for a delayed disk write', async () => {
    let release!: () => void;
    let written = false;
    const files: ScrollbackFiles = {
      read: (name) => disk.get(name),
      write: async (name, blob) => {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        disk.set(name, blob);
        written = true;
      },
      remove: (name) => disk.delete(name),
    };
    const s = new ServerScrollback({
      files,
      emit: <E extends ServerEvent>(type: E, data: ServerEvents[E]) => shown.push({ type, data }),
      sizeOf: () => size,
      recording: () => recording,
    });
    s.append('a', 'delayed', SIZE);
    const flushing = s.flushPending();
    let completed = false;
    void flushing.then(() => {
      completed = true;
    });
    await Promise.resolve();
    expect(completed).toBe(false);
    release();
    await flushing;
    expect(written).toBe(true);
  });

  it('flushPending propagates disk write failures', async () => {
    const files: ScrollbackFiles = {
      read: (name) => disk.get(name),
      write: async () => {
        throw new Error('disk failed');
      },
      remove: (name) => disk.delete(name),
    };
    const s = new ServerScrollback({
      files,
      emit: <E extends ServerEvent>(type: E, data: ServerEvents[E]) => shown.push({ type, data }),
      sizeOf: () => size,
      recording: () => recording,
    });
    s.append('a', 'fail', SIZE);
    await expect(s.flushPending()).rejects.toThrow('disk failed');
  });

  it('flushPending propagates a debounced write failure that already settled', async () => {
    vi.useFakeTimers();
    const s = new ServerScrollback({
      files: {
        read: () => undefined,
        write: async () => {
          throw new Error('earlier disk failure');
        },
        remove: () => {},
      },
      emit: () => {},
      sizeOf: () => SIZE,
      recording: () => true,
    });
    s.append('a', 'bytes already credited', SIZE);
    await vi.advanceTimersByTimeAsync(250);
    await expect(s.flushPending()).rejects.toThrow('earlier disk failure');
    vi.useRealTimers();
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
