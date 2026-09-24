import { EventEmitter } from 'node:events';
import type * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type WatchedChange, watchServerRoot } from '../../electron/lsp-watcher';
import { compileWatchGlobs, GO_SERVER, isRootMarker } from '../../src/lsp-registry';

const ROOT = path.join(path.sep, 'w', 'mod');
const abs = (rel: string) => path.join(ROOT, rel);
/** What libuv reports for the deleted root itself: its path resolved against the cwd. */
const SELF = `\\\\?\\${path.resolve(ROOT)}`;

function fakeWatch() {
  let listener: ((event: string, filename: string | null) => void) | null = null;
  const watcher = Object.assign(new EventEmitter(), { close: vi.fn() });
  const watch = vi.fn((_root: string, _opts: unknown, cb: typeof listener) => {
    listener = cb;
    return watcher;
  });
  return {
    watch: watch as unknown as typeof fs.watch,
    watcher,
    emit: (event: 'rename' | 'change', rel: string) => listener?.(event, rel),
  };
}

const goFilter = {
  matches: compileWatchGlobs(GO_SERVER.watchGlobs),
  isMarker: (rel: string) => isRootMarker(GO_SERVER, rel),
};

function setup(existing: string[] = [], filter = goFilter) {
  const w = fakeWatch();
  const batches: WatchedChange[][] = [];
  const onMarker = vi.fn();
  const onGone = vi.fn();
  const log = vi.fn();
  const files = new Set(existing.map(abs));
  const handle = watchServerRoot(ROOT, filter, (c) => batches.push(c), onMarker, onGone, {
    watch: w.watch,
    stat: async (p) => files.has(p),
    log,
  });
  return { ...w, batches, onMarker, onGone, log, handle, files };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('watchServerRoot', () => {
  it('only rels passing filter.matches reach onChanges', async () => {
    const s = setup(['a.go', 'x.ts']);
    s.emit('change', 'a.go');
    s.emit('change', 'x.ts');
    await vi.advanceTimersByTimeAsync(200);
    expect(s.batches).toEqual([[{ path: abs('a.go'), type: 2 }]]);
  });

  it('a custom matcher (**/*.rs) is honoured — the watcher knows no language', async () => {
    const s = setup(['src/lib.rs', 'main.go'], {
      matches: compileWatchGlobs(['**/*.rs']),
      isMarker: () => false,
    });
    s.emit('change', 'src/lib.rs');
    s.emit('change', 'main.go');
    await vi.advanceTimersByTimeAsync(200);
    expect(s.batches).toEqual([[{ path: abs('src/lib.rs'), type: 2 }]]);
  });

  it('node_modules and .git noise ignored', async () => {
    const s = setup(['node_modules/x/a.go', '.git/objects/a.go', 'vendor.go']);
    s.emit('change', 'node_modules/x/a.go');
    s.emit('change', '.git/objects/a.go');
    await vi.advanceTimersByTimeAsync(500);
    expect(s.batches).toEqual([]);
  });

  it('a 200 ms burst becomes one batch with the last type per path', async () => {
    const s = setup(['a.go', 'b.go']);
    s.emit('rename', 'a.go');
    s.emit('change', 'a.go');
    s.emit('change', 'b.go');
    s.emit('rename', 'b.go');
    await vi.advanceTimersByTimeAsync(199);
    expect(s.batches).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(s.batches).toEqual([
      [
        { path: abs('a.go'), type: 2 },
        { path: abs('b.go'), type: 1 },
      ],
    ]);
  });

  it('deleted 3, created 1, modified 2', async () => {
    const s = setup(['new.go', 'mod.go']);
    s.emit('rename', 'gone.go');
    s.emit('rename', 'new.go');
    s.emit('change', 'mod.go');
    await vi.advanceTimersByTimeAsync(200);
    expect(s.batches[0]).toEqual([
      { path: abs('gone.go'), type: 3 },
      { path: abs('new.go'), type: 1 },
      { path: abs('mod.go'), type: 2 },
    ]);
  });

  it('a marker rel fires onMarker once per batch', async () => {
    const s = setup(['go.mod', 'sub/go.mod', 'a.go']);
    s.emit('change', 'go.mod');
    s.emit('rename', 'sub/go.mod');
    s.emit('change', 'a.go');
    await vi.advanceTimersByTimeAsync(200);
    expect(s.onMarker).toHaveBeenCalledTimes(1);
    s.emit('change', 'a.go');
    await vi.advanceTimersByTimeAsync(200);
    expect(s.onMarker).toHaveBeenCalledTimes(1);
  });

  it('close stops watcher and timer', async () => {
    const s = setup(['a.go']);
    s.emit('change', 'a.go');
    s.handle.close();
    await vi.advanceTimersByTimeAsync(500);
    expect(s.watcher.close).toHaveBeenCalled();
    expect(s.batches).toEqual([]);
  });

  it('watch error closes and logs', () => {
    const s = setup();
    s.watcher.emit('error', new Error('EPERM'));
    expect(s.watcher.close).toHaveBeenCalled();
    expect(s.log).toHaveBeenCalledWith(expect.stringContaining('EPERM'));
  });

  it('the server root itself vanishing closes the watch once and sends nothing', async () => {
    const s = setup();
    for (let i = 0; i < 1000; i++) s.emit('rename', SELF);
    expect(s.watcher.close).toHaveBeenCalledTimes(1);
    expect(s.log).toHaveBeenCalledWith(expect.stringContaining('vanished'));
    await vi.advanceTimersByTimeAsync(500);
    expect(s.batches).toEqual([]);
    expect(s.onGone).toHaveBeenCalledTimes(1);
  });

  it('a vanishing root still delivers the deletions reported just before it, marker included', async () => {
    const s = setup();
    s.emit('rename', 'go.mod');
    s.emit('rename', 'a.go');
    s.emit('rename', SELF);
    await vi.advanceTimersByTimeAsync(0);
    expect(s.batches).toEqual([
      [
        { path: abs('go.mod'), type: 3 },
        { path: abs('a.go'), type: 3 },
      ],
    ]);
    expect(s.onMarker).toHaveBeenCalledTimes(1);
    expect(s.onGone).toHaveBeenCalledTimes(1);
    expect(s.onGone.mock.invocationCallOrder[0]).toBeGreaterThan(
      s.onMarker.mock.invocationCallOrder[0] as number,
    );
    await vi.advanceTimersByTimeAsync(500);
    expect(s.batches).toHaveLength(1);
  });

  it('a watch error flushes the pending batch too, then reports gone', async () => {
    const s = setup(['a.go']);
    s.emit('change', 'a.go');
    s.watcher.emit('error', new Error('EPERM'));
    await vi.advanceTimersByTimeAsync(0);
    expect(s.batches).toEqual([[{ path: abs('a.go'), type: 2 }]]);
    expect(s.onGone).toHaveBeenCalledTimes(1);
  });

  it('an explicit close is never reported as gone', async () => {
    const s = setup();
    s.emit('rename', 'go.mod');
    s.handle.close();
    await vi.advanceTimersByTimeAsync(500);
    expect(s.onGone).not.toHaveBeenCalled();
    expect(s.batches).toEqual([]);
  });
});
