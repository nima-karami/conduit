// The editor's navigation-history entry model: what a Back/Forward stop is, when two stops are
// "the same place" (R4), and how a stop is announced. Pure — no React, no runtime monaco.
// See docs/specs/2026-09-22-editor-nav-history.md §2.1–§2.2.
import type { NavOps } from '../src/nav-history';
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
}

/** `pos` is present only for a text entry (a file showing Monaco). */
export interface NavEntry {
  sessionId: string;
  doc: DocRef;
  pos?: CursorPos;
}

const COALESCE_LINES = 10;

export function navEntryFor(
  doc: Pick<OpenDoc, 'kind' | 'path' | 'sessionId'>,
  pos?: CursorPos,
): NavEntry {
  const entry: NavEntry = { sessionId: doc.sessionId, doc: { kind: doc.kind, path: doc.path } };
  if (pos) entry.pos = pos;
  return entry;
}

function sameDoc(a: NavEntry, b: NavEntry): boolean {
  return a.sessionId === b.sessionId && a.doc.kind === b.doc.kind && a.doc.path === b.doc.path;
}

export function coalescesEntries(a: NavEntry, b: NavEntry): boolean {
  if (!sameDoc(a, b)) return false;
  if (!a.pos || !b.pos) return true;
  return Math.abs(a.pos.line - b.pos.line) <= COALESCE_LINES;
}

export function absorbEntry(into: NavEntry, next: NavEntry): NavEntry {
  return next.pos ? { ...into, pos: next.pos } : into;
}

export const EDITOR_NAV_OPS: NavOps<NavEntry> = {
  sameTarget: sameDoc,
  coalesces: coalescesEntries,
  absorb: absorbEntry,
};

export function findOpenDoc<D extends { kind: DocKind; path: string }>(
  docs: readonly D[],
  ref: DocRef,
): D | undefined {
  return docs.find((d) => d.kind === ref.kind && d.path === ref.path);
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
