// Per-session agent scope, dismissals and the published drift view, in host memory only
// (mf-live-edits spec §2.1, §2.5). Reaches the renderer as a postState decoration.
import {
  type AgentScope,
  agentScopeDrift,
  type DismissKind,
  pruneDismissed,
} from '../src/agent-scope';
import { folderKey } from '../src/folder-key';
import type { AgentScopeView, Session } from '../src/types';

export interface AgentScopeTrackerDeps {
  get: (id: string) => Session | undefined;
  exists: (p: string) => Promise<boolean>;
  onChange: (sessionId: string) => void;
}

const sameList = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((v, i) => v === b[i]);

const sameView = (a: AgentScopeView | undefined, b: AgentScopeView | undefined) =>
  a === undefined || b === undefined
    ? a === b
    : sameList(a.unseen, b.unseen) &&
      sameList(a.stillSeen, b.stillSeen) &&
      sameList(a.typeable, b.typeable);

export class AgentScopeTracker {
  private readonly scopes = new Map<string, AgentScope>();
  private readonly dismissed = new Map<string, Map<string, DismissKind>>();
  private readonly views = new Map<string, AgentScopeView>();
  private readonly tokens = new Map<string, number>();

  constructor(private readonly deps: AgentScopeTrackerDeps) {}

  captured(sessionId: string, scope: AgentScope): void {
    this.scopes.set(sessionId, scope);
    this.dismissed.delete(sessionId);
    this.recompute(sessionId);
  }

  ended(sessionId: string): void {
    this.scopes.delete(sessionId);
    this.dismissed.delete(sessionId);
    this.tokens.delete(sessionId);
    if (this.views.delete(sessionId)) this.deps.onChange(sessionId);
  }

  recompute(sessionId: string): void {
    const scope = this.scopes.get(sessionId);
    const s = this.deps.get(sessionId);
    if (!scope || !s) return;
    const token = (this.tokens.get(sessionId) ?? 0) + 1;
    this.tokens.set(sessionId, token);
    const dismissed = pruneDismissed(this.dismissed.get(sessionId) ?? new Map(), s);
    this.dismissed.set(sessionId, dismissed);
    void agentScopeDrift(s, scope, dismissed, this.deps.exists).then((view) => {
      // A newer recompute, an `ended`, or a re-capture while the stat ran owns the result now.
      if (this.tokens.get(sessionId) !== token || this.scopes.get(sessionId) !== scope) return;
      if (sameView(this.views.get(sessionId), view)) return;
      if (view) this.views.set(sessionId, view);
      else this.views.delete(sessionId);
      this.deps.onChange(sessionId);
    });
  }

  delivered(sessionId: string, path: string): void {
    const scope = this.scopes.get(sessionId);
    if (!scope) return;
    const k = folderKey(path);
    if (!scope.dirs.some((d) => folderKey(d) === k)) {
      this.scopes.set(sessionId, { ...scope, dirs: [...scope.dirs, path] });
    }
    this.recompute(sessionId);
  }

  dismiss(sessionId: string): void {
    const view = this.views.get(sessionId);
    if (!view) return;
    const d = new Map(this.dismissed.get(sessionId));
    for (const p of view.unseen) d.set(folderKey(p), 'unseen');
    for (const p of view.stillSeen) d.set(folderKey(p), 'stillSeen');
    this.dismissed.set(sessionId, d);
    this.recompute(sessionId);
  }

  view(sessionId: string): AgentScopeView | undefined {
    return this.views.get(sessionId);
  }

  typeable(sessionId: string): readonly string[] | undefined {
    if (!this.scopes.has(sessionId)) return undefined;
    return this.views.get(sessionId)?.typeable ?? [];
  }
}
