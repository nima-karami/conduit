import { contentHash } from './review-marks';

/**
 * The review-notes model (spec 2026-08-27-review-supercharge §2 Lane F). Node-free on purpose:
 * the HOST reads/writes `.conduit/review-notes.json` with it and the RENDERER anchors, re-anchors
 * and folds patches with it, so the two sides can only disagree by disagreeing with this file.
 *
 * Notes live IN the project (ADR 0002 envelope) because the point is that the agent can read
 * them — the opposite call from reviewed marks, which are per-user and stay in userData (§5).
 */

/** Which side of the diff a note is pinned to. `old` is a note on a removed line. */
export type NoteSide = 'new' | 'old';

export interface ReviewNote {
  id: string;
  /** Repo-relative posix path, exactly as ChangeDTO carries it. */
  path: string;
  side: NoteSide;
  /** 1-based on `side`. The VIEW position is recomputed by `reanchor`; this is the last one saved. */
  line: number;
  /** FNV-1a of the line plus one context line each side. */
  anchor: string;
  /**
   * The anchored line's text, capped at SNIPPET_CHARS. Not in the spec's model literal: the spec
   * needs the line text in two outputs (the handoff line, the detached notice) and `anchor` is
   * one-way — see the plan's assumption 1.
   */
  snippet: string;
  /** Markdown, <= MAX_NOTE_BODY. */
  body: string;
  /** ISO-8601 UTC. */
  createdAt: string;
  resolvedAt?: string;
  sentAt?: string;
}

export interface ReviewNotesData {
  version: 1;
  notes: ReviewNote[];
}

/** What one window asks the host to merge. `add` carries a whole note so the renderer can render
 *  it optimistically under the same id the host will persist. */
export type ReviewNotePatch =
  | { op: 'add'; note: ReviewNote }
  | { op: 'edit'; id: string; body: string }
  | { op: 'resolve'; id: string; resolved: boolean; at: string }
  | { op: 'delete'; id: string }
  | { op: 'sent'; ids: string[]; at: string };

/** The composer's refusal threshold, counted over UNRESOLVED notes — see the plan's assumption 3. */
export const MAX_OPEN_NOTES_PER_REPO = 500;
/** Hard ceiling on the artifact so resolved notes can't grow it without bound. */
export const MAX_STORED_NOTES_PER_REPO = 2000;
export const MAX_NOTE_BODY = 4096;
const SNIPPET_CHARS = 60;
/** How far a moved line is followed before the note is called detached (§2 Lane F). */
const REANCHOR_RADIUS = 50;

export function emptyNotesData(): ReviewNotesData {
  return { version: 1, notes: [] };
}

