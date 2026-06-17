import { useEffect, useImperativeHandle, useRef, useState } from 'react';
import { changesBadgeClass } from '../../src/changes-badge';
import { dropIntent } from '../../src/drop-intent';
import type { GitOp } from '../../src/git-actions';
import { anchorMenuToRect } from '../../src/menu-position';
import { menuToggleIntent } from '../../src/menu-toggle';
import type { ChangeDTO } from '../../src/protocol';
import { fsDndCopy, fsDndMove, fsMutate, post, subscribe } from '../bridge';
import {
  applyEntries,
  buildChangeMap,
  collapseAll,
  isSearchActive,
  joinPath,
  pathsToRefresh,
  resolveCreateTarget,
  type TreeNode,
  validateName,
} from '../file-tree';
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
  IconReview,
  IconTrash,
} from '../icons';
import { type MoveGrip, panelMoveDragProps } from '../panel-move-grip';
import { pushToast } from '../toast-store';
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

function ChangeRow({
  change,
  actions,
  onOpenDiff,
  onAction,
  onChangeContextMenu,
}: {
  change: ChangeDTO;
  // Ordered list of row actions: label + the op to fire when clicked.
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
  onReviewAll,
  onRefresh,
}: {
  changes: ChangeDTO[];
  onOpenDiff: (relPath: string) => void;
  onAction: (intent: GitActionIntent) => void;
  onChangeContextMenu?: (e: React.MouseEvent, relPath: string) => void;
  /** Open the global Review view (R3) stacking every change as hunk cards. */
  onReviewAll?: () => void;
  /** Re-read the working-tree change list from the host (R5.3 manual refresh). */
  onRefresh?: () => void;
}) {
  // Kebab menu state: the local ContextMenu is anchored to the three-dot trigger.
  const [bulkMenu, setBulkMenu] = useState<MenuState | null>(null);
  const kebabRef = useRef<HTMLButtonElement | null>(null);
  const wasOpenRef = useRef(false);

  // A small reusable refresh control for the header (both empty + populated states).
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

  // Build and open the bulk-actions kebab menu, anchored below/right the trigger.
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
        {onReviewAll && (
          <button
            type="button"
            className="iconbtn iconbtn--sm changes__review"
            title="Review all changes"
            aria-label="Review all changes"
            onClick={onReviewAll}
          >
            <IconReview size={15} />
          </button>
        )}
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
              // Untracked files discard via delete; tracked via git restore — both
              // routed through 'discardTracked'/'discardUntracked' by the caller based
              // on kind. Here we pick the op from the kind so the confirm copy matches.
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

function FilesView({
  projectPath,
  changes,
  onOpenFile,
  onOpenMatch,
  setMenu,
  revealPath,
  copyToClipboard,
  onDelete,
  onRenamed,
  searchPaneRef,
  recordFsOp,
}: {
  projectPath: string | undefined;
  /** Renderer-only overlay: drives git status dots on file/folder rows. */
  changes: ChangeDTO[];
  onOpenFile: (absPath: string) => void;
  onOpenMatch: (abs: string, line: number, column: number) => void;
  setMenu: (m: MenuState | null) => void;
  revealPath: (path: string) => void;
  copyToClipboard: (text: string) => void;
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
  const [roots, setRoots] = useState<TreeNode[]>([]);
  const [loaded, setLoaded] = useState(false);
  // The single active inline draft (create or rename), or null. Only one at a time.
  const [draft, setDraft] = useState<Draft | null>(null);
  // Renderer-only overlay: relative-path → kind, with folder rollup, built from changes.
  const changeMap = buildChangeMap(changes);
  // The currently selected folder path (for targeted create). null = root-targeted.
  const [selectedDir, setSelectedDir] = useState<string | null>(null);
  // The search query text, controlled here so we can react to it for tree/search switching.
  const [searchText, setSearchText] = useState('');
  // Latest tree, mirrored into a ref so the focus-refresh handler can read the
  // current expansion state without re-subscribing on every keystroke of growth.
  const rootsRef = useRef<TreeNode[]>([]);
  rootsRef.current = roots;
  // Drag-and-drop state (D5): path currently being dragged, and which folder path
  // is the active drop target (for the highlight). null = none.
  const [draggedPath, setDraggedPath] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);

  const expandNode = (nodes: TreeNode[], path: string): TreeNode[] =>
    nodes.map((n) =>
      n.path === path
        ? { ...n, expanded: true }
        : n.children
          ? { ...n, children: expandNode(n.children, path) }
          : n,
    );
  const collapseNode = (nodes: TreeNode[], path: string): TreeNode[] =>
    nodes.map((n) =>
      n.path === path
        ? { ...n, expanded: false }
        : n.children
          ? { ...n, children: collapseNode(n.children, path) }
          : n,
    );

  useEffect(() => {
    setRoots([]);
    setLoaded(false);
    setSelectedDir(null);
    if (projectPath) post({ type: 'readDir', path: projectPath });
  }, [projectPath]);

  useEffect(() => {
    return subscribe((msg) => {
      if (msg.type !== 'dirEntries' || !projectPath) return;
      if (msg.path === projectPath) setLoaded(true);
      setRoots((prev) => applyEntries(prev, projectPath, msg.path, msg.entries));
    });
  }, [projectPath]);

  // Re-read the tree when the window regains focus or the tab becomes visible
  // again. This is the fix for J5: while the app is in the background an external
  // tool/agent/terminal may create or delete files; on returning to the window we
  // re-read the root and every currently-expanded directory so those changes show
  // up on their own — no Files↔Changes tab toggle needed. Reconciliation
  // (applyEntries) preserves which folders were expanded.
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
    return () => {
      window.removeEventListener('focus', doRefresh);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [projectPath]);

  const toggle = (node: TreeNode) => {
    if (node.kind === 'file') {
      // Opening a file means you're navigating, not folder-targeting — clear the
      // selection so the next create goes to root (deselect is always reachable,
      // even when the tree fills the panel and there is no empty space to click).
      setSelectedDir(null);
      onOpenFile(node.path);
      return;
    }
    // Clicking a dir selects it (for targeted create); toggle expand/collapse as before.
    setSelectedDir((prev) => (prev === node.path ? null : node.path));
    if (node.expanded) setRoots((prev) => collapseNode(prev, node.path));
    else if (node.children) setRoots((prev) => expandNode(prev, node.path));
    else post({ type: 'readDir', path: node.path });
  };

  // The immediate child names of `dir` already loaded in the tree (root or a folder),
  // used for UI-side collision validation. Empty if the directory isn't loaded yet.
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

  // Re-read a directory so applyEntries reconciles the on-disk change into the tree
  // (preserving expansion). `post` round-trips through dirEntries; expansion of the dir
  // itself is ensured by applyEntries when it has children, or by an explicit expand.
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

  /** Called when the user starts dragging a tree node. */
  const onDragStart = (e: React.DragEvent, node: TreeNode) => {
    e.dataTransfer.effectAllowed = 'copyMove';
    e.dataTransfer.setData('text/plain', node.path);
    setDraggedPath(node.path);
  };

  /** Called when a dragged item leaves a folder row (or the tree). */
  const onDragEnd = () => {
    setDraggedPath(null);
    setDropTarget(null);
  };

  /**
   * Resolve the effective drop-target directory for a given tree node.
   * Files target their parent directory; folders target themselves.
   */
  const dropDirFor = (node: TreeNode): string =>
    node.kind === 'dir' ? node.path : node.path.replace(/[\\/]+$/, '').replace(/[\\/][^\\/]+$/, '');

  /** Called when a dragged item moves over a tree node. */
  const onDragOver = (e: React.DragEvent, node: TreeNode) => {
    if (!draggedPath) return;
    const targetDir = dropDirFor(node);
    const intent = dropIntent({ source: draggedPath, targetDir, modifiers: { ctrl: e.ctrlKey } });
    if (!intent) return; // invalid drop — no highlight, no drop
    e.preventDefault();
    e.dataTransfer.dropEffect = intent.op === 'copy' ? 'copy' : 'move';
    setDropTarget(targetDir);
  };

  const onDragLeave = () => {
    setDropTarget(null);
  };

  /** Execute the drop: compute intent, call fsMove/fsCopy, refresh both dirs. */
  const onDrop = async (e: React.DragEvent, node: TreeNode) => {
    e.preventDefault();
    const source = draggedPath ?? e.dataTransfer.getData('text/plain');
    setDraggedPath(null);
    setDropTarget(null);
    if (!source) return;

    const targetDir = dropDirFor(node);
    const intent = dropIntent({
      source,
      targetDir,
      modifiers: { ctrl: e.ctrlKey, shift: e.shiftKey, alt: e.altKey },
    });
    if (!intent) return;

    const res =
      intent.op === 'copy'
        ? await fsDndCopy(source, intent.dest)
        : await fsDndMove(source, intent.dest);

    if (!res.ok) {
      pushToast({ message: res.error, variant: 'error' });
      return;
    }

    // Record the successful op into the undo stack.
    if (intent.op === 'copy') {
      recordFsOp?.({ kind: 'copy', from: source, to: intent.dest });
    } else {
      recordFsOp?.({ kind: 'move', from: source, to: intent.dest });
    }

    // Refresh: the source's parent dir (for move) and the target dir.
    const sourceParent = source.replace(/[\\/]+$/, '').replace(/[\\/][^\\/]+$/, '');
    if (intent.op === 'move') refreshDir(sourceParent);
    refreshDir(targetDir);
  };

  // Begin a draft. Creating inside a collapsed/unloaded folder first expands+loads it
  // so the new editable row appears in context.
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
    const rel = projectPath
      ? node.path.replace(projectPath.replace(/[\\/]+$/, ''), '').replace(/^[\\/]+/, '')
      : node.path;
    const parentDir = node.path.replace(/[\\/]+$/, '').replace(/[\\/][^\\/]+$/, '');
    const items: MenuItem[] = [];
    if (node.kind === 'file') {
      items.push({
        label: 'Open',
        icon: <IconDoc size={14} />,
        onClick: () => onOpenFile(node.path),
      });
      items.push({
        label: 'New file…',
        icon: <IconPlus size={14} />,
        separatorBefore: true,
        onClick: () => startCreate(parentDir, 'file'),
      });
    } else {
      items.push({
        label: 'New file…',
        icon: <IconPlus size={14} />,
        onClick: () => startCreate(node.path, 'file'),
      });
      items.push({
        label: 'New folder…',
        icon: <IconFolder size={14} />,
        onClick: () => startCreate(node.path, 'dir'),
      });
    }
    items.push(
      { label: 'Rename…', icon: <IconPencil size={14} />, onClick: () => startRename(node) },
      {
        label: 'Delete',
        icon: <IconTrash size={14} />,
        danger: true,
        onClick: () => onDelete(node, () => refreshDir(parentDir)),
      },
      {
        label: 'Reveal in Explorer',
        icon: <IconExternal size={14} />,
        separatorBefore: true,
        onClick: () => revealPath(node.path),
      },
      {
        label: 'Copy path',
        icon: <IconCopy size={14} />,
        onClick: () => copyToClipboard(node.path),
      },
      {
        label: 'Copy relative path',
        icon: <IconCopy size={14} />,
        onClick: () => copyToClipboard(rel),
      },
    );
    setMenu({ x: e.clientX, y: e.clientY, items });
  };

  // Right-click empty space → create at the root (or selected folder).
  const openRootMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    if (!projectPath) return;
    const target = resolveCreateTarget(selectedDir, projectPath);
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

  // Resolve the create target: selected folder or project root.
  const createTarget = resolveCreateTarget(selectedDir, projectPath);

  const searchActive = isSearchActive(searchText);

  return (
    <>
      {/* Integrated search bar — always visible at the top of the Files tab.
          hideResultsWhenEmpty keeps the bar compact while the tree is shown below. */}
      <SearchPane
        projectPath={projectPath}
        onOpenMatch={onOpenMatch}
        paneRef={searchPaneRef}
        onTextChange={setSearchText}
        hideResultsWhenEmpty={!searchActive}
      />
      {/* Header bar with root dir label + icon buttons — only shown when search is NOT active */}
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
            title={selectedDir ? `New file in ${nameOf(selectedDir)}` : 'New file at root'}
            aria-label={selectedDir ? `New file in ${nameOf(selectedDir)}` : 'New file at root'}
            onClick={() => startCreate(createTarget, 'file')}
          >
            <IconPlus size={15} />
          </button>
          <button
            type="button"
            className="iconbtn iconbtn--sm"
            title={selectedDir ? `New folder in ${nameOf(selectedDir)}` : 'New folder at root'}
            aria-label={selectedDir ? `New folder in ${nameOf(selectedDir)}` : 'New folder at root'}
            onClick={() => startCreate(createTarget, 'dir')}
          >
            <IconFolder size={15} />
          </button>
        </div>
      )}
      {/* File tree — hidden when search is active */}
      {!searchActive && (
        <div
          className="right__scroll right__scroll--files"
          onContextMenu={openRootMenu}
          onClick={(e) => {
            // Click on empty space → deselect the selected folder.
            if (e.target === e.currentTarget) setSelectedDir(null);
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
              {rows.map(({ node, depth }) => {
                if (draft?.mode === 'rename' && draft.path === node.path) {
                  return draftRow(draft, depth);
                }
                const isSelected = node.kind === 'dir' && node.path === selectedDir;
                const effectiveDropDir = dropDirFor(node);
                const isDropTarget = dropTarget !== null && dropTarget === effectiveDropDir;
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
                    className={`filerow${isSelected ? ' filerow--selected' : ''}${isDropTarget ? ' filerow--droptarget' : ''}`}
                    key={node.path}
                    style={{ paddingLeft: 10 + depth * 14 }}
                    draggable
                    onDragStart={(e) => onDragStart(e, node)}
                    onDragEnd={onDragEnd}
                    onDragOver={(e) => onDragOver(e, node)}
                    onDragLeave={onDragLeave}
                    onDrop={(e) => void onDrop(e, node)}
                    onClick={() => toggle(node)}
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
                    {node.kind === 'dir' && <IconFolder size={13} className="filerow__icon" />}
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
            </>
          )}
        </div>
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
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
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
  copyToClipboard,
  onDeleteFile,
  onFileRenamed,
  onChangeContextMenu,
  onReviewAll,
  onRefreshChanges,
  moveGrip,
  paneRef,
  recordFsOp,
}: {
  projectPath: string | undefined;
  changes: ChangeDTO[];
  onOpenFile: (absPath: string) => void;
  onOpenMatch: (abs: string, line: number, column: number) => void;
  onOpenDiff: (relPath: string) => void;
  onGitAction: (intent: GitActionIntent) => void;
  setMenu: (m: MenuState | null) => void;
  revealPath: (path: string) => void;
  copyToClipboard: (text: string) => void;
  onDeleteFile: (node: { path: string; kind: 'dir' | 'file' }, afterDeleted: () => void) => void;
  onFileRenamed: (fromPath: string, toPath: string) => void;
  onChangeContextMenu?: (e: React.MouseEvent, relPath: string) => void;
  /** Open the global Review view (R3). */
  onReviewAll?: () => void;
  /** Re-read the working-tree change list (R5.3 manual refresh). */
  onRefreshChanges?: () => void;
  // Barless panel: the tab row doubles as the panel-move drag surface (R5 alignment).
  moveGrip?: MoveGrip;
  paneRef?: React.MutableRefObject<RightPaneHandle | null>;
  /** Record a successful fs op into the app-level undo stack. */
  recordFsOp?: (op: FsOp) => void;
}) {
  const [tab, setTab] = useState<RightTab>('changes');
  // Bridge to the SearchPane's input focus (lives inside FilesView when the Files tab is active).
  const searchPaneRef = useRef<SearchPaneHandle | null>(null);

  useImperativeHandle(
    paneRef,
    () => ({
      openSearch() {
        setTab('files');
        // Focus after the tab mounts / is already mounted (next frame).
        requestAnimationFrame(() => searchPaneRef.current?.focusInput());
      },
    }),
    [],
  );

  return (
    <aside className="right">
      <div className="right__tabs" {...panelMoveDragProps(moveGrip)}>
        <button
          className={`rtab ${tab === 'changes' ? 'rtab--active' : ''}`}
          onClick={() => setTab('changes')}
        >
          Changes
          {(() => {
            const cls = changesBadgeClass(changes.length, tab === 'changes');
            return cls !== null ? <span className={cls}>{changes.length}</span> : null;
          })()}
        </button>
        <button
          className={`rtab ${tab === 'files' ? 'rtab--active' : ''}`}
          onClick={() => setTab('files')}
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
          onReviewAll={onReviewAll}
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
          copyToClipboard={copyToClipboard}
          onDelete={onDeleteFile}
          onRenamed={onFileRenamed}
          searchPaneRef={searchPaneRef}
          recordFsOp={recordFsOp}
        />
      )}
    </aside>
  );
}
