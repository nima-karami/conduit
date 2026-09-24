import { EventEmitter } from 'node:events';
import type * as fs from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { namesWatchedDir, type WatchFn, watchDir } from '../../electron/watch-dir';

type Listener = (event: string, filename: string | Buffer | null) => void;

function setup(dir: string, recursive = false) {
  let cb: Listener = () => {};
  const w = Object.assign(new EventEmitter(), { close: vi.fn() });
  const watch = vi.fn((_d: string, _o: { recursive?: boolean }, l: Listener) => {
    cb = l;
    return w as unknown as fs.FSWatcher;
  });
  const events: [string, string | null][] = [];
  const gone: (Error | undefined)[] = [];
  const handle = watchDir(
    dir,
    { recursive, watch: watch as WatchFn },
    (event, filename) => events.push([event, filename]),
    (err) => gone.push(err),
  );
  return { handle, watch, w, events, gone, emit: (e: string, f: string | null) => cb(e, f) };
}

describe('watchDir', () => {
  it('passes the dir and recursive flag through and forwards ordinary events', () => {
    const h = setup('C:\\x\\R', true);
    expect(h.watch).toHaveBeenCalledWith('C:\\x\\R', { recursive: true }, expect.any(Function));
    h.emit('change', 'a.ts');
    h.emit('rename', 'src\\b.ts');
    h.emit('rename', null);
    expect(h.events).toEqual([
      ['change', 'a.ts'],
      ['rename', 'src\\b.ts'],
      ['rename', null],
    ]);
    expect(h.gone).toEqual([]);
  });

  // Measured on Windows (Electron 43 / libuv 1.52): a deleted watched directory — recursive or
  // not — reports its own `\\?\` path as `rename` ~80 000 times a second, never an 'error'.
  it('an event naming the watched dir itself reports gone once and closes the watch', () => {
    const h = setup('C:\\x\\R');
    for (let i = 0; i < 1000; i++) h.emit('rename', '\\\\?\\C:\\x\\R');
    expect(h.gone).toEqual([undefined]);
    expect(h.w.close).toHaveBeenCalledTimes(1);
    expect(h.events).toEqual([]);
  });

  it('matches the self-named event whatever the spelling the watch was opened with', () => {
    const h = setup('c:/X/r/');
    h.emit('rename', '\\\\?\\C:\\x\\R');
    expect(h.gone).toEqual([undefined]);
  });

  it('recognises a UNC dir through its \\\\?\\UNC\\ spelling', () => {
    const h = setup('\\\\srv\\Share\\R');
    h.emit('rename', '\\\\?\\UNC\\srv\\share\\R');
    expect(h.gone).toEqual([undefined]);
    expect(h.events).toEqual([]);
  });

  it('a child entry named like the dir is still an ordinary change', () => {
    const h = setup('C:\\x\\R');
    h.emit('rename', 'R');
    h.emit('rename', 'R\\R');
    expect(h.gone).toEqual([]);
    expect(h.events).toEqual([
      ['rename', 'R'],
      ['rename', 'R\\R'],
    ]);
  });

  it('a long-path name that is not the dir itself is not gone', () => {
    const h = setup('C:\\x\\R');
    h.emit('rename', '\\\\?\\C:\\x\\R\\sub');
    h.emit('rename', '\\\\?\\C:\\x\\R2');
    expect(h.gone).toEqual([]);
    expect(h.events).toHaveLength(2);
  });

  it("an 'error' reports gone with the error and closes the watch", () => {
    const h = setup('C:\\x\\R');
    const err = new Error('EPERM');
    h.w.emit('error', err);
    h.emit('rename', '\\\\?\\C:\\x\\R');
    expect(h.gone).toEqual([err]);
    expect(h.w.close).toHaveBeenCalledTimes(1);
  });

  it('close() is idempotent and silences every later callback', () => {
    const h = setup('C:\\x\\R');
    h.handle.close();
    h.handle.close();
    h.emit('change', 'a.ts');
    h.emit('rename', '\\\\?\\C:\\x\\R');
    expect(h.w.close).toHaveBeenCalledTimes(1);
    expect(h.events).toEqual([]);
    expect(h.gone).toEqual([]);
  });

  it('a throwing watch propagates to the caller', () => {
    const watch = (() => {
      throw new Error('ENOENT');
    }) as WatchFn;
    expect(() => watchDir('C:\\nope', { watch }, vi.fn(), vi.fn())).toThrow('ENOENT');
  });
});

describe('namesWatchedDir', () => {
  it('is false for relative names and true only for the dir itself', () => {
    expect(namesWatchedDir('C:\\x\\R', 'R')).toBe(false);
    expect(namesWatchedDir('C:\\x\\R', '\\\\?\\C:\\x\\R')).toBe(true);
    expect(namesWatchedDir('C:\\x\\R', '\\\\?\\c:\\X\\r')).toBe(true);
    expect(namesWatchedDir('C:\\x\\R', '\\\\?\\C:\\x')).toBe(false);
  });
});
