import { useRef, useState } from 'react';
import type { OpenDoc } from '../docs';
import { IconBranch, IconClose, IconSparkle } from '../icons';

export function DocTabs({
  docs,
  activeId,
  terminalLabel,
  onSelect,
  onClose,
  onTabContextMenu,
  onReorder,
  moveGrip,
}: {
  docs: OpenDoc[];
  activeId: string | null;
  terminalLabel: string;
  onSelect: (id: string | null) => void;
  onClose: (id: string) => void;
  onTabContextMenu?: (e: React.MouseEvent, doc: OpenDoc) => void;
  onReorder?: (dragId: string, targetId: string | null) => void;
  /** Drag handle to re-dock the center (terminal/editor) panel between slots. */
  moveGrip?: { onDragStart: () => void; onDragEnd: () => void };
}) {
  const dragIdRef = useRef<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);

  return (
    <div className="tabbar">
      {moveGrip && (
        <div
          className="tabbar__grip"
          draggable
          title="Drag to move the terminal / editor panel"
          onDragStart={(e) => {
            e.dataTransfer.effectAllowed = 'move';
            moveGrip.onDragStart();
          }}
          onDragEnd={moveGrip.onDragEnd}
        >
          ⠿
        </div>
      )}
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
          className={`tab ${activeId === d.id ? 'tab--active' : ''} ${overId === d.id ? 'tab--dropbefore' : ''}`}
          onClick={() => onSelect(d.id)}
          onContextMenu={onTabContextMenu ? (e) => onTabContextMenu(e, d) : undefined}
          draggable={!!onReorder}
          onDragStart={(e) => {
            dragIdRef.current = d.id;
            e.dataTransfer.effectAllowed = 'move';
          }}
          onDragOver={(e) => {
            const dr = dragIdRef.current;
            if (dr && dr !== d.id) {
              e.preventDefault();
              setOverId(d.id);
            }
          }}
          onDragLeave={() => setOverId((o) => (o === d.id ? null : o))}
          onDrop={(e) => {
            e.preventDefault();
            const dr = dragIdRef.current;
            if (dr) onReorder?.(dr, d.id);
            dragIdRef.current = null;
            setOverId(null);
          }}
          onDragEnd={() => {
            dragIdRef.current = null;
            setOverId(null);
          }}
        >
          {d.kind === 'diff' && <IconBranch size={12} className="tab__spark" />}
          <span>{d.title}</span>
          <button
            className="tab__close"
            aria-label="Close tab"
            onClick={(e) => {
              e.stopPropagation();
              onClose(d.id);
            }}
          >
            <IconClose size={12} />
          </button>
        </button>
      ))}
    </div>
  );
}
