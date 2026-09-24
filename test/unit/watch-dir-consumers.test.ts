import type { FSWatcher } from 'node:fs';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BoardWatcher } from '../../electron/board-watcher';
import { ConduitDirWatch } from '../../electron/conduit-dir-watch';
import {
  BOARD_FILE_NAME,
  conduitDir,
  PLANS_DIR_NAME,
  writePlanFile,
} from '../../electron/conduit-fs';
import { OpenFileWatcher } from '../../electron/open-file-watcher';
import { PlanWatcher } from '../../electron/plan-watcher';
import { EXISTS_POLL_MS, watchDirWhilePresent } from '../../electron/watch-dir';
import type { BoardData } from '../../src/board';
import { serializeBoardArtifact } from '../../src/conduit-store';
import { board, delay, waitFor } from './watch-test-helpers';

type Listener = (event: string, filename: string | null) => void;
interface RealWatch {
  dir: string;
  cb: Listener;
  w: FSWatcher;
  close: ReturnType<typeof vi.spyOn>;
}

// Real watches (so real writes still arrive), recorded so a test can hand a callback the
// self-named event Windows produces for a deleted watched directory on any platform. While
// `refuse` is set, opening a watch throws it (inotify ENOSPC, an unsupported filesystem).
const watches: RealWatch[] = [];
let refuse: Error | null = null;
vi.mock('node:fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs')>();
  const watch = (dir: string, ...rest: unknown[]) => {
    if (refuse) throw refuse;
    const cb = rest[rest.length - 1] as Listener;
    const w = (real.watch as (...a: unknown[]) => FSWatcher)(dir, ...rest);
    watches.push({ dir, cb, w, close: vi.spyOn(w, 'close') });
    return w;
  };
  return { ...real, default: { ...real, watch }, watch };
});

const vanish = (x: RealWatch) => {
  for (let i = 0; i < 1000; i++) x.cb('rename', `\\\\?\\${x.dir}`);
};

/** Delete a watched dir the way a branch switch does, and deliver the self-event it causes. */
const removeWatched = (x: RealWatch) => {
  fs.rmSync(x.dir, { recursive: true, force: true });
  vanish(x);
};

// On Windows the name stays delete-pending until the last handle on it closes.
const recreate = (dir: string) =>
  waitFor(() => {
    try {
      fs.mkdirSync(dir, { recursive: true });
      return true;
    } catch {
      return false;
    }
  });

const poll = () => vi.advanceTimersByTime(EXISTS_POLL_MS);

const cards = (id: string): BoardData['cards'] => [{ id, title: id, notes: '', stage: 'wishlist' }];

let tmp: string[];
const mkRoot = (): string => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'watch-gone-')));
  tmp.push(root);
  return root;
};

beforeEach(() => {
  watches.length = 0;
  refuse = null;
  tmp = [];
  // Only the existence poll is faked; the watches and debounces run on real time.
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
});
afterEach(() => {
  vi.useRealTimers();
  for (const x of watches) x.w.close();
  for (const root of tmp) fs.rmSync(root, { recursive: true, force: true });
});

describe('ConduitDirWatch on a vanished .conduit/', () => {
  it('closes the watch once and never settles on the loop', async () => {
    const root = mkRoot();
    fs.mkdirSync(conduitDir(root));
    const dw = new ConduitDirWatch(20);
    const onEvent = vi.fn(() => true);
    const onSettle = vi.fn();
    dw.start(root, onEvent, onSettle);
    expect(watches).toHaveLength(1);
    removeWatched(watches[0]);
    expect(watches[0].close).toHaveBeenCalledTimes(1);
    expect(onEvent).not.toHaveBeenCalled();
    await delay(100);
    expect(onSettle).not.toHaveBeenCalled();
    dw.stop();
    expect(watches[0].close).toHaveBeenCalledTimes(1);
  });

  it("an 'error' is handled, keeps the pending settle, and re-arms on the poll, not inline", async () => {
    const root = mkRoot();
    fs.mkdirSync(conduitDir(root));
    const dw = new ConduitDirWatch(20);
    const onSettle = vi.fn();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      dw.start(root, () => true, onSettle);
      watches[0].cb('change', BOARD_FILE_NAME);
      expect(() => watches[0].w.emit('error', new Error('EPERM'))).not.toThrow();
      expect(watches[0].close).toHaveBeenCalledTimes(1);
      expect(watches).toHaveLength(1);
      await waitFor(() => onSettle.mock.calls.length === 1);
      poll();
      expect(watches).toHaveLength(2);
    } finally {
      dw.stop();
      warn.mockRestore();
    }
  });

  it('stop() also ends the wait for a missing directory', () => {
    const root = mkRoot();
    const dw = new ConduitDirWatch(20);
    dw.start(root, () => true, vi.fn());
    dw.stop();
    fs.mkdirSync(conduitDir(root));
    poll();
    expect(watches).toHaveLength(0);
  });
});

