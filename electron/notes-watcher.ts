// Host-side live watcher for a project's `.conduit/review-notes.json`. It exists for ONE reason:
// picking up an EXTERNAL (agent) edit (spec 2026-08-27-review-supercharge §2 Lane F). Every change
// the app itself makes reaches the other window by broadcast, not by the filesystem — which is why
// the app's own write is suppressed here and why `.conduit/` is out of `fsChanged` entirely
// (src/watch-filter.ts). Structure mirrors board-watcher.ts; the loop-avoidance predicate is the
// shared, unit-tested `isSelfEcho`.

import { isSelfEcho } from '../src/board-watch';
import { readReviewNotesArtifact } from '../src/conduit-store';
import { notesFingerprint, type ReviewNotesData } from '../src/review-notes';
import { ConduitDirWatch } from './conduit-dir-watch';
import { REVIEW_NOTES_FILE_NAME, readReviewNotesBlob } from './conduit-fs';

export type OnExternalNotes = (notes: ReviewNotesData) => void;

export class NotesWatcher {
  private readonly watch_: ConduitDirWatch;
  private root = '';
  private onChange: OnExternalNotes | null = null;
  private lastWritten: string | undefined;

  constructor(debounceMs = 250) {
    this.watch_ = new ConduitDirWatch(debounceMs, 'notes-watcher');
  }

  /** Start watching `<projectRoot>/.conduit/review-notes.json`; replaces any prior watch. */
  watch(projectRoot: string, onChange: OnExternalNotes): void {
    this.stop();
    if (!projectRoot) return;
    this.root = projectRoot;
    this.onChange = onChange;
    this.watch_.start(
      projectRoot,
      (filename) => !filename || filename === REVIEW_NOTES_FILE_NAME,
      () => this.readbackAndEmit(),
    );
  }

  /** Fingerprint of the notes the app is about to write, so the imminent FS event is its own echo. */
  recordWrite(fingerprint: string): void {
    this.lastWritten = fingerprint;
  }

  /** Also drops the recorded fingerprint, so it never leaks across projects. */
  stop(): void {
    this.watch_.stop();
    this.root = '';
    this.onChange = null;
    this.lastWritten = undefined;
  }

  private readbackAndEmit(): void {
    if (!this.root || !this.onChange) return;
    // `undefined` means unreadable right now (mid-write, locked — common on Windows during an
    // external writer's rename). Skip rather than emit an empty list over the user's notes.
    const blob = readReviewNotesBlob(this.root);
    if (blob === undefined) return;
    const notes = readReviewNotesArtifact(blob);
    if (isSelfEcho(this.lastWritten, notesFingerprint(notes))) return;
    this.onChange(notes);
  }
}
