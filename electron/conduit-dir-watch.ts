// Shared `.conduit/` directory watch primitive. Both the live board watcher
// (board-watcher.ts) and the proposal watcher (proposal-watcher.ts) attach an
// `fs.watch` to a project's `.conduit/` directory, filter events to a set of
// filenames, and debounce before reacting. This factors out that common plumbing so
// each watcher only supplies WHAT it watches and HOW it reacts on settle — not the
// fs.watch / debounce / teardown boilerplate (which had drifted into a near-duplicate).

import * as fs from 'node:fs';
import { conduitDir } from './conduit-fs';

const DEFAULT_DEBOUNCE_MS = 250;

/**
 * Called for each raw fs event with the touched filename (null = platform gave none).
 * Return `false` to IGNORE this event entirely (don't (re)schedule the debounce) — e.g. an
 * event for an unrelated file in `.conduit/`. Return `true` (or void) to accept it.
 */
export type OnDirEvent = (filename: string | null) => boolean | void;

/**
 * A debounced watch on one project's `.conduit/` directory. `start` attaches the watch
 * (a no-op if the dir doesn't exist yet — watching must never create the committed dir);
 * `stop` tears it down and clears the debounce. The owner passes an `onEvent` that runs on
 * each raw fs event (to accumulate state) and an `onSettle` that runs once the debounce
 * elapses. Filtering by filename is the owner's job inside `onEvent`.
 */
export class ConduitDirWatch {
  private fsWatcher: fs.FSWatcher | null = null;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly debounceMs: number = DEFAULT_DEBOUNCE_MS,
    private readonly label = 'conduit-dir-watch',
  ) {}

  /** Attach to `<projectRoot>/.conduit/`. Replaces any prior watch. */
  start(projectRoot: string, onEvent: OnDirEvent, onSettle: () => void): void {
    this.stop();
    const dir = conduitDir(projectRoot);
    // Never mkdir here: watching must not have the side effect of creating a committed
    // `.conduit/` dir merely because a view opened. If absent, the first write creates it
    // and a later re-arm picks it up.
    if (!fs.existsSync(dir)) return;
    try {
      this.fsWatcher = fs.watch(dir, (_event, filename) => {
        if (onEvent(filename) === false) return; // event vetoed (unrelated file)
        this.schedule(onSettle);
      });
    } catch (err) {
      // Watching is best-effort — persistence still works without it. Don't crash the host.
      console.warn(`[${this.label}] could not watch`, dir, err);
      this.fsWatcher = null;
    }
  }

  /** Detach the watch and cancel any pending debounce. */
  stop(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    if (this.fsWatcher) {
      this.fsWatcher.close();
      this.fsWatcher = null;
    }
  }

  private schedule(onSettle: () => void): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      onSettle();
    }, this.debounceMs);
  }
}
