import { useEffect, useImperativeHandle, useRef, useState } from 'react';
import type { GitOp } from '../../src/git-actions';
import { anchorMenuToRect } from '../../src/menu-position';
import { menuToggleIntent } from '../../src/menu-toggle';
import type { ChangeDTO } from '../../src/protocol';
import { fsMutate, post, subscribe } from '../bridge';
import { applyEntries, joinPath, pathsToRefresh, type TreeNode, validateName } from '../file-tree';
import {
  IconChevron,
  IconCopy,
  IconDoc,
  IconExternal,
  IconFolder,
  IconMore,
  IconPencil,
  IconPlus,
  IconReview,
  IconTrash,
} from '../icons';
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
}: {
  changes: ChangeDTO[];
  onOpenDiff: (relPath: string) => void;
  onAction: (intent: GitActionIntent) => void;
  onChangeContextMenu?: (e: React.MouseEvent, relPath: string) => void;
  /** Open the global Review view (R3) stacking every change as hunk cards. */
  onReviewAll?: () => void;
}) {
  // Kebab menu state: the local ContextMenu is anchored to the three-dot trigger.
  const [bulkMenu, setBulkMenu] = useState<MenuState | null>(null);
  const kebabRef = useRef<HTMLButtonElement | null>(null);
  const wasOpenRef = useRef(false);

  if (changes.length === 0)
    return <EmptyState title="No changes" hint="The working tree is clean." />;

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
  onOpenFile,
  setMenu,
  revealPath,
  copyToClipboard,
  onDelete,
  onRenamed,
}: {
  projectPath: string | undefined;
  onOpenFile: (absPath: string) => void;
  setMenu: (m: MenuState | null) => void;
  revealPath: (path: string) => void;
  copyToClipboard: (text: string) => void;
  // App owns the destructive flow (confirm + recycle-bin / permanent fallback + closing
  // any open doc tab for the deleted file). It calls `afterDeleted` on a successful
  // removal so the tree refreshes.
  onDelete: (node: { path: string; kind: 'dir' | 'file' }, afterDeleted: () => void) => void;
  // A file was renamed on disk; app updates/closes any open doc tab for the old path.
  onRenamed: (fromPath: string, toPath: string) => void;
}) {
  const [roots, setRoots] = useState<TreeNode[]>([]);
  const [loaded, setLoaded] = useState(false);
  // The single active inline draft (create or rename), or null. Only one at a time.
  const [draft, setDraft] = useState<Draft | null>(null);
  // Latest tree, mirrored into a ref so the focus-refresh handler can read the
  // current expansion state without re-subscribing on every keystroke of growth.
  const rootsRef = useRef<TreeNode[]>([]);
  rootsRef.current = roots;

  const expand = (nodes: TreeNode[], path: string): TreeNode[] =>
    nodes.map((n) =>
      n.path === path
        ? { ...n, expanded: true }
        : n.children
          ? { ...n, children: expand(n.children, path) }
          : n,
    );
  const collapse = (nodes: TreeNode[], path: string): TreeNode[] =>
    nodes.map((n) =>
      n.path === path
        ? { ...n, expanded: false }
        : n.children
          ? { ...n, children: collapse(n.children, path) }
          : n,
    );

  useEffect(() => {
    setRoots([]);
    setLoaded(false);
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
    const refresh = () => {
      if (document.visibilityState === 'hidden') return;
      for (const dir of pathsToRefresh(rootsRef.current, projectPath)) {
        post({ type: 'readDir', path: dir });
      }
    };
    const onVisibility = () => {
      if (document.visibilityState === 'visible') refresh();
    };
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [projectPath]);

  const toggle = (node: TreeNode) => {
    if (node.kind === 'file') {
      onOpenFile(node.path);
      return;
    }
    if (node.expanded) setRoots((prev) => collapse(prev, node.path));
    else if (node.children) setRoots((prev) => expand(prev, node.path));
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
    if (projectPath && dir !== projectPath) setRoots((prev) => expand(prev, dir));
    post({ type: 'readDir', path: dir });
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
      refreshDir(d.dir);
      if (d.kind === 'file') onOpenFile(targetPath);
    } else {
      const res = await fsMutate({ op: 'rename', from: d.path, to: targetPath });
      if (!res.ok) {
        pushToast({ message: res.error, variant: 'error' });
        return;
      }
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

  // Right-click empty space (or the New buttons in the header) → create at the root.
  const openRootMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    if (!projectPath) return;
    setMenu({
      x: e.clientX,
      y: e.clientY,
      items: [
        {
          label: 'New file…',
          icon: <IconPlus size={14} />,
          onClick: () => startCreate(projectPath, 'file'),
        },
        {
          label: 'New folder…',
          icon: <IconFolder size={14} />,
          onClick: () => startCreate(projectPath, 'dir'),
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

  return (
    <>
      <div className="files__bar">
        <span className="panel-title">Explorer</span>
        <button
          type="button"
          className="files__newbtn"
          title="New file at root"
          onClick={() => projectPath && startCreate(projectPath, 'file')}
        >
          <IconPlus size={13} />
        </button>
        <button
          type="button"
          className="files__newbtn"
          title="New folder at root"
          onClick={() => projectPath && startCreate(projectPath, 'dir')}
        >
          <IconFolder size={13} />
        </button>
      </div>
      <div
        className="right__scroll right__scroll--files"
        onContextMenu={openRootMenu}
        onClick={() => setMenu(null)}
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
              const elems = [
                <div
                  className="filerow"
                  key={node.path}
                  style={{ paddingLeft: 10 + depth * 14 }}
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

type RightTab = 'changes' | 'search' | 'files';

/** Imperative handle so App's Mod+Shift+F can switch to Search and focus its input. */
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
  paneRef,
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
  paneRef?: React.MutableRefObject<RightPaneHandle | null>;
}) {
  const [tab, setTab] = useState<RightTab>('changes');
  // Bridge to the SearchPane's input focus (set when the Search tab is mounted).
  const searchPaneRef = useRef<SearchPaneHandle | null>(null);

  useImperativeHandle(
    paneRef,
    () => ({
      openSearch() {
        setTab('search');
        // Focus after the tab mounts the SearchPane (next frame).
        requestAnimationFrame(() => searchPaneRef.current?.focusInput());
      },
    }),
    [],
  );

  return (
    <aside className="right">
      <div className="right__tabs">
        <button
          className={`rtab ${tab === 'changes' ? 'rtab--active' : ''}`}
          onClick={() => setTab('changes')}
        >
          Changes
        </button>
        <button
          className={`rtab ${tab === 'search' ? 'rtab--active' : ''}`}
          onClick={() => setTab('search')}
        >
          Search
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
        />
      ) : tab === 'search' ? (
        <SearchPane projectPath={projectPath} onOpenMatch={onOpenMatch} paneRef={searchPaneRef} />
      ) : (
        <FilesView
          projectPath={projectPath}
          onOpenFile={onOpenFile}
          setMenu={setMenu}
          revealPath={revealPath}
          copyToClipboard={copyToClipboard}
          onDelete={onDeleteFile}
          onRenamed={onFileRenamed}
        />
      )}
    </aside>
  );
}
