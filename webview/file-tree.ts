// Pure file-tree logic for the Explorer, kept out of the React component so the
// reconciliation and refetch decisions have a single, unit-tested source of truth.
//
// The Explorer reads a directory's entries from the host (`readDir` → `dirEntries`).
// On the very first read of a directory we build fresh nodes; on a *refresh* (e.g.
// the window regained focus and an external tool wrote files) we must reconcile the
// new on-disk listing into the existing tree WITHOUT discarding which directories
// the user had expanded or their already-loaded children. `mergeEntries` does that.

import type { DirEntryDTO } from '../src/protocol';

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
