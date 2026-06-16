import * as monaco from 'monaco-editor';

/** Canonical file:// URI for an absolute path (shared by CodeViewer + the index so
 *  the opened file and its background model are the SAME model). */
export function fileUri(path: string): monaco.Uri {
  return monaco.Uri.parse(`file:///${path.replace(/\\/g, '/').replace(/^\/+/, '')}`);
}

/** Create a Monaco model per project file (if absent) so the TS service can resolve
 *  cross-file definitions/imports. */
export function indexModels(files: { path: string; content: string; language: string }[]): void {
  for (const f of files) {
    const uri = fileUri(f.path);
    if (!monaco.editor.getModel(uri)) {
      try {
        monaco.editor.createModel(f.content, f.language, uri);
      } catch {
        /* already exists / race */
      }
    }
  }
}

// Pending reveal targets keyed by the abs path that App opens, consumed by CodeViewer.
const reveals = new Map<string, { line: number; column: number }>();
const key = (path: string) => path.replace(/\\/g, '/').replace(/^\/+/, '');

// Subscribers notified when a reveal is staged. An ALREADY-mounted CodeViewer (the
// target file is already an open tab) won't re-run its onMount reveal, so it listens
// here and reveals live when a hit for its path is staged (search jump / go-to-def).
const revealSubs = new Set<(path: string) => void>();
export function subscribeReveal(cb: (path: string) => void): () => void {
  revealSubs.add(cb);
  return () => revealSubs.delete(cb);
}

export function setReveal(path: string, pos: { line: number; column: number }): void {
  reveals.set(key(path), pos);
  const k = key(path);
  for (const cb of revealSubs) cb(k);
}
export function takeReveal(path: string): { line: number; column: number } | undefined {
  const k = key(path);
  const v = reveals.get(k);
  reveals.delete(k);
  return v;
}

// App registers how to open a file (as a doc tab); CodeViewer calls it for
// cross-file go-to-definition.
let opener: ((absPath: string) => void) | null = null;
export function setDefinitionOpener(fn: (absPath: string) => void): void {
  opener = fn;
}
export function openDefinitionFile(absPath: string): void {
  opener?.(absPath);
}

// ── Cursor-position bus (E3 breadcrumbs) ─────────────────────────────────
// CodeViewer publishes position changes here; BreadcrumbBar subscribes.
// The payload carries the file path + 0-based character offset so the bar
// can map it to the enclosing symbol chain without re-reading the model.

export interface CursorEvent {
  path: string;
  offset: number;
}

type CursorListener = (e: CursorEvent) => void;
const cursorSubs = new Set<CursorListener>();

export function subscribeCursor(cb: CursorListener): () => void {
  cursorSubs.add(cb);
  return () => cursorSubs.delete(cb);
}

export function publishCursor(e: CursorEvent): void {
  for (const cb of cursorSubs) cb(e);
}
