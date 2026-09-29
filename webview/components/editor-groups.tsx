import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { CenterLayout, GroupIndex, GroupView } from '../doc-groups';
import type { OpenDoc } from '../docs';
import { clampSplitRatio, stepSplitRatio } from '../editor-split';
import { SPLIT_COPY } from '../split-editor-copy';
import {
  acceptTabDrop,
  currentTabDrag,
  endTabDrag,
  subscribeTabDrag,
  type TabDrag,
} from '../tab-drag';

const STEP_KEYS = new Set(['ArrowLeft', 'ArrowRight', 'Home', 'End']);

/** The width the two fr columns share: the grid's, less the divider's own column. */
const groupsWidth = (grid: HTMLElement, divider: HTMLElement) =>
  grid.clientWidth - divider.offsetWidth;

type DropKind = 'group' | 'edge';

/** What a tab drop at `clientX` over group `g`'s body does (spec §2.4 flows 3–4). */
function dropKindAt(
  drag: TabDrag,
  g: GroupIndex,
  split: boolean,
  zone: HTMLElement,
  clientX: number,
): DropKind | null {
  if (drag.group !== g) return 'group';
  if (split) return null;
  const box = zone.getBoundingClientRect();
  return clientX >= box.left + (box.width * 2) / 3 ? 'edge' : null;
}

export function EditorGroups({
  layout,
  ratio,
  onRatioCommit,
  renderGroup,
  webDocs,
  webPlacement,
  renderWeb,
  onFocusGroup,
  onMoveTab,
}: {
  layout: CenterLayout;
  ratio: number;
  onRatioCommit: (r: number) => void;
  renderGroup: (view: GroupView) => React.ReactNode;
  webDocs: OpenDoc[];
  webPlacement: (id: string) => { group: GroupIndex; visible: boolean } | null;
  renderWeb: (doc: OpenDoc) => React.ReactNode;
  onFocusGroup: (g: GroupIndex) => void;
  onMoveTab: (id: string, toGroup: GroupIndex, beforeId: string | null, duplicate: boolean) => void;
}) {
  const gridRef = useRef<HTMLDivElement>(null);
  const [liveRatio, setLiveRatio] = useState(ratio);
  const [dragging, setDragging] = useState(false);
  useEffect(() => setLiveRatio(ratio), [ratio]);
  const tabDrag = useSyncExternalStore(subscribeTabDrag, currentTabDrag, currentTabDrag);
  const [over, setOver] = useState<{ group: GroupIndex; kind: DropKind } | null>(null);
  useEffect(() => {
    if (tabDrag === null) setOver(null);
  }, [tabDrag]);

  const split = layout.groups.length === 2;
  const r = split ? liveRatio : 1;
  const columns = split ? `minmax(0, ${r}fr) auto minmax(0, ${1 - r}fr)` : 'minmax(0, 1fr)';

  const onDividerPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    const grid = gridRef.current;
    const divider = e.currentTarget;
    if (!grid || e.button !== 0) return;
    e.preventDefault();
    let next = liveRatio;
    const onMove = (ev: PointerEvent) => {
      const width = groupsWidth(grid, divider);
      const left = ev.clientX - grid.getBoundingClientRect().left - divider.offsetWidth / 2;
      next = clampSplitRatio(left / width, width);
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

  const onDividerKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const grid = gridRef.current;
    if (!grid || !STEP_KEYS.has(e.key)) return;
    e.preventDefault();
    const next = stepSplitRatio(
      liveRatio,
      groupsWidth(grid, e.currentTarget),
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
      {tabDrag !== null &&
        layout.groups.map(({ group: g }) => {
          const kind = over?.group === g ? over.kind : null;
          return (
            <div
              key={`drop-${g}`}
              className={`editorgroups__drop${kind === 'edge' ? ' editorgroups__drop--edge' : ''}`}
              data-group={g}
              data-over={kind ?? undefined}
              onDragOver={(e) => {
                const drag = currentTabDrag();
                const next = drag && dropKindAt(drag, g, split, e.currentTarget, e.clientX);
                if (next) acceptTabDrop(e);
                setOver(next ? { group: g, kind: next } : null);
              }}
              onDragLeave={() => setOver((o) => (o?.group === g ? null : o))}
              onDrop={(e) => {
                e.preventDefault();
                const drag = currentTabDrag();
                const kind = drag && dropKindAt(drag, g, split, e.currentTarget, e.clientX);
                endTabDrag();
                if (drag && kind) onMoveTab(drag.id, kind === 'edge' ? 2 : g, null, e.ctrlKey);
              }}
            />
          );
        })}
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
