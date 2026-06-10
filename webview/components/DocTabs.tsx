import type { OpenDoc } from '../docs';
import { IconSparkle, IconClose, IconBranch } from '../icons';

export function DocTabs({
  docs,
  activeId,
  terminalLabel,
  onSelect,
  onClose,
}: {
  docs: OpenDoc[];
  activeId: string | null;
  terminalLabel: string;
  onSelect: (id: string | null) => void;
  onClose: (id: string) => void;
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
        >
          {d.kind === 'diff' && <IconBranch size={12} className="tab__spark" />}
          <span>{d.title}</span>
          <span
            className="tab__close"
            title="Close"
            onClick={(e) => { e.stopPropagation(); onClose(d.id); }}
          >
            <IconClose size={12} />
          </span>
        </button>
      ))}
    </div>
  );
}
