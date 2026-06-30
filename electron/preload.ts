import { contextBridge, ipcRenderer, webUtils } from 'electron';
import type { DndOpts, DndResult } from '../src/fs-dnd';
import type { ImportConflictPolicy, ImportResult } from '../src/fs-import';
import type { FsMutationRequest, MutationResult } from '../src/fs-mutations';
import type { GitActionRequest, GitActionResult } from '../src/git-actions';
import type { WriteResult } from '../src/path-guard';
import type { HostToWebview, WebviewToHost } from '../src/protocol';

/** Safe bridge exposed to the renderer as `window.agentDeck`. */
const api = {
  post(msg: WebviewToHost): void {
    ipcRenderer.send('to-host', msg);
  },
  subscribe(cb: (msg: HostToWebview) => void): () => void {
    const listener = (_e: unknown, msg: HostToWebview) => cb(msg);
    ipcRenderer.on('to-webview', listener);
    return () => ipcRenderer.removeListener('to-webview', listener);
  },
  /** Open an external (http/https/OS-scheme) URL in the user's real browser. */
  openExternal(url: string): void {
    ipcRenderer.send('open-external', url);
  },
  /** Open the host logs folder in the OS file manager (diagnostics). */
  revealLogs(): void {
    ipcRenderer.send('to-host', { type: 'revealLogs' });
  },
  /**
   * Bundle the recent logs + app/OS versions into a diagnostics file, then reveal it.
   * Returns the bundle path (or null if it couldn't be written). The HOST assembles the
   * bundle from already-redacted disk logs; no process.env is dumped.
   */
  copyDiagnostics(): Promise<string | null> {
    return ipcRenderer.invoke('copyDiagnostics');
  },
  /** Read the last `n` lines of the active log (already redacted on disk) for the About tail. */
  readLogTail(n: number): Promise<{ off: boolean; tail: string }> {
    return ipcRenderer.invoke('readLogTail', n);
  },
  /**
   * Save the editor buffer back to `path`. The HOST validates that the path stays
   * inside an open workspace root before writing (the renderer is untrusted); the
   * result reports success or a rejection/error so the dirty state is only cleared
   * on a real write.
   */
  writeFile(path: string, content: string): Promise<WriteResult> {
    return ipcRenderer.invoke('writeFile', path, content);
  },
  /**
   * Run a git action (stage / unstage / discard / stash) in `req.root`. The HOST
   * validates the root is a known workspace and that any path stays inside it
   * before touching git/disk. Returns ok/error so the renderer can toast failures.
   */
  gitAction(req: GitActionRequest): Promise<GitActionResult> {
    return ipcRenderer.invoke('git-action', req);
  },
  /**
   * Create / rename / delete a file or folder in the tree. The HOST validates that
   * every path stays inside a known workspace root before touching disk (the renderer
   * is untrusted). Delete goes to the OS recycle bin; returns ok/error so the renderer
   * can refresh on success and toast on failure.
   */
  fsMutate(req: FsMutationRequest): Promise<MutationResult> {
    return ipcRenderer.invoke('fs-mutate', req);
  },
  /**
   * Move a file or folder to a new location (drag-and-drop, D5). The HOST validates
   * that both paths stay inside a known workspace root before touching disk. Returns
   * ok/error; the renderer refreshes the tree on success and toasts on failure.
   */
  fsMove(from: string, to: string, opts?: DndOpts): Promise<DndResult> {
    return ipcRenderer.invoke('fs-move', from, to, opts);
  },
  /**
   * Copy a file or folder to a new location (drag-and-drop with Ctrl, D5). The HOST
   * validates that both paths stay inside a known workspace root. Returns ok/error.
   */
  fsCopy(from: string, to: string, opts?: DndOpts): Promise<DndResult> {
    return ipcRenderer.invoke('fs-copy', from, to, opts);
  },
  /**
   * Import (copy) OS files/folders dragged from outside the app into `targetDir`. The HOST
   * validates only the TARGET stays inside a workspace root — the sources are arbitrary OS
   * paths the user explicitly dragged in. Always a copy; never moves the originals.
   */
  fsImport(
    sources: string[],
    targetDir: string,
    opts?: { onConflict?: ImportConflictPolicy },
  ): Promise<ImportResult> {
    return ipcRenderer.invoke('fs-import', sources, targetDir, opts);
  },
  /**
   * Resolve the absolute filesystem path of a `File` from a drop's `dataTransfer` (the
   * renderer can't read it directly under context isolation; Electron 32+ removed
   * `File.path` in favour of `webUtils.getPathForFile`).
   */
  getPathForFile(file: File): string {
    return webUtils.getPathForFile(file);
  },
  win: {
    minimize: () => ipcRenderer.send('win:minimize'),
    toggleMaximize: () => ipcRenderer.send('win:toggleMaximize'),
    close: () => ipcRenderer.send('win:close'),
    /** Open a new, empty Conduit window (multi-window Slice A). */
    new: () => ipcRenderer.send('to-host', { type: 'win:new' }),
    isMaximized: (): Promise<boolean> => ipcRenderer.invoke('win:isMaximized'),
    onMaximizeChange: (cb: (maximized: boolean) => void): (() => void) => {
      const listener = (_e: unknown, maximized: boolean) => cb(maximized);
      ipcRenderer.on('win:maximized', listener);
      return () => ipcRenderer.removeListener('win:maximized', listener);
    },
  },
};

export type AgentDeckBridge = typeof api;

contextBridge.exposeInMainWorld('agentDeck', api);
