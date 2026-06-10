import { useEffect, useState } from 'react';
import type { ChangeDTO, DirEntryDTO } from '../../src/protocol';
import { post, subscribe } from '../bridge';
import { IconSearch, IconFolder, IconChevron } from '../icons';

function ChangesView({
  changes,
  onOpenDiff,
  onChangeContextMenu,
}: {
  changes: ChangeDTO[];
  onOpenDiff: (relPath: string) => void;
  onChangeContextMenu?: (e: React.MouseEvent, relPath: string) => void;
}) {
  if (changes.length === 0) return <div className="right__empty">No changes</div>;
  const totalAdd = changes.reduce((a, c) => a + c.added, 0);
  const totalDel = changes.reduce((a, c) => a + c.removed, 0);
  return (
    <>
      <div className="right__actions">
        <button className="btn btn--primary">Stage Changes</button>
        <button className="btn">Stash</button>
        <button className="btn btn--ghost">Reset all</button>
      </div>
      <div className="changes__summary">
        <span>{changes.length} files</span>
        <span className="diffstat">
          <span className="diffstat--add">+{totalAdd}</span>{' '}
          <span className="diffstat--del">-{totalDel}</span>
        </span>
      </div>
      <div className="right__scroll">
        {changes.map((c) => {
          const parts = c.path.split('/');
          const file = parts.pop()!;
          const dir = parts.join('/');
          return (
            <div
              className="change"
              key={c.path}
              onClick={() => onOpenDiff(c.path)}
              onContextMenu={onChangeContextMenu ? (e) => onChangeContextMenu(e, c.path) : undefined}
              title="Open diff"
            >
              <span className={`change__kind change__kind--${c.kind}`}>{c.kind}</span>
              <span className="change__path">
                {dir && <span className="change__dir">{dir}/</span>}
                <span className="change__file">{file}</span>
              </span>
              <span className="change__stat">
                {c.added > 0 && <span className="diffstat--add">+{c.added}</span>}
                {c.removed > 0 && <span className="diffstat--del"> -{c.removed}</span>}
              </span>
            </div>
          );
        })}
      </div>
    </>
  );
}

interface TreeNode {
  name: string;
  path: string; // absolute
  kind: 'dir' | 'file';
  expanded: boolean;
  children?: TreeNode[];
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
  const join = (base: string, name: string) => `${base.replace(/[\\/]+$/, '')}/${name}`;

  const graft = (nodes: TreeNode[], path: string, children: TreeNode[]): TreeNode[] =>
    nodes.map((n) => {
      if (n.path === path) return { ...n, expanded: true, children };
      if (n.children) return { ...n, children: graft(n.children, path, children) };
      return n;
    });
  const expand = (nodes: TreeNode[], path: string): TreeNode[] =>
    nodes.map((n) =>
      n.path === path ? { ...n, expanded: true }
        : n.children ? { ...n, children: expand(n.children, path) } : n,
    );
  const collapse = (nodes: TreeNode[], path: string): TreeNode[] =>
    nodes.map((n) =>
      n.path === path ? { ...n, expanded: false }
        : n.children ? { ...n, children: collapse(n.children, path) } : n,
    );

  useEffect(() => {
    setRoots([]);
    setLoaded(false);
    if (projectPath) post({ type: 'readDir', path: projectPath });
  }, [projectPath]);

  useEffect(() => {
    return subscribe((msg) => {
      if (msg.type !== 'dirEntries') return;
      const children: TreeNode[] = msg.entries.map((e: DirEntryDTO) => ({
        name: e.name,
        path: join(msg.path, e.name),
        kind: e.kind,
        expanded: false,
      }));
      if (projectPath && msg.path === projectPath) {
        setRoots(children);
        setLoaded(true);
        return;
      }
      setRoots((prev) => graft(prev, msg.path, children));
    });
  }, [projectPath]);

  const toggle = (node: TreeNode) => {
    if (node.kind === 'file') { onOpenFile(node.path); return; }
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
  if (roots.length === 0) return <div className="right__empty">{loaded ? 'No files' : 'Loading…'}</div>;

  return (
    <div className="right__scroll right__scroll--files">
      {rows.map(({ node, depth }) => (
        <div
          className="filerow"
          key={node.path}
          style={{ paddingLeft: 10 + depth * 14 }}
          onClick={() => toggle(node)}
          onContextMenu={onFileContextMenu ? (e) => onFileContextMenu(e, { path: node.path, kind: node.kind }) : undefined}
        >
          {node.kind === 'dir' ? (
            <IconChevron size={12} className={`filerow__chev ${node.expanded ? 'filerow__chev--open' : ''}`} />
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
  onFileContextMenu,
  onChangeContextMenu,
}: {
  projectPath: string | undefined;
  changes: ChangeDTO[];
  onOpenFile: (absPath: string) => void;
  onOpenDiff: (relPath: string) => void;
  onFileContextMenu?: (e: React.MouseEvent, node: { path: string; kind: 'dir' | 'file' }) => void;
  onChangeContextMenu?: (e: React.MouseEvent, relPath: string) => void;
}) {
  const [tab, setTab] = useState<'changes' | 'files'>('changes');
  return (
    <aside className="right">
      <div className="right__tabs">
        <button className={`rtab ${tab === 'changes' ? 'rtab--active' : ''}`} onClick={() => setTab('changes')}>
          Changes
        </button>
        <button className={`rtab ${tab === 'files' ? 'rtab--active' : ''}`} onClick={() => setTab('files')}>
          Files
        </button>
      </div>
      {tab === 'changes'
        ? <ChangesView changes={changes} onOpenDiff={onOpenDiff} onChangeContextMenu={onChangeContextMenu} />
        : <FilesView projectPath={projectPath} onOpenFile={onOpenFile} onFileContextMenu={onFileContextMenu} />}
    </aside>
  );
}
