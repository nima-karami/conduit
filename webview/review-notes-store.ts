import type { ReviewNote, ReviewNotePatch } from '../src/protocol';
import { normalizeRoot } from '../src/review-marks';
import { applyNotePatch } from '../src/review-notes';
import { post, subscribe } from './bridge';

/**
 * Renderer mirror of the host's per-repo review notes (spec 2026-08-27-review-supercharge §2
 * Lane F). A module-singleton external store, mirroring review-marks-store.ts: views read it with
 * useSyncExternalStore and the host stays the single owner of the artifact.
 *
 * The load gate is PER ROOT (not one global flag as the marks store has): notes are a per-project
 * artifact the host only reads when asked, so "no notes yet" and "not asked yet" are different
 * answers and only the second one may disable a control (§4).
 */

export interface NotesSnapshot {
  byRoot: ReadonlyMap<string, readonly ReviewNote[]>;
}

type Listener = () => void;

/** Stable identity so a memo over "this root has no notes" doesn't re-run every render. */
const EMPTY: readonly ReviewNote[] = [];

let snapshot: NotesSnapshot = { byRoot: new Map() };
const listeners = new Set<Listener>();
const requested = new Set<string>();

function set(key: string, notes: readonly ReviewNote[]): void {
  const byRoot = new Map(snapshot.byRoot);
  byRoot.set(key, notes);
  snapshot = { byRoot };
  listeners.forEach((l) => {
    l();
  });
}

subscribe((msg) => {
  if (msg.type === 'review:notes') set(normalizeRoot(msg.root), msg.notes);
});

export function subscribeNotes(cb: Listener): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

export function getNotesSnapshot(): NotesSnapshot {
  return snapshot;
}

export function notesFor(snap: NotesSnapshot, root: string): readonly ReviewNote[] {
  return snap.byRoot.get(normalizeRoot(root)) ?? EMPTY;
}

/** The load gate: false until the host has answered for THIS root. */
export function notesLoaded(snap: NotesSnapshot, root: string): boolean {
  return snap.byRoot.has(normalizeRoot(root));
}

/** Ask the host to read + watch a repo's notes. Idempotent per root for the window's lifetime. */
export function loadNotesFor(root: string): void {
  const key = normalizeRoot(root);
  if (!key || requested.has(key)) return;
  requested.add(key);
  post({ type: 'review:loadNotes', root: key });
}

/**
 * Apply one change locally first so the row answers in the same frame; the host's echo replaces the
 * optimistic list a tick later and wins any cross-window race.
 */
export function patchNotes(root: string, patch: ReviewNotePatch): void {
  const key = normalizeRoot(root);
  set(key, applyNotePatch(snapshot.byRoot.get(key) ?? EMPTY, patch));
  post({ type: 'review:setNotes', root: key, patch });
}
