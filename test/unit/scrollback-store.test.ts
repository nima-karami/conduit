import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PtyHost } from '../../src/pty-host';
import { restoreScrollback } from '../../src/scrollback-persistence';
import { ScrollbackStore } from '../../src/scrollback-store';

// node-pty is a native addon built against Electron's ABI; PtyHost's bookkeeping is the subject.
let emit: ((data: string) => void) | null = null;
let onExitCb: ((e: { exitCode: number }) => void) | null = null;
vi.mock('@lydell/node-pty', () => ({
  spawn: () => ({
    onData: (cb: (data: string) => void) => {
      emit = cb;
    },
    onExit: (cb: (e: { exitCode: number }) => void) => {
      onExitCb = cb;
    },
    write: () => {},
    resize: () => {},
    kill: () => {},
  }),
}));

const spec = { command: 'cmd.exe', args: [] as string[], cwd: '.' };

function harness() {
  const writes: string[] = [];
  const store = new ScrollbackStore((_id, blob) => writes.push(blob), {
    send: () => {},
    recording: () => true,
  });
  const lastWrite = () => restoreScrollback(writes[writes.length - 1]);
  return { store, writes, lastWrite };
}

describe('ScrollbackStore', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('keeps the geometry when a session exits and is disposed inside the debounce window', () => {
    const { store, writes, lastWrite } = harness();
    // Wired the way main.ts wires it: output is stamped with the live PTY's size on arrival,
    // the exit flushes, and the exited pane's term:dispose disposes the PTY.
    const host = new PtyHost((msg) => {
      if (msg.type === 'term:data') store.append(msg.sessionId, msg.data, host.size(msg.sessionId));
      if (msg.type === 'term:exit') store.flush(msg.sessionId);
    });
    host.start('s1', 144, 73, spec);
    emit?.('last words\r\n');
    onExitCb?.({ exitCode: 0 });
    host.dispose('s1');
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
    expect(restoreScrollback(writes[writes.length - 1])?.segments).toEqual([
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
    expect(writes.map((b) => restoreScrollback(b)?.sessionId)).toEqual(['s1']);
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
});
