import { useRef, useState, useSyncExternalStore } from 'react';
import { getDirtySnapshot, subscribeDirty } from '../dirty-store';
import type { OpenDoc } from '../docs';
import { isPanelDragTarget } from '../drag-guard';
import { IconBranch, IconClose, IconSparkle } from '../icons';

/** Subscribe to the shared dirty set so each tab can show an unsaved-changes dot. */
function useDirtySet(): ReadonlySet<string> {
  return useSyncExternalStore(subscribeDirty, getDirtySnapshot, getDirtySnapshot);
}

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
  /**
   * Re-dock the center (terminal/editor) panel between slots. When present, the tab-bar
   * background itself is the drag surface — dragging an empty area of the bar moves the
   * panel; dragging a tab still does the intra-bar reorder (tabs own their own drag).
   */
  moveGrip?: { onDragStart: () => void; onDragEnd: () => void };
}) {
  const dragIdRef = useRef<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);
  const dirty = useDirtySet();

  return (
    <div
      className="tabbar"
      draggable={!!moveGrip}
      onDragStart={
        moveGrip
          ? (e) => {
              // Only the bar background moves the panel; a tab's own drag (reorder) or
              // a control must not be hijacked. Don't preventDefault here — that would
              // also cancel a child tab's drag; just bail so the child's drag proceeds.
              if (!isPanelDragTarget(e.target as Element, e.currentTarget)) return;
              e.dataTransfer.effectAllowed = 'move';
              moveGrip.onDragStart();
            }
          : undefined
      }
      onDragEnd={moveGrip?.onDragEnd}
    >
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
          className={`tab ${activeId === d.id ? 'tab--active' : ''} ${overId === d.id ? 'tab--dropbefore' : ''} ${dirty.has(d.path) ? 'tab--dirty' : ''}`}
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
          {dirty.has(d.path) && (
            <span className="tab__dirty" aria-label="Unsaved changes" title="Unsaved changes" />
          )}
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
