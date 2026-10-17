/**
 * Session → the ordered roots a terminal path token is resolved against (spec
 * 2026-10-16-terminal-path-links §3.2 "Roots"). Pure and browser-safe: the pane computes
 * rootsSigOf locally for its cache scope, the host computes the same for its reply.
 */
import { folderKey } from './folder-key';
import { isAncestorOf } from './owning-session';
import type { PathPlatform } from './path-token-normalize';
import type { RepoInfo } from './repo-scan';
import type { Session } from './types';

export type ResolveRootKind = 'cwd-repo' | 'home' | 'attached' | 'nested' | 'worktree';

export interface ResolveRoot {
  /** Forward-slashed, as stored on the session / RepoInfo.root. */
  abs: string;
  kind: ResolveRootKind;
  /** worktreeName ?? last path segment of abs. */
  name: string;
  /** repoGit[abs].branch, worktrees only. */
  branch?: string;
  /** True for home, session.roots and session.repos lying under one of them; for 'cwd-repo'
   *  only when it lies inside a user root. Terminal output can move the cwd (OSC 9;9), so a
   *  cwd-derived root is untrusted — see plan Decisions "UNC and device paths". */
  userChosen: boolean;
}

type SessionRootFields = Pick<Session, 'home' | 'roots' | 'repos' | 'missingRoots'>;
interface RootOpts {
  platform: PathPlatform;
  caseSensitive: boolean;
}

const slash = (p: string): string => p.replace(/\\/g, '/');
const keyFor = (opts: RootOpts) => (p: string) =>
  opts.caseSensitive ? folderKey(p) : folderKey(p).toLowerCase();
const lastSeg = (p: string): string => slash(p).split('/').filter(Boolean).pop() ?? p;

function presentRoots(s: SessionRootFields, key: (p: string) => string): string[] {
  const missing = new Set((s.missingRoots ?? []).map(key));
  return s.roots.filter((r) => !missing.has(key(r)));
}

/** The user-chosen roots only: home + present session.roots + session.repos[].root under one of
 *  those. The only input to confinement, UNC-root admission and the cwd-report gate. */
export function userRootsOf(s: SessionRootFields, opts: RootOpts): string[] {
  const key = keyFor(opts);
  const base = [s.home, ...presentRoots(s, key)].map(slash);
  const baseKeys = base.map(key);
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (p: string) => {
    const k = key(p);
    if (seen.has(k)) return;
    seen.add(k);
    out.push(p);
  };
  for (const b of base) add(b);
  for (const r of s.repos ?? []) {
    const k = key(r.root);
    if (baseKeys.some((b) => isAncestorOf(b, k))) add(slash(r.root));
  }
  return out;
}

const KIND_FROM_TAG: Record<RepoInfo['tag'], ResolveRootKind> = {
  home: 'home',
  nested: 'nested',
  attached: 'attached',
};

/** What the session says about one folder; the kind is decided from all of it at once. */
interface FolderFacts {
  abs: string;
  tag?: RepoInfo['tag'];
  repoOrder: number;
  isHome: boolean;
  attachedOrder: number;
  isCwd: boolean;
}

/** Order: cwd-repo (only when it is no other root) → home → attached (session.roots order, then
 *  repos tagged attached) → nested + worktree (by name). Deduped by folder key; one folder's kind
 *  is worktree > RepoInfo.tag > home > attached > cwd-repo. Missing roots are skipped. */
export function buildResolveRoots(
  session: SessionRootFields & Pick<Session, 'repoGit'>,
  cwdGitRoot: string,
  opts: RootOpts,
): ResolveRoot[] {
  const key = keyFor(opts);
  const userKeys = userRootsOf(session, opts).map(key);
  const git = session.repoGit ?? {};
  const facts = new Map<string, FolderFacts>();
  const factsFor = (abs: string): FolderFacts => {
    const k = key(abs);
    let f = facts.get(k);
    if (!f) {
      f = { abs: slash(abs), repoOrder: -1, isHome: false, attachedOrder: -1, isCwd: false };
      facts.set(k, f);
    }
    return f;
  };

  (session.repos ?? []).forEach((r, i) => {
    const f = factsFor(r.root);
    if (f.tag !== undefined) return;
    f.tag = r.tag;
    f.repoOrder = i;
  });
  factsFor(session.home).isHome = true;
  presentRoots(session, key).forEach((r, i) => {
    const f = factsFor(r);
    if (f.attachedOrder < 0) f.attachedOrder = i;
  });
  if (cwdGitRoot) factsFor(cwdGitRoot).isCwd = true;

  const roots: Array<ResolveRoot & { order: number }> = [];
  for (const f of facts.values()) {
    const info = git[f.abs];
    const kind: ResolveRootKind = info?.isWorktree
      ? 'worktree'
      : f.tag !== undefined
        ? KIND_FROM_TAG[f.tag]
        : f.isHome
          ? 'home'
          : f.attachedOrder >= 0
            ? 'attached'
            : 'cwd-repo';
    const k = key(f.abs);
    roots.push({
      abs: f.abs,
      kind,
      name: kind === 'worktree' && info?.worktreeName ? info.worktreeName : lastSeg(f.abs),
      ...(kind === 'worktree' && info?.branch ? { branch: info.branch } : {}),
      userChosen: userKeys.some((u) => isAncestorOf(u, k)),
      // Within a group: session.home, then session.roots order, then repos order.
      order: f.isHome ? -1 : f.attachedOrder >= 0 ? f.attachedOrder : 1000 + f.repoOrder,
    });
  }

  const group: Record<ResolveRootKind, number> = {
    'cwd-repo': 0,
    home: 1,
    attached: 2,
    nested: 3,
    worktree: 3,
  };
  roots.sort(
    (a, b) =>
      group[a.kind] - group[b.kind] ||
      (group[a.kind] === 3 ? a.name.localeCompare(b.name) : a.order - b.order),
  );
  return roots.map(({ order: _order, ...r }) => r);
}

// FNV-1a 32-bit: a cheap stable signature, not a security hash.
function fnv1a(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/** Signature over home, roots (ordered: attach order ranks), repos[].root and missingRoots (both
 *  sorted). repoGit is excluded. The host echoes it; the pane computes it from the same fields. */
export function rootsSigOf(session: SessionRootFields): string {
  const parts = [
    session.home,
    session.roots.join('\n'),
    (session.repos ?? [])
      .map((r) => r.root)
      .sort()
      .join('\n'),
    [...(session.missingRoots ?? [])].sort().join('\n'),
  ];
  return fnv1a(parts.join('\0'));
}
