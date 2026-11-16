// The Files tab for a remote session (plan CON-43 T4): B's session folders as one read-only tree.
// Listings and watches go to B over the link; the local tree's pure helpers do the bookkeeping.
// Parents key this by row id: a watch is bound to one machine and session for its lifetime.

import { type KeyboardEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { folderKey } from '../../src/folder-key';
import type { OpenMode } from '../docs';
import { FileTypeIcon } from '../file-icons';
import {
  applyEntries,
  expandNode,
  findNode,
  nameOf,
  nextVisiblePath,
  parentDir,
  type TreeNode,
} from '../file-tree';
import { IconFolder } from '../icons';
import { MACHINES_STR } from '../machines-strings';
import { listRemoteDir, watchRemote } from '../remote-files-store';
import { type RemoteSessionRow, remoteKeyId } from '../remote-sessions';
import { useSettings } from '../settings';
import { TreeChevron, TreeChevronSpacer } from './tree-chevron';

/** The session's home and roots as browsed folders. A root equal to another by folder key shows once. */
function dedupeFolders(home: string, roots: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of [home, ...roots]) {
    if (p === '') continue;
    const key = folderKey(p);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(p);
  }
  return out;
}

/** Every expanded directory under `nodes`, in tree order. */
function expandedDirs(nodes: TreeNode[]): string[] {
  return nodes.flatMap((n) =>
    n.kind === 'dir' && n.expanded ? [n.path, ...expandedDirs(n.children ?? [])] : [],
  );
}

/** Collapse a directory and drop its loaded children, so expanding it again lists it afresh. */
function collapseForget(nodes: TreeNode[], path: string): TreeNode[] {
  return nodes.map((n) =>
    n.path === path
      ? { ...n, expanded: false, children: undefined }
      : n.children
        ? { ...n, children: collapseForget(n.children, path) }
        : n,
  );
}

/** One listing per folder or directory, keyed by folder and path: a root inside home is its own. */
const slotOf = (folder: string, dir: string): string => JSON.stringify([folder, dir]);
/** Row keys qualified by folder index, so two folders can show the same path without a collision. */
const keyOf = (fi: number, path: string): string => `${fi}:${path}`;

