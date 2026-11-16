// The Files tab for a remote session (plan CON-43 T4): B's session folders as a read-only tree.
// Listings and watches go to B over the link; the local tree's pure helpers do the bookkeeping, so a
// re-list keeps the user's expansion. Parents key this by row id: a watch is bound to one machine
// and session for its lifetime.

import { type KeyboardEvent, useCallback, useEffect, useRef, useState } from 'react';
import type { OpenMode } from '../docs';
import { FileTypeIcon } from '../file-icons';
import {
  applyEntries,
  collapseNode,
  expandNode,
  findNode,
  nameOf,
  nextVisiblePath,
  parentDir,
  type TreeNode,
  visibleOrder,
} from '../file-tree';
import { IconFolder } from '../icons';
import { MACHINES_STR } from '../machines-strings';
import { listRemoteDir, watchRemote } from '../remote-files-store';
import { type RemoteSessionRow, remoteKeyId } from '../remote-sessions';
import { useSettings } from '../settings';
import { TreeChevron, TreeChevronSpacer } from './tree-chevron';

/** Folders the owner can browse: the session's home and roots, each once. */
function remoteFolders(home: string, roots: readonly string[]): string[] {
  return [...new Set([home, ...roots].filter((p) => p !== ''))];
}

/** Every expanded directory under `nodes`, in tree order. */
function expandedDirs(nodes: TreeNode[]): string[] {
  return nodes.flatMap((n) =>
    n.kind === 'dir' && n.expanded ? [n.path, ...expandedDirs(n.children ?? [])] : [],
  );
}

type Item =
  | { kind: 'node'; folder: string; depth: number; node: TreeNode }
  | { kind: 'status'; folder: string; dir: string; depth: number; error: string | null };

/** The visible rows of one folder's tree, with a status row under each expanded directory. */
function flatten(
  folder: string,
  nodes: TreeNode[],
  depth: number,
  status: (dir: string) => { loading: boolean; error: string | null },
): Item[] {
  return nodes.flatMap((node): Item[] => {
    const row: Item = { kind: 'node', folder, depth, node };
    if (node.kind !== 'dir' || !node.expanded) return [row];
    const { loading, error } = status(node.path);
    const children = node.children
      ? flatten(folder, node.children, depth + 1, status)
      : loading
        ? [{ kind: 'status' as const, folder, dir: node.path, depth: depth + 1, error: null }]
        : [];
    const failed =
      error !== null
        ? [{ kind: 'status' as const, folder, dir: node.path, depth: depth + 1, error }]
        : [];
    return [row, ...children, ...failed];
  });
}

