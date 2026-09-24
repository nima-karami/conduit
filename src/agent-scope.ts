// What a running claude can see versus the session's folders (mf-live-edits spec §2.1).
// Renderer-safe: no node:*, no DOM; path resolution and existence are injected.
import { folderKey } from './folder-key';
import { isAncestorOf } from './owning-session';
import { presentRoots } from './session-folders';
import type { AgentScopeView, Session } from './types';

export interface AgentScope {
  cwd: string;
  /** Every --add-dir value of the final spawn args plus delivered /add-dir paths, resolved,
   *  deduped by folder key. */
  dirs: string[];
  /** Entries of [cwd, ...dirs] the session's folders did not cover at capture — a user's own
   *  agents.json --add-dir. Never stillSeen: no restart could clear it (plan §Spec staleness). */
  external: string[];
}

export type DismissKind = 'unseen' | 'stillSeen';

function covered(p: string, entries: readonly string[]): boolean {
  const k = folderKey(p);
  return entries.some((e) => isAncestorOf(folderKey(e), k));
}

function dedupeByKey(paths: readonly string[]): string[] {
  const seen = new Set<string>();
  return paths.filter((p) => {
    const k = folderKey(p);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

function addDirValues(args: readonly string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith('--add-dir=')) {
      out.push(a.slice('--add-dir='.length));
    } else if (a === '--add-dir') {
      // claude's --add-dir is variadic: values run until the next flag.
      while (i + 1 < args.length && !args[i + 1].startsWith('-')) out.push(args[++i]);
    }
  }
  return out.filter((v) => v !== '');
}

export function scopeFromSpawnArgs(
  cwd: string,
  args: readonly string[],
  resolve: (base: string, p: string) => string,
  folders: Pick<Session, 'home' | 'roots'>,
): AgentScope {
  const dirs = dedupeByKey(addDirValues(args).map((v) => resolve(cwd, v)));
  const mine = [folders.home, ...folders.roots];
  const external = dedupeByKey([cwd, ...dirs]).filter((p) => !covered(p, mine));
  return { cwd, dirs, external };
}

export function isTypeablePath(p: string): boolean {
  if (p.startsWith('\\\\') || p.startsWith('//')) return false;
  for (let i = 0; i < p.length; i++) {
    const c = p.charCodeAt(i);
    if (c <= 0x1f || (c >= 0x7f && c <= 0x9f)) return false;
  }
  return true;
}

export async function agentScopeDrift(
  s: Pick<Session, 'home' | 'homeMissing' | 'roots' | 'missingRoots'>,
  scope: AgentScope,
  dismissed: ReadonlyMap<string, DismissKind>,
  exists: (p: string) => Promise<boolean>,
): Promise<AgentScopeView | undefined> {
  const seen = [scope.cwd, ...scope.dirs];
  const unseen = [...(s.homeMissing ? [] : [s.home]), ...presentRoots(s)].filter(
    (p) => !covered(p, seen) && dismissed.get(folderKey(p)) !== 'unseen',
  );
  // Missing roots count as the session's own: a root that went missing was not removed.
  const mine = [s.home, ...s.roots];
  const external = new Set(scope.external.map(folderKey));
  const candidates = dedupeByKey([...scope.dirs, scope.cwd]).filter((p) => {
    const k = folderKey(p);
    return !covered(p, mine) && !external.has(k) && dismissed.get(k) !== 'stillSeen';
  });
  const present = await Promise.all(candidates.map((p) => exists(p)));
  const stillSeen = candidates.filter((_, i) => present[i]);
  if (unseen.length === 0 && stillSeen.length === 0) return undefined;
  return { unseen, stillSeen, typeable: unseen.filter(isTypeablePath) };
}

export function pruneDismissed(
  dismissed: ReadonlyMap<string, DismissKind>,
  s: Pick<Session, 'home' | 'roots'>,
): Map<string, DismissKind> {
  const mine = [s.home, ...s.roots];
  const keys = new Set(mine.map(folderKey));
  const out = new Map<string, DismissKind>();
  for (const [k, kind] of dismissed) {
    if (kind === 'unseen' ? keys.has(k) : !covered(k, mine)) out.set(k, kind);
  }
  return out;
}
