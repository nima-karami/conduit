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
const pendingFocus = new Set<string>();

export function registerNavEditor(path: string, editor: NavEditor): () => void {
  const key = canonicalPath(path);
  editors.set(key, editor);
  if (pendingFocus.delete(key)) editor.focus();
  return () => {
    if (editors.get(key) === editor) editors.delete(key);
  };
}

export function liveCursor(path: string): CursorPos | undefined {
  const p = editors.get(canonicalPath(path))?.getPosition();
  return p ? { line: p.lineNumber, column: p.column } : undefined;
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
  if (editor) editor.focus();
  else pendingFocus.add(key);
}