export function RemoteFilesView({
  row,
  onOpenFile,
}: {
  row: RemoteSessionRow;
  /** Absent: the tree browses but opening a file is unavailable. */
  onOpenFile?: (path: string, mode: OpenMode) => void;
}) {
  const { settings } = useSettings();
  const { machineId, sessionId } = row.key;
  const rowKey = remoteKeyId(row.key);
  const offline = row.machineState !== 'up' && row.machineState !== 'degraded';
  const folders = remoteFolders(row.session.home, row.session.roots);
  const folderSig = folders.join('\n');

  // trees: folder → its roots (undefined until listed). errors and loading: by directory path.
  const [trees, setTrees] = useState<Record<string, TreeNode[] | undefined>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState<Record<string, true>>({});
  const [focusPath, setFocusPath] = useState<string | null>(null);
  const inFlight = useRef(new Set<string>());
  const rowEls = useRef(new Map<string, HTMLElement>());
  const watches = useRef(new Map<string, () => void>());
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  // One listing of `dirPath` (a folder itself, or a directory inside it). A reply that arrives
  // after the view has gone is dropped; a failure stays on the directory until Retry.
  const load = useCallback(
    (folder: string, dirPath: string) => {
      if (inFlight.current.has(dirPath)) return;
      inFlight.current.add(dirPath);
      setLoading((cur) => ({ ...cur, [dirPath]: true }));
      void listRemoteDir(machineId, sessionId, dirPath).then((r) => {
        inFlight.current.delete(dirPath);
        if (!alive.current) return;
        setLoading(({ [dirPath]: _done, ...rest }) => rest);
        if (!r.ok) {
          setErrors((cur) => ({ ...cur, [dirPath]: r.error }));
          return;
        }
        setErrors(({ [dirPath]: _cleared, ...rest }) => rest);
        setTrees((cur) => ({
          ...cur,
          [folder]: applyEntries(cur[folder] ?? [], folder, dirPath, r.entries),
        }));
      });
    },
    [machineId, sessionId],
  );

  // Each folder is listed once when the view appears (or the machine comes back); a failed one
  // waits for Retry rather than retrying on every render.
  useEffect(() => {
    if (offline) return;
    for (const folder of folderSig.split('\n')) {
      if (trees[folder] === undefined && !errors[folder]) load(folder, folder);
    }
  }, [offline, folderSig, trees, errors, load]);

  // A watch per folder and per expanded directory. Each re-lists its directory on any change.
  // Folder and directory joined per line, so the effect reads the list from one string dependency.
  const watchSig = offline
    ? ''
    : folders
        .flatMap((folder) =>
          [folder, ...expandedDirs(trees[folder] ?? [])].map((dir) => [folder, dir]),
        )
        .map(([folder, dir]) => `${folder}\u0000${dir}`)
        .join('\n');
  useEffect(() => {
    const want = new Map<string, string>(
      watchSig === ''
        ? []
        : watchSig.split('\n').map((line) => {
            const at = line.indexOf('\u0000');
            return [line.slice(at + 1), line.slice(0, at)];
          }),
    );
    const held = watches.current;
    for (const [dir, release] of held) {
      if (!want.has(dir)) {
        release();
        held.delete(dir);
      }
    }
    for (const [dir, folder] of want) {
      if (held.has(dir)) continue;
      held.set(
        dir,
        watchRemote(`${rowKey}|dir|${dir}`, machineId, sessionId, dir, () => load(folder, dir)),
      );
    }
  }, [watchSig, rowKey, load, machineId, sessionId]);
  useEffect(() => {
    const held = watches.current;
    return () => {
      for (const release of held.values()) release();
      held.clear();
    };
  }, []);

  const folderOf = (dir: string): string | undefined =>
    folders.find((f) => findNode(trees[f] ?? [], dir) !== undefined);

  const toggle = (node: TreeNode) => {
    const folder = folderOf(node.path);
    if (folder === undefined) return;
    if (node.expanded) {
      setTrees((cur) => ({ ...cur, [folder]: collapseNode(cur[folder] ?? [], node.path) }));
      return;
    }
    setTrees((cur) => ({ ...cur, [folder]: expandNode(cur[folder] ?? [], node.path) }));
    if (node.children === undefined) load(folder, node.path);
  };

  const focusRow = (path: string) => {
    setFocusPath(path);
    rowEls.current.get(path)?.focus();
  };

  const items = folders.flatMap((folder) =>
    flatten(folder, trees[folder] ?? [], 0, (dir) => ({
      loading: loading[dir] === true,
      error: errors[dir] ?? null,
    })),
  );
  const order = folders.flatMap((f) => visibleOrder(trees[f] ?? []));
  const roving = focusPath !== null && order.includes(focusPath) ? focusPath : (order[0] ?? null);

  const onTreeKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (roving === null) return;
    const node = findAnyNode(trees, folders, roving);
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const next = nextVisiblePath(order, roving, e.key === 'ArrowDown' ? 'down' : 'up');
      if (next) focusRow(next);
    } else if (e.key === 'Home' || e.key === 'End') {
      e.preventDefault();
      const next = nextVisiblePath(order, roving, e.key === 'Home' ? 'first' : 'last');
      if (next) focusRow(next);
    } else if (e.key === 'ArrowRight' && node?.kind === 'dir') {
      e.preventDefault();
      if (node.expanded) {
        const next = nextVisiblePath(order, roving, 'down');
        if (next) focusRow(next);
      } else toggle(node);
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault();
      if (node?.kind === 'dir' && node.expanded) toggle(node);
      else {
        const up = parentDir(roving);
        if (order.includes(up)) focusRow(up);
      }
    } else if ((e.key === 'Enter' || e.key === ' ') && node) {
      e.preventDefault();
      if (node.kind === 'dir') toggle(node);
      else onOpenFile?.(node.path, 'permanent');
    }
  };

  return (
    <div className="remote-files">
      {offline ? (
        <p className="remote-files__note" role="status">
          {MACHINES_STR.filesOffline(row.machineName)}
        </p>
      ) : (
        folders.map((folder) => (
          <section key={folder} className="remote-files__section">
            <header className="remote-files__head" title={folder}>
              <bdi dir="ltr" className="remote-files__name">
                {nameOf(folder)}
              </bdi>
            </header>
            {folderBody(folder)}
          </section>
        ))
      )}
    </div>
  );

  function folderBody(folder: string) {
    const tree = trees[folder];
    const rootError = errors[folder];
    if (tree === undefined) {
      if (rootError === undefined) {
        return (
          <p className="remote-files__status" role="status" aria-live="polite">
            {MACHINES_STR.filesLoading}
          </p>
        );
      }
      return (
        <div className="remote-files__status remote-files__status--error" role="status">
          <span>{MACHINES_STR.paneError(rootError)}</span>
          <button type="button" className="btn btn--sm" onClick={() => load(folder, folder)}>
            {MACHINES_STR.filesRetry}
          </button>
        </div>
      );
    }
    return (
      <div
        className="remote-files__tree"
        role="tree"
        aria-label={MACHINES_STR.filesTree}
        onKeyDown={onTreeKeyDown}
      >
        {tree.length === 0 ? (
          <p className="remote-files__status" role="status">
            {MACHINES_STR.filesEmpty}
          </p>
        ) : null}
        {items.filter((item) => item.folder === folder).flatMap((item) => renderItem(item))}
      </div>
    );
  }

  function renderItem(item: Item) {
    // Depth is the row's indent: a token-sized step per level, so the step lives in the stylesheet.
    const indent = { paddingInlineStart: `calc(${item.depth} * var(--remote-files-step))` };
    if (item.kind === 'status') {
      const { dir, folder, error } = item;
      return [
        <div
          key={`status:${dir}`}
          className={`remote-files__status${error ? ' remote-files__status--error' : ''}`}
          role="status"
          style={indent}
        >
          {error === null ? (
            <span>{MACHINES_STR.filesLoading}</span>
          ) : (
            <>
              <span>{MACHINES_STR.paneError(error)}</span>
              <button type="button" className="btn btn--sm" onClick={() => load(folder, dir)}>
                {MACHINES_STR.filesRetry}
              </button>
            </>
          )}
        </div>,
      ];
    }
    const { node } = item;
    const isDir = node.kind === 'dir';
    return [
      <div
        key={node.path}
        ref={(el) => {
          if (el) rowEls.current.set(node.path, el);
          else rowEls.current.delete(node.path);
        }}
        className={`remote-files__row${node.ignored ? ' remote-files__row--ignored' : ''}`}
        role="treeitem"
        aria-level={item.depth + 1}
        aria-expanded={isDir ? node.expanded : undefined}
        tabIndex={node.path === roving ? 0 : -1}
        style={indent}
        onClick={() => {
          setFocusPath(node.path);
          if (isDir) toggle(node);
          else onOpenFile?.(node.path, 'preview');
        }}
        onDoubleClick={() => {
          if (!isDir) onOpenFile?.(node.path, 'permanent');
        }}
      >
        {isDir ? <TreeChevron open={node.expanded} /> : <TreeChevronSpacer />}
        {isDir ? (
          <IconFolder size={13} className="remote-files__icon" />
        ) : (
          <FileTypeIcon
            name={node.name}
            pack={settings.iconPack}
            size={13}
            className="remote-files__icon"
          />
        )}
        <span className="remote-files__label">{node.name}</span>
      </div>,
    ];
  }
}

function findAnyNode(
  trees: Record<string, TreeNode[] | undefined>,
  folders: readonly string[],
  path: string,
): TreeNode | undefined {
  for (const f of folders) {
    const found = findNode(trees[f] ?? [], path);
    if (found) return found;
  }
  return undefined;
}
