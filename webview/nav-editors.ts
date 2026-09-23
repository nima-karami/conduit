// Registry of the CodeViewer main editors, keyed by doc path, so navigation history can read a
// file's live cursor, reveal a stop without it counting as a jump, and focus the landed editor.
// See docs/specs/2026-09-22-editor-nav-history.md §2.2 ("one record per move") and §2.3.
import type * as monaco from 'monaco-editor';
import { type CursorPos, clampPos } from './editor-nav';
import { canonicalPath } from './project-index';

/** Monaco `source` on every reveal-driven setPosition; the jump listener ignores it. */
export const NAV_REVEAL_SOURCE = 'conduit.navReveal';

export type NavEditor = Pick<
  monaco.editor.ICodeEditor,
  'getPosition' | 'setPosition' | 'revealLineInCenter' | 'focus' | 'getModel'
>;

const editors = new Map<string, NavEditor>();
// One slot, consumed by the very next register whatever its path: a doc that renders without
// Monaco (image, PDF, rendered markdown) never registers, and a request left pending for it would
// steal focus from some unrelated editor much later.
let pendingFocus: string | null = null;

export function registerNavEditor(path: string, editor: NavEditor): () => void {
  const key = canonicalPath(path);
  editors.set(key, editor);
  if (pendingFocus === key) editor.focus();
  pendingFocus = null;
  return () => {
    if (editors.get(key) !== editor) return;
    const left = toCursorPos(editor);
    if (left) rememberCursor(key, left);
    editors.delete(key);
  };
}

// Where each unmounted editor left its cursor — the position its view state restores to — so a
// stop recorded without one (left by a session switch) can still be announced with its line.
// Bounded well past the 50-entry history: Map order is insertion order, so re-inserting on every
// write makes the first key the least recently left.
export const LAST_CURSOR_CAP = 200;
const lastCursors = new Map<string, CursorPos>();

function rememberCursor(key: string, pos: CursorPos): void {
  lastCursors.delete(key);
  lastCursors.set(key, pos);
  if (lastCursors.size > LAST_CURSOR_CAP) {
    const oldest = lastCursors.keys().next().value;
    if (oldest !== undefined) lastCursors.delete(oldest);
  }
}

function toCursorPos(editor: NavEditor): CursorPos | undefined {
  const p = editor.getPosition();
  return p ? { line: p.lineNumber, column: p.column } : undefined;
}

export function liveCursor(path: string): CursorPos | undefined {
  const editor = editors.get(canonicalPath(path));
  return editor ? toCursorPos(editor) : undefined;
}

export function lastCursor(path: string): CursorPos | undefined {
  const key = canonicalPath(path);
  return liveCursor(key) ?? lastCursors.get(key);
}

export function revealInEditor(editor: NavEditor, pos: CursorPos): void {
  const model = editor.getModel();
  const at = model
    ? clampPos(pos, model.getLineCount(), (line) => model.getLineMaxColumn(line))
    : pos;
  editor.setPosition({ lineNumber: at.line, column: at.column }, NAV_REVEAL_SOURCE);
  editor.revealLineInCenter(at.line);
}

export function revealInNavEditor(path: string, pos: CursorPos): boolean {
  const editor = editors.get(canonicalPath(path));
  if (!editor) return false;
  revealInEditor(editor, pos);
  editor.focus();
  return true;
}

export type CursorJumpSink = (path: string, from: CursorPos, to: CursorPos) => void;

let jumpSink: CursorJumpSink | null = null;

export function setCursorJumpSink(sink: CursorJumpSink | null): void {
  jumpSink = sink;
}

export function emitCursorJump(path: string, from: CursorPos, to: CursorPos): void {
  jumpSink?.(path, from, to);
}

/** Focus now when mounted; otherwise on the next register for `path` (a tab still mounting). */
export function requestNavFocus(path: string): void {
  const key = canonicalPath(path);
  const editor = editors.get(key);
  pendingFocus = editor ? null : key;
  editor?.focus();
}

/** A user navigation elsewhere supersedes a Back/Forward landing that has not mounted yet. */
export function cancelNavFocus(): void {
  pendingFocus = null;
}
