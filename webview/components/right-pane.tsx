import { useEffect, useRef, useState } from 'react';
import type { GitOp } from '../../src/git-actions';
import type { ChangeDTO } from '../../src/protocol';
import { post, subscribe } from '../bridge';
import { applyEntries, pathsToRefresh, type TreeNode } from '../file-tree';
import { IconChevron, IconFolder } from '../icons';

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
}: {
  changes: ChangeDTO[];
  onOpenDiff: (relPath: string) => void;
  onAction: (intent: GitActionIntent) => void;
  onChangeContextMenu?: (e: React.MouseEvent, relPath: string) => void;
}) {
  if (changes.length === 0) return <div className="right__empty">No changes</div>;

  const staged = changes.filter((c) => c.staged);
  const unstaged = changes.filter((c) => !c.staged);
  const totalAdd = changes.reduce((a, c) => a + c.added, 0);
  const totalDel = changes.reduce((a, c) => a + c.removed, 0);

  return (
    <>
      <div className="right__actions">
        <button
          type="button"
          className="btn btn--primary"
          disabled={unstaged.length === 0}
          onClick={() => onAction({ op: 'stageAll' })}
        >
          Stage all
        </button>
        <button
          type="button"
          className="btn"
          disabled={staged.length === 0}
          onClick={() => onAction({ op: 'unstageAll' })}
        >
          Unstage all
        </button>
        <button type="button" className="btn" onClick={() => onAction({ op: 'stashPush' })}>
          Stash
        </button>
        <button type="button" className="btn" onClick={() => onAction({ op: 'stashPop' })}>
          Pop
        </button>
        <button
          type="button"
          className="btn btn--ghost"
          disabled={changes.length === 0}
          onClick={() => onAction({ op: 'discardAll' })}
        >
          Discard all
        </button>
      </div>
      <div className="changes__summary">
        <span>{changes.length} changes</span>
        <span className="diffstat">
          <span className="diffstat--add">+{totalAdd}</span>{' '}
          <span className="diffstat--del">-{totalDel}</span>
        </span>
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
    </>
  );
}

function FilesView({
  projectPath,
  onOpenFile,
  onFileContextMenu,
}: {
  projectPath: string | undefined;
  onOpenFile: (absPath: string) => void;
  onFileContextMenu?: (e: React.MouseEvent, node: { path: string; kind: 'dir' | 'file' }) => void;
}) {
  const [roots, setRoots] = useState<TreeNode[]>([]);
  const [loaded, setLoaded] = useState(false);
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

  const rows: { node: TreeNode; depth: number }[] = [];
  const walk = (nodes: TreeNode[], depth: number) => {
    for (const n of nodes) {
      rows.push({ node: n, depth });
      if (n.kind === 'dir' && n.expanded && n.children) walk(n.children, depth + 1);
    }
  };
  walk(roots, 0);

  if (!projectPath) return <div className="right__empty">No active project</div>;
  if (roots.length === 0)
    return <div className="right__empty">{loaded ? 'No files' : 'Loading…'}</div>;

  return (
    <div className="right__scroll right__scroll--files">
      {rows.map(({ node, depth }) => (
        <div
          className="filerow"
          key={node.path}
          style={{ paddingLeft: 10 + depth * 14 }}
          onClick={() => toggle(node)}
          onContextMenu={
            onFileContextMenu
              ? (e) => onFileContextMenu(e, { path: node.path, kind: node.kind })
              : undefined
          }
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
        </div>
      ))}
    </div>
  );
}

export function RightPane({
  projectPath,
  changes,
  onOpenFile,
  onOpenDiff,
  onGitAction,
  onFileContextMenu,
  onChangeContextMenu,
}: {
  projectPath: string | undefined;
  changes: ChangeDTO[];
  onOpenFile: (absPath: string) => void;
  onOpenDiff: (relPath: string) => void;
  onGitAction: (intent: GitActionIntent) => void;
  onFileContextMenu?: (e: React.MouseEvent, node: { path: string; kind: 'dir' | 'file' }) => void;
  onChangeContextMenu?: (e: React.MouseEvent, relPath: string) => void;
}) {
  const [tab, setTab] = useState<'changes' | 'files'>('changes');
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
        />
      ) : (
        <FilesView
          projectPath={projectPath}
          onOpenFile={onOpenFile}
          onFileContextMenu={onFileContextMenu}
        />
      )}
    </aside>
  );
}
