import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BoardWatcher } from '../../electron/board-watcher';
import { conduitDir, conduitPath, writeBoardArtifactFile } from '../../electron/conduit-fs';
import type { BoardData } from '../../src/board';
import { fingerprint } from '../../src/board-watch';
import { serializeBoardArtifact } from '../../src/conduit-store';
import { board, delay, expectNoEventAfterWrite, waitFor } from './watch-test-helpers';

let root: string;
let watcher: BoardWatcher;

/** Seed an initial board (so `.conduit/board.json` exists) then start watching. */
async function seedAndWatch(): Promise<BoardData[]> {
  await writeBoardArtifactFile(
    root,
    board([{ id: 'a', title: 'A', notes: '', stage: 'wishlist' }]),
  );
  const seen: BoardData[] = [];
  watcher.watch(root, (b) => seen.push(b));
  return seen;
}

/** Create an empty `.conduit/` dir then start watching. */
function mkdirAndWatch(): BoardData[] {
  fs.mkdirSync(conduitDir(root), { recursive: true });
  const seen: BoardData[] = [];
  watcher.watch(root, (b) => seen.push(b));
  return seen;
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'conduit-watch-'));
  // Small debounce so the tests are fast but still exercise the debounce path.
  watcher = new BoardWatcher(40);
});

afterEach(() => {
  watcher.stop();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('BoardWatcher', () => {
  it('fires onExternalChange when .conduit/board.json is edited externally', async () => {
    // Seed an initial board so the .conduit/ dir + file exist before watching.
    const seen = await seedAndWatch();

    // Simulate an external agent advancing the card wishlist -> building.
    fs.writeFileSync(
      conduitPath(root, 'board.json'),
      serializeBoardArtifact(board([{ id: 'a', title: 'A', notes: '', stage: 'building' }])),
    );

    await waitFor(() => seen.length > 0);
    expect(seen[seen.length - 1].cards[0].stage).toBe('building');
  });

  it('suppresses the app own write (self-echo) so there is no reload loop', async () => {
    const seen = mkdirAndWatch();

    // The app records the fingerprint of what it is about to write, then writes those
    // exact cards. The resulting watch event must be recognized as our own echo.
    const next = board([{ id: 'a', title: 'A', notes: '', stage: 'done' }]);
    watcher.recordWrite(fingerprint(next));
    fs.writeFileSync(conduitPath(root, 'board.json'), serializeBoardArtifact(next));

    // Give the watcher generous time to (not) fire.
    await delay(300);
    expect(seen).toEqual([]);
  });

  it('emits a real external change even after a recorded self-write', async () => {
    const seen = mkdirAndWatch();

    const mine = board([{ id: 'a', title: 'A', notes: '', stage: 'planning' }]);
    watcher.recordWrite(fingerprint(mine));
    fs.writeFileSync(conduitPath(root, 'board.json'), serializeBoardArtifact(mine));
    await delay(150); // self-write settles, suppressed

    // Now an external editor changes it to something else.
    fs.writeFileSync(
      conduitPath(root, 'board.json'),
      serializeBoardArtifact(board([{ id: 'a', title: 'A', notes: '', stage: 'done' }])),
    );
    await waitFor(() => seen.length > 0);
    expect(seen[seen.length - 1].cards[0].stage).toBe('done');
  });

  it('stops watching after stop() (no callback fires)', async () => {
    const seen = await seedAndWatch();
    watcher.stop();

    await expectNoEventAfterWrite(
      conduitPath(root, 'board.json'),
      [{ id: 'a', title: 'A', notes: '', stage: 'building' }],
      seen,
    );
  });

  it('is a no-op for a falsy root', () => {
    expect(() => watcher.watch('', () => {})).not.toThrow();
  });

  it('does not create a .conduit/ directory just from watching (no read-path side effect)', () => {
    // A project with no .conduit/ yet: opening the board must not litter it with an
    // empty committed directory.
    expect(fs.existsSync(conduitDir(root))).toBe(false);
    watcher.watch(root, () => {});
    expect(fs.existsSync(conduitDir(root))).toBe(false);
  });

  it('does not leak a self-write fingerprint across projects (stop/watch resets it)', async () => {
    // Project A: record a self-write fingerprint, then switch the watcher to project B.
    const a = fs.mkdtempSync(path.join(os.tmpdir(), 'conduit-watch-a-'));
    const b = fs.mkdtempSync(path.join(os.tmpdir(), 'conduit-watch-b-'));
    try {
      const moved = board([{ id: 'x', title: 'X', notes: '', stage: 'done' }]);
      fs.mkdirSync(conduitDir(a), { recursive: true });
      fs.mkdirSync(conduitDir(b), { recursive: true });
      watcher.watch(a, () => {});
      watcher.recordWrite(fingerprint(moved));

      // Switch to B (watch() calls stop(), which must clear the A fingerprint).
      const seen: BoardData[] = [];
      watcher.watch(b, (board) => seen.push(board));

      // An external edit in B whose cards equal A's recorded fingerprint must NOT be
      // suppressed as a self-echo (it was never our write in B).
      fs.writeFileSync(conduitPath(b, 'board.json'), serializeBoardArtifact(moved));
      await waitFor(() => seen.length > 0);
      expect(seen[seen.length - 1].cards[0].id).toBe('x');
    } finally {
      fs.rmSync(a, { recursive: true, force: true });
      fs.rmSync(b, { recursive: true, force: true });
    }
  });
});
