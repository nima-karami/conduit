import { promises as fsp } from 'node:fs';
import type { WindowPresence } from '../../src/contracts/server-protocol';
import {
  applyHealthReport,
  type Bounded,
  FolderHealth,
  type FolderHealthReport,
} from '../../src/folder-health';
import { folderKey } from '../../src/folder-key';
import type { SessionOpReason } from '../../src/folder-validation';
import type { SessionManager } from '../../src/session-manager';
import type { DomainLog } from './index';

export interface ServerFolderHealthDeps {
  mgr: Pick<SessionManager, 'get' | 'list' | 'setFolderHealth'>;
  revalidate: (sessionId: string, folder: string) => Promise<SessionOpReason | null>;
  realKeys: Map<string, string>;
  log: DomainLog;
}

const isDir = (p: string) =>
  fsp.stat(p).then(
    (st) => st.isDirectory(),
    () => false,
  );

/**
 * The health half of electron/session-folder-runtime.ts: marks and clears missing folders on the
 * session records. Watchers, repo scans and plan reconcile stay in the app (W7), which reports a
 * lost watch as C2 `folders.suspect`.
 */
export class ServerFolderHealth {
  private readonly health: FolderHealth;
  private readonly loggedRejections = new Map<string, SessionOpReason>();
  private focusedWindow: number | null = null;

  constructor(private readonly deps: ServerFolderHealthDeps) {
    this.health = new FolderHealth({
      isDir,
      get: (id) => deps.mgr.get(id),
      sessions: () => deps.mgr.list(),
      apply: (r, bounded) => this.apply(r, bounded),
    });
  }

  check(sessionId: string, only?: readonly string[]): Promise<void> {
    return this.health.check(sessionId, only);
  }

  pending(sessionId: string): Promise<void> | undefined {
    return this.health.pending(sessionId);
  }

  /** Only a path that is one of the session's own folders; the app's watcher may cover others. */
  suspect(sessionId: string, path: string): Promise<void> {
    const s = this.deps.mgr.get(sessionId);
    const key = folderKey(path);
    if (!s || ![s.home, ...s.roots].some((f) => folderKey(f) === key)) return Promise.resolve();
    this.deps.log.warn('folders', 'watch suspect', { sessionId, path });
    return this.check(sessionId, [path]);
  }

  /** Today's folders.focused(): a window gaining focus rechecks what it shows. */
  presence(windows: readonly WindowPresence[]): void {
    const focused = windows.find((w) => w.focused);
    const id = focused?.windowId ?? null;
    if (id === this.focusedWindow) return;
    this.focusedWindow = id;
    for (const sessionId of focused?.visibleSessionIds ?? []) void this.check(sessionId);
  }

  dispose(): void {
    this.health.dispose();
  }

  // FolderHealth awaits this, so it must not reject.
  private async apply(r: FolderHealthReport, bounded: Bounded): Promise<void> {
    try {
      await this.reconcile(r, bounded);
    } catch (e) {
      this.deps.log.warn('folders', `health apply failed: ${String(e)}`, {
        sessionId: r.sessionId,
      });
    }
  }

  private async reconcile(r: FolderHealthReport, bounded: Bounded) {
    const s = this.deps.mgr.get(r.sessionId);
    if (!s) return;
    const { realKeys } = this.deps;
    const present = (key: string) => r.states.get(key) === 'present';
    const marked = new Set((s.missingRoots ?? []).map(folderKey));
    if (s.homeMissing && r.homeKey === folderKey(s.home)) marked.add(r.homeKey);
    const rejected = new Set<string>();
    for (const folder of [s.home, ...s.roots]) {
      const key = folderKey(folder);
      if (!present(key) || !marked.has(key)) continue;
      const reason = await bounded(() => this.deps.revalidate(s.id, folder));
      // Not revalidated in time: the mark stays until a later check finishes it.
      if (reason !== null) rejected.add(key);
      if (reason !== undefined) this.noteRejection(key, folder, reason);
    }
    for (const folder of [s.home, ...s.roots]) {
      const key = folderKey(folder);
      if (!present(key) || rejected.has(key) || realKeys.has(key)) continue;
      try {
        const real = await bounded(() => fsp.realpath(folder));
        if (real !== undefined) realKeys.set(key, folderKey(real));
      } catch {
        // Gone again since its stat: the next check marks it, and its key stays lexical-only.
      }
    }
    const cur = this.deps.mgr.get(r.sessionId);
    if (cur) this.deps.mgr.setFolderHealth(cur.id, applyHealthReport(cur, r, rejected));
  }

  // Re-probed every poll tick, so only a new reason is worth a line (mf-model plan, Decisions).
  private noteRejection(key: string, folder: string, reason: SessionOpReason | null) {
    if (!reason) {
      this.loggedRejections.delete(key);
      return;
    }
    if (this.loggedRejections.get(key) === reason) return;
    this.loggedRejections.set(key, reason);
    this.deps.log.warn('folders', 'returning folder failed revalidation', { folder, reason });
  }
}
