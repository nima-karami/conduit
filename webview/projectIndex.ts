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

export function setReveal(path: string, pos: { line: number; column: number }): void {
  reveals.set(key(path), pos);
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
