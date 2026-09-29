// Registry of the CodeViewer main editors, keyed by doc path, so navigation history can read a
// file's live cursor, reveal a stop without it counting as a jump, and focus the landed editor.
// See docs/specs/2026-09-22-editor-nav-history.md §2.2 ("one record per move") and §2.3.
import type * as monaco from 'monaco-editor';
import { canonicalPath } from '../src/canonical-path';
import type { GroupIndex } from './doc-groups';
import { type CursorPos, clampPos } from './editor-nav';
import { createPathRegistry } from './path-registry';

/** Monaco `source` on every reveal-driven setPosition; the jump listener ignores it. */
export const NAV_REVEAL_SOURCE = 'conduit.navReveal';

export type NavEditor = Pick<
  monaco.editor.ICodeEditor,
  'getPosition' | 'setPosition' | 'revealLineInCenter' | 'focus' | 'getModel'
>;

const editors = createPathRegistry<NavEditor>(canonicalPath);
const editorGroups = new Map<unknown, GroupIndex>();

export function registerNavEditor(
  path: string,
  editor: NavEditor,
  group: GroupIndex = 1,
): () => void {
  const key = canonicalPath(path);
  const unregister = editors.register(key, editor, group);
  editorGroups.set(editor, group);
  let registered = true;
  return () => {
    if (!registered) return;
    registered = false;
    const left = toCursorPos(editor);
    if (left) rememberCursor(key, left);
    unregister();
    editorGroups.delete(editor);
  };
}

export function groupOfEditor(editor: unknown): GroupIndex | undefined {
  return editorGroups.get(editor);
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

// Given a group, only that group's editor: a stop in one group is never read from, or revealed
// in, the other group's view of the same file.
function editorFor(path: string, group?: GroupIndex): NavEditor | undefined {
  if (group === undefined) return editors.get(path);
  return editors
    .entries(path)
    .filter((e) => e.group === group)
    .at(-1)?.value;
}

export function liveCursor(path: string, group?: GroupIndex): CursorPos | undefined {
  const editor = editorFor(path, group);
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

export function revealInNavEditor(path: string, pos: CursorPos, group?: GroupIndex): boolean {
  const editor = editorFor(path, group);
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
