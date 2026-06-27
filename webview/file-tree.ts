// Pure file-tree logic for the Explorer, kept out of the React component so the
// reconciliation and refetch decisions have a single unit-tested source of truth. A refresh
// must reconcile a fresh on-disk listing WITHOUT discarding the user's expanded dirs or
// already-loaded children (see `mergeEntries`).

import type { ChangeDTO, ChangeKind, DirEntryDTO } from '../src/protocol';

export interface TreeNode {
  name: string;
  path: string; // absolute
  kind: 'dir' | 'file';
  expanded: boolean;
  children?: TreeNode[];
  /** Mirrors DirEntryDTO.ignored — git-ignored entries are dimmed in the Explorer. */
  ignored?: boolean;
}

/** Join a directory path and a child name with a forward slash (host-agnostic). */
export function joinPath(base: string, name: string): string {
  return `${base.replace(/[\\/]+$/, '')}/${name}`;
}

/**
 * UI-side validation of a typed file/folder name before any host round-trip (L2). Returns an
 * inline error or `null`. `self` (for a rename) is excluded from the collision check.
 * Collision is case-insensitive to match win32 (and harmless elsewhere).
 */
export function validateName(
  name: string,
  siblings: readonly string[],
  self?: string,
): string | null {
  const trimmed = name.trim();
  if (!trimmed) return 'Name cannot be empty.';
  if (trimmed === '.' || trimmed === '..') return 'Reserved name.';
  if (/[\\/]/.test(trimmed)) return 'Name cannot contain a path separator.';
  const lower = trimmed.toLowerCase();
  if (self && lower === self.toLowerCase()) return null;
  if (siblings.some((s) => s.toLowerCase() === lower)) {
    return 'A file or folder with that name already exists.';
  }
  return null;
}

/**
 * Reconcile a fresh on-disk listing of `dirPath` against the `existing` nodes for it.
 * Surviving directories keep their `expanded` flag and loaded `children` so a refresh never
 * collapses the tree or discards deeper reads; a name that changed kind is a fresh node.
 * Result follows `entries` order (host sorts dirs-first).
 */
export function mergeEntries(
  existing: TreeNode[] | undefined,
  dirPath: string,
  entries: DirEntryDTO[],
): TreeNode[] {
  const prev = new Map((existing ?? []).map((n) => [n.name, n]));
  return entries.map((e) => {
    const old = prev.get(e.name);
    if (old && old.kind === e.kind) {
      // Preserve expansion + loaded children; refresh the (possibly changed) ignored flag.
      return old.ignored === e.ignored ? old : { ...old, ignored: e.ignored };
    }
    return {
      name: e.name,
      path: joinPath(dirPath, e.name),
      kind: e.kind,
      expanded: false,
      ignored: e.ignored,
    };
  });
}

/**
 * Apply a fresh listing for `dirPath` to the whole tree, merging in place. Loading a
 * directory's contents NEVER changes its `expanded` flag — expansion is a separate action
 * (`expandNode`, done explicitly by the caller). Forcing expansion here caused a race: a
 * background refresh's readDir reply, arriving after the user collapsed the folder, would
 * pop it back open. Expansion elsewhere is untouched.
 */
export function applyEntries(
  roots: TreeNode[],
  rootPath: string,
  dirPath: string,
  entries: DirEntryDTO[],
): TreeNode[] {
  if (dirPath === rootPath) {
    return mergeEntries(roots, dirPath, entries);
  }
  const recurse = (nodes: TreeNode[]): TreeNode[] =>
    nodes.map((n) => {
      if (n.path === dirPath) {
        return { ...n, children: mergeEntries(n.children, dirPath, entries) };
      }
      if (n.children) return { ...n, children: recurse(n.children) };
      return n;
    });
  return recurse(roots);
}

/**
 * Directory paths a refresh should re-read: the root plus every expanded dir with children.
 * Keeps refresh cheap (no eager walk of unopened folders) while surfacing changes anywhere
 * visible.
 */
export function pathsToRefresh(roots: TreeNode[], rootPath: string): string[] {
  const out: string[] = [rootPath];
  const walk = (nodes: TreeNode[]) => {
    for (const n of nodes) {
      if (n.kind === 'dir' && n.expanded && n.children) {
        out.push(n.path);
        walk(n.children);
      }
    }
  };
  walk(roots);
  return out;
}

/** Flip a single directory node (matched by absolute path) to expanded. Pure. */
export function expandNode(nodes: TreeNode[], path: string): TreeNode[] {
  return nodes.map((n) =>
    n.path === path
      ? { ...n, expanded: true }
      : n.children
        ? { ...n, children: expandNode(n.children, path) }
        : n,
  );
}

/** Flip a single directory node (matched by absolute path) to collapsed. Pure. */
export function collapseNode(nodes: TreeNode[], path: string): TreeNode[] {
  return nodes.map((n) =>
    n.path === path
      ? { ...n, expanded: false }
      : n.children
        ? { ...n, children: collapseNode(n.children, path) }
        : n,
  );
}

