import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { type DeleteOutcome, deleteOutcomeAnnouncement } from '../../src/delete-confirm';
import { dropIntent, topLevelPaths } from '../../src/drop-intent';
import { folderKey } from '../../src/folder-key';
import { countNoun } from '../../src/menu-selection';
import { isAncestorOf } from '../../src/owning-session';
import type { ChangeKind } from '../../src/protocol';
import type { FolderSectionModel } from '../../src/session-sections';
import { fsMutate, post, subscribe } from '../bridge';
import type { OpenMode } from '../docs';
import { buildExplorerMenuItems, resolveExplorerTargets } from '../explorer-menu';
import { FileTypeIcon } from '../file-icons';
import {
  ancestorDirChain,
  applyEntries,
  collapseAll,
  collapseNode,
  expandNode,
  findNode,
  joinPath,
  nameOf,
  nearestSurvivor,
  nextVisiblePath,
  parentDir,
  pathsToRefresh,
  renameSelectionRange,
  resolveCreateTarget,
  type TreeNode,
  treeNodePath,
  validateName,
  visibleOrder,
} from '../file-tree';
import {
  activePath,
  clearSelection,
  EMPTY_SELECTION,
  reconcile,
  type SelectionState,
  selectAll,
  selectMany,
  selectOne,
  selectRange,
  toggle as toggleSelection,
} from '../file-tree-selection';
import type { FsOp } from '../fs-undo';
import { IconChevron, IconFolder, IconPlus } from '../icons';
import { middleClickProps } from '../middle-click';
import { useSettings } from '../settings';
import { TERMINAL_PATH_MIME } from '../terminal-drop';
import { pushToast } from '../toast-store';
import { computeSectionWindow } from '../tree-window';
import type { MenuState } from './context-menu';
import { EmptyState } from './empty-state';
import { FolderBar } from './folder-bar';

// Rows mounted above/below the viewport to absorb fling without mounting the whole tree.
const OVERSCAN_ROWS = 8;
// The roving-focus movement keys, shared by the unmodified, Shift (extend) and Ctrl (preserve)
// forms so all three move focus identically.
const MOVE_KEYS: Record<string, 'up' | 'down' | 'first' | 'last' | undefined> = {
  ArrowDown: 'down',
  ArrowUp: 'up',
  Home: 'first',
  End: 'last',
};

/**
 * A transient inline edit in the tree (L2). `create` shows an empty editable row in
 * `dir` (for a new file or folder); `rename` swaps an existing row's label for a
 * prefilled input. The draft holds the typed `name` and a UI-side validation `error`.
 */
type Draft =
  | { mode: 'create'; kind: 'file' | 'dir'; dir: string; name: string; error: string | null }
  | {
      mode: 'rename';
      kind: 'file' | 'dir';
      path: string;
      dir: string;
      name: string;
      error: string | null;
    };

export interface FolderSectionHandle {
  /** Expands the section first when collapsed. */
  revealInTree(absPath: string): void;
  refreshAll(): void;
  refreshDir(dir: string): void;
  selectMany(paths: string[]): void;
  /** The bar's chevron button. */
  focusCollapse(): void;
  /** For the pane's conflict prompt, which names what already sits at the destination. */
  nodeAt(path: string): TreeNode | undefined;
  /** The pane's empty space (below every section) acts on the home section. */
  openRootMenu(at: { x: number; y: number }): void;
  clearSelection(): void;
}

export interface FilesPaneApi {
  draggedPaths: readonly string[];
  dropTargetPath: string | null;
  committing: boolean;
  hasClipboard: boolean;
  setDropTarget(path: string | null): void;
  startDrag(paths: string[], e: React.DragEvent): void;
  endDrag(): void;
  dropInternal(
    sources: string[],
    targetDir: string,
    modifiers: { ctrl?: boolean; shift?: boolean; alt?: boolean },
  ): void;
  dropOs(e: React.DragEvent, targetDir: string): void;
  cut(paths: string[]): void;
  copy(paths: string[]): void;
  paste(targetDir: string): void;
  clearClipboard(): void;
  announce(msg: string): void;
  /** Brings the row at this absolute content offset of the shared scroller into view. */
  scrollTo(top: number): void;
  openFolderMenu(
    section: FolderSectionModel,
    at: { x: number; y: number; keyboard: boolean },
  ): void;
}

export interface FolderSectionProps {
  /** Never missing. */
  section: FolderSectionModel;
  pane: FilesPaneApi;
  view: { scrollTop: number; viewportHeight: number; rowHeight: number };
  collapsed: boolean;
  onToggleCollapsed: () => void;
  treeCache: Map<string, TreeNode[]>;
  rowChanges: ReadonlyMap<string, ChangeKind>;
  openAsSessionHint?: string;
  onPerf: (key: string, counts: { mountedRowCount: number; totalRowCount: number }) => void;
  handleRef: (h: FolderSectionHandle | null) => void;
  onOpenFile: (absPath: string, mode?: OpenMode) => void;
  onContextPath?: (absPath: string) => void;
  setMenu: (m: MenuState | null) => void;
  revealPath: (path: string) => void;
  openExternalApp: (path: string) => void;
  openWithChooser: (path: string) => void;
  openAsSession: (dir: string) => void;
  copyToClipboard: (text: string) => void;
  onDelete: (
    nodes: { path: string; kind: 'dir' | 'file' }[],
    afterDeleted: (outcome: DeleteOutcome) => void,
  ) => void;
  onRenamed: (fromPath: string, toPath: string) => void;
  recordFsOp?: (op: FsOp) => void;
}