type Item =
  | { kind: 'header'; key: string; fi: number; folder: string; name: string }
  | { kind: 'node'; key: string; fi: number; folder: string; depth: number; node: TreeNode }
  | {
      kind: 'status';
      key: string;
      folder: string;
      depth: number;
      dir: string;
      slot: string;
      status: 'loading' | 'empty' | 'error';
      error: string;
    };

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
  const folderSig = dedupeFolders(row.session.home, row.session.roots).join('\n');
  const folders = useMemo(() => (folderSig === '' ? [] : folderSig.split('\n')), [folderSig]);

  // trees: folder → its roots (undefined until listed). errors and loading: by listing slot.
  const [trees, setTrees] = useState<Record<string, TreeNode[] | undefined>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState<Record<string, true>>({});
  const [focusKey, setFocusKey] = useState<string | null>(null);
  const inFlight = useRef(new Set<string>());
  // A change that lands while a listing is in flight asks for one more listing after it.
  const rerun = useRef(new Set<string>());
  const rowEls = useRef(new Map<string, HTMLElement>());
  const watches = useRef(new Map<string, () => void>());
  const wasOffline = useRef(false);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  // One listing of `dirPath` in `folder`. A reply for a directory collapsed meanwhile is dropped,
  // so a collapsed directory never gets children it would then show without a fresh listing.
  const load = useCallback(
    (folder: string, dirPath: string) => {
      const slot = slotOf(folder, dirPath);
      if (inFlight.current.has(slot)) {
        rerun.current.add(slot);
        return;
      }
      inFlight.current.add(slot);
      setLoading((cur) => ({ ...cur, [slot]: true }));
      const run = async () => {
        do {
          rerun.current.delete(slot);
          const r = await listRemoteDir(machineId, sessionId, dirPath);
          if (!alive.current) break;
          if (r.ok) {
            setErrors(({ [slot]: _cleared, ...rest }) => rest);
            setTrees((cur) => {
              const tree = cur[folder] ?? [];
              if (dirPath !== folder) {
                const node = findNode(tree, dirPath);
                if (!node?.expanded) return cur;
              }
              return { ...cur, [folder]: applyEntries(tree, folder, dirPath, r.entries) };
            });
          } else {
            setErrors((cur) => ({ ...cur, [slot]: r.error }));
          }
        } while (rerun.current.has(slot) && alive.current);
        inFlight.current.delete(slot);
        rerun.current.delete(slot);
        if (alive.current) setLoading(({ [slot]: _done, ...rest }) => rest);
      };
      void run();
    },
    [machineId, sessionId],
  );

  // Every folder is listed when the view appears, and again when the machine comes back from
  // offline (with every expanded directory). A folder that failed waits for its Retry.
  useEffect(() => {
    if (offline) {
      wasOffline.current = true;
      return;
    }
    const reconnect = wasOffline.current;
    wasOffline.current = false;
    for (const folder of folders) {
      const rootSlot = slotOf(folder, folder);
      if (reconnect || (trees[folder] === undefined && !errors[rootSlot] && !loading[rootSlot])) {
        load(folder, folder);
      }
      if (reconnect) {
        for (const dir of expandedDirs(trees[folder] ?? [])) load(folder, dir);
      }
    }
  }, [offline, folders, trees, errors, loading, load]);

  // A watch per folder and per expanded directory. Collapsing a directory drops its watch; going
  // offline releases each held watch exactly once, and coming back re-watches them.
  const watchList = useMemo(
    () =>
      offline
        ? []
        : folders.flatMap((folder) =>
            [folder, ...expandedDirs(trees[folder] ?? [])].map((dir) => ({ folder, dir })),
          ),
    [offline, folders, trees],
  );
  useEffect(() => {
    const want = new Map(watchList.map((w) => [slotOf(w.folder, w.dir), w] as const));
    const held = watches.current;
    for (const [slot, release] of held) {
      if (!want.has(slot)) {
        release();
        held.delete(slot);
      }
    }
    for (const [slot, w] of want) {
      if (held.has(slot)) continue;
      held.set(
        slot,
        watchRemote(`${rowKey}|dir|${slot}`, machineId, sessionId, w.dir, () =>
          load(w.folder, w.dir),
        ),
      );
    }
  }, [watchList, rowKey, load, machineId, sessionId]);
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
      setTrees((cur) => ({ ...cur, [folder]: collapseForget(cur[folder] ?? [], node.path) }));
      return;
    }
    setTrees((cur) => ({ ...cur, [folder]: expandNode(cur[folder] ?? [], node.path) }));
    if (node.children === undefined) load(folder, node.path);
  };

  // The visible rows, depth first, one header per folder. Status lines are not keyboard stops.
  const items: Item[] = offline
    ? []
    : folders.flatMap((folder, fi): Item[] => {
        const header: Item = {
          kind: 'header',
          key: keyOf(fi, folder),
          fi,
          folder,
          name: nameOf(folder),
        };
        const rootSlot = slotOf(folder, folder);
        const tree = trees[folder];
        const rootStatus = (status: 'loading' | 'empty' | 'error', error = ''): Item => ({
          kind: 'status',
          key: `${fi}:status:${rootSlot}`,
          folder,
          depth: 0,
          dir: folder,
          slot: rootSlot,
          status,
          error,
        });
        if (tree === undefined) {
          const err = errors[rootSlot];
          return [header, err !== undefined ? rootStatus('error', err) : rootStatus('loading')];
        }
        const rootErr = errors[rootSlot];
        const body = (nodes: TreeNode[], depth: number): Item[] =>
          nodes.flatMap((node): Item[] => {
            const row: Item = { kind: 'node', key: keyOf(fi, node.path), fi, folder, depth, node };
            if (node.kind !== 'dir' || !node.expanded) return [row];
            const slot = slotOf(folder, node.path);
            const statusLine = (status: 'loading' | 'error', error = ''): Item => ({
              kind: 'status',
              key: `${fi}:status:${slot}`,
              folder,
              depth: depth + 1,
              dir: node.path,
              slot,
              status,
              error,
            });
            const err = errors[slot];
            const under: Item[] = node.children
              ? body(node.children, depth + 1)
              : loading[slot]
                ? [statusLine('loading')]
                : [];
            const failed: Item[] = err !== undefined ? [statusLine('error', err)] : [];
            return [row, ...under, ...failed];
          });
        const top: Item[] =
          rootErr !== undefined
            ? [rootStatus('error', rootErr)]
            : tree.length === 0
              ? [rootStatus('empty')]
              : [];
        return [header, ...top, ...body(tree, 0)];
      });

  const order = items.flatMap((i) => (i.kind === 'status' ? [] : [i.key]));
  const roving = focusKey !== null && order.includes(focusKey) ? focusKey : (order[0] ?? null);
  const byKey = new Map(items.map((i) => [i.key, i] as const));

  const focusItem = (key: string) => {
    setFocusKey(key);
    rowEls.current.get(key)?.focus();
  };

  const onTreeKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (roving === null) return;
    const item = byKey.get(roving);
    if (!item || item.kind === 'status') return;
    const move = (dir: 'up' | 'down' | 'first' | 'last') => {
      const next = nextVisiblePath(order, roving, dir);
      if (next) focusItem(next);
    };
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      move('down');
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      move('up');
    } else if (e.key === 'Home') {
      e.preventDefault();
      move('first');
    } else if (e.key === 'End') {
      e.preventDefault();
      move('last');
    } else if (e.key === 'ArrowRight') {
      if (item.kind === 'node' && item.node.kind === 'dir' && !item.node.expanded) {
        e.preventDefault();
        toggle(item.node);
      } else if (item.kind === 'header' || (item.kind === 'node' && item.node.kind === 'dir')) {
        e.preventDefault();
        move('down');
      }
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault();
      if (item.kind === 'node' && item.node.kind === 'dir' && item.node.expanded) {
        toggle(item.node);
      } else if (item.kind === 'node') {
        // A top-level row's parent is its folder's header; a deeper row's is its directory.
        const up =
          item.depth === 0
            ? keyOf(item.fi, item.folder)
            : keyOf(item.fi, parentDir(item.node.path));
        if (byKey.has(up)) focusItem(up);
      }
    } else if (e.key === 'Enter' || e.key === ' ') {
      if (item.kind !== 'node') return;
      e.preventDefault();
      if (item.node.kind === 'dir') toggle(item.node);
      else onOpenFile?.(item.node.path, 'permanent');
    }
  };

  const retry = (folder: string, dir: string) => load(folder, dir);

  return (
    <div className="remote-files">
      {offline ? (
        <p className="remote-files__note" role="status">
          {MACHINES_STR.filesOffline(row.machineName)}
        </p>
      ) : (
        <div
          className="remote-files__tree"
          role="tree"
          aria-label={MACHINES_STR.filesTree(row.machineName)}
          onKeyDown={onTreeKeyDown}
        >
          {items.map((item) => {
            if (item.kind === 'header') {
              return (
                <div
                  key={item.key}
                  ref={(el) => setRowEl(item.key, el)}
                  className="remote-files__head"
                  role="treeitem"
                  aria-level={1}
                  aria-expanded={true}
                  tabIndex={item.key === roving ? 0 : -1}
                  title={item.folder}
                  onClick={() => focusItem(item.key)}
                >
                  <bdi dir="ltr" className="remote-files__name">
                    {item.name}
                  </bdi>
                </div>
              );
            }
            if (item.kind === 'status') {
              return (
                <div
                  key={item.key}
                  className={`remote-files__status${item.status === 'error' ? ' remote-files__status--error' : ''}`}
                  role="treeitem"
                  aria-level={item.depth + 2}
                  aria-selected={false}
                  tabIndex={-1}
                  style={{ paddingInlineStart: `calc(${item.depth} * var(--remote-files-step))` }}
                >
                  <span>
                    {item.status === 'loading'
                      ? MACHINES_STR.filesLoading
                      : item.status === 'empty'
                        ? MACHINES_STR.filesEmpty
                        : MACHINES_STR.paneError(item.error)}
                  </span>
                  {item.status === 'error' ? (
                    <button
                      type="button"
                      className="btn btn--sm"
                      onClick={() => retry(item.folder, item.dir)}
                    >
                      {MACHINES_STR.filesRetry}
                    </button>
                  ) : null}
                </div>
              );
            }
            const { node } = item;
            const isDir = node.kind === 'dir';
            return (
              <div
                key={item.key}
                ref={(el) => setRowEl(item.key, el)}
                className={`remote-files__row${node.ignored ? ' remote-files__row--ignored' : ''}`}
                role="treeitem"
                aria-level={item.depth + 2}
                aria-expanded={isDir ? node.expanded : undefined}
                tabIndex={item.key === roving ? 0 : -1}
                style={{ paddingInlineStart: `calc(${item.depth} * var(--remote-files-step))` }}
                onClick={() => {
                  setFocusKey(item.key);
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
              </div>
            );
          })}
        </div>
      )}
    </div>
  );

  function setRowEl(key: string, el: HTMLElement | null) {
    if (el) rowEls.current.set(key, el);
    else rowEls.current.delete(key);
  }
}
