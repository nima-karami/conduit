import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { changesBadgeClass } from '../../src/changes-badge';
import { dropIntent, topLevelPaths } from '../../src/drop-intent';
import type { ConflictPolicy } from '../../src/fs-dnd';
import type { GitOp } from '../../src/git-actions';
import { anchorMenuToRect } from '../../src/menu-position';
import { menuToggleIntent } from '../../src/menu-toggle';
import type { ChangeDTO } from '../../src/protocol';
import {
  fsDndCopy,
  fsDndImport,
  fsDndMove,
  fsMutate,
  pathForDroppedFile,
  post,
  subscribe,
} from '../bridge';
import type { OpenMode } from '../docs';
import { FileTypeIcon } from '../file-icons';
import {
  ancestorDirChain,
  applyEntries,
  buildChangeMap,
  collapseAll,
  collapseNode,
  expandNode,
  findNode,
  isSearchActive,
  joinPath,
  nextVisiblePath,
  parentDir,
  pathsToRefresh,
  renameSelectionRange,
  resolveCreateTarget,
  type TreeNode,
  validateName,
  visibleOrder,
} from '../file-tree';
import {
  activePath,
  clearSelection,
  EMPTY_SELECTION,
  reconcile,
  type SelectionState,
  selectMany,
  selectOne,
  selectRange,
  toggle as toggleSelection,
} from '../file-tree-selection';
import type { FsOp } from '../fs-undo';
import {
  IconChevron,
  IconChevronDown,
  IconCopy,
  IconDoc,
  IconExternal,
  IconFolder,
  IconMore,
  IconPencil,
  IconPlus,
  IconRefresh,
  IconTrash,
} from '../icons';
import { type MoveGrip, panelMoveDragProps } from '../panel-move-grip';
import { useSettings } from '../settings';
import { TERMINAL_PATH_MIME } from '../terminal-drop';
import { pushToast } from '../toast-store';
import { computeFixedWindow } from '../tree-window';
import { ConflictDialog, type ConflictPrompt, type ConflictResolution } from './conflict-dialog';
import { ContextMenu, type MenuItem, type MenuState } from './context-menu';
import { EmptyState } from './empty-state';
import { SearchPane, type SearchPaneHandle } from './search-pane';

/**
 * An action the Changes tab can request. `discardAll` is a renderer-only intent
 * (no single git op — the handler fans it out / confirms); every other value is a
 * real host GitOp. `path` is omitted for bulk ops.
 */
export type IntentOp = GitOp | 'discardAll';
export type GitActionIntent = { op: IntentOp; path?: string };

// Fallback row height (px) used before a real `.filerow` is measured; corrected on first mount.
const DEFAULT_ROW_HEIGHT = 25;
// Rows mounted above/below the viewport to absorb fling without mounting the whole tree.
const OVERSCAN_ROWS = 8;

declare global {
  interface Window {
    /** Dev/test perf counters read by the explorer virtualization smoke check (numbers only). */
    __conduitFilesPerf?: { mountedRowCount: number; totalRowCount: number };
  }
}

function ChangeRow({
  change,
  actions,
  onOpenDiff,
  onAction,
  onChangeContextMenu,
}: {
  change: ChangeDTO;
  actions: { label: string; op: GitOp; danger?: boolean; title: string }[];
  onOpenDiff: (relPath: string) => void;
  onAction: (intent: GitActionIntent) => void;
  onChangeContextMenu?: (e: React.MouseEvent, relPath: string) => void;
}) {
  const parts = change.path.split('/');
  const file = parts.pop() ?? change.path;
  const dir = parts.join('/');
  return (
    <div
      className="change"
      onClick={() => onOpenDiff(change.path)}
      onContextMenu={onChangeContextMenu ? (e) => onChangeContextMenu(e, change.path) : undefined}
      title="Open diff"
    >
      <span className={`change__kind change__kind--${change.kind}`}>{change.kind}</span>
      <span className="change__path">
        {dir && <span className="change__dir">{dir}/</span>}
        <span className="change__file">{file}</span>
      </span>
      <span className="change__stat">
        {change.added > 0 && <span className="diffstat--add">+{change.added}</span>}
        {change.removed > 0 && <span className="diffstat--del"> -{change.removed}</span>}
      </span>
      <span className="change__row-actions">
        {actions.map((a) => (
          <button
            key={a.op}
            type="button"
            className={`change__action ${a.danger ? 'change__action--danger' : ''}`}
            title={a.title}
            onClick={(e) => {
              e.stopPropagation();
              onAction({ op: a.op, path: change.path });
            }}
          >
            {a.label}
          </button>
        ))}
      </span>
    </div>
  );
}

