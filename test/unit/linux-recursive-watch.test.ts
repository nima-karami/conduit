import { EventEmitter } from 'node:events';
import type * as fs from 'node:fs';
import * as nodeFs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRecursiveWatch } from '../../electron/linux-recursive-watch';
import type { WatchFn } from '../../electron/watch-dir';
import { shouldIgnoreWatchPath } from '../../src/watch-filter';

type Listener = (event: string, filename: string | Buffer | null) => void;
interface Fake {
  dir: string;
  opts: { recursive?: boolean };
  cb: Listener;
  w: EventEmitter;
  close: ReturnType<typeof vi.fn>;
}

/** A fake `fs.watch`: records every open, and can refuse the Nth one with an error. */
function fakeWatch(refuseAt?: number, refusal?: Error) {
  const opened: Fake[] = [];
  let calls = 0;
  const watch = vi.fn((dir: string, opts: { recursive?: boolean }, cb: Listener) => {
    calls += 1;
    if (refuseAt === calls && refusal) throw refusal;
    const w = new EventEmitter();
    const close = vi.fn();
    opened.push({ dir, opts, cb, w, close });
    return Object.assign(w, { close }) as unknown as fs.FSWatcher;
  });
  const open = () => opened.filter((x) => !x.close.mock.calls.length);
  return { watch, opened, open, attempts: () => calls };
}

const rel = (root: string, dir: string) => path.relative(root, dir).split(path.sep).join('/');

let tmp: string[];
const mkRoot = (): string => {
  const root = nodeFs.realpathSync(nodeFs.mkdtempSync(path.join(os.tmpdir(), 'linux-watch-')));
  tmp.push(root);
  return root;
};
const mkTree = (root: string, dirs: string[]) => {
  for (const d of dirs) nodeFs.mkdirSync(path.join(root, d), { recursive: true });
};

beforeEach(() => {
  tmp = [];
});
afterEach(() => {
  for (const root of tmp) nodeFs.rmSync(root, { recursive: true, force: true });
});

