import { useEffect, useRef, useState } from 'react';
import type { CenterLayout, GroupIndex, GroupView } from '../doc-groups';
import type { OpenDoc } from '../docs';
import { clampSplitRatio, stepSplitRatio } from '../editor-split';
import { SPLIT_COPY } from '../split-editor-copy';

const STEP_KEYS = new Set(['ArrowLeft', 'ArrowRight', 'Home', 'End']);

export function EditorGroups({
  layout,
  ratio,
  onRatioCommit,
  renderGroup,
  webDocs,
  webPlacement,
  renderWeb,
  onFocusGroup,
}: {
  layout: CenterLayout;
  ratio: number;
  onRatioCommit: (r: number) => void;
  renderGroup: (view: GroupView) => React.ReactNode;
  webDocs: OpenDoc[];
  webPlacement: (id: string) => { group: GroupIndex; visible: boolean } | null;
  renderWeb: (doc: OpenDoc) => React.ReactNode;
  onFocusGroup: (g: GroupIndex) => void;
}) {
  const gridRef = useRef<HTMLDivElement>(null);
  const [liveRatio, setLiveRatio] = useState(ratio);
  const [dragging, setDragging] = useState(false);
  useEffect(() => setLiveRatio(ratio), [ratio]);

  const split = layout.groups.length === 2;
  const r = split ? liveRatio : 1;
  const columns = split ? `minmax(0, ${r}fr) auto minmax(0, ${1 - r}fr)` : 'minmax(0, 1fr)';

  const onDividerPointerDown = (e: React.PointerEvent) => {
    const grid = gridRef.current;
    if (!grid || e.button !== 0) return;
    e.preventDefault();
    let next = liveRatio;
    const onMove = (ev: PointerEvent) => {
      const rect = grid.getBoundingClientRect();
      next = clampSplitRatio((ev.clientX - rect.left) / rect.width, grid.clientWidth);
      setLiveRatio(next);
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      setDragging(false);
      onRatioCommit(next);
    };
    setDragging(true);
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  const onDividerKeyDown = (e: React.KeyboardEvent) => {
    const grid = gridRef.current;
    if (!grid || !STEP_KEYS.has(e.key)) return;
    e.preventDefault();
    const next = stepSplitRatio(
      liveRatio,
      grid.clientWidth,
      e.key as 'ArrowLeft' | 'ArrowRight' | 'Home' | 'End',
      e.shiftKey,
    );
    setLiveRatio(next);
    onRatioCommit(next);
  };

  return (
    <div
      ref={gridRef}
      className="editorgroups"
      data-split={split || undefined}
      data-resizing={dragging || undefined}
      style={{ gridTemplateColumns: columns }}
    >
      {layout.groups.map((view) => renderGroup(view))}
      {split && (
        <div
          className="editorgroups__divider"
          role="separator"
          aria-orientation="vertical"
          aria-valuenow={Math.round(liveRatio * 100)}
          aria-label={SPLIT_COPY.divider}
          tabIndex={0}
          onPointerDown={onDividerPointerDown}
          onKeyDown={onDividerKeyDown}
        />
      )}
      {webDocs.map((doc) => {
        const placement = webPlacement(doc.id);
        if (!placement) return null;
        return (
          // see split-editor plan P7: a direct child of the grid for its whole life, never reparented.
          <div
            key={doc.id}
            className="webhost"
            data-group={placement.group}
            hidden={!placement.visible}
            onFocusCapture={() => onFocusGroup(placement.group)}
          >
            {renderWeb(doc)}
          </div>
        );
      })}
    </div>
  );
}