function ChangesView({
  changes,
  onOpenDiff,
  onAction,
  onChangeContextMenu,
  onRefresh,
}: {
  changes: ChangeDTO[];
  onOpenDiff: (relPath: string) => void;
  onAction: (intent: GitActionIntent) => void;
  onChangeContextMenu?: (e: React.MouseEvent, relPath: string) => void;
  /** Re-read the working-tree change list from the host (R5.3 manual refresh). */
  onRefresh?: () => void;
}) {
  const [bulkMenu, setBulkMenu] = useState<MenuState | null>(null);
  const kebabRef = useRef<HTMLButtonElement | null>(null);
  const wasOpenRef = useRef(false);

  // Shared by the header's empty + populated states.
  const refreshBtn = onRefresh && (
    <button
      type="button"
      className="iconbtn iconbtn--sm changes__refresh"
      title="Refresh changes"
      aria-label="Refresh changes"
      onClick={onRefresh}
    >
      <IconRefresh size={14} />
    </button>
  );

  if (changes.length === 0)
    return (
      <>
        <div className="changes__header">
          <span className="changes__header-summary">
            <span>No changes</span>
          </span>
          {refreshBtn}
        </div>
        <EmptyState title="No changes" hint="The working tree is clean." />
      </>
    );

  const staged = changes.filter((c) => c.staged);
  const unstaged = changes.filter((c) => !c.staged);
  const totalAdd = changes.reduce((a, c) => a + c.added, 0);
  const totalDel = changes.reduce((a, c) => a + c.removed, 0);

  const openBulkMenu = (e: React.MouseEvent<HTMLButtonElement>) => {
    if (menuToggleIntent(wasOpenRef.current) === 'close') {
      setBulkMenu(null);
      return;
    }
    const r = e.currentTarget.getBoundingClientRect();
    const MENU_W = 200;
    const anchor = anchorMenuToRect(r, MENU_W);
    const items: MenuItem[] = [
      {
        label: 'Stage all',
        onClick: () => {
          onAction({ op: 'stageAll' });
          setBulkMenu(null);
        },
        disabled: unstaged.length === 0,
      },
      {
        label: 'Unstage all',
        onClick: () => {
          onAction({ op: 'unstageAll' });
          setBulkMenu(null);
        },
        disabled: staged.length === 0,
      },
      {
        label: 'Stash changes',
        separatorBefore: true,
        onClick: () => {
          onAction({ op: 'stashPush' });
          setBulkMenu(null);
        },
      },
      {
        label: 'Pop stash',
        onClick: () => {
          onAction({ op: 'stashPop' });
          setBulkMenu(null);
        },
      },
      {
        label: 'Discard all changes',
        danger: true,
        separatorBefore: true,
        onClick: () => {
          onAction({ op: 'discardAll' });
          setBulkMenu(null);
        },
        disabled: changes.length === 0,
      },
    ];
    setBulkMenu({ x: anchor.x, y: anchor.y, items });
  };

  return (
    <>
      <div className="changes__header">
        <span className="changes__header-summary">
          <span>
            {changes.length} change{changes.length !== 1 ? 's' : ''}
          </span>
          <span className="diffstat">
            {totalAdd > 0 && <span className="diffstat--add">+{totalAdd}</span>}
            {totalAdd > 0 && totalDel > 0 && ' '}
            {totalDel > 0 && <span className="diffstat--del">-{totalDel}</span>}
          </span>
        </span>
        {refreshBtn}
        <button
          ref={kebabRef}
          type="button"
          className="iconbtn iconbtn--sm changes__kebab"
          title="Git actions"
          aria-label="Git actions"
          aria-haspopup="menu"
          aria-expanded={bulkMenu !== null}
          onMouseDown={() => {
            wasOpenRef.current = bulkMenu !== null;
          }}
          onClick={openBulkMenu}
        >
          <IconMore size={15} />
        </button>
      </div>
      <div className="right__scroll">
        {staged.length > 0 && (
          <>
            <div className="changes__section">Staged</div>
            {staged.map((c) => (
              <ChangeRow
                key={`s:${c.path}`}
                change={c}
                actions={[{ label: 'Unstage', op: 'unstageFile', title: 'Unstage this file' }]}
                onOpenDiff={onOpenDiff}
                onAction={onAction}
                onChangeContextMenu={onChangeContextMenu}
              />
            ))}
          </>
        )}
        {unstaged.length > 0 && (
          <>
            <div className="changes__section">Changes</div>
            {unstaged.map((c) => {
              // Untracked discard via delete, tracked via git restore — pick the op from
              // kind so the confirm copy matches.
              const discardOp: GitOp = c.kind === 'U' ? 'discardUntracked' : 'discardTracked';
              return (
                <ChangeRow
                  key={`u:${c.path}`}
                  change={c}
                  actions={[
                    { label: 'Stage', op: 'stageFile', title: 'Stage this file' },
                    {
                      label: 'Discard',
                      op: discardOp,
                      danger: true,
                      title: c.kind === 'U' ? 'Delete untracked file' : 'Discard changes',
                    },
                  ]}
                  onOpenDiff={onOpenDiff}
                  onAction={onAction}
                  onChangeContextMenu={onChangeContextMenu}
                />
              );
            })}
          </>
        )}
      </div>
      {bulkMenu && (
        <ContextMenu menu={bulkMenu} onClose={() => setBulkMenu(null)} triggerRef={kebabRef} />
      )}
    </>
  );
}

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

interface FilesViewHandle {
  /** Expand the tree down to `absPath`, loading dirs as needed, and highlight the file. */
  revealInTree(absPath: string): void;
}

