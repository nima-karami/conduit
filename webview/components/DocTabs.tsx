import type { OpenDoc } from '../docs';
import { IconSparkle, IconClose, IconBranch } from '../icons';

export function DocTabs({
  docs,
  activeId,
  terminalLabel,
  onSelect,
  onClose,
  onTabContextMenu,
}: {
  docs: OpenDoc[];
  activeId: string | null;
  terminalLabel: string;
  onSelect: (id: string | null) => void;
  onClose: (id: string) => void;
  onTabContextMenu?: (e: React.MouseEvent, doc: OpenDoc) => void;
}) {
  return (
    <div className="tabbar">
      <button
        className={`tab ${activeId === null ? 'tab--active' : ''}`}
        onClick={() => onSelect(null)}
      >
        <IconSparkle size={13} className="tab__spark" />
        <span>{terminalLabel}</span>
      </button>
      {docs.map((d) => (
        <button
          key={d.id}
          className={`tab ${activeId === d.id ? 'tab--active' : ''}`}
          onClick={() => onSelect(d.id)}
          onContextMenu={onTabContextMenu ? (e) => onTabContextMenu(e, d) : undefined}
        >
          {d.kind === 'diff' && <IconBranch size={12} className="tab__spark" />}
          <span>{d.title}</span>
          <button
            className="tab__close"
            aria-label="Close tab"
            onClick={(e) => { e.stopPropagation(); onClose(d.id); }}
          >
            <IconClose size={12} />
          </button>
        </button>
      ))}
    </div>
  );
}