/** Find a node anywhere in the tree by absolute path (depth-first). */
export function findNode(roots: TreeNode[], path: string): TreeNode | undefined {
  for (const n of roots) {
    if (n.path === path) return n;
    if (n.children) {
      const found = findNode(n.children, path);
      if (found) return found;
    }
  }
  return undefined;
}

/**
 * The chain of directory paths to expand to reveal `filePath`: root, then each intermediate
 * dir down to the file's parent. Built with `joinPath` so paths compare equal to
 * `TreeNode.path`. Returns `[]` when `filePath` is not under `rootPath`.
 */
export function ancestorDirChain(filePath: string, rootPath: string): string[] {
  const norm = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '');
  const root = norm(rootPath);
  const file = norm(filePath);
  if (file === root || !file.startsWith(`${root}/`)) return [];
  const segments = file
    .slice(root.length + 1)
    .split('/')
    .filter(Boolean);
  const dirSegments = segments.slice(0, -1);
  const chain = [rootPath];
  let cur = rootPath.replace(/[\\/]+$/, '');
  for (const seg of dirSegments) {
    cur = joinPath(cur, seg);
    chain.push(cur);
  }
  return chain;
}

/** True when the query has non-whitespace content (drives the results view, not the tree). */
export function isSearchActive(query: string): boolean {
  return query.trim().length > 0;
}

/** Collapse every directory node (recursively, immutably). */
export function collapseAll(nodes: TreeNode[]): TreeNode[] {
  return nodes.map((n) =>
    n.kind === 'dir'
      ? { ...n, expanded: false, children: n.children ? collapseAll(n.children) : undefined }
      : n,
  );
}

/** Expand only already-loaded directory nodes; never triggers a readDir for unloaded folders. */
export function expandLoaded(nodes: TreeNode[]): TreeNode[] {
  return nodes.map((n) =>
    n.kind === 'dir' && n.children
      ? { ...n, expanded: true, children: expandLoaded(n.children) }
      : n,
  );
}

/** Flattened depth-first paths of every currently-visible row (expanded dirs only). */
export function visibleOrder(roots: TreeNode[]): string[] {
  const out: string[] = [];
  const walk = (nodes: TreeNode[]) => {
    for (const n of nodes) {
      out.push(n.path);
      if (n.kind === 'dir' && n.expanded && n.children) walk(n.children);
    }
  };
  walk(roots);
  return out;
}

/** Parent directory of an absolute path (host-agnostic; trailing separators stripped). */
function parentDir(path: string): string {
  return path.replace(/[\\/]+$/, '').replace(/[\\/][^\\/]+$/, '');
}

/**
 * Create-target from the active item (Decision D1): an active directory targets itself, an
 * active file targets its parent dir, and no active item targets the project root.
 */
export function resolveCreateTarget(
  active: { path: string; kind: 'dir' | 'file' } | null,
  projectPath: string,
): string {
  if (!active) return projectPath;
  return active.kind === 'dir' ? active.path : parentDir(active.path);
}

/**
 * Precedence rule when a file appears in both the staged and unstaged lists
 * (git porcelain `MM`): the worktree/unstaged kind wins over the index/staged kind
 * because it reflects the current on-disk state the user sees.
 */
function resolveKindPrecedence(_staged: ChangeKind, unstaged: ChangeKind): ChangeKind {
  return unstaged;
}

/**
 * Build a `Map<relativePath, ChangeKind>` from a flat `ChangeDTO[]` for the Files-tree
 * overlay. Decorates every changed file plus every ancestor folder of one (folder kind =
 * most alarming descendant, D > M > A > U). On MM (staged + unstaged) the unstaged kind wins.
 */
export function buildChangeMap(changes: ChangeDTO[]): Map<string, ChangeKind> {
  // Forward slashes so matching against host-separator tree paths is consistent.
  const normalize = (p: string) => p.replace(/\\/g, '/');

  // Collapse MM duplicates (same path staged + unstaged); unstaged wins.
  const fileMap = new Map<string, ChangeKind>();
  for (const c of changes) {
    const p = normalize(c.path);
    const existing = fileMap.get(p);
    if (existing === undefined) {
      fileMap.set(p, c.kind);
    } else {
      if (!c.staged) {
        fileMap.set(p, resolveKindPrecedence(existing, c.kind));
      }
    }
  }

  const out = new Map<string, ChangeKind>(fileMap);

  // Roll up to ancestor folders, keeping the highest-priority kind.
  const kindPriority: Record<ChangeKind, number> = { D: 3, M: 2, A: 1, U: 0 };
  for (const [filePath, kind] of fileMap) {
    const segments = filePath.split('/');
    for (let i = 1; i < segments.length; i++) {
      const folderRel = segments.slice(0, i).join('/');
      const existing = out.get(folderRel);
      if (existing === undefined || kindPriority[kind] > kindPriority[existing]) {
        out.set(folderRel, kind);
      }
    }
  }

  return out;
}
