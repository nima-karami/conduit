// The editor's navigation-history entry model: what a Back/Forward stop is, when two stops are
// "the same place" (R4), and how a stop is announced. Pure — no React, no runtime monaco.
// See docs/specs/2026-09-22-editor-nav-history.md §2.1–§2.2.
import type { NavOps } from '../src/nav-history';
import type { DiffTabScope } from '../src/protocol';
import type { DocKind, OpenDoc } from './docs';

/** 1-based, Monaco's convention. */
export interface CursorPos {
  line: number;
  column: number;
}

/** A doc by what it shows, not by tab id: a commit-diff preview retargets in place. */
export interface DocRef {
  kind: DocKind;
  path: string;
  /** A diff's side: (Index) and (Working Tree) are separate tabs. Absent = unscoped, its own tab. */
  diffScope?: DiffTabScope;
}

type DocIdentity = Pick<DocRef, 'kind' | 'path' | 'diffScope'>;

// The ONE identity rule for history (sameDoc, findOpenDoc, R4, "on screen"): kind, path and diff
// scope. Never the session: a doc has ONE owner and moves to whichever session reopens it
// (webview/docs.ts), so the same doc recorded under two sessions is one place.
function sameRef(a: DocIdentity, b: DocIdentity): boolean {
  return a.kind === b.kind && a.path === b.path && a.diffScope === b.diffScope;
}

/** `pos` is present only for a text entry (a file showing Monaco). */
export interface NavEntry {
  /** The doc's owner when last recorded: where a CLOSED file reopens. Not part of its identity. */
  sessionId: string;
  doc: DocRef;
  pos?: CursorPos;
}

const COALESCE_LINES = 10;

export function navEntryFor(
  doc: Pick<OpenDoc, 'kind' | 'path' | 'sessionId' | 'diffScope'>,
  pos?: CursorPos,
): NavEntry {
  const ref: DocRef = { kind: doc.kind, path: doc.path };
  if (doc.diffScope) ref.diffScope = doc.diffScope;
  const entry: NavEntry = { sessionId: doc.sessionId, doc: ref };
  if (pos) entry.pos = pos;
  return entry;
}

function sameDoc(a: NavEntry, b: NavEntry): boolean {
  return sameRef(a.doc, b.doc);
}

export function coalescesEntries(a: NavEntry, b: NavEntry): boolean {
  if (!sameDoc(a, b)) return false;
  if (!a.pos || !b.pos) return true;
  return Math.abs(a.pos.line - b.pos.line) <= COALESCE_LINES;
}

export function absorbEntry(into: NavEntry, next: NavEntry): NavEntry {
  const merged: NavEntry = { ...into, sessionId: next.sessionId };
  if (next.pos) merged.pos = next.pos;
  return merged;
}

export const EDITOR_NAV_OPS: NavOps<NavEntry> = {
  sameTarget: sameDoc,
  coalesces: coalescesEntries,
  absorb: absorbEntry,
};

export function findOpenDoc<D extends DocIdentity>(docs: readonly D[], ref: DocRef): D | undefined {
  return docs.find((d) => sameRef(d, ref));
}

/** R3: a single cursor move of MORE than this many lines is an entry. */
const JUMP_LINES = 10;

export interface CursorMove {
  fromLine: number;
  toLine: number;
  /** The model changed since the previous cursor event (typing, paste, undo, format, reload). */
  edited: boolean;
  /** A reveal-driven move a producer already recorded (or, for Back/Forward, must not). */
  tagged: boolean;
}

export function isSignificantJump(m: CursorMove): boolean {
  return !m.edited && !m.tagged && Math.abs(m.toLine - m.fromLine) > JUMP_LINES;
}

/** Edits may have shifted lines since the entry was recorded (spec A4: clamp, don't track). */
export function clampPos(
  pos: CursorPos,
  lineCount: number,
  maxColumn: (line: number) => number,
): CursorPos {
  const line = Math.min(Math.max(pos.line, 1), Math.max(lineCount, 1));
  const column = Math.min(Math.max(pos.column, 1), Math.max(maxColumn(line), 1));
  return { line, column };
}

export function navAnnouncement(title: string, pos?: CursorPos): string {
  return pos ? `Editor: ${title}, line ${pos.line}` : `Editor: ${title}`;
}
