import { useState } from 'react';
import { VMChange, VMFileNode } from '../viewModel';
import { IconSearch, IconFolder, IconChevron } from '../icons';

function ChangesView({ changes }: { changes: VMChange[] }) {
  const totalAdd = changes.reduce((a, c) => a + c.added, 0);
  const totalDel = changes.reduce((a, c) => a + c.removed, 0);
  return (
    <>
      <div className="right__actions">
        <button className="btn btn--primary">Stage Changes</button>
        <button className="btn">Stash</button>
        <button className="btn btn--ghost">Reset all</button>
      </div>
      <div className="searchbox">
        <IconSearch size={13} />
        <input placeholder="Search changes" />
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
            <div className="change" key={c.path}>
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

function FilesView({ files }: { files: VMFileNode[] }) {
  return (
    <div className="right__scroll right__scroll--files">
      {files.map((f, i) => (
        <div
          className={`filerow ${f.status ? `filerow--${f.status}` : ''}`}
          key={i}
          style={{ paddingLeft: 10 + f.depth * 14 }}
        >
          {f.kind === 'dir' ? (
            <IconChevron size={12} className={`filerow__chev ${f.expanded ? 'filerow__chev--open' : ''}`} />
          ) : (
            <span className="filerow__chev-spacer" />
          )}
          {f.kind === 'dir' && <IconFolder size={13} className="filerow__icon" />}
          <span className="filerow__name">{f.name}</span>
          {f.status && <span className={`filerow__badge filerow__badge--${f.status}`}>{f.status}</span>}
        </div>
      ))}
    </div>
  );
}

export function RightPane({ changes, files }: { changes: VMChange[]; files: VMFileNode[] }) {
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
      {tab === 'changes' ? <ChangesView changes={changes} /> : <FilesView files={files} />}
    </aside>
  );
}
