/**
 * Gate for cwds reported by terminal OUTPUT (OSC 9;9 / OSC 7, src/osc-cwd.ts). Output is
 * untrusted: a printed `\\host\share` must not make the main process open an SMB connection, and
 * the existence check must not block the main thread. See plan 2026-10-16-terminal-path-links
 * Task 2.4 and Decisions "UNC and device paths".
 */
import { isUncLike, normalizeAbs, type PathPlatform } from './path-token-normalize';

export interface CwdReportGateDeps {
  /** fs.promises.stat → kind; null on a miss. */
  stat(abs: string): Promise<'file' | 'dir' | null>;
  /** userRootsOf(session); null when the session is gone. */
  userRoots(sessionId: string): string[] | null;
  /** Applies the cwd; a no-op when it equals the session's cwd at accept time. */
  accept(sessionId: string, cwd: string): void;
  platform: PathPlatform;
  caseSensitive: boolean;
}

export interface CwdReportGate {
  /** Fire-and-forget. A UNC/device cwd not lexically under a UNC user root is refused with no fs
   *  call; anything else is accepted after an async stat says 'dir', and only if it is still the
   *  session's newest report. */
  report(sessionId: string, cwd: string): void;
  /** On session dispose: any in-flight result is discarded. */
  drop(sessionId: string): void;
}

export function createCwdReportGate(deps: CwdReportGateDeps): CwdReportGate {
  // One counter across sessions, so a report after drop() never reuses a pending sequence.
  let counter = 0;
  const newest = new Map<string, number>();
  const key = (p: string) => {
    const n = normalizeAbs(p, deps.platform);
    return deps.caseSensitive ? n : n.toLowerCase();
  };
  const underUncUserRoot = (cwd: string, roots: string[]) => {
    const k = key(cwd);
    return roots.some((r) => {
      if (!isUncLike(r)) return false;
      const rk = key(r);
      return k === rk || k.startsWith(`${rk}/`);
    });
  };

  return {
    report(sessionId, cwd) {
      const seq = ++counter;
      newest.set(sessionId, seq);
      const roots = deps.userRoots(sessionId);
      if (roots === null) return;
      if (isUncLike(cwd) && !underUncUserRoot(cwd, roots)) return;
      deps.stat(cwd).then(
        (kind) => {
          if (kind === 'dir' && newest.get(sessionId) === seq) deps.accept(sessionId, cwd);
        },
        // A stat that fails (EPERM, ENOENT) is "not a dir": the report is not applied.
        () => {},
      );
    },
    drop(sessionId) {
      newest.delete(sessionId);
    },
  };
}