describe('createRecursiveWatch', () => {
  it('opens one non-recursive watch per kept dir and none under ignored dirs', async () => {
    const root = mkRoot();
    mkTree(root, [
      'src/a/b',
      'node_modules/pkg/lib',
      'dist',
      '.git/objects/ab',
      '.git/refs/heads',
      '.git/logs',
    ]);
    nodeFs.writeFileSync(path.join(root, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    const fw = fakeWatch();
    const h = createRecursiveWatch(
      root,
      { ignore: shouldIgnoreWatchPath, watch: fw.watch },
      vi.fn(),
      vi.fn(),
    );
    await vi.waitFor(() => expect(fw.open().length).toBe(7));
    const dirs = fw.opened.map((x) => rel(root, x.dir)).sort();
    expect(dirs).toEqual(['', '.git', '.git/refs', '.git/refs/heads', 'src', 'src/a', 'src/a/b']);
    expect(fw.opened.every((x) => x.opts.recursive === false)).toBe(true);
    h.close();
  });

  it('never follows a symlinked directory', async () => {
    const root = mkRoot();
    const outside = mkRoot();
    mkTree(outside, ['deep']);
    mkTree(root, ['src']);
    nodeFs.symlinkSync(outside, path.join(root, 'src', 'link'), 'dir');
    const fw = fakeWatch();
    const h = createRecursiveWatch(
      root,
      { ignore: () => false, watch: fw.watch },
      vi.fn(),
      vi.fn(),
    );
    await vi.waitFor(() => expect(fw.open().length).toBe(2));
    expect(fw.opened.map((x) => rel(root, x.dir)).sort()).toEqual(['', 'src']);
    h.close();
  });

  it('a subdirectory created after start is watched, and its events carry the relative path', async () => {
    const root = mkRoot();
    mkTree(root, ['src']);
    const fw = fakeWatch();
    const onEvent = vi.fn();
    const h = createRecursiveWatch(
      root,
      { ignore: () => false, watch: fw.watch },
      onEvent,
      vi.fn(),
    );
    await vi.waitFor(() => expect(fw.open().length).toBe(2));
    const src = fw.opened.find((x) => rel(root, x.dir) === 'src');
    nodeFs.mkdirSync(path.join(root, 'src', 'fresh'));
    src?.cb('rename', 'fresh');
    expect(onEvent).toHaveBeenCalledWith('rename', 'src/fresh');
    await vi.waitFor(() =>
      expect(fw.opened.some((x) => rel(root, x.dir) === 'src/fresh')).toBe(true),
    );
    const fresh = fw.opened.find((x) => rel(root, x.dir) === 'src/fresh');
    fresh?.cb('change', 'file.ts');
    expect(onEvent).toHaveBeenLastCalledWith('change', 'src/fresh/file.ts');
    h.close();
  });

  it('a new subdirectory that matches the ignore predicate is not watched', async () => {
    const root = mkRoot();
    mkTree(root, ['src']);
    const fw = fakeWatch();
    const h = createRecursiveWatch(
      root,
      { ignore: shouldIgnoreWatchPath, watch: fw.watch },
      vi.fn(),
      vi.fn(),
    );
    await vi.waitFor(() => expect(fw.open().length).toBe(2));
    nodeFs.mkdirSync(path.join(root, 'node_modules'));
    fw.opened.find((x) => rel(root, x.dir) === 'src')?.cb('rename', 'node_modules');
    await new Promise((r) => setTimeout(r, 30));
    expect(fw.attempts()).toBe(2);
    h.close();
  });

  it('deleting a watched subdirectory closes its watch and every descendant watch', async () => {
    const root = mkRoot();
    mkTree(root, ['src/a/b', 'src/keep']);
    const fw = fakeWatch();
    const h = createRecursiveWatch(
      root,
      { ignore: () => false, watch: fw.watch },
      vi.fn(),
      vi.fn(),
    );
    await vi.waitFor(() => expect(fw.open().length).toBe(5));
    nodeFs.rmSync(path.join(root, 'src', 'a'), { recursive: true, force: true });
    fw.opened.find((x) => rel(root, x.dir) === 'src')?.cb('rename', 'a');
    await vi.waitFor(() =>
      expect(
        fw.opened
          .filter((x) => x.close.mock.calls.length > 0)
          .map((x) => rel(root, x.dir))
          .sort(),
      ).toEqual(['src/a', 'src/a/b']),
    );
    expect(
      fw
        .open()
        .map((x) => rel(root, x.dir))
        .sort(),
    ).toEqual(['', 'src', 'src/keep']);
    h.close();
  });

  it('close() closes every watch', async () => {
    const root = mkRoot();
    mkTree(root, ['a', 'b/c']);
    const fw = fakeWatch();
    const h = createRecursiveWatch(
      root,
      { ignore: () => false, watch: fw.watch },
      vi.fn(),
      vi.fn(),
    );
    await vi.waitFor(() => expect(fw.open().length).toBe(4));
    h.close();
    expect(fw.opened.every((x) => x.close.mock.calls.length === 1)).toBe(true);
    h.close();
    expect(fw.opened.every((x) => x.close.mock.calls.length === 1)).toBe(true);
  });

  it('close() during the walk cancels it: no watch is opened afterwards', async () => {
    const root = mkRoot();
    mkTree(root, ['a/b', 'c/d', 'e']);
    const fw = fakeWatch();
    const h = createRecursiveWatch(
      root,
      { ignore: () => false, watch: fw.watch },
      vi.fn(),
      vi.fn(),
    );
    h.close();
    await new Promise((r) => setTimeout(r, 50));
    expect(fw.attempts()).toBeLessThanOrEqual(1);
    expect(fw.opened.every((x) => x.close.mock.calls.length === 1)).toBe(true);
  });

  it('an ENOSPC on the 3rd watch calls onError once and attempts no further watch', async () => {
    const root = mkRoot();
    mkTree(root, ['a', 'b', 'c', 'd']);
    const enospc = Object.assign(
      new Error('ENOSPC: System limit for number of file watchers reached'),
      {
        code: 'ENOSPC',
      },
    );
    const fw = fakeWatch(3, enospc);
    const onError = vi.fn();
    const h = createRecursiveWatch(
      root,
      { ignore: () => false, watch: fw.watch },
      vi.fn(),
      onError,
    );
    await vi.waitFor(() => expect(onError).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 30));
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(enospc);
    expect(fw.attempts()).toBe(3);
    // Existing watches are kept, not torn down by the limit.
    expect(fw.opened.every((x) => x.close.mock.calls.length === 0)).toBe(true);
    h.close();
  });

  it('an EMFILE on a later watch is handled the same way', async () => {
    const root = mkRoot();
    mkTree(root, ['a', 'b', 'c']);
    const emfile = Object.assign(new Error('EMFILE: too many open files'), { code: 'EMFILE' });
    const fw = fakeWatch(2, emfile);
    const onError = vi.fn();
    const h = createRecursiveWatch(
      root,
      { ignore: () => false, watch: fw.watch },
      vi.fn(),
      onError,
    );
    await vi.waitFor(() => expect(onError).toHaveBeenCalledWith(emfile));
    await new Promise((r) => setTimeout(r, 30));
    expect(onError).toHaveBeenCalledTimes(1);
    expect(fw.attempts()).toBe(2);
    h.close();
  });

  it('an error on the root watch closes everything and reports it through onError', async () => {
    const root = mkRoot();
    mkTree(root, ['a']);
    const fw = fakeWatch();
    const onError = vi.fn();
    const h = createRecursiveWatch(
      root,
      { ignore: () => false, watch: fw.watch },
      vi.fn(),
      onError,
    );
    await vi.waitFor(() => expect(fw.open().length).toBe(2));
    const failure = new Error('EIO');
    fw.opened[0].w.emit('error', failure);
    expect(onError).toHaveBeenCalledWith(failure);
    expect(fw.opened.every((x) => x.close.mock.calls.length === 1)).toBe(true);
    h.close();
  });

  it('the root itself removed reports onError with no error and closes everything', async () => {
    const root = mkRoot();
    mkTree(root, ['a']);
    const fw = fakeWatch();
    const onError = vi.fn();
    const onEvent = vi.fn();
    const h = createRecursiveWatch(
      root,
      { ignore: () => false, watch: fw.watch },
      onEvent,
      onError,
    );
    await vi.waitFor(() => expect(fw.open().length).toBe(2));
    nodeFs.rmSync(root, { recursive: true, force: true });
    fw.opened[0].cb('rename', path.basename(root));
    await vi.waitFor(() => expect(onError).toHaveBeenCalledWith(undefined));
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onEvent).not.toHaveBeenCalled();
    expect(fw.opened.every((x) => x.close.mock.calls.length === 1)).toBe(true);
    h.close();
  });

  it('root-level events report the name relative to the root', async () => {
    const root = mkRoot();
    const fw = fakeWatch();
    const onEvent = vi.fn();
    const h = createRecursiveWatch(
      root,
      { ignore: () => false, watch: fw.watch },
      onEvent,
      vi.fn(),
    );
    fw.opened[0].cb('change', 'README.md');
    expect(onEvent).toHaveBeenCalledWith('change', 'README.md');
    h.close();
  });

  describe('an unreadable folder', () => {
    const eacces = () => Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });

    it('a readdir EACCES drops that subtree, keeps its siblings live, and does not end the watch', async () => {
      const root = mkRoot();
      mkTree(root, ['src/locked/deep', 'src/open']);
      const locked = path.join(root, 'src', 'locked');
      const fw = fakeWatch();
      const onError = vi.fn();
      const onSkip = vi.fn();
      const onEvent = vi.fn();
      const readdir = (dir: string) =>
        dir === locked
          ? Promise.reject(eacces())
          : nodeFs.promises.readdir(dir, { withFileTypes: true });
      const h = createRecursiveWatch(
        root,
        { ignore: () => false, watch: fw.watch, readdir, onSkip },
        onEvent,
        onError,
      );
      await vi.waitFor(() => expect(onSkip).toHaveBeenCalledTimes(1));
      expect(onSkip.mock.calls[0][0]).toBe('src/locked');
      expect(onSkip.mock.calls[0][1]).toMatchObject({ code: 'EACCES' });
      expect(
        fw
          .open()
          .map((x) => rel(root, x.dir))
          .sort(),
      ).toEqual(['', 'src', 'src/open']);
      expect(fw.opened.find((x) => rel(root, x.dir) === 'src/locked')?.close).toHaveBeenCalled();
      fw.opened.find((x) => rel(root, x.dir) === 'src/open')?.cb('change', 'a.ts');
      expect(onEvent).toHaveBeenCalledWith('change', 'src/open/a.ts');
      expect(onError).not.toHaveBeenCalled();
      h.close();
    });

    it('an EACCES opening a child watch skips that subtree once, and the rest stays live', async () => {
      const root = mkRoot();
      mkTree(root, ['src/locked/deep', 'src/open']);
      const locked = path.join(root, 'src', 'locked');
      const fw = fakeWatch();
      const onError = vi.fn();
      const onSkip = vi.fn();
      const onEvent = vi.fn();
      const watch = vi.fn((dir: string, o: { recursive?: boolean }, cb: Listener) => {
        if (dir === locked) throw eacces();
        return fw.watch(dir, o, cb);
      });
      const h = createRecursiveWatch(
        root,
        { ignore: () => false, watch: watch as WatchFn, onSkip },
        onEvent,
        onError,
      );
      await vi.waitFor(() => expect(onSkip).toHaveBeenCalledTimes(1));
      expect(onSkip.mock.calls[0][0]).toBe('src/locked');
      expect(
        fw
          .open()
          .map((x) => rel(root, x.dir))
          .sort(),
      ).toEqual(['', 'src', 'src/open']);
      await new Promise((r) => setTimeout(r, 30));
      expect(onSkip).toHaveBeenCalledTimes(1);
      expect(watch.mock.calls.some(([d]) => d === path.join(locked, 'deep'))).toBe(false);
      fw.opened.find((x) => rel(root, x.dir) === 'src/open')?.cb('change', 'b.ts');
      expect(onEvent).toHaveBeenCalledWith('change', 'src/open/b.ts');
      expect(onError).not.toHaveBeenCalled();
      h.close();
    });

    it('an EACCES on the root itself still ends the watch through onError', async () => {
      const root = mkRoot();
      const fw = fakeWatch();
      const onError = vi.fn();
      const readdir = () => Promise.reject(eacces());
      const h = createRecursiveWatch(
        root,
        { ignore: () => false, watch: fw.watch, readdir },
        vi.fn(),
        onError,
      );
      await vi.waitFor(() => expect(onError).toHaveBeenCalledTimes(1));
      expect(onError.mock.calls[0][0]).toMatchObject({ code: 'EACCES' });
      h.close();
    });
  });
});
