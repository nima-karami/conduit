// Host-side live watcher for a project's `.conduit/board.json`. When an external agent
// edits the board file on disk, this debounces the FS events, re-reads the board, and
// (unless its cards are what the renderer already holds) invokes a callback so the open
// board view updates live. The card `fingerprint` it compares is pure + unit-tested in
// src/board-watch.ts. The fs.watch/debounce plumbing is shared with ProposalWatcher via
// ConduitDirWatch. See docs/specs/archive/2026-06-11-conduit-board.md.

import type { BoardData } from '../src/board';
import { fingerprint } from '../src/board-watch';
import { readBoardArtifact } from '../src/conduit-store';
import { ConduitDirWatch } from './conduit-dir-watch';
import { BOARD_FILE_NAME, readBoardBlob } from './conduit-fs';

export type OnExternalChange = (board: BoardData) => void;

/**
 * Watches one project's `.conduit/board.json` at a time. `fs.watch` (via ConduitDirWatch)
 * targets the `.conduit/` directory (robust to the atomic write's rename, which swaps the
 * file's inode) and filters to `board.json`. Events are debounced; on settle the board is
 * re-read and emitted only if it differs from the board the renderer already holds: the
 * app's own last write (so the write→watch→emit→… loop can't form), the board sent when
 * the watch was armed, or the last board emitted. An event is not proof of a change —
 * FSEvents also reports writes made shortly BEFORE the watch was armed.
 */
export class BoardWatcher {
  private readonly watch_: ConduitDirWatch;
  private root = '';
  private onChange: OnExternalChange | null = null;
  /** Fingerprint of the board the renderer already holds; a readback matching it is not news. */
  private known: string | undefined;

  constructor(debounceMs = 250) {
    this.watch_ = new ConduitDirWatch(debounceMs, 'board-watcher');
  }

  /**
   * Start watching `<projectRoot>/.conduit/board.json`; replaces any prior watch. `shown` is the
   * board the caller already sent the renderer. It is the baseline rather than a fresh read: an
   * edit landing after the caller's read would otherwise become the baseline and never arrive.
   */
  watch(projectRoot: string, shown: BoardData, onChange: OnExternalChange): void {
    this.stop();
    if (!projectRoot) return; // no project => nothing to watch
    this.root = projectRoot;
    this.onChange = onChange;
    this.known = fingerprint(shown);
    this.watch_.start(
      projectRoot,
      // `filename` can be null on some platforms; in that case react to any event.
      // Veto events for any other file in `.conduit/` so they don't trigger a readback.
      (filename) => !filename || filename === BOARD_FILE_NAME,
      () => this.readbackAndEmit(),
    );
    // An edit between the caller's read and the arm raised no event; anything later will.
    this.readbackAndEmit();
  }

  /**
   * Record the fingerprint of a board the app is about to write, so the imminent FS
   * event(s) from that write are recognized as our own echo and not re-emitted.
   */
  recordWrite(boardFingerprint: string): void {
    this.known = boardFingerprint;
  }

  /** Stop watching and clear any pending debounce. Also resets the known fingerprint so it
   *  never leaks across projects (a fingerprint from project A must not suppress a
   *  coincidentally-matching genuine edit in project B). */
  stop(): void {
    this.watch_.stop();
    this.root = '';
    this.onChange = null;
    this.known = undefined;
  }

  private readbackAndEmit(): void {
    if (!this.root || !this.onChange) return;
    // Read the raw blob first: `undefined` means the file is currently unreadable
    // (absent, mid-write, or briefly locked — common on Windows during an external
    // writer's truncate/rename). Skip rather than emit an empty board, which would wipe
    // the user's view on a transient failure. A genuine subsequent settled event re-reads.
    const blob = readBoardBlob(this.root);
    if (blob === undefined) return;
    const board = readBoardArtifact(blob);
    const current = fingerprint(board);
    if (current === this.known) return;
    this.known = current;
    this.onChange(board);
  }
}