function FilesView({
  projectPath,
  changes,
  onOpenFile,
  onOpenMatch,
  setMenu,
  revealPath,
  openExternalApp,
  openWithChooser,
  copyToClipboard,
  onDelete,
  onRenamed,
  searchPaneRef,
  filesPaneRef,
  treeCache,
  recordFsOp,
  onContextPath,
}: {
  projectPath: string | undefined;
  /** Renderer-only overlay: drives git status dots on file/folder rows. */
  changes: ChangeDTO[];
  // `mode` lets the explorer double-click open a permanent tab while single-click previews.
  onOpenFile: (absPath: string, mode?: OpenMode) => void;
  /** Multi-repo auto-follow: report a clicked file/folder path so the active repo follows it. */
  onContextPath?: (absPath: string) => void;
  onOpenMatch: (abs: string, line: number, column: number) => void;
  setMenu: (m: MenuState | null) => void;
  revealPath: (path: string) => void;
  /** Open a file with its OS-default app (shell.openPath). */
  openExternalApp: (path: string) => void;
  /** Open the OS "Open with…" application chooser for a file. */
  openWithChooser: (path: string) => void;
  copyToClipboard: (text: string) => void;
  /** Imperative handle so the parent can reveal-and-highlight a path in the tree. */
  filesPaneRef: React.MutableRefObject<FilesViewHandle | null>;
  /** Per-project tree (expansion) cache, owned by the parent so it survives both a
   *  session switch (projectPath change) and a Files↔Changes tab unmount. */
  treeCache: Map<string, TreeNode[]>;
  // App owns the destructive flow (confirm + recycle-bin / permanent fallback + closing
  // any open doc tab for the deleted file). It calls `afterDeleted` on a successful
  // removal so the tree refreshes.
  onDelete: (node: { path: string; kind: 'dir' | 'file' }, afterDeleted: () => void) => void;
  // A file was renamed on disk; app updates/closes any open doc tab for the old path.
  onRenamed: (fromPath: string, toPath: string) => void;
  // Forwarded so the parent's openSearch() can focus the search input.
  searchPaneRef: React.MutableRefObject<SearchPaneHandle | null>;
  /** Record a successful fs op into the app-level undo stack. */
  recordFsOp?: (op: FsOp) => void;
}) {
  const { settings } = useSettings();
  const [roots, setRoots] = useState<TreeNode[]>([]);
  const [loaded, setLoaded] = useState(false);
  // The single active inline draft (create or rename), or null.
  const [draft, setDraft] = useState<Draft | null>(null);
  // Renderer-only overlay: relative-path → kind, with folder rollup.
  const changeMap = buildChangeMap(changes);
  // Multi-select state (ctrl/cmd toggle + shift range). The anchor (`activePath`) drives the
  // create-target. See docs/specs/2026-06-27-explorer-multiselect.md.
  const [selection, setSelection] = useState<SelectionState>(EMPTY_SELECTION);
  const [searchText, setSearchText] = useState('');
  // In a ref so the focus-refresh handler reads the current expansion state without
  // re-subscribing as the tree grows.
  const rootsRef = useRef<TreeNode[]>([]);
  rootsRef.current = roots;
  // D5 drag-and-drop. `draggedPaths` is the internal drag set ([] for an OS-origin drag);
  // `dropTargetPath` is the SINGLE folder-row path to highlight (or projectPath for the root
  // container) — keyed on the row's own path so only one row lights up (spec M1).
  const [draggedPaths, setDraggedPaths] = useState<string[]>([]);
  const [dropTargetPath, setDropTargetPath] = useState<string | null>(null);
  // True while a drag/paste batch is committing — blocks a second drop / paste (no double-submit).
  const [committing, setCommitting] = useState(false);
  // The active name-collision prompt (resolves the batch loop's awaited choice), or null.
  const [conflict, setConflict] = useState<{
    prompt: ConflictPrompt;
    resolve: (r: ConflictResolution) => void;
  } | null>(null);
  // In-app cut/copy clipboard of paths (keyboard drag-alternative, WCAG 2.5.7). Not the OS clipboard.
  const [clipboard, setClipboard] = useState<{ op: 'move' | 'copy'; paths: string[] } | null>(null);
  // Roving keyboard focus over the visible rows (the row that owns tabIndex=0).
  const [focusPath, setFocusPath] = useState<string | null>(null);
  const focusPathRef = useRef<string | null>(null);
  focusPathRef.current = focusPath;
  const liveRef = useRef<HTMLDivElement>(null);
  // Spring-loaded folders: a hover timer + the dir it targets + dirs this drag auto-expanded.
  const springTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const springTargetRef = useRef<string | null>(null);
  const springOpened = useRef<Set<string>>(new Set());
  // The file most recently revealed (opened from anywhere) — highlighted in the tree.
  const [revealedPath, setRevealedPath] = useState<string | null>(null);
  // The file the tree is currently expanding toward. A ref so the dirEntries-driven
  // advance reads it without re-subscribing.
  const revealTargetRef = useRef<string | null>(null);

  // Row-list virtualization: only rows intersecting the viewport (+ overscan) mount, so
  // expanding a directory with thousands of entries no longer mounts thousands of DOM rows.
  // All `.filerow`s are equal-height, so the window is a plain index range (webview/tree-window.ts).
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(0);
  const [rowHeight, setRowHeight] = useState(DEFAULT_ROW_HEIGHT);
  const rowHeightRef = useRef(rowHeight);
  rowHeightRef.current = rowHeight;

  // The tree scroller is rendered only while the search overlay is closed, and reveal closes the
  // overlay by clearing the search text — which REMOUNTS the scroller as a brand-new element. A
  // mount-only ([]) measure effect would keep its ResizeObserver bound to the old, detached node,
  // leaving viewportHeight at 0 forever after the remount (→ nothing mounts → the revealed row
  // never appears). A callback ref re-measures and rebinds the observer on every (re)mount, and
  // disconnects it when the element detaches (called with null).
  const resizeObs = useRef<ResizeObserver | null>(null);
  const setScrollerRef = useCallback((el: HTMLDivElement | null) => {
    resizeObs.current?.disconnect();
    resizeObs.current = null;
    scrollerRef.current = el;
    if (!el) return;
    setViewportHeight(el.clientHeight);
    const ro = new ResizeObserver(() => setViewportHeight(el.clientHeight));
    ro.observe(el);
    resizeObs.current = ro;
  }, []);

  // Bring a row's index into the window by nudging scrollTop, so a keyboard target that was
  // virtualized off-screen mounts before we try to focus it. Ref-based metrics so the callback
  // keeps a stable identity.
  const scrollPathIntoView = useCallback((p: string) => {
    const el = scrollerRef.current;
    if (!el) return;
    const idx = visibleOrder(rootsRef.current).indexOf(p);
    if (idx < 0) return;
    const rh = rowHeightRef.current;
    const rowTop = idx * rh;
    const rowBottom = rowTop + rh;
    if (rowTop < el.scrollTop) el.scrollTop = rowTop;
    else if (rowBottom > el.scrollTop + el.clientHeight) el.scrollTop = rowBottom - el.clientHeight;
    setScrollTop(el.scrollTop);
  }, []);

  // Cache each project's tree (expansion + loaded children) in a parent-owned map and
  // restore it, so a project switch (or live `cd`) doesn't reset to collapsed. The cleanup
  // stashes the outgoing tree on both projectPath change AND unmount (Files↔Changes
  // toggle). A restore still re-reads in the background (applyEntries preserves expansion).
  useEffect(() => {
    if (!projectPath) {
      setRoots([]);
      setLoaded(false);
      setSelection(EMPTY_SELECTION);
      return;
    }
    const cached = treeCache.get(projectPath);
    if (cached && cached.length > 0) {
      setRoots(cached);
      setLoaded(true);
      setSelection(EMPTY_SELECTION);
      for (const dir of pathsToRefresh(cached, projectPath)) post({ type: 'readDir', path: dir });
    } else {
      setRoots([]);
      setLoaded(false);
      setSelection(EMPTY_SELECTION);
      post({ type: 'readDir', path: projectPath });
    }
    return () => {
      if (projectPath && rootsRef.current.length > 0) treeCache.set(projectPath, rootsRef.current);
    };
  }, [projectPath, treeCache]);

  useEffect(() => {
    return subscribe((msg) => {
      if (msg.type !== 'dirEntries' || !projectPath) return;
      if (msg.path === projectPath) setLoaded(true);
      setRoots((prev) => applyEntries(prev, projectPath, msg.path, msg.entries));
    });
  }, [projectPath]);

  // Prune the selection whenever the visible tree changes (collapse, refresh, rename, delete,
  // drag-move) so it never references vanished rows. reconcile returns the same reference when
  // nothing changed, so this never loops. See spec §3.
  useEffect(() => {
    setSelection((s) => reconcile(s, visibleOrder(roots)));
  }, [roots]);

  // Reveal a file in the explorer. Walks the ancestor chain top-down — one unit of
  // progress per call (load OR expand one ancestor); the dirEntries reply re-drives this
  // via the roots effect below until the whole chain is present, then highlights + scrolls.
  const advanceReveal = useCallback(() => {
    const target = revealTargetRef.current;
    if (!target || !projectPath) return;
    const chain = ancestorDirChain(target, projectPath);
    if (chain.length === 0) return; // not under this project (yet) — wait or skip
    for (const dir of chain) {
      if (dir === projectPath) {
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
    // Whole chain present → the file row exists. Highlight; the reveal-scroll layout effect
    // (keyed on revealedPath) does the scroll once the pinned row has committed.
    revealTargetRef.current = null;
    // Reveal/open is a separate concept from selection (spec §3, D4) — it must not clear a
    // selection a plain file-click just set, so only the revealed highlight moves here.
    setRevealedPath(target);
  }, [projectPath]);
  // `roots` is a re-trigger (not read here) — each tree growth re-drives the in-progress reveal.
  // biome-ignore lint/correctness/useExhaustiveDependencies: roots drives the re-run, not the body
  useEffect(() => {
    if (revealTargetRef.current) advanceReveal();
  }, [roots, advanceReveal]);

  // Scroll the revealed row into view AFTER it commits. The row list is windowed and the scroller
  // is remounted when reveal closes the search overlay, so a fire-and-forget rAF fired before the
  // fresh element and the pinned row were in the DOM. revealedPath is pinned into the window (see
  // `pins` below) so this always finds a mounted row. Nudge scrollTop to bring it in-window first,
  // then let the browser refine to the exact position.
  // biome-ignore lint/correctness/useExhaustiveDependencies: only re-run when the target changes
  useLayoutEffect(() => {
    if (!revealedPath) return;
    const el = scrollerRef.current;
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

  useImperativeHandle(
    filesPaneRef,
    () => ({
      revealInTree(absPath: string) {
        revealTargetRef.current = absPath;
        // A search overlay hides the tree — clear it (both the SearchPane's own state and
        // our mirror) so the revealed file is actually visible in the tree below.
        searchPaneRef.current?.clear();
        setSearchText('');
        advanceReveal();
      },
    }),
    [advanceReveal, searchPaneRef],
  );

  // Re-read root + every expanded dir on focus/visibility so files an external
  // tool/agent created or deleted while backgrounded appear on their own (J5).
  // applyEntries preserves which folders were expanded.
  useEffect(() => {
    if (!projectPath) return;
    const doRefresh = () => {
      if (document.visibilityState === 'hidden') return;
      for (const dir of pathsToRefresh(rootsRef.current, projectPath)) {
        post({ type: 'readDir', path: dir });
      }
    };
    const onVisibility = () => {
      if (document.visibilityState === 'visible') doRefresh();
    };
    window.addEventListener('focus', doRefresh);
    document.addEventListener('visibilitychange', onVisibility);
    // The host pushes `fsChanged` on a disk change so files appear without a refocus.
    const norm = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
    const unsub = subscribe((msg) => {
      if (msg.type === 'fsChanged' && norm(msg.root) === norm(projectPath)) doRefresh();
    });
    return () => {
      window.removeEventListener('focus', doRefresh);
      document.removeEventListener('visibilitychange', onVisibility);
      unsub();
    };
  }, [projectPath]);

  // Measure a real row's height (font-scale-dependent, so not a constant). Runs each render but
  // only writes on a change, so it self-settles.
  useLayoutEffect(() => {
    const el = scrollerRef.current?.querySelector<HTMLElement>('.filerow');
    if (!el) return;
    const h = el.getBoundingClientRect().height;
    if (h > 0 && Math.abs(h - rowHeightRef.current) > 0.5) setRowHeight(h);
  });
  // A --font-scale change (a style edit on <html>) resizes rows via CSS without a React render,
  // so re-measure on that mutation too.
  useEffect(() => {
    const remeasure = () => {
      const el = scrollerRef.current?.querySelector<HTMLElement>('.filerow');
      if (!el) return;
      const h = el.getBoundingClientRect().height;
      if (h > 0 && Math.abs(h - rowHeightRef.current) > 0.5) setRowHeight(h);
    };
    const obs = new MutationObserver(remeasure);
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ['style'] });
    return () => obs.disconnect();
  }, []);

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
    if (projectPath && dir === projectPath) return roots.map((n) => n.name);
    const find = (nodes: TreeNode[]): TreeNode | undefined => {
      for (const n of nodes) {
        if (n.path === dir) return n;
        if (n.children) {
          const hit = find(n.children);
          if (hit) return hit;
        }
      }
      return undefined;
    };
    return find(roots)?.children?.map((n) => n.name) ?? [];
  };

  // Re-read a directory so applyEntries reconciles the on-disk change (preserving expansion).
  const refreshDir = (dir: string) => {
    if (projectPath && dir !== projectPath) setRoots((prev) => expandNode(prev, dir));
    post({ type: 'readDir', path: dir });
  };

  // Manual refresh: re-read root + all expanded dirs (same as the focus/visibility handler).
  const refreshAll = () => {
    if (!projectPath) return;
    for (const dir of pathsToRefresh(rootsRef.current, projectPath)) {
      post({ type: 'readDir', path: dir });
    }
  };

  // ---- Drag-and-drop handlers (D5) ----

  /** Announce an outcome via the polite live region (things only visible users get from toasts). */
  const announce = (msg: string) => {
    if (liveRef.current) liveRef.current.textContent = msg;
  };

  /** Effective destination FOLDER for a drop on `node`: a dir targets itself, a file its parent. */
  const dropFolderFor = (node: TreeNode): string =>
    node.kind === 'dir' ? node.path : parentDir(node.path);

  /** True when the drag carries OS files (from Explorer/Finder), not a tree node. */
  const isOsFileDrag = (e: React.DragEvent) => e.dataTransfer.types.includes('Files');

  const clearSpring = () => {
    if (springTimer.current) {
      clearTimeout(springTimer.current);
      springTimer.current = null;
    }
    springTargetRef.current = null;
  };

  // Spring-load: hovering a collapsed folder for 600ms during a drag expands it so nested drops
  // are reachable. Re-arms when the hovered dir changes; dirs opened this way are tracked so
  // onDragEnd can re-collapse the ones not dropped into.
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

  const onDragStart = (e: React.DragEvent, node: TreeNode) => {
    // Multi-drag: grabbing a row that's part of the selection drags the whole selection
    // (top-level de-duped); grabbing an unselected row acts on (and selects) just that row.
    const set = selection.selected;
    const multi = set.has(node.path) && set.size > 1;
    const paths = multi ? topLevelPaths([...set]) : [node.path];
    if (!multi) setSelection(selectOne(node.path));
    e.dataTransfer.effectAllowed = 'copyMove';
    e.dataTransfer.setData('text/plain', paths.join('\n'));
    // A terminal accepts a single path reference, not the whole multi-selection.
    e.dataTransfer.setData(TERMINAL_PATH_MIME, node.path);
    setDraggedPaths(paths);
  };

  const onDragEnd = () => {
    // Re-collapse folders this drag auto-expanded but didn't drop into (leave the tree as found).
    const opened = [...springOpened.current];
    if (opened.length > 0) {
      setRoots((prev) => opened.reduce((acc, p) => collapseNode(acc, p), prev));
    }
    springOpened.current.clear();
    clearSpring();
    setDraggedPaths([]);
    setDropTargetPath(null);
  };

  const onDragOver = (e: React.DragEvent, node: TreeNode) => {
    // Over a row, the row owns the drop target — stop the event before it bubbles to the
    // scroller's root handler, which otherwise overrides this precise folder highlight with a
    // whole-tree one (the reported bug) and would import into root as well on drop.
    e.stopPropagation();
    const folder = dropFolderFor(node);
    // OS files from outside → copy-import into the target folder.
    if (draggedPaths.length === 0 && isOsFileDrag(e)) {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
      setDropTargetPath(folder);
      armSpring(node);
      return;
    }
    if (draggedPaths.length === 0) return;
    // Only highlight when at least one dragged item can actually land here (else invalid drop).
    const ok = draggedPaths.some((src) =>
      dropIntent({ source: src, targetDir: folder, modifiers: { ctrl: e.ctrlKey } }),
    );
    if (!ok) {
      setDropTargetPath(null);
      clearSpring();
      return;
    }
    e.preventDefault();
    e.dataTransfer.dropEffect = e.ctrlKey ? 'copy' : 'move';
    setDropTargetPath(folder);
    armSpring(node);
  };

  /** Prompt for a name collision; resolves the batch loop's awaited choice. */
  const promptConflict = (destPath: string, remaining: number) =>
    new Promise<ConflictResolution>((resolve) => {
      const existing = findNode(rootsRef.current, destPath);
      setConflict({
        prompt: {
          name: nameOf(destPath),
          targetName: nameOf(parentDir(destPath)),
          destIsDir: existing?.kind === 'dir',
          destChildCount: existing?.children?.length,
          remaining,
        },
        resolve: (r) => {
          setConflict(null);
          resolve(r);
        },
      });
    });

  const callDnd = (op: 'move' | 'copy', source: string, dest: string, policy: ConflictPolicy) =>
    op === 'copy'
      ? fsDndCopy(source, dest, { onConflict: policy })
      : fsDndMove(source, dest, { onConflict: policy });

  /**
   * Drive N single-item move/copy ops with per-item conflict resolution. First attempt uses the
   * 'error' policy to detect a collision; on EEXIST it prompts (or applies a sticky "apply to
   * all" choice). A non-conflict failure stops the batch and reports (items so far stay applied,
   * each its own undo entry). Selection + focus follow the landed items.
   */
  const runBatch = async (
    items: { source: string; op: 'move' | 'copy'; dest: string }[],
    targetDir: string,
  ) => {
    if (items.length === 0 || committing) return;
    setCommitting(true);
    let sticky: ConflictResolution['action'] | null = null;
    const landed: string[] = [];
    const refreshDirs = new Set<string>([targetDir]);
    const verb = items[0].op === 'copy' ? 'Copied' : 'Moved';
    try {
      for (let i = 0; i < items.length; i++) {
        const it = items[i];
        let res = await callDnd(it.op, it.source, it.dest, 'error');
        if (!res.ok && res.code === 'EEXIST') {
          let action = sticky;
          if (!action) {
            const r = await promptConflict(it.dest, items.length - i - 1);
            action = r.action;
            if (r.applyToAll) sticky = r.action;
          }
          if (action === 'cancel') {
            announce(`Skipped ${nameOf(it.source)}`);
            continue;
          }
          res = await callDnd(
            it.op,
            it.source,
            it.dest,
            action === 'replace' ? 'replace' : 'rename',
          );
        }
        if (!res.ok) {
          pushToast({
            message: `Couldn't ${it.op} ${nameOf(it.source)}: ${res.error}`,
            variant: 'error',
          });
          break;
        }
        recordFsOp?.({ kind: it.op, from: it.source, to: res.path });
        landed.push(res.path);
        if (it.op === 'move') refreshDirs.add(parentDir(it.source));
        refreshDirs.add(parentDir(res.path));
      }
    } finally {
      setCommitting(false);
    }
    for (const d of refreshDirs) refreshDir(d);
    if (landed.length > 0) {
      setSelection(selectMany(landed));
      setFocusPath(landed[landed.length - 1]);
      announce(
        `${verb} ${landed.length} item${landed.length === 1 ? '' : 's'} to ${nameOf(targetDir)}`,
      );
    }
  };

  /** Build move/copy items from sources + a target folder, then run the batch. */
  const moveOrCopyInto = async (
    sources: string[],
    targetDir: string,
    modifiers: { ctrl?: boolean; shift?: boolean; alt?: boolean },
  ) => {
    const items = sources.flatMap((source) => {
      const intent = dropIntent({ source, targetDir, modifiers });
      return intent ? [{ source, op: intent.op, dest: intent.dest }] : [];
    });
    await runBatch(items, targetDir);
  };

  // Import OS files/folders dropped from outside into `targetDir`, one source at a time so a
  // collision opens the same conflict dialog as an internal move (spec §D).
  const importOsFiles = async (files: File[], targetDir: string) => {
    const sources = files.map((f) => pathForDroppedFile(f)).filter(Boolean);
    if (sources.length === 0) {
      pushToast({ message: 'Could not read the dropped file paths.', variant: 'error' });
      return;
    }
    if (committing) return;
    setCommitting(true);
    let sticky: ConflictResolution['action'] | null = null;
    const landed: string[] = [];
    try {
      for (let i = 0; i < sources.length; i++) {
        const src = sources[i];
        const destPath = joinPath(targetDir, nameOf(src));
        let res = await fsDndImport([src], targetDir, { onConflict: 'error' });
        if (!res.ok && res.code === 'EEXIST') {
          let action = sticky;
          if (!action) {
            const r = await promptConflict(destPath, sources.length - i - 1);
            action = r.action;
            if (r.applyToAll) sticky = r.action;
          }
          if (action === 'cancel') {
            announce(`Skipped ${nameOf(src)}`);
            continue;
          }
          res = await fsDndImport([src], targetDir, {
            onConflict: action === 'replace' ? 'replace' : 'rename',
          });
        }
        if (!res.ok) {
          pushToast({ message: `Couldn't add ${nameOf(src)}: ${res.error}`, variant: 'error' });
          break;
        }
        landed.push(...res.paths);
      }
    } finally {
      setCommitting(false);
    }
    refreshDir(targetDir);
    if (landed.length > 0) {
      const n = landed.length;
      announce(`Added ${n} item${n === 1 ? '' : 's'} to ${nameOf(targetDir)}`);
      pushToast({
        message: `Added ${n} item${n === 1 ? '' : 's'} to the project.`,
        variant: 'info',
      });
    }
  };

  const onDrop = async (e: React.DragEvent, node: TreeNode) => {
    e.preventDefault();
    e.stopPropagation(); // see onDragOver: keep the drop on this row, not the scroller root
    clearSpring();
    const folder = dropFolderFor(node);
    springOpened.current.delete(folder); // a dropped-into dir stays open
    const osFiles = Array.from(e.dataTransfer.files ?? []);
    if (draggedPaths.length === 0 && osFiles.length > 0) {
      setDropTargetPath(null);
      await importOsFiles(osFiles, folder);
      return;
    }
    const sources =
      draggedPaths.length > 0
        ? draggedPaths
        : topLevelPaths((e.dataTransfer.getData('text/plain') || '').split('\n').filter(Boolean));
    setDraggedPaths([]);
    setDropTargetPath(null);
    if (sources.length === 0) return;
    await moveOrCopyInto(sources, folder, {
      ctrl: e.ctrlKey,
      shift: e.shiftKey,
      alt: e.altKey,
    });
  };

  // ---- Cut / copy / paste: the keyboard + menu drag-alternative (WCAG 2.5.7) ----
  // An in-app clipboard of paths (NOT the OS clipboard) — a cut is consumed on paste; a copy
  // can paste repeatedly.
  const cutPaths = (paths: string[]) => {
    const eff = topLevelPaths(paths);
    if (eff.length === 0) return;
    setClipboard({ op: 'move', paths: eff });
    announce(`Cut ${eff.length} item${eff.length === 1 ? '' : 's'}`);
  };
  const copyPaths = (paths: string[]) => {
    const eff = topLevelPaths(paths);
    if (eff.length === 0) return;
    setClipboard({ op: 'copy', paths: eff });
    announce(`Copied ${eff.length} item${eff.length === 1 ? '' : 's'}`);
  };
  const pasteInto = async (targetDir: string) => {
    if (!clipboard) return;
    await moveOrCopyInto(clipboard.paths, targetDir, { ctrl: clipboard.op === 'copy' });
    if (clipboard.op === 'move') setClipboard(null);
  };

  // Expand+load a collapsed/unloaded target dir first so the new row appears in context.
  const startCreate = (dir: string, kind: 'file' | 'dir') => {
    if (projectPath && dir !== projectPath) refreshDir(dir);
    setDraft({ mode: 'create', kind, dir, name: '', error: null });
  };
  const startRename = (node: { path: string; kind: 'dir' | 'file' }) => {
    const dir = node.path.replace(/[\\/]+$/, '').replace(/[\\/][^\\/]+$/, '');
    const name =
      node.path
        .replace(/[\\/]+$/, '')
        .split(/[\\/]/)
        .pop() ?? node.path;
    setDraft({ mode: 'rename', kind: node.kind, path: node.path, dir, name, error: null });
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

  const openMenu = (e: React.MouseEvent, node: { path: string; kind: 'dir' | 'file' }) => {
    e.preventDefault();
    e.stopPropagation();
    // D3: right-clicking outside the selection collapses it to that row; inside a multi-select
    // the set is preserved (the MVP menu still acts only on the clicked row).
    setSelection((s) => (s.selected.has(node.path) ? s : selectOne(node.path)));
    // Cut/Copy act on the whole selection when right-clicking inside it, else the clicked row.
    const menuPaths = selection.selected.has(node.path) ? [...selection.selected] : [node.path];
    const rel = projectPath
      ? node.path.replace(projectPath.replace(/[\\/]+$/, ''), '').replace(/^[\\/]+/, '')
      : node.path;
    const parentOfNode = parentDir(node.path);
    const items: MenuItem[] = [];
    if (node.kind === 'file') {
      // Open (primary) → modify (create+rename) → reference → destructive.
      items.push(
        { label: 'Open', icon: <IconDoc size={14} />, onClick: () => onOpenFile(node.path) },
        {
          label: 'Open externally',
          icon: <IconExternal size={14} />,
          onClick: () => openExternalApp(node.path),
        },
        {
          label: 'Open with…',
          icon: <IconExternal size={14} />,
          onClick: () => openWithChooser(node.path),
        },
        {
          label: 'New file…',
          icon: <IconPlus size={14} />,
          separatorBefore: true,
          onClick: () => startCreate(parentOfNode, 'file'),
        },
        { label: 'Rename…', icon: <IconPencil size={14} />, onClick: () => startRename(node) },
        { label: 'Cut', icon: <IconCopy size={14} />, onClick: () => cutPaths(menuPaths) },
        { label: 'Copy', icon: <IconCopy size={14} />, onClick: () => copyPaths(menuPaths) },
        {
          label: 'Paste into folder',
          icon: <IconCopy size={14} />,
          disabled: !clipboard,
          onClick: () => void pasteInto(parentOfNode),
        },
      );
    } else {
      items.push(
        {
          label: 'New file…',
          icon: <IconPlus size={14} />,
          onClick: () => startCreate(node.path, 'file'),
        },
        {
          label: 'New folder…',
          icon: <IconFolder size={14} />,
          onClick: () => startCreate(node.path, 'dir'),
        },
        { label: 'Rename…', icon: <IconPencil size={14} />, onClick: () => startRename(node) },
        { label: 'Cut', icon: <IconCopy size={14} />, onClick: () => cutPaths(menuPaths) },
        { label: 'Copy', icon: <IconCopy size={14} />, onClick: () => copyPaths(menuPaths) },
        {
          label: 'Paste into folder',
          icon: <IconCopy size={14} />,
          disabled: !clipboard,
          onClick: () => void pasteInto(node.path),
        },
      );
    }
    items.push(
      {
        label: 'Copy path',
        icon: <IconCopy size={14} />,
        separatorBefore: true,
        onClick: () => copyToClipboard(node.path),
      },
      {
        label: 'Copy relative path',
        icon: <IconCopy size={14} />,
        onClick: () => copyToClipboard(rel),
      },
      {
        label: 'Reveal in Explorer',
        icon: <IconExternal size={14} />,
        onClick: () => revealPath(node.path),
      },
      {
        label: 'Delete',
        icon: <IconTrash size={14} />,
        danger: true,
        separatorBefore: true,
        onClick: () => onDelete(node, () => refreshDir(parentOfNode)),
      },
    );
    setMenu({ x: e.clientX, y: e.clientY, items });
  };

  // Create-target derives from the active item (anchor): active dir → itself, active file →
  // its parent, none → project root (Decision D1). `?? null` collapses an anchor that is no
  // longer in the tree to the empty case.
  const active = activePath(selection);
  const activeNode = active ? (findNode(roots, active) ?? null) : null;
  const createTarget = projectPath
    ? resolveCreateTarget(
        activeNode ? { path: activeNode.path, kind: activeNode.kind } : null,
        projectPath,
      )
    : '';

  // The row that owns keyboard focus (roving tabindex). Falls back to the active/anchor row,
  // then the first visible row so Tab can always reach the tree.
  const rovingPath = focusPath ?? active ?? roots[0]?.path ?? null;

  // Move keyboard focus to `p`: select it, scroll it into view, and focus its DOM row.
  const focusRow = (p: string | null) => {
    if (!p) return;
    setFocusPath(p);
    setSelection(selectOne(p));
    // Windowed list: scroll the target into the window so it mounts before we focus it.
    scrollPathIntoView(p);
    requestAnimationFrame(() => {
      for (const el of document.querySelectorAll<HTMLElement>('.filerow')) {
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
    if (mod && (e.key === 'x' || e.key === 'c' || e.key === 'v')) {
      e.preventDefault();
      const sel =
        selection.selected.size > 0 ? [...selection.selected] : rovingPath ? [rovingPath] : [];
      if (e.key === 'x') cutPaths(sel);
      else if (e.key === 'c') copyPaths(sel);
      else void pasteInto(createTarget);
      return;
    }
    const order = visibleOrder(roots);
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
          if (par !== projectPath && findNode(roots, par)) focusRow(par);
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
      case 'Delete':
        e.preventDefault();
        if (node)
          onDelete({ path: node.path, kind: node.kind }, () => refreshDir(parentDir(node.path)));
        break;
      case 'Escape':
        setSelection(clearSelection());
        setClipboard(null);
        break;
    }
  };

  // Right-click empty space → create at the active item's dir (or the root).
  const openRootMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    if (!projectPath) return;
    const target = createTarget;
    setMenu({
      x: e.clientX,
      y: e.clientY,
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

  const rows: { node: TreeNode; depth: number }[] = [];
  const walk = (nodes: TreeNode[], depth: number) => {
    for (const n of nodes) {
      rows.push({ node: n, depth });
      if (n.kind === 'dir' && n.expanded && n.children) walk(n.children, depth + 1);
    }
  };
  walk(roots, 0);

  // Rows that must stay mounted regardless of scroll. An active inline draft must never unmount
  // mid-edit (its input would blur→cancel), so pin its anchor row; the revealed row is pinned so
  // the reveal-scroll effect always finds a mounted target after the search overlay closes. A
  // root-level create draft renders outside the list (below) and needs no pin.
  const pins: number[] = [];
  if (draft) {
    const pinPath = draft.mode === 'rename' ? draft.path : draft.dir;
    if (pinPath && pinPath !== projectPath) {
      const i = rows.findIndex((r) => r.node.path === pinPath);
      if (i >= 0) pins.push(i);
    }
  }
  if (revealedPath) {
    const i = rows.findIndex((r) => r.node.path === revealedPath);
    if (i >= 0) pins.push(i);
  }
  const win = computeFixedWindow({
    count: rows.length,
    scrollTop,
    viewportHeight,
    rowHeight,
    overscan: OVERSCAN_ROWS,
    pins,
  });
  const windowed =
    win.endIndex >= win.startIndex ? rows.slice(win.startIndex, win.endIndex + 1) : [];
  // When the roving row is scrolled out of the window it isn't mounted to carry tabIndex=0, so
  // give the scroller the tab stop instead — its onKeyDown still drives arrow nav (which scrolls
  // the target back into view), keeping the tree keyboard-reachable.
  const rovingMounted = rovingPath != null && windowed.some((r) => r.node.path === rovingPath);

  const mountedRowCount = windowed.length;
  const totalRowCount = rows.length;
  useEffect(() => {
    window.__conduitFilesPerf = { mountedRowCount, totalRowCount };
  }, [mountedRowCount, totalRowCount]);

  if (!projectPath) return <EmptyState title="No active project" />;

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
    draft?.mode === 'create' && draft.dir === projectPath ? draftRow(draft, 0) : null;

  const searchActive = isSearchActive(searchText);

  return (
    <>
      {/* hideResultsWhenEmpty keeps the search bar compact while the tree shows below. */}
      <SearchPane
        projectPath={projectPath}
        onOpenMatch={onOpenMatch}
        paneRef={searchPaneRef}
        onTextChange={setSearchText}
        hideResultsWhenEmpty={!searchActive}
      />
      {/* Header bar (root label + actions) — hidden while search is active. */}
      {!searchActive && (
        <div className="files__bar">
          <span className="files__root" title={projectPath}>
            <IconFolder size={13} className="files__root-icon" />
            <span className="files__root-name">{nameOf(projectPath)}</span>
          </span>
          <button
            type="button"
            className="iconbtn iconbtn--sm"
            title="Collapse all folders"
            aria-label="Collapse all folders"
            onClick={() => setRoots((prev) => collapseAll(prev))}
          >
            <IconChevronDown size={14} className="files__bar-chev--open" />
          </button>
          <button
            type="button"
            className="iconbtn iconbtn--sm"
            title="Refresh file tree"
            aria-label="Refresh file tree"
            onClick={refreshAll}
          >
            <IconRefresh size={14} />
          </button>
          <button
            type="button"
            className="iconbtn iconbtn--sm"
            title={
              createTarget === projectPath
                ? 'New file at root'
                : `New file in ${nameOf(createTarget)}`
            }
            aria-label={
              createTarget === projectPath
                ? 'New file at root'
                : `New file in ${nameOf(createTarget)}`
            }
            onClick={() => startCreate(createTarget, 'file')}
          >
            <IconPlus size={15} />
          </button>
          <button
            type="button"
            className="iconbtn iconbtn--sm"
            title={
              createTarget === projectPath
                ? 'New folder at root'
                : `New folder in ${nameOf(createTarget)}`
            }
            aria-label={
              createTarget === projectPath
                ? 'New folder at root'
                : `New folder in ${nameOf(createTarget)}`
            }
            onClick={() => startCreate(createTarget, 'dir')}
          >
            <IconFolder size={15} />
          </button>
        </div>
      )}
      {!searchActive && (
        <div
          ref={setScrollerRef}
          className={`right__scroll right__scroll--files${dropTargetPath === projectPath ? ' right__scroll--droptarget' : ''}`}
          role="tree"
          aria-multiselectable={true}
          aria-label="Files"
          tabIndex={rovingMounted ? -1 : 0}
          onScroll={() => {
            const el = scrollerRef.current;
            if (el) setScrollTop(el.scrollTop);
          }}
          onKeyDown={onTreeKeyDown}
          onContextMenu={openRootMenu}
          onClick={(e) => {
            // Click on empty space → clear the selection.
            if (e.target === e.currentTarget) setSelection(clearSelection());
            setMenu(null);
          }}
          // Empty tree space targets the project root — OS import or an internal move into root.
          onDragOver={(e) => {
            if (!projectPath) return;
            if (draggedPaths.length === 0 && !isOsFileDrag(e)) return;
            e.preventDefault();
            e.dataTransfer.dropEffect = draggedPaths.length > 0 && !e.ctrlKey ? 'move' : 'copy';
            setDropTargetPath(projectPath);
          }}
          onDragLeave={(e) => {
            // The guard fires only when the drag leaves the scroller entirely (relatedTarget is
            // outside it), so clear whatever was highlighted — root OR a specific folder row.
            if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
            setDropTargetPath(null);
          }}
          onDrop={(e) => {
            if (!projectPath) return;
            const osFiles = Array.from(e.dataTransfer.files ?? []);
            if (draggedPaths.length === 0 && osFiles.length === 0) return;
            e.preventDefault();
            setDropTargetPath(null);
            if (draggedPaths.length > 0) {
              const sources = draggedPaths;
              setDraggedPaths([]);
              void moveOrCopyInto(sources, projectPath, {
                ctrl: e.ctrlKey,
                shift: e.shiftKey,
                alt: e.altKey,
              });
            } else {
              void importOsFiles(osFiles, projectPath);
            }
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
              {windowed.map(({ node, depth }) => {
                if (draft?.mode === 'rename' && draft.path === node.path) {
                  return draftRow(draft, depth);
                }
                const isSelected = selection.selected.has(node.path);
                const isRevealed = node.kind === 'file' && node.path === revealedPath;
                // Precise highlight (spec M1): only the ONE folder row whose own path is the drop
                // target lights up — never its siblings (the old keyed-on-effective-dir bug).
                const isDropTarget = node.kind === 'dir' && dropTargetPath === node.path;
                // Derive relative path for the change-map lookup (forward slashes, no leading slash).
                const relPath = projectPath
                  ? node.path
                      .replace(projectPath.replace(/[\\/]+$/, ''), '')
                      .replace(/^[\\/]+/, '')
                      .replace(/\\/g, '/')
                  : node.name;
                const dotKind = changeMap.get(relPath);
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
                    draggable={!committing}
                    onDragStart={(e) => onDragStart(e, node)}
                    onDragEnd={onDragEnd}
                    onDragOver={(e) => onDragOver(e, node)}
                    onDrop={(e) => void onDrop(e, node)}
                    onClick={(e) => onRowClick(e, node)}
                    onDoubleClick={(e) => {
                      // VS Code parity: double-click opens a permanent (non-preview) tab.
                      // The dblclick's two plain clicks first open a preview, which this
                      // promotes. Modifier clicks are selection-only, so don't promote.
                      if (node.kind === 'file' && !e.shiftKey && !e.ctrlKey && !e.metaKey) {
                        onOpenFile(node.path, 'permanent');
                      }
                    }}
                    onAuxClick={(e) => {
                      // Middle-click a file opens it permanently (VS Code parity, like
                      // dbl-click/Enter). Folders have no middle-click action.
                      if (e.button === 1 && node.kind === 'file') {
                        e.preventDefault();
                        onOpenFile(node.path, 'permanent');
                      }
                    }}
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
      <div ref={liveRef} className="sr-only" aria-live="polite" role="status" />
      {conflict && (
        <ConflictDialog prompt={conflict.prompt} onResolve={(r) => conflict.resolve(r)} />
      )}
    </>
  );
}

/** Basename of a path (forward or back slashes), trailing separators stripped. */
function nameOf(p: string): string {
  return (
    p
      .replace(/[\\/]+$/, '')
      .split(/[\\/]/)
      .pop() ?? p
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

type RightTab = 'changes' | 'files';

/** Imperative handle so App's Mod+Shift+F can switch to the Files tab and focus the search input. */
export interface RightPaneHandle {
  openSearch(): void;
  /** Switch to the Files tab and reveal+highlight `path` in the tree. */
  revealInTree(path: string): void;
}

export function RightPane({
  projectPath,
  changes,
  onOpenFile,
  onOpenMatch,
  onOpenDiff,
  onGitAction,
  setMenu,
  revealPath,
  openExternalApp,
  openWithChooser,
  copyToClipboard,
  onDeleteFile,
  onFileRenamed,
  onChangeContextMenu,
  onRefreshChanges,
  moveGrip,
  paneRef,
  recordFsOp,
  onContextPath,
}: {
  projectPath: string | undefined;
  changes: ChangeDTO[];
  onOpenFile: (absPath: string, mode?: OpenMode) => void;
  onOpenMatch: (abs: string, line: number, column: number) => void;
  onOpenDiff: (relPath: string) => void;
  onGitAction: (intent: GitActionIntent) => void;
  setMenu: (m: MenuState | null) => void;
  revealPath: (path: string) => void;
  /** Open a file with its OS-default app (shell.openPath). */
  openExternalApp: (path: string) => void;
  /** Open the OS "Open with…" application chooser for a file. */
  openWithChooser: (path: string) => void;
  copyToClipboard: (text: string) => void;
  onDeleteFile: (node: { path: string; kind: 'dir' | 'file' }, afterDeleted: () => void) => void;
  onFileRenamed: (fromPath: string, toPath: string) => void;
  onChangeContextMenu?: (e: React.MouseEvent, relPath: string) => void;
  /** Re-read the working-tree change list (R5.3 manual refresh). */
  onRefreshChanges?: () => void;
  // Barless panel: the tab row doubles as the panel-move drag surface (R5 alignment).
  moveGrip?: MoveGrip;
  paneRef?: React.MutableRefObject<RightPaneHandle | null>;
  /** Record a successful fs op into the app-level undo stack. */
  recordFsOp?: (op: FsOp) => void;
  /** Multi-repo auto-follow: report a clicked file/folder path so the active repo follows it. */
  onContextPath?: (absPath: string) => void;
}) {
  const { settings, update } = useSettings();
  const [tab, setTab] = useState<RightTab>(settings.rightPaneTab);
  // Explicit tab-button click persists the choice globally; imperative reveal/search switches
  // (openSearch/revealInTree) intentionally do NOT — a transient navigation shouldn't overwrite
  // the remembered preference.
  const selectTab = useCallback(
    (next: RightTab) => {
      setTab(next);
      if (next !== settings.rightPaneTab) update({ rightPaneTab: next });
    },
    [settings.rightPaneTab, update],
  );
  // Adopt the persisted tab when it changes value — covers the async host hydration that
  // lands after mount (so a remembered 'changes' reopens correctly). Fires only on an actual
  // preference change, so a transient reveal/search switch (which doesn't touch the pref) is
  // not snapped back. Never posts — no write loop with the settings broadcast.
  useEffect(() => {
    setTab(settings.rightPaneTab);
  }, [settings.rightPaneTab]);
  // Bridge to the SearchPane's input focus (lives inside FilesView when the Files tab is active).
  const searchPaneRef = useRef<SearchPaneHandle | null>(null);
  // Bridge to FilesView's reveal-in-tree (also only mounted on the Files tab).
  const filesPaneRef = useRef<FilesViewHandle | null>(null);
  // Per-project tree cache, owned here so it outlives FilesView (which unmounts when the
  // Changes tab is active) and a session switch (which only changes FilesView's prop).
  const treeCacheRef = useRef<Map<string, TreeNode[]>>(new Map());

  useImperativeHandle(
    paneRef,
    () => ({
      openSearch() {
        setTab('files');
        // Focus after the tab mounts / is already mounted (next frame).
        requestAnimationFrame(() => searchPaneRef.current?.focusInput());
      },
      revealInTree(path: string) {
        setTab('files');
        // FilesView may have just mounted (was on Changes) — reveal next frame.
        requestAnimationFrame(() => filesPaneRef.current?.revealInTree(path));
      },
    }),
    [],
  );

  return (
    <aside className="right">
      <div className="right__tabs" {...panelMoveDragProps(moveGrip)}>
        <button
          className={`rtab ${tab === 'changes' ? 'rtab--active' : ''}`}
          onClick={() => selectTab('changes')}
        >
          Changes
          {(() => {
            const cls = changesBadgeClass(changes.length, tab === 'changes');
            return cls !== null ? <span className={cls}>{changes.length}</span> : null;
          })()}
        </button>
        <button
          className={`rtab ${tab === 'files' ? 'rtab--active' : ''}`}
          onClick={() => selectTab('files')}
        >
          Files
        </button>
      </div>
      {tab === 'changes' ? (
        <ChangesView
          changes={changes}
          onOpenDiff={onOpenDiff}
          onAction={onGitAction}
          onChangeContextMenu={onChangeContextMenu}
          onRefresh={onRefreshChanges}
        />
      ) : (
        <FilesView
          projectPath={projectPath}
          changes={changes}
          onOpenFile={onOpenFile}
          onOpenMatch={onOpenMatch}
          setMenu={setMenu}
          revealPath={revealPath}
          openExternalApp={openExternalApp}
          openWithChooser={openWithChooser}
          copyToClipboard={copyToClipboard}
          onDelete={onDeleteFile}
          onRenamed={onFileRenamed}
          searchPaneRef={searchPaneRef}
          filesPaneRef={filesPaneRef}
          treeCache={treeCacheRef.current}
          recordFsOp={recordFsOp}
          onContextPath={onContextPath}
        />
      )}
    </aside>
  );
}
