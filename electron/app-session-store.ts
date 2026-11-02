import { resolveActiveRepo } from '../src/active-repo';
import {
  type AppSessionOverlay,
  type AppSessionView,
  mergeAppOverlay,
  type SessionView,
} from '../src/contracts/server-protocol';
import type { RepoInfo } from '../src/repo-scan';
import { sameRepoGit } from '../src/session-manager';
import type { GitInfo } from '../src/types';

export interface SessionFolderDiff {
  sessionId: string;
  kind: 'added' | 'removed' | 'changed';
  homeChanged: boolean;
  cwdChanged: boolean;
}

const sameList = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((x, i) => x === b[i]);

const sameRepos = (a: RepoInfo[] | undefined, b: RepoInfo[]) =>
  (a?.length ?? 0) === b.length &&
  b.every((r, i) => {
    const o = a?.[i];
    return o?.root === r.root && o.tag === r.tag && o.folder === r.folder;
  });

/**
 * The app's session list: the server's views with the D39 overlay (repo fields the app derives)
 * merged on. Repo logic ported from SessionManager's setRepos…unpinRepo.
 */
export class AppSessionStore {
  private views: SessionView[] = [];
  private readonly byId = new Map<string, SessionView>();
  private readonly overlays = new Map<string, AppSessionOverlay>();
  private readonly listeners = new Set<() => void>();

  /** No onChange: the caller broadcasts once per server list, with the diff in hand. */
  applyServer(views: SessionView[]): SessionFolderDiff[] {
    const diffs: SessionFolderDiff[] = [];
    const next = new Map(views.map((v) => [v.id, v]));
    for (const v of views) {
      const prev = this.byId.get(v.id);
      if (!prev) {
        diffs.push({
          sessionId: v.id,
          kind: 'added',
          homeChanged: true,
          cwdChanged: v.cwd !== undefined,
        });
        continue;
      }
      const homeChanged = prev.home !== v.home;
      const cwdChanged = prev.cwd !== v.cwd;
      if (homeChanged || cwdChanged || !sameList(prev.roots, v.roots))
        diffs.push({ sessionId: v.id, kind: 'changed', homeChanged, cwdChanged });
    }
    for (const id of this.byId.keys())
      if (!next.has(id)) {
        diffs.push({ sessionId: id, kind: 'removed', homeChanged: false, cwdChanged: false });
        this.overlays.delete(id);
      }
    this.views = views;
    this.byId.clear();
    for (const [id, v] of next) this.byId.set(id, v);
    // The opened root is the active repo's fallback, so a moved home re-resolves it.
    for (const d of diffs) {
      const overlay = this.overlays.get(d.sessionId);
      const view = this.byId.get(d.sessionId);
      if (d.homeChanged && overlay && view) this.recompute(view, overlay);
    }
    return diffs;
  }

  list(): AppSessionView[] {
    return this.views.map((v) => mergeAppOverlay(v, this.overlays.get(v.id)));
  }

  get(id: string): AppSessionView | undefined {
    const v = this.byId.get(id);
    return v && mergeAppOverlay(v, this.overlays.get(id));
  }

  generationOf(id: string): number | null {
    return this.byId.get(id)?.runtime.generation ?? null;
  }

  /** Returns whether it emitted. */
  setRepos(id: string, repos: RepoInfo[]): boolean {
    const view = this.byId.get(id);
    if (!view) return false;
    const o = this.overlay(id);
    const unchanged = sameRepos(o.repos, repos);
    o.repos = repos;
    let pruned = false;
    if (o.repoGit) {
      const roots = new Set(repos.map((r) => r.root));
      const kept = Object.entries(o.repoGit).filter(([root]) => roots.has(root));
      if (kept.length !== Object.keys(o.repoGit).length) {
        o.repoGit = Object.fromEntries(kept);
        pruned = true;
      }
    }
    const derived = this.recompute(view, o);
    if (unchanged && !derived && !pruned) return false;
    this.emit();
    return true;
  }

  setRepoGit(id: string, g: Record<string, GitInfo> | undefined): void {
    if (!this.byId.has(id)) return;
    const o = this.overlay(id);
    if (sameRepoGit(o.repoGit, g)) return;
    o.repoGit = g;
    this.emit();
  }

  /** One emit for the whole batch; unchanged entries are skipped. */
  mergeRepoGit(p: ReadonlyArray<{ sessionId: string; root: string; info: GitInfo }>): void {
    let changed = false;
    for (const { sessionId, root, info } of p) {
      if (!this.byId.has(sessionId)) continue;
      const o = this.overlay(sessionId);
      const next = { ...o.repoGit, [root]: info };
      if (sameRepoGit(o.repoGit, next)) continue;
      o.repoGit = next;
      changed = true;
    }
    if (changed) this.emit();
  }

  setAutoRepo(id: string, root: string | undefined): void {
    this.editRepoChoice(id, (o) => {
      if (o.autoRepoRoot === root) return false;
      o.autoRepoRoot = root;
      return true;
    });
  }

  pinRepo(id: string, root: string): void {
    this.editRepoChoice(id, (o) => {
      if (o.pinnedRepoRoot === root) return false;
      o.pinnedRepoRoot = root;
      return true;
    });
  }

  unpinRepo(id: string): void {
    this.editRepoChoice(id, (o) => {
      if (!o.pinnedRepoRoot) return false;
      delete o.pinnedRepoRoot;
      return true;
    });
  }

  onChange(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  private editRepoChoice(id: string, edit: (o: AppSessionOverlay) => boolean): void {
    const view = this.byId.get(id);
    if (!view) return;
    const o = this.overlay(id);
    if (edit(o) && this.recompute(view, o)) this.emit();
  }

  private overlay(id: string): AppSessionOverlay {
    let o = this.overlays.get(id);
    if (!o) {
      o = {};
      this.overlays.set(id, o);
    }
    return o;
  }

  /** Returns whether the derived fields changed. */
  private recompute(view: SessionView, o: AppSessionOverlay): boolean {
    const next = resolveActiveRepo({
      repos: o.repos ?? [],
      pinnedRoot: o.pinnedRepoRoot,
      autoRoot: o.autoRepoRoot,
      openedRoot: view.home,
    });
    // The pin is in effect iff it won; a pin whose repo vanished is dropped (no second scan).
    const pinned = next !== undefined && next === o.pinnedRepoRoot;
    if (o.pinnedRepoRoot && !pinned) delete o.pinnedRepoRoot;
    let changed = false;
    if (o.activeRepoRoot !== next) {
      o.activeRepoRoot = next;
      changed = true;
    }
    if (o.repoPinned !== pinned) {
      o.repoPinned = pinned;
      changed = true;
    }
    return changed;
  }

  private emit(): void {
    for (const cb of [...this.listeners]) cb();
  }
}