/** True when the drag carries OS files (from Explorer/Finder), not a tree node. */
export const isOsFileDrag = (e: React.DragEvent) => e.dataTransfer.types.includes('Files');

/** Effective destination FOLDER for a drop on `node`: a dir targets itself, a file its parent. */
const dropFolderFor = (node: { path: string; kind: 'dir' | 'file' }): string =>
  node.kind === 'dir' ? node.path : parentDir(node.path);

export function FolderSection({
  section,
  pane,
  view,
  collapsed,
  onToggleCollapsed,
  treeCache,
  rowChanges,
  openAsSessionHint,
  onPerf,
  handleRef,
  onOpenFile,
  onContextPath,
  setMenu,
  revealPath,
  openExternalApp,
  openWithChooser,
  openAsSession,
  copyToClipboard,
  onDelete,
  onRenamed,
  recordFsOp,
}: FolderSectionProps) {
  const { settings } = useSettings();
  const root = section.path;
  const key = section.key;
  const treeId = `files-tree-${key.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
  const [roots, setRoots] = useState<TreeNode[]>([]);
  const [loaded, setLoaded] = useState(false);
  // The single active inline draft (create or rename), or null.
  const [draft, setDraft] = useState<Draft | null>(null);
  // Multi-select state (ctrl/cmd toggle + shift range). The anchor (`activePath`) drives the
  // create-target. See docs/specs/2026-06-27-explorer-multiselect.md. Per section (spec §2.2).
  const [selection, setSelection] = useState<SelectionState>(EMPTY_SELECTION);
  // In a ref so the focus-refresh handler reads the current expansion state without
  // re-subscribing as the tree grows.
  const rootsRef = useRef<TreeNode[]>([]);
  rootsRef.current = roots;
  // Roving keyboard focus over the visible rows (the row that owns tabIndex=0).
  const [focusPath, setFocusPath] = useState<string | null>(null);
  const focusPathRef = useRef<string | null>(null);
  focusPathRef.current = focusPath;
  // A deleted focus row + the visible order it was deleted from, until the refresh removes it.
  const focusRescue = useRef<{ order: string[]; gone: string } | null>(null);
  // Spring-loaded folders: a hover timer + the dir it targets + dirs this drag auto-expanded.
  const springTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const springTargetRef = useRef<string | null>(null);
  const springOpened = useRef<Set<string>>(new Set());
  // The file most recently revealed (opened from anywhere) — highlighted in the tree.
  const [revealedPath, setRevealedPath] = useState<string | null>(null);
  // The file the tree is currently expanding toward. A ref so the dirEntries-driven
  // advance reads it without re-subscribing.
  const revealTargetRef = useRef<string | null>(null);
  const collapseRef = useRef<HTMLButtonElement>(null);
  const treeRef = useRef<HTMLDivElement>(null);
  // The tree's first-row offset inside the shared scroller's content (spec §2.2 layout).
  const [sectionTop, setSectionTop] = useState(0);
  const sectionTopRef = useRef(0);
  sectionTopRef.current = sectionTop;
  const { rowHeight } = view;
  const rowHeightRef = useRef(rowHeight);
  rowHeightRef.current = rowHeight;

  // Runs every render, writing only on a change: an earlier section growing moves this one
  // without re-rendering it, and the pane re-renders every section when any of them resizes.
  useLayoutEffect(() => {
    const el = treeRef.current;
    const scroller = el?.closest<HTMLElement>('.right__scroll--files');
    if (!el || !scroller) return;
    const top =
      el.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop;
    if (Math.abs(top - sectionTopRef.current) > 0.5) setSectionTop(top);
  });

  const scrollPathIntoView = useCallback(
    (p: string) => {
      const idx = visibleOrder(rootsRef.current).indexOf(p);
      if (idx < 0) return;
      pane.scrollTo(sectionTopRef.current + idx * rowHeightRef.current);
    },
    [pane],
  );

  // Restore this folder's cached tree (expansion + loaded children) and stash it on the way
  // out, so a session switch, a Files↔Changes toggle or a missing→present flip keeps it. A
  // restore still re-reads in the background (applyEntries preserves expansion).
  useEffect(() => {
    const cached = treeCache.get(key);
    setSelection(EMPTY_SELECTION);
    if (cached && cached.length > 0) {
      setRoots(cached);
      setLoaded(true);
      for (const dir of pathsToRefresh(cached, root)) post({ type: 'readDir', path: dir });
    } else {
      setRoots([]);
      setLoaded(false);
      post({ type: 'readDir', path: root });
    }
    return () => {
      if (rootsRef.current.length > 0) treeCache.set(key, rootsRef.current);
    };
  }, [key, root, treeCache]);

  useEffect(() => {
    return subscribe((msg) => {
      if (msg.type !== 'dirEntries' || !isAncestorOf(key, folderKey(msg.path))) return;
      if (msg.path === root) setLoaded(true);
      setRoots((prev) => applyEntries(prev, root, msg.path, msg.entries));
    });
  }, [key, root]);

  // Prune the selection whenever the visible tree changes (collapse, refresh, rename, delete,
  // drag-move) so it never references vanished rows. reconcile returns the same reference when
  // nothing changed, so this never loops. See spec §3.
  useEffect(() => {
    const order = visibleOrder(roots);
    setSelection((s) => reconcile(s, order));
    // The delete's own refresh is what makes the row vanish, so the rescue lands here rather
    // than at delete time (selection-aware-context-menus spec §12).
    const rescue = focusRescue.current;
    if (rescue && !order.includes(rescue.gone)) {
      focusRescue.current = null;
      setFocusPath(nearestSurvivor(rescue.order, rescue.gone, new Set(order)));
    }
  }, [roots]);

  // Reveal a file in the explorer. Walks the ancestor chain top-down — one unit of
  // progress per call (load OR expand one ancestor); the dirEntries reply re-drives this
  // via the roots effect below until the whole chain is present, then highlights + scrolls.
  const advanceReveal = useCallback(() => {
    const target = revealTargetRef.current;
    if (!target) return;
    const chain = ancestorDirChain(target, root);
    if (chain.length === 0) return; // not under this folder (yet) — wait or skip
    for (const dir of chain) {
      if (dir === root) {
        if (rootsRef.current.length === 0) return; // root not loaded yet — wait for it
        continue;
      }
      const node = findNode(rootsRef.current, dir);
      if (!node?.children) {
        post({ type: 'readDir', path: dir }); // parent is loaded (we got here) → this lands
        return;
      }
      if (!node.expanded) setRoots((prev) => expandNode(prev, dir));
    }
    revealTargetRef.current = null;
    // Re-derived, not matched as given: a host path and a tree node path differ in separator
    // form (see treeNodePath). Reveal is not selection (spec §3, D4), so only the highlight moves.
    setRevealedPath(treeNodePath(target, root) ?? target);
  }, [root]);
  // `roots` is a re-trigger (not read here) — each tree growth re-drives the in-progress reveal.
  // biome-ignore lint/correctness/useExhaustiveDependencies: roots drives the re-run, not the body
  useEffect(() => {
    if (revealTargetRef.current) advanceReveal();
  }, [roots, advanceReveal]);

  // Scroll the revealed row into view AFTER it commits: it is pinned into the window (see
  // `pins`), so this always finds a mounted row. Nudge the shared scroller first, then let the
  // browser refine to the exact position.
  // biome-ignore lint/correctness/useExhaustiveDependencies: only re-run when the target changes
  useLayoutEffect(() => {
    if (!revealedPath) return;
    const el = treeRef.current;
    if (!el) return;
    scrollPathIntoView(revealedPath);
    for (const rowEl of el.querySelectorAll<HTMLElement>('.filerow')) {
      // Match by dataset rather than a CSS attribute selector — Windows paths carry
      // backslashes that would need escaping inside the selector string.
      if (rowEl.dataset.path === revealedPath) {
        rowEl.scrollIntoView({ block: 'nearest' });
        break;
      }
    }
  }, [revealedPath]);

  // Re-read root + every expanded dir on focus/visibility so files an external
  // tool/agent created or deleted while backgrounded appear on their own (J5).
  useEffect(() => {
    const doRefresh = () => {
      if (document.visibilityState === 'hidden') return;
      for (const dir of pathsToRefresh(rootsRef.current, root)) {
        post({ type: 'readDir', path: dir });
      }
    };
    const onVisibility = () => {
      if (document.visibilityState === 'visible') doRefresh();
    };
    window.addEventListener('focus', doRefresh);
    document.addEventListener('visibilitychange', onVisibility);
    // One fsChanged per watcher fire names every folder it touched (locked L12 B3).
    const unsub = subscribe((msg) => {
      if (msg.type === 'fsChanged' && msg.folders.some((f) => folderKey(f) === key)) doRefresh();
    });
    return () => {
      window.removeEventListener('focus', doRefresh);
      document.removeEventListener('visibilitychange', onVisibility);
      unsub();
    };
  }, [root, key]);

  // Toggle a folder's expansion (loading children on first open).
  const toggleExpand = (node: TreeNode) => {
    if (node.expanded) setRoots((prev) => collapseNode(prev, node.path));
    else if (node.children) setRoots((prev) => expandNode(prev, node.path));
    else {
      // Unloaded: expand now (applyEntries no longer auto-expands) and load its children.
      setRoots((prev) => expandNode(prev, node.path));
      post({ type: 'readDir', path: node.path });
    }
  };

  // Pointer selection (spec §2): plain click selects + activates (open file / toggle folder);
  // Ctrl/Cmd-click toggles membership; Shift-click ranges from the anchor. Modifier clicks are
  // selection-only — they never open a file or expand a folder (VS Code parity).
  const onRowClick = (e: React.MouseEvent, node: TreeNode) => {
    onContextPath?.(node.path); // multi-repo: active repo follows the clicked file/folder
    setFocusPath(node.path); // keep keyboard focus in sync with the pointer
    if (e.shiftKey) {
      setSelection((s) => selectRange(s, node.path, visibleOrder(roots)));
      return;
    }
    if (e.ctrlKey || e.metaKey) {
      setSelection((s) => toggleSelection(s, node.path));
      return;
    }
    setSelection(selectOne(node.path));
    if (node.kind === 'file') onOpenFile(node.path);
    else toggleExpand(node);
  };

  // Loaded immediate child names of `dir`, for UI-side collision validation. Empty if the
  // directory isn't loaded yet.
  const siblingsOf = (dir: string): string[] => {
    if (dir === root) return roots.map((n) => n.name);
    return findNode(roots, dir)?.children?.map((n) => n.name) ?? [];
  };

  // Re-read a directory so applyEntries reconciles the on-disk change (preserving expansion).
  const refreshDir = (dir: string) => {
    if (dir !== root) setRoots((prev) => expandNode(prev, dir));
    post({ type: 'readDir', path: dir });
  };

  const refreshAll = () => {
    for (const dir of pathsToRefresh(rootsRef.current, root)) {
      post({ type: 'readDir', path: dir });
    }
  };

  const clearSpring = useCallback(() => {
    if (springTimer.current) {
      clearTimeout(springTimer.current);
      springTimer.current = null;
    }
    springTargetRef.current = null;
  }, []);

  // Spring-load: hovering a collapsed folder for 600ms during a drag expands it so nested drops
  // are reachable. Re-arms when the hovered dir changes; dirs opened this way are tracked so
  // the drag's end can re-collapse the ones not dropped into.
  const armSpring = (node: TreeNode) => {
    if (node.kind !== 'dir' || node.expanded) {
      clearSpring();
      return;
    }
    if (springTargetRef.current === node.path) return;
    clearSpring();
    springTargetRef.current = node.path;
    springTimer.current = setTimeout(() => {
      springOpened.current.add(node.path);
      setRoots((prev) => expandNode(prev, node.path));
      if (!node.children) post({ type: 'readDir', path: node.path });
      springTimer.current = null;
    }, 600);
  };

  // The drag set is pane-wide and the source row's dragend lands in whichever section started
  // it, so each section re-collapses its own spring-opened dirs when the pane's drag ends.
  const dragging = pane.draggedPaths.length > 0;
  useEffect(() => {
    if (dragging) return;
    const opened = [...springOpened.current];
    if (opened.length > 0) {
      setRoots((prev) => opened.reduce((acc, p) => collapseNode(acc, p), prev));
    }
    springOpened.current.clear();
    clearSpring();
  }, [dragging, clearSpring]);
  // A hover that moved to another section (or off the tree) disarms this one's timer.
  useEffect(() => {
    if (springTargetRef.current && pane.dropTargetPath !== springTargetRef.current) clearSpring();
  }, [pane.dropTargetPath, clearSpring]);

  const onDragStart = (e: React.DragEvent, node: TreeNode) => {
    // Multi-drag: grabbing a row that's part of the selection drags the whole selection;
    // grabbing an unselected row acts on (and selects) just that row.
    const set = selection.selected;
    const multi = set.has(node.path) && set.size > 1;
    if (!multi) setSelection(selectOne(node.path));
    // A terminal accepts a single path reference, not the whole multi-selection.
    e.dataTransfer.setData(TERMINAL_PATH_MIME, node.path);
    pane.startDrag(multi ? [...set] : [node.path], e);
  };

  const onDragOver = (e: React.DragEvent, node: TreeNode) => {
    // Over a row, the row owns the drop target — stop the event before it bubbles to the
    // section/scroller root handlers, which would override this precise folder highlight.
    e.stopPropagation();
    const folder = dropFolderFor(node);
    const { draggedPaths } = pane;
    if (draggedPaths.length === 0 && isOsFileDrag(e)) {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
      pane.setDropTarget(folder);
      armSpring(node);
      return;
    }
    if (draggedPaths.length === 0) return;
    // Only highlight when at least one dragged item can actually land here (else invalid drop).
    const ok = draggedPaths.some((src) =>
      dropIntent({ source: src, targetDir: folder, modifiers: { ctrl: e.ctrlKey } }),
    );
    if (!ok) {
      pane.setDropTarget(null);
      clearSpring();
      return;
    }
    e.preventDefault();
    e.dataTransfer.dropEffect = e.ctrlKey ? 'copy' : 'move';
    pane.setDropTarget(folder);
    armSpring(node);
  };

  const onDrop = (e: React.DragEvent, node: TreeNode) => {
    e.preventDefault();
    e.stopPropagation(); // see onDragOver: keep the drop on this row
    clearSpring();
    const folder = dropFolderFor(node);
    springOpened.current.delete(folder); // a dropped-into dir stays open
    dropOn(e, folder);
  };

  const dropOn = (e: React.DragEvent, folder: string) => {
    if (pane.draggedPaths.length === 0 && (e.dataTransfer.files?.length ?? 0) > 0) {
      pane.setDropTarget(null);
      pane.dropOs(e, folder);
      return;
    }
    const sources =
      pane.draggedPaths.length > 0
        ? [...pane.draggedPaths]
        : topLevelPaths((e.dataTransfer.getData('text/plain') || '').split('\n').filter(Boolean));
    pane.setDropTarget(null);
    if (sources.length === 0) return;
    pane.dropInternal(sources, folder, { ctrl: e.ctrlKey, shift: e.shiftKey, alt: e.altKey });
  };

  // Expand+load a collapsed/unloaded target dir first so the new row appears in context.
  const startCreate = (dir: string, kind: 'file' | 'dir') => {
    if (collapsed) onToggleCollapsed();
    if (dir !== root) refreshDir(dir);
    setDraft({ mode: 'create', kind, dir, name: '', error: null });
  };
  const startRename = (node: { path: string; kind: 'dir' | 'file' }) => {
    const dir = node.path.replace(/[\\/]+$/, '').replace(/[\\/][^\\/]+$/, '');
    setDraft({
      mode: 'rename',
      kind: node.kind,
      path: node.path,
      dir,
      name: nameOf(node.path),
      error: null,
    });
  };
  const cancelDraft = () => setDraft(null);

  // Commit the active draft: re-validate, call the host, refresh + reveal on success,
  // toast on failure. Blur and Escape cancel; only Enter (or a valid commit) lands here.
  const commitDraft = async (d: Draft) => {
    const self = d.mode === 'rename' ? d.name && nameOf(d.path) : undefined;
    const err = validateName(d.name, siblingsOf(d.dir), self ?? undefined);
    if (err) {
      setDraft({ ...d, error: err });
      return;
    }
    const name = d.name.trim();
    const targetPath = joinPath(d.dir, name);
    setDraft(null);
    if (d.mode === 'create') {
      const res = await fsMutate({
        op: d.kind === 'dir' ? 'createDir' : 'createFile',
        path: targetPath,
      });
      if (!res.ok) {
        pushToast({ message: res.error, variant: 'error' });
        return;
      }
      recordFsOp?.({ kind: 'create', path: targetPath, isDir: d.kind === 'dir' });
      refreshDir(d.dir);
      if (d.kind === 'file') onOpenFile(targetPath);
    } else {
      const res = await fsMutate({ op: 'rename', from: d.path, to: targetPath });
      if (!res.ok) {
        pushToast({ message: res.error, variant: 'error' });
        return;
      }
      recordFsOp?.({ kind: 'rename', from: d.path, to: targetPath });
      refreshDir(d.dir);
      if (d.kind === 'file') onRenamed(d.path, targetPath);
    }
  };

  const relToRoot = (abs: string) =>
    abs.replace(root.replace(/[\\/]+$/, ''), '').replace(/^[\\/]+/, '');

  // Every target is acted on, per kind — files open, folders expand, exactly as Enter does
  // (spec §4.2). Multiple files open as permanent tabs: a preview tab replaces in place, so N
  // previews would leave one tab and silently discard the rest (§15).
  const openTargets = (paths: string[]) => {
    const mode: OpenMode | undefined = paths.length > 1 ? 'permanent' : undefined;
    for (const p of paths) {
      const node = findNode(rootsRef.current, p);
      if (node?.kind === 'dir') {
        setRoots((prev) => expandNode(prev, p));
        if (!node.children) post({ type: 'readDir', path: p });
      } else onOpenFile(p, mode);
    }
  };

  /** Refresh each affected parent once, rescue the focus row, and announce (spec §4.3 step 5). */
  const applyDeleteOutcome = (outcome: DeleteOutcome) => {
    const gone = focusPathRef.current;
    if (gone && outcome.deleted.includes(gone)) {
      focusRescue.current = { order: visibleOrder(rootsRef.current), gone };
    }
    for (const dir of new Set(outcome.deleted.map(parentDir))) refreshDir(dir);
    const msg = deleteOutcomeAnnouncement(outcome.deleted.length, outcome.failed.length);
    if (msg) pane.announce(msg);
  };

  const deleteTargets = (paths: string[]) => {
    const nodes = paths.map((p) => ({
      path: p,
      // A target that vanished from the tree still gets its removal attempted (spec §6); the
      // kind only decides whether an open doc tab is closed.
      kind: findNode(rootsRef.current, p)?.kind ?? ('file' as const),
    }));
    onDelete(nodes, applyDeleteOutcome);
  };

  const openMenu = (e: React.MouseEvent, node: { path: string; kind: 'dir' | 'file' }) => {
    e.preventDefault();
    e.stopPropagation();
    // Tree order, so clipboard writes and the delete loop follow the tree the user is looking at.
    const ordered = visibleOrder(roots).filter((p) => selection.selected.has(p));
    const { targets, collapse } = resolveExplorerTargets(ordered, node.path);
    if (collapse) setSelection(selectOne(node.path));
    setMenu({
      x: e.clientX,
      y: e.clientY,
      items: buildExplorerMenuItems({
        node,
        targets,
        targetDir: dropFolderFor(node),
        hasClipboard: pane.hasClipboard,
        relativePath: relToRoot,
        onOpen: openTargets,
        onOpenExternally: openExternalApp,
        onOpenWith: openWithChooser,
        onNewFile: (dir) => startCreate(dir, 'file'),
        onNewFolder: (dir) => startCreate(dir, 'dir'),
        onRename: startRename,
        onCut: pane.cut,
        onCopy: pane.copy,
        onPaste: pane.paste,
        onCopyText: copyToClipboard,
        onReveal: revealPath,
        onOpenAsSession: openAsSession,
        onDelete: deleteTargets,
        openAsSessionHint,
      }),
    });
  };

  // Create-target derives from the active item (anchor): active dir → itself, active file →
  // its parent, none → the folder root (Decision D1). `?? null` collapses an anchor that is no
  // longer in the tree to the empty case.
  const active = activePath(selection);
  const activeNode = active ? (findNode(roots, active) ?? null) : null;
  const createTarget = resolveCreateTarget(
    activeNode ? { path: activeNode.path, kind: activeNode.kind } : null,
    root,
  );

  const openRootMenu = (at: { x: number; y: number }) => {
    const target = createTarget;
    setMenu({
      x: at.x,
      y: at.y,
      items: [
        {
          label: 'New file…',
          icon: <IconPlus size={14} />,
          onClick: () => startCreate(target, 'file'),
        },
        {
          label: 'New folder…',
          icon: <IconFolder size={14} />,
          onClick: () => startCreate(target, 'dir'),
        },
      ],
    });
  };

  // The row that owns keyboard focus (roving tabindex). Falls back to the active/anchor row,
  // then the first visible row so Tab can always reach the tree.
  const rovingPath = focusPath ?? active ?? roots[0]?.path ?? null;

  // Move keyboard focus to `p` and do to the selection whatever `mode` says: 'replace' collapses
  // onto the row (an unmodified arrow), 'extend' ranges from the anchor (Shift+arrow), 'preserve'
  // leaves it alone (Ctrl+arrow). One function so all three share the scroll/mount/focus dance.
  const focusRow = (p: string | null, mode: 'replace' | 'extend' | 'preserve' = 'replace') => {
    if (!p) return;
    setFocusPath(p);
    if (mode === 'replace') setSelection(selectOne(p));
    else if (mode === 'extend') {
      setSelection((s) => selectRange(s, p, visibleOrder(rootsRef.current)));
    }
    // Windowed list: scroll the target into the window so it mounts before we focus it.
    scrollPathIntoView(p);
    requestAnimationFrame(() => {
      for (const el of treeRef.current?.querySelectorAll<HTMLElement>('.filerow') ?? []) {
        if (el.dataset.path === p) {
          el.scrollIntoView({ block: 'nearest' });
          el.focus();
          break;
        }
      }
    });
  };

  // Full keyboard navigation + actions for the focused tree (spec §9). Editing defers to the
  // draft input. Cut/Copy/Paste are the accessible drag-alternative (WCAG 2.5.7).
  const onTreeKeyDown = (e: React.KeyboardEvent) => {
    if (draft) return;
    const mod = e.ctrlKey || e.metaKey;
    // Caps Lock makes e.key upper-case; matchCombo (shortcuts.ts) ignores letter case too.
    const clipKey = e.shiftKey ? '' : e.key.toLowerCase();
    if (mod && (clipKey === 'x' || clipKey === 'c' || clipKey === 'v')) {
      e.preventDefault();
      const sel =
        selection.selected.size > 0 ? [...selection.selected] : rovingPath ? [rovingPath] : [];
      if (clipKey === 'x') pane.cut(sel);
      else if (clipKey === 'c') pane.copy(sel);
      else pane.paste(createTarget);
      return;
    }
    const order = visibleOrder(roots);
    // Keyboard multi-select (docs/specs/2026-08-17-explorer-keyboard-multiselect.md §2). Handled
    // ABOVE the guard below, and every branch preventDefaults so the app's window-level shortcut
    // handler — which bails on defaultPrevented — doesn't fire the same keystroke twice.
    const modOnly = mod && !e.shiftKey && !e.altKey;
    const shiftOnly = e.shiftKey && !mod && !e.altKey;
    if (modOnly || shiftOnly) {
      const moveDir = MOVE_KEYS[e.key];
      if (moveDir) {
        e.preventDefault();
        focusRow(nextVisiblePath(order, rovingPath, moveDir), modOnly ? 'preserve' : 'extend');
        return;
      }
      if (modOnly && (e.key === 'a' || e.key === 'A')) {
        e.preventDefault();
        setSelection((s) => selectAll(s, order));
        if (order.length > 0) pane.announce(`Selected ${countNoun(order.length, 'item', 'items')}`);
        return;
      }
      if (modOnly && e.key === ' ') {
        e.preventDefault();
        if (rovingPath) setSelection((s) => toggleSelection(s, rovingPath));
        return;
      }
    }
    // Every gesture below is an UNMODIFIED key, and each one preventDefaults. Letting a
    // modified key through the switch swallowed the app's own chords whenever the tree held
    // focus — Alt+Left/Right (nav back/forward) died on a selected file row.
    if (mod || e.altKey) return;
    const cur = rovingPath;
    const node = cur ? findNode(roots, cur) : null;
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        focusRow(nextVisiblePath(order, cur, 'down'));
        break;
      case 'ArrowUp':
        e.preventDefault();
        focusRow(nextVisiblePath(order, cur, 'up'));
        break;
      case 'Home':
        e.preventDefault();
        focusRow(nextVisiblePath(order, cur, 'first'));
        break;
      case 'End':
        e.preventDefault();
        focusRow(nextVisiblePath(order, cur, 'last'));
        break;
      case 'ArrowRight':
        e.preventDefault();
        if (node?.kind === 'dir') {
          if (!node.expanded) toggleExpand(node);
          else focusRow(nextVisiblePath(order, cur, 'down'));
        }
        break;
      case 'ArrowLeft':
        e.preventDefault();
        if (node?.kind === 'dir' && node.expanded)
          setRoots((prev) => collapseNode(prev, node.path));
        else if (cur) {
          const par = parentDir(cur);
          if (par !== root && findNode(roots, par)) focusRow(par);
        }
        break;
      case 'Enter':
        e.preventDefault();
        if (node?.kind === 'file') onOpenFile(node.path, 'permanent');
        else if (node) toggleExpand(node);
        break;
      case 'F2':
        e.preventDefault();
        if (node) startRename({ path: node.path, kind: node.kind });
        break;
      case 'Delete': {
        e.preventDefault();
        // Same scoping rule as the menu (spec §4.4), but the roving row is not a menu target, so
        // a selection it sits outside of is left alone rather than collapsed.
        if (node) {
          const ordered = order.filter((p) => selection.selected.has(p));
          deleteTargets(resolveExplorerTargets(ordered, node.path).targets);
        }
        break;
      }
      case 'Escape':
        setSelection(clearSelection());
        pane.clearClipboard();
        break;
    }
  };

  const toggleSection = () => {
    // D3: collapsing the section collapses every subfolder too; expanding shows the top level.
    if (!collapsed) setRoots((prev) => collapseAll(prev));
    onToggleCollapsed();
  };

  useImperativeHandle(
    handleRef,
    (): FolderSectionHandle => ({
      revealInTree(absPath: string) {
        if (collapsed) onToggleCollapsed();
        revealTargetRef.current = absPath;
        advanceReveal();
      },
      refreshAll,
      refreshDir,
      selectMany(paths: string[]) {
        if (paths.length === 0) return;
        setSelection(selectMany(paths));
        setFocusPath(paths[paths.length - 1]);
      },
      focusCollapse() {
        collapseRef.current?.focus();
      },
      nodeAt: (p) => findNode(rootsRef.current, p),
      openRootMenu,
      clearSelection() {
        setSelection(clearSelection());
      },
    }),
  );

  const rows: { node: TreeNode; depth: number }[] = [];
  const walk = (nodes: TreeNode[], depth: number) => {
    for (const n of nodes) {
      rows.push({ node: n, depth });
      if (n.kind === 'dir' && n.expanded && n.children) walk(n.children, depth + 1);
    }
  };
  if (!collapsed) walk(roots, 0);

  // Rows that must stay mounted regardless of scroll. An active inline draft must never unmount
  // mid-edit (its input would blur→cancel), so pin its anchor row; the revealed row is pinned so
  // the reveal-scroll effect always finds a mounted target. A root-level create draft renders
  // outside the list (below) and needs no pin.
  const pins: number[] = [];
  if (draft) {
    const pinPath = draft.mode === 'rename' ? draft.path : draft.dir;
    if (pinPath && pinPath !== root) {
      const i = rows.findIndex((r) => r.node.path === pinPath);
      if (i >= 0) pins.push(i);
    }
  }
  if (revealedPath) {
    const i = rows.findIndex((r) => r.node.path === revealedPath);
    if (i >= 0) pins.push(i);
  }
  const win = computeSectionWindow({
    count: rows.length,
    scrollTop: view.scrollTop,
    viewportHeight: view.viewportHeight,
    rowHeight,
    overscan: OVERSCAN_ROWS,
    pins,
    sectionTop,
  });
  const windowed =
    win.endIndex >= win.startIndex ? rows.slice(win.startIndex, win.endIndex + 1) : [];
  // When the roving row is scrolled out of the window it isn't mounted to carry tabIndex=0, so
  // give the tree the tab stop instead — its onKeyDown still drives arrow nav (which scrolls
  // the target back into view), keeping the tree keyboard-reachable.
  const rovingMounted = rovingPath != null && windowed.some((r) => r.node.path === rovingPath);

  const mountedRowCount = windowed.length;
  const totalRowCount = rows.length;
  useEffect(() => {
    onPerf(key, { mountedRowCount, totalRowCount });
  }, [onPerf, key, mountedRowCount, totalRowCount]);
  useEffect(() => () => onPerf(key, { mountedRowCount: 0, totalRowCount: 0 }), [onPerf, key]);

  const draftRow = (d: Draft, depth: number) => (
    <DraftRow
      key="__draft__"
      depth={depth}
      kind={d.kind}
      value={d.name}
      error={d.error}
      onChange={(name) => setDraft({ ...d, name, error: null })}
      onCommit={() => void commitDraft(d)}
      onCancel={cancelDraft}
    />
  );

  // A create-draft renders right after its target dir's row (or at the top for a root
  // draft); a rename-draft replaces the row inline (handled in the row map below).
  const rootCreateDraft =
    draft?.mode === 'create' && draft.dir === root ? draftRow(draft, 0) : null;

  const onSectionDragOver = (e: React.DragEvent) => {
    if (pane.draggedPaths.length === 0 && !isOsFileDrag(e)) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = pane.draggedPaths.length > 0 && !e.ctrlKey ? 'move' : 'copy';
    pane.setDropTarget(root);
  };
  const onSectionDrop = (e: React.DragEvent) => {
    if (pane.draggedPaths.length === 0 && (e.dataTransfer.files?.length ?? 0) === 0) return;
    e.preventDefault();
    e.stopPropagation();
    dropOn(e, root);
  };

  return (
    <div
      className={`files-section${pane.dropTargetPath === root ? ' files-section--droptarget' : ''}`}
      role="group"
      aria-label={section.label}
      onDragOver={onSectionDragOver}
      onDrop={onSectionDrop}
    >
      <FolderBar
        section={section}
        collapsed={collapsed}
        treeId={treeId}
        createTarget={createTarget}
        collapseRef={collapseRef}
        onToggle={toggleSection}
        onRefresh={refreshAll}
        onNewFile={() => startCreate(createTarget, 'file')}
        onNewFolder={() => startCreate(createTarget, 'dir')}
        onMenu={(at) => pane.openFolderMenu(section, at)}
      />
      {!collapsed && (
        <div
          ref={treeRef}
          id={treeId}
          className="files-section__tree"
          role="tree"
          aria-multiselectable={true}
          aria-label={section.label}
          tabIndex={rovingMounted ? -1 : 0}
          onKeyDown={onTreeKeyDown}
          onContextMenu={(e) => {
            e.preventDefault();
            e.stopPropagation();
            openRootMenu({ x: e.clientX, y: e.clientY });
          }}
          onClick={(e) => {
            // Click on empty space → clear the selection.
            if (e.target === e.currentTarget) setSelection(clearSelection());
            setMenu(null);
          }}
        >
          {!loaded && roots.length === 0 ? (
            <EmptyState title="Loading…" role="status" />
          ) : roots.length === 0 && !rootCreateDraft ? (
            <EmptyState title="No files" hint="This folder is empty." />
          ) : (
            <>
              {rootCreateDraft}
              <div style={{ height: win.padTop }} aria-hidden />
              {/* Flat, so each row's identity is its path key alone. A nested array per row keys
                  it by window index too, and every window shift then remounts every row — which
                  eats a click pressed across it (no auxclick/click on a replaced element). */}
              {windowed.flatMap(({ node, depth }) => {
                if (draft?.mode === 'rename' && draft.path === node.path) {
                  return draftRow(draft, depth);
                }
                const isSelected = selection.selected.has(node.path);
                const isRevealed = node.kind === 'file' && node.path === revealedPath;
                // Precise highlight (spec M1): only the ONE folder row whose own path is the drop
                // target lights up — never its siblings.
                const isDropTarget = node.kind === 'dir' && pane.dropTargetPath === node.path;
                const dotKind = rowChanges.get(folderKey(node.path));
                const elems = [
                  <div
                    className={`filerow${isSelected ? ' filerow--selected' : ''}${isRevealed ? ' filerow--revealed' : ''}${isDropTarget ? ' filerow--droptarget' : ''}${node.ignored ? ' filerow--ignored' : ''}`}
                    key={node.path}
                    data-path={node.path}
                    role="treeitem"
                    aria-selected={isSelected}
                    aria-level={depth + 1}
                    aria-expanded={node.kind === 'dir' ? node.expanded : undefined}
                    tabIndex={node.path === rovingPath ? 0 : -1}
                    style={{ paddingLeft: 10 + depth * 14 }}
                    draggable={!pane.committing}
                    onDragStart={(e) => onDragStart(e, node)}
                    onDragEnd={pane.endDrag}
                    onDragOver={(e) => onDragOver(e, node)}
                    onDrop={(e) => onDrop(e, node)}
                    onClick={(e) => onRowClick(e, node)}
                    onDoubleClick={(e) => {
                      // VS Code parity: double-click opens a permanent (non-preview) tab.
                      // The dblclick's two plain clicks first open a preview, which this
                      // promotes. Modifier clicks are selection-only, so don't promote.
                      if (node.kind === 'file' && !e.shiftKey && !e.ctrlKey && !e.metaKey) {
                        onOpenFile(node.path, 'permanent');
                      }
                    }}
                    // Opens only — no selection, focus or repo-follow change; a folder gets
                    // no middle action (spec 2026-09-22-middle-click-new-tab §9 S1).
                    {...middleClickProps(
                      node.kind === 'file' ? () => onOpenFile(node.path, 'background') : null,
                    )}
                    onContextMenu={(e) => openMenu(e, { path: node.path, kind: node.kind })}
                  >
                    {node.kind === 'dir' ? (
                      <IconChevron
                        size={12}
                        className={`filerow__chev ${node.expanded ? 'filerow__chev--open' : ''}`}
                      />
                    ) : (
                      <span className="filerow__chev-spacer" />
                    )}
                    {node.kind === 'dir' ? (
                      <IconFolder size={13} className="filerow__icon" />
                    ) : (
                      <FileTypeIcon
                        name={node.name}
                        pack={settings.iconPack}
                        size={13}
                        className="filerow__icon"
                      />
                    )}
                    <span className="filerow__name">{node.name}</span>
                    {dotKind && (
                      <span
                        className={`filerow__dot filerow__dot--${dotKind}`}
                        aria-label={dotKind}
                      />
                    )}
                  </div>,
                ];
                // A create-draft targeting this expanded dir renders just under its row.
                if (draft?.mode === 'create' && draft.dir === node.path && node.kind === 'dir') {
                  elems.push(draftRow(draft, depth + 1));
                }
                return elems;
              })}
              <div style={{ height: win.padBottom }} aria-hidden />
            </>
          )}
        </div>
      )}
    </div>
  );
}

/** The inline editable row for a create/rename draft. Enter commits, Escape and blur cancel. */
function DraftRow({
  depth,
  kind,
  value,
  error,
  onChange,
  onCommit,
  onCancel,
}: {
  depth: number;
  kind: 'file' | 'dir';
  value: string;
  error: string | null;
  onChange: (v: string) => void;
  onCommit: () => void;
  onCancel: () => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  // Guards the blur handler: a commit/cancel programmatically unmounts the input, whose
  // blur must not then double-fire cancel.
  const done = useRef(false);
  // Select the filename stem on mount (extension preserved), per renameSelectionRange. Mount-only:
  // re-running on each keystroke would fight the user's caret.
  // biome-ignore lint/correctness/useExhaustiveDependencies: initial selection only
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    const { start, end } = renameSelectionRange(value, kind);
    el.setSelectionRange(start, end);
  }, []);
  return (
    <div
      className={`filerow filerow--draft ${error ? 'filerow--error' : ''}`}
      style={{ paddingLeft: 10 + depth * 14 }}
      title={error ?? undefined}
    >
      <span className="filerow__chev-spacer" />
      {kind === 'dir' && <IconFolder size={13} className="filerow__icon" />}
      <input
        ref={ref}
        className="filerow__input"
        value={value}
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            done.current = true;
            onCommit();
          } else if (e.key === 'Escape') {
            e.preventDefault();
            done.current = true;
            onCancel();
          }
        }}
        onBlur={() => {
          if (!done.current) onCancel();
        }}
      />
    </div>
  );
}