/** Matches the repo's own id shape (src/pipeline.ts); the clock is injected so tests can pin it. */
export function newNoteId(now: number = Date.now()): string {
  return `note-${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function snippetOf(lineText: string): string {
  const t = lineText.trim();
  return t.length > SNIPPET_CHARS ? `${t.slice(0, SNIPPET_CHARS)}…` : t;
}

/** A missing neighbour is a distinct value from an empty one, so a note on line 1 and a note whose
 *  predecessor is a blank line can't collide. */
const NEIGHBOUR_ABSENT = String.fromCharCode(0);
const neighbour = (s: string | null): string => (s === null ? NEIGHBOUR_ABSENT : s);

export function anchorFor(
  lineText: string,
  prevLine: string | null,
  nextLine: string | null,
): string {
  return contentHash(`${neighbour(prevLine)}\n${lineText}\n${neighbour(nextLine)}`);
}

/** The anchor a 1-based `line` of `fileLines` would produce; null when the line isn't there. */
export function anchorAt(fileLines: readonly string[], line: number): string | null {
  if (line < 1 || line > fileLines.length) return null;
  const prev = line >= 2 ? fileLines[line - 2] : null;
  const next = line < fileLines.length ? fileLines[line] : null;
  return anchorFor(fileLines[line - 1], prev, next);
}

/** Shape check for anything crossing a boundary — the parse path AND the host write path, which
 *  persists what it is handed into a file the user commits. */
const isNote = (v: unknown): v is ReviewNote => {
  if (typeof v !== 'object' || v === null) return false;
  const n = v as Record<string, unknown>;
  return (
    typeof n.id === 'string' &&
    typeof n.path === 'string' &&
    (n.side === 'new' || n.side === 'old') &&
    typeof n.line === 'number' &&
    Number.isFinite(n.line) &&
    typeof n.anchor === 'string' &&
    typeof n.snippet === 'string' &&
    typeof n.body === 'string' &&
    typeof n.createdAt === 'string' &&
    (n.resolvedAt === undefined || typeof n.resolvedAt === 'string') &&
    (n.sentAt === undefined || typeof n.sentAt === 'string')
  );
};

const isOpen = (n: ReviewNote): boolean => n.resolvedAt === undefined;

export function openNotes(notes: readonly ReviewNote[]): ReviewNote[] {
  return notes.filter(isOpen);
}

/** What "Send to agent (N)" counts: unresolved AND not yet sent (§2 Lane F). */
export function pendingNotes(notes: readonly ReviewNote[]): ReviewNote[] {
  return notes.filter((n) => isOpen(n) && n.sentAt === undefined);
}

export function canAddNote(notes: readonly ReviewNote[]): boolean {
  return openNotes(notes).length < MAX_OPEN_NOTES_PER_REPO;
}

/** Unresolved first, then newest-first — the order the stored ceiling trims from the end of. */
function trim(notes: readonly ReviewNote[]): ReviewNote[] {
  if (notes.length <= MAX_STORED_NOTES_PER_REPO) return [...notes];
  return [...notes]
    .sort((a, b) => {
      if (isOpen(a) !== isOpen(b)) return isOpen(a) ? -1 : 1;
      return a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0;
    })
    .slice(0, MAX_STORED_NOTES_PER_REPO);
}

const validBody = (body: string): boolean => body.trim().length > 0 && body.length <= MAX_NOTE_BODY;

/**
 * The single merge path, shared by the host (authoritative) and the renderer (optimistic). Every
 * refusal is a silent no-op returning the list unchanged: the renderer gates on `canAddNote` and
 * shows the guidance, and the host must never throw on a message a window could malform.
 */
export function applyNotePatch(notes: readonly ReviewNote[], patch: ReviewNotePatch): ReviewNote[] {
  switch (patch.op) {
    case 'add': {
      if (!isNote(patch.note) || !validBody(patch.note.body)) return [...notes];
      if (!canAddNote(notes)) return [...notes];
      if (notes.some((n) => n.id === patch.note.id)) return [...notes];
      return trim([...notes, patch.note]);
    }
    case 'edit': {
      if (!validBody(patch.body)) return [...notes];
      return notes.map((n) => (n.id === patch.id ? { ...n, body: patch.body } : n));
    }
    case 'resolve':
      return notes.map((n) => {
        if (n.id !== patch.id) return n;
        if (patch.resolved) return { ...n, resolvedAt: patch.at };
        const { resolvedAt: _reopened, ...rest } = n;
        return rest;
      });
    case 'delete':
      return notes.filter((n) => n.id !== patch.id);
    case 'sent': {
      const ids = new Set(patch.ids);
      return notes.map((n) => (ids.has(n.id) ? { ...n, sentAt: patch.at } : n));
    }
  }
}

/** A note and where it currently sits; `line` null => detached (§2 Lane F: never dropped). */
export interface AnchoredNote {
  note: ReviewNote;
  line: number | null;
}

/**
 * Exact line → nearest match within REANCHOR_RADIUS → detached. `fileLines` is ONE side of ONE
 * file, so the caller partitions by `side` first. Pure and view-only: the stored `line` is never
 * rewritten from here (plan assumption 4), so a read can never provoke a write.
 */
export function reanchor(
  notes: readonly ReviewNote[],
  fileLines: readonly string[],
): AnchoredNote[] {
  return notes.map((note) => {
    if (anchorAt(fileLines, note.line) === note.anchor) return { note, line: note.line };
    for (let d = 1; d <= REANCHOR_RADIUS; d++) {
      // Lower line first, so two equidistant candidates resolve deterministically (assumption 5).
      if (anchorAt(fileLines, note.line - d) === note.anchor) return { note, line: note.line - d };
      if (anchorAt(fileLines, note.line + d) === note.anchor) return { note, line: note.line + d };
    }
    return { note, line: null };
  });
}

export function serializeNotes(data: ReviewNotesData): string {
  return JSON.stringify({ version: 1, notes: trim(data.notes) });
}

/** A corrupt or foreign-version payload is an EMPTY set of notes, never an error (§4). */
export function restoreNotes(blob: string | undefined): ReviewNotesData {
  if (!blob) return emptyNotesData();
  let parsed: unknown;
  try {
    parsed = JSON.parse(blob);
  } catch {
    return emptyNotesData();
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
    return emptyNotesData();
  const { version, notes } = parsed as { version?: unknown; notes?: unknown };
  if (version !== 1 || !Array.isArray(notes)) return emptyNotesData();
  return { version: 1, notes: trim(notes.filter(isNote)) };
}

/** Content fingerprint for the watcher's self-echo guard — the notes only, never the envelope's
 *  `updatedAt`, which changes on every write. Mirrors src/board-watch.ts's `fingerprint`. */
export function notesFingerprint(data: ReviewNotesData): string {
  return JSON.stringify(data.notes);
}
