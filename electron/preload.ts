import { contextBridge, ipcRenderer } from 'electron';
import type { DndResult } from '../src/fs-dnd';
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
  fsMove(from: string, to: string): Promise<DndResult> {
    return ipcRenderer.invoke('fs-move', from, to);
  },
  /**
   * Copy a file or folder to a new location (drag-and-drop with Ctrl, D5). The HOST
   * validates that both paths stay inside a known workspace root. Returns ok/error.
   */
  fsCopy(from: string, to: string): Promise<DndResult> {
    return ipcRenderer.invoke('fs-copy', from, to);
  },
  win: {
    minimize: () => ipcRenderer.send('win:minimize'),
    toggleMaximize: () => ipcRenderer.send('win:toggleMaximize'),
    close: () => ipcRenderer.send('win:close'),
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
