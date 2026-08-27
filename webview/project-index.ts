import * as monaco from 'monaco-editor';

/** `C:` / `/c:` at the head of a Windows path — the only shape that gets rewritten. */
const WIN_DRIVE = /^\/?([a-zA-Z]):(?=[\\/])/;

/**
 * The ONE spelling of an absolute path the renderer keys anything by — tabs (`docs.ts`'s
 * `idOf` is a case-sensitive string compare), reveal targets, and the go-to-definition opener.
 *
 * Windows paths become uppercase-drive + backslashes, which is what the host's `path.join`
 * hands the explorer tree, so a tree open and a navigation into the same file produce the same
 * key. Everything else (POSIX, UNC `\\server\…`, extended `\\?\…`) is left exactly as given:
 * those are already unambiguous, and rewriting separators inside them would break them.
 *
 * See docs/specs/2026-08-21-goto-definition-flows.md contract 4.
 */
export function canonicalPath(path: string): string {
  const m = WIN_DRIVE.exec(path);
  if (!m) return path;
  return `${m[1].toUpperCase()}:${path.slice(m[0].length).replace(/\//g, '\\')}`;
}

/**
 * `uri.toString()` → the canonical path it was built from. Populated by `fileUri`, so it
 * covers every indexed file and every open tab; the opener reads it to turn a navigation
 * result back into the exact path the tab store already uses.
 */
const uriToPath = new Map<string, string>();

/** Canonical file:// URI for an absolute path (shared by CodeViewer + the index so
 *  the opened file and its background model are the SAME model).
 *
 *  `Uri.file`, not `Uri.parse`: parsing `file:///C:/a/c#/mod.ts` reads `#/mod.ts` as a
 *  FRAGMENT (and `?…` as a query), so the key silently loses everything past it. */
export function fileUri(path: string): monaco.Uri {
  const canonical = canonicalPath(path);
  // Forward slashes on purpose: `Uri.file` only treats `\` as a separator when Monaco
  // thinks it is on Windows, and the unit suite also runs on the Linux CI runner.
  const uri = monaco.Uri.file(canonical.replace(/\\/g, '/'));
  uriToPath.set(uri.toString(), canonical);
  return uri;
}

/** The canonical path behind a model / navigation-result URI. */
export function pathForUri(uri: monaco.Uri): string {
  return uriToPath.get(uri.toString()) ?? canonicalPath(uri.path);
}

// Project sources reach the TS service as extraLibs, not as models — see
// webview/ts-project.ts. Models exist only for open tabs and for whichever file a
// navigation lands in.

// Pending reveal targets keyed by the abs path that App opens, consumed by CodeViewer.
const reveals = new Map<string, { line: number; column: number }>();
const key = canonicalPath;

// An ALREADY-mounted CodeViewer (target file is an open tab) won't re-run its onMount
// reveal, so it subscribes here and reveals live when a hit for its path is staged.
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

// Peek without consuming, so a viewer can let an explicit reveal WIN over a saved-scroll
// restore (spec 2026-06-30 §3 reveal-vs-restore): the reveal effect still consumes it.
export function hasReveal(path: string): boolean {
  return reveals.has(key(path));
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

// Cursor-position bus (E3 breadcrumbs): CodeViewer publishes; BreadcrumbBar subscribes.
// The path + 0-based offset lets the bar map to the enclosing symbol chain without
// re-reading the model.

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
