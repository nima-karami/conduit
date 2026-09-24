export interface OsDropSeamInput {
  items: { path: string; isDir: boolean }[];
  targetDir: string;
  x: number;
  y: number;
}

declare global {
  interface Window {
    /** e2e only: an OS drop that Playwright cannot synthesize, entered after its capture step. */
    __conduitOsDrop?: (input: OsDropSeamInput) => Promise<void>;
  }
}

/** Installed only under CONDUIT_E2E=1 (spec §3.3, AC18): unlike the read-only `__conduit*`
 *  probes this one can attach folders, i.e. widen writeRoots. Returns the uninstaller. */
export function installOsDropSeam(
  enabled: boolean,
  handler: (input: OsDropSeamInput) => Promise<void>,
): () => void {
  if (!enabled) return () => {};
  window.__conduitOsDrop = handler;
  return () => {
    if (window.__conduitOsDrop === handler) delete window.__conduitOsDrop;
  };
}
