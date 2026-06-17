// Pure file-tree logic for the Explorer, kept out of the React component so the
// reconciliation and refetch decisions have a single, unit-tested source of truth.
//
// The Explorer reads a directory's entries from the host (`readDir` → `dirEntries`).
// On the very first read of a directory we build fresh nodes; on a *refresh* (e.g.
// the window regained focus and an external tool wrote files) we must reconcile the
// new on-disk listing into the existing tree WITHOUT discarding which directories
// the user had expanded or their already-loaded children. `mergeEntries` does that.

import type { ChangeDTO, ChangeKind, DirEntryDTO } from '../src/protocol';

export interface TreeNode {
  name: string;
  path: string; // absolute
  kind: 'dir' | 'file';
  expanded: boolean;
  children?: TreeNode[];
}

/** Join a directory path and a child name with a forward slash (host-agnostic). */
export function joinPath(base: string, name: string): string {
  return `${base.replace(/[\\/]+$/, '')}/${name}`;
}

/**
 * UI-side validation of a typed file/folder name BEFORE any host round-trip (L2).
 * Returns an error string to show inline, or `null` when the name is acceptable.
 * `siblings` are the names already present in the target directory; `self` (for a
 * rename) is excluded from the collision check so re-confirming the same name is fine.
 *
 * Collision is case-insensitive — matching how the host filesystem behaves on win32
 * (and harmless elsewhere: two names differing only by case in one folder is a
 * confusing edge the UI is right to block early).
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
 * Reconcile a fresh on-disk listing of `dirPath` (its immediate `entries`) against
 * the `existing` nodes already shown for that directory.
 *
 * - New entries (appeared on disk) are added as collapsed, unloaded nodes.
 * - Removed entries (gone from disk) are dropped.
 * - Surviving entries keep their identity: a still-present directory retains its
 *   `expanded` flag and its previously-loaded `children`, so a refresh never
 *   collapses the tree or throws away deeper reads.
 * - A name that changed kind (file ⇄ dir) is treated as a fresh node.
 *
 * The result follows the order of `entries` (the host already sorts dirs-first),
 * so newly-created files land in their sorted position.
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
      return old; // preserve expansion + loaded children
    }
    return {
      name: e.name,
      path: joinPath(dirPath, e.name),
      kind: e.kind,
      expanded: false,
    };
  });
}

/**
 * Apply a fresh listing for `dirPath` to the whole tree, finding the matching node
 * (or the root level when `dirPath === rootPath`) and merging in place. Expansion
 * state elsewhere in the tree is untouched.
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
        return { ...n, expanded: true, children: mergeEntries(n.children, dirPath, entries) };
      }
      if (n.children) return { ...n, children: recurse(n.children) };
      return n;
    });
  return recurse(roots);
}

/**
 * Every directory path currently loaded in the tree that a refresh should re-read:
 * the root plus every expanded directory that already has children. Re-reading just
 * these keeps a refresh cheap (we don't eagerly walk unopened folders) while still
 * surfacing additions/removals anywhere the user can currently see.
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
 * The chain of directory paths that must be loaded/expanded to make `filePath`
 * visible in the tree: `rootPath` first, then each intermediate directory down to
 * (and including) the file's immediate parent. Built with the same `joinPath` shape
 * the tree uses for child nodes so the paths compare equal to `TreeNode.path`.
 *
 * Returns `[]` when `filePath` is not under `rootPath` (nothing to reveal here).
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
  const dirSegments = segments.slice(0, -1); // drop the file name itself
  const chain = [rootPath];
  let cur = rootPath.replace(/[\\/]+$/, '');
  for (const seg of dirSegments) {
    cur = joinPath(cur, seg);
    chain.push(cur);
  }
  return chain;
}

/**
 * Returns true when the search query string is considered "active" — meaning it
 * has non-whitespace content and should drive the search results view instead of
 * the file tree. Extracted as a pure predicate so it can be unit-tested.
 */
export function isSearchActive(query: string): boolean {
  return query.trim().length > 0;
}

/**
 * Collapse all directory nodes in the tree (recursively). Returns a new tree
 * without mutating the original. Expand state of unloaded dirs is also set to
 * false so a future readDir triggers correctly.
 */
export function collapseAll(nodes: TreeNode[]): TreeNode[] {
  return nodes.map((n) =>
    n.kind === 'dir'
      ? { ...n, expanded: false, children: n.children ? collapseAll(n.children) : undefined }
      : n,
  );
}

/**
 * Expand all directory nodes that are currently loaded (have children). Does NOT
 * trigger readDir for unloaded folders — only flips the `expanded` flag on nodes
 * that already have children in memory.
 */
export function expandLoaded(nodes: TreeNode[]): TreeNode[] {
  return nodes.map((n) =>
    n.kind === 'dir' && n.children
      ? { ...n, expanded: true, children: expandLoaded(n.children) }
      : n,
  );
}

/**
 * Resolve the target directory for a "New file" or "New folder" button:
 * if a folder is selected, create inside it; otherwise fall back to the project root.
 */
export function resolveCreateTarget(selectedDir: string | null, projectPath: string): string {
  return selectedDir ?? projectPath;
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
 * Build a `Map<relativePath, ChangeKind>` from a flat `ChangeDTO[]` for use as a
 * renderer-only overlay on the Files tree. The map covers:
 *
 * - Every changed file (relative path as the key, normalized to forward slashes).
 * - Every ancestor folder segment of each changed path — a folder is decorated if
 *   any descendant has a change. Folder kind follows the first changed descendant
 *   found (priority: D > M > A > U, via `folderKindForRollup`).
 * - MM precedence: when a path appears staged AND unstaged, the unstaged kind wins.
 */
export function buildChangeMap(changes: ChangeDTO[]): Map<string, ChangeKind> {
  // Normalize to forward slashes so matching against tree node paths (which may
  // use the host separator) is done consistently on the relative side.
  const normalize = (p: string) => p.replace(/\\/g, '/');

  // First pass: collapse any MM duplicates (same path staged + unstaged).
  // Unstaged wins per the precedence rule.
  const fileMap = new Map<string, ChangeKind>();
  for (const c of changes) {
    const p = normalize(c.path);
    const existing = fileMap.get(p);
    if (existing === undefined) {
      fileMap.set(p, c.kind);
    } else {
      // If one entry is staged and another unstaged, prefer unstaged.
      // We detect this by checking whether the new entry would differ.
      if (!c.staged) {
        // The new entry is unstaged — it wins.
        fileMap.set(p, resolveKindPrecedence(existing, c.kind));
      }
      // If both are staged (shouldn't happen) or both unstaged, keep first.
    }
  }

  const out = new Map<string, ChangeKind>(fileMap);

  // Second pass: roll up to ancestor folder segments.
  // Priority for folder kind: D > M > A > U (most alarming visible state).
  const kindPriority: Record<ChangeKind, number> = { D: 3, M: 2, A: 1, U: 0 };
  for (const [filePath, kind] of fileMap) {
    const segments = filePath.split('/');
    // Walk every ancestor prefix (skip the file name itself — last segment).
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
