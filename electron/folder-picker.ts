import type { BrowserWindow } from 'electron';

export interface FolderPickerDeps {
  showOpenDialog: (
    win: BrowserWindow | null,
    opts: Electron.OpenDialogOptions,
  ) => Promise<Electron.OpenDialogReturnValue>;
  /** process.env.CONDUIT_E2E === '1' */
  e2e: boolean;
  installHook: (hook: { queue(paths: (string | null)[]): void }) => void;
}

/** The one folder-pick seam (locked L11); mf-files' Locate reuses `pick`. */
export interface FolderPicker {
  /** A queued hook entry answers first (e2e); else the native dialog, parented to win.
   *  A second pick while one is open for the same window resolves null without a dialog. */
  pick(win: BrowserWindow | null, title: string, defaultPath?: string): Promise<string | null>;
}

export function createFolderPicker(deps: FolderPickerDeps): FolderPicker {
  const queued: (string | null)[] = [];
  // Playwright can't drive a native dialog, so e2e scenarios answer picks through this queue.
  if (deps.e2e) deps.installHook({ queue: (paths) => queued.push(...paths) });
  const open = new Set<BrowserWindow | null>();
  return {
    async pick(win, title, defaultPath) {
      if (queued.length > 0) return queued.shift() ?? null;
      if (open.has(win)) return null;
      open.add(win);
      try {
        const r = await deps.showOpenDialog(win, {
          properties: ['openDirectory'],
          title,
          ...(defaultPath !== undefined ? { defaultPath } : {}),
        });
        return r.canceled ? null : (r.filePaths[0] ?? null);
      } finally {
        open.delete(win);
      }
    },
  };
}