describe('watchDirWhilePresent on a directory that exists but cannot be watched', () => {
  it('keeps retrying on the poll but warns once per stretch the directory is there', () => {
    const dir = mkRoot();
    const log = vi.fn();
    refuse = new Error('ENOSPC');
    const h = watchDirWhilePresent(dir, { log }, vi.fn());
    try {
      for (let i = 0; i < 5; i++) poll();
      expect(log).toHaveBeenCalledTimes(1);
      expect(log).toHaveBeenCalledWith('could not watch', refuse);
      refuse = null;
      poll();
      expect(watches).toHaveLength(1);
      watches[0].w.emit('error', new Error('EPERM'));
      refuse = new Error('ENOSPC');
      for (let i = 0; i < 5; i++) poll();
      expect(log).toHaveBeenCalledTimes(1);
      fs.rmSync(dir, { recursive: true, force: true });
      poll();
      fs.mkdirSync(dir);
      poll();
      expect(log).toHaveBeenCalledTimes(2);
    } finally {
      h.close();
    }
  });
});

describe('BoardWatcher when .conduit/ comes back', () => {
  it('deleted and recreated: the next external edit is delivered', async () => {
    const root = mkRoot();
    const dir = conduitDir(root);
    fs.mkdirSync(dir);
    const seen: BoardData[] = [];
    const bw = new BoardWatcher(20);
    try {
      bw.watch(root, (b) => seen.push(b));
      expect(watches).toHaveLength(1);
      removeWatched(watches[0]);
      poll();
      expect(watches).toHaveLength(1);
      await recreate(dir);
      poll();
      expect(watches).toHaveLength(2);
      fs.writeFileSync(path.join(dir, BOARD_FILE_NAME), serializeBoardArtifact(board(cards('b'))));
      await waitFor(() => seen.length > 0, 3000);
      expect(seen.at(-1)?.cards.map((c) => c.id)).toEqual(['b']);
    } finally {
      bw.stop();
    }
  });

  it('absent when the board opened: the first external edit after it appears is delivered', async () => {
    const root = mkRoot();
    const seen: BoardData[] = [];
    const bw = new BoardWatcher(20);
    try {
      bw.watch(root, (b) => seen.push(b));
      expect(watches).toHaveLength(0);
      fs.mkdirSync(conduitDir(root));
      poll();
      expect(watches).toHaveLength(1);
      fs.writeFileSync(
        path.join(conduitDir(root), BOARD_FILE_NAME),
        serializeBoardArtifact(board(cards('c'))),
      );
      await waitFor(() => seen.length > 0, 3000);
    } finally {
      bw.stop();
    }
  });

  // A checkout, or an agent's `mkdir -p` + first write, lands the board before the poll re-arms.
  it('recreated with the board already inside: it is delivered without a later edit', async () => {
    const root = mkRoot();
    const dir = conduitDir(root);
    fs.mkdirSync(dir);
    const seen: BoardData[] = [];
    const bw = new BoardWatcher(20);
    try {
      bw.watch(root, (b) => seen.push(b));
      removeWatched(watches[0]);
      await recreate(dir);
      fs.writeFileSync(path.join(dir, BOARD_FILE_NAME), serializeBoardArtifact(board(cards('r'))));
      poll();
      expect(watches).toHaveLength(2);
      await waitFor(() => seen.length > 0, 3000);
      expect(seen.at(-1)?.cards.map((c) => c.id)).toEqual(['r']);
    } finally {
      bw.stop();
    }
  });

  it('absent when the board opened, then created with the board inside: it is delivered', async () => {
    const root = mkRoot();
    const seen: BoardData[] = [];
    const bw = new BoardWatcher(20);
    try {
      bw.watch(root, (b) => seen.push(b));
      fs.mkdirSync(conduitDir(root));
      fs.writeFileSync(
        path.join(conduitDir(root), BOARD_FILE_NAME),
        serializeBoardArtifact(board(cards('first'))),
      );
      poll();
      expect(watches).toHaveLength(1);
      await waitFor(() => seen.length > 0, 3000);
      expect(seen.at(-1)?.cards.map((c) => c.id)).toEqual(['first']);
    } finally {
      bw.stop();
    }
  });

  it('a board present from the start is not re-read just for arming', async () => {
    const root = mkRoot();
    fs.mkdirSync(conduitDir(root));
    fs.writeFileSync(
      path.join(conduitDir(root), BOARD_FILE_NAME),
      serializeBoardArtifact(board(cards('s'))),
    );
    const seen: BoardData[] = [];
    const bw = new BoardWatcher(20);
    try {
      bw.watch(root, (b) => seen.push(b));
      expect(watches).toHaveLength(1);
      await delay(100);
      expect(seen).toEqual([]);
    } finally {
      bw.stop();
    }
  });
});

