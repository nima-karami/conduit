import type { SessionManager } from '../src/session-manager';

export interface SessionFolderRuntimeDeps {
  mgr: Pick<SessionManager, 'get' | 'list'>;
  scheduleRepoScan: (sessionId: string) => void;
  reconcilePlans: (homes: string[]) => void;
  log: (level: 'info' | 'warn', msg: string, data?: Record<string, unknown>) => void;
}

/** The host's one owner of a session's folder lifecycle (L12 S1; mf-model plan Contracts). */
export class SessionFolderRuntime {
  private listeners: ((sessionId: string) => void)[] = [];

  constructor(private readonly deps: SessionFolderRuntimeDeps) {}

  created(sessionId: string): void {
    this.deps.scheduleRepoScan(sessionId);
  }

  foldersChanged(sessionId: string, change: { homeChanged: boolean }): void {
    this.deps.scheduleRepoScan(sessionId);
    if (change.homeChanged) this.deps.reconcilePlans(this.deps.mgr.list().map((s) => s.home));
    this.emit(sessionId);
  }

  onFoldersChanged(cb: (sessionId: string) => void): { dispose(): void } {
    this.listeners.push(cb);
    return { dispose: () => (this.listeners = this.listeners.filter((l) => l !== cb)) };
  }

  stop(): void {
    this.listeners = [];
  }

  private emit(sessionId: string) {
    for (const l of this.listeners) {
      // A consumer's failure must not abort the op that already mutated the session.
      try {
        l(sessionId);
      } catch (e) {
        this.deps.log('warn', `onFoldersChanged listener failed: ${String(e)}`, { sessionId });
      }
    }
  }
}
