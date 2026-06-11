import { contextBridge, ipcRenderer } from 'electron';
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