describe('PlanWatcher when .conduit/plans/ comes back', () => {
  it('deleted, polled while missing, recreated: the next plan written arrives', async () => {
    const root = mkRoot();
    const plans = path.join(conduitDir(root), PLANS_DIR_NAME);
    fs.mkdirSync(plans, { recursive: true });
    const seen: string[] = [];
    const pw = new PlanWatcher((_r, slug) => seen.push(slug), 20);
    try {
      pw.watch(root);
      expect(watches).toHaveLength(1);
      removeWatched(watches[0]);
      expect(watches[0].close).toHaveBeenCalledTimes(1);
      poll();
      expect(watches).toHaveLength(1);
      await recreate(plans);
      poll();
      expect(watches).toHaveLength(2);
      await writePlanFile(root, 'next', '# Next\n');
      await waitFor(() => seen.includes('next'), 3000);
    } finally {
      pw.stop();
    }
  });

  it("an 'error' while the dir exists re-arms on the poll and the pending plan still arrives", async () => {
    const root = mkRoot();
    await writePlanFile(root, 'kept', '# Kept\n');
    const seen: string[] = [];
    const pw = new PlanWatcher((_r, slug) => seen.push(slug), 20);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      pw.watch(root);
      watches[0].cb('change', 'kept.md');
      watches[0].w.emit('error', new Error('EPERM'));
      expect(watches).toHaveLength(1);
      await waitFor(() => seen.includes('kept'));
      poll();
      expect(watches).toHaveLength(2);
    } finally {
      pw.stop();
      warn.mockRestore();
    }
  });
});

describe('OpenFileWatcher when a watched file directory comes back', () => {
  it('re-arms without a setPaths, and the next change to the open file is reported', async () => {
    const root = mkRoot();
    const sub = path.join(root, 'src');
    fs.mkdirSync(sub);
    const file = path.join(sub, 'a.ts');
    fs.writeFileSync(file, 'x');
    const changed = vi.fn();
    const ow = new OpenFileWatcher(changed, 20);
    try {
      ow.setPaths([file]);
      expect(watches).toHaveLength(1);
      removeWatched(watches[0]);
      expect(watches[0].close).toHaveBeenCalledTimes(1);
      await recreate(sub);
      poll();
      expect(watches).toHaveLength(2);
      expect(watches[1].dir).toBe(sub);
      fs.writeFileSync(file, 'y');
      await waitFor(() => changed.mock.calls.length > 0, 3000);
      expect(changed).toHaveBeenCalledWith(file);
    } finally {
      ow.stop();
    }
  });

  it('recreated with the open files already inside: each is reported without a later edit', async () => {
    const root = mkRoot();
    const sub = path.join(root, 'src');
    fs.mkdirSync(sub);
    const a = path.join(sub, 'a.ts');
    const b = path.join(sub, 'b.ts');
    fs.writeFileSync(a, 'x');
    fs.writeFileSync(b, 'x');
    const changed = vi.fn();
    const ow = new OpenFileWatcher(changed, 20);
    try {
      ow.setPaths([a, b]);
      removeWatched(watches[0]);
      await recreate(sub);
      fs.writeFileSync(a, 'restored');
      fs.writeFileSync(b, 'restored');
      poll();
      expect(watches).toHaveLength(2);
      await waitFor(() => changed.mock.calls.length >= 2, 3000);
      expect(changed.mock.calls.map((c) => c[0]).sort()).toEqual([a, b].sort());
    } finally {
      ow.stop();
    }
  });
});
