import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { menuToggleIntent } from '../../src/menu-toggle';
import type { ResolvedSessionIcon } from '../../src/session-icon';
import { AUTO_SAVE_COPY } from '../auto-save-copy';
import { getDirtySnapshot, subscribeDirty } from '../dirty-store';
import { type GroupIndex, splitBehavior } from '../doc-groups';
import type { OpenDoc } from '../docs';
import { isPanelDragTarget } from '../drag-guard';
import { stampFileDrag } from '../file-drag-data';
import type { FileSaveStatus } from '../file-save-controller';
import {
  IconBranch,
  IconCheck,
  IconChevronDown,
  IconClose,
  IconReview,
  IconSplit,
  IconWarning,
  SessionGlyph,
} from '../icons';
import { middleClickProps } from '../middle-click';
import { saveDocByPath } from '../save-registry';
import { SPLIT_COPY } from '../split-editor-copy';
import { acceptTabDrop, beginTabDrag, endTabDrag, tabDragOf } from '../tab-drag';
import { isStripOverflowing, scrollTargetTabId, TERMINAL_TABID } from '../tab-overflow';
import { ContextMenu, type MenuState } from './context-menu';

/** Subscribe to the shared dirty set so each tab can show an unsaved-changes dot. */
function useDirtySet(): ReadonlySet<string> {
  return useSyncExternalStore(subscribeDirty, getDirtySnapshot, getDirtySnapshot);
}

const NO_SAVE_STATUSES: ReadonlyMap<string, FileSaveStatus> = new Map();

export function DocTabs({
  group,
  groupActive,
  showTerminal,
  split,
  onStripContextMenu,
  docs,
  activeId,
  previewIds,
  terminalLabel,
  terminalIcon,
  onSelect,
  onClose,
  onTabContextMenu,
  onTerminalTabContextMenu,
  onReorder,
  onPinDoc,
  onMoveTab,
  moveGrip,
  flashTabId = null,
  saveStatuses = NO_SAVE_STATUSES,
}: {
  group: GroupIndex;
  /** The strip's group is the active one: its active tab takes the full active treatment. */
  groupActive: boolean;
  /** Group 1 only (spec I5). */
  showTerminal: boolean;
  split: { disabledReason: string | null; onSplit: () => void };
  onStripContextMenu?: (e: React.MouseEvent) => void;
  docs: OpenDoc[];
  activeId: string | null;
  previewIds: ReadonlySet<string>;
  terminalLabel: string;
  // Resolved icon for the terminal tab — the active session's icon (iconOverride,
  // appIcon, or agent-derived kind), falling back to the plain terminal glyph.
  terminalIcon: ResolvedSessionIcon;
  onSelect: (id: string | null) => void;
  onClose: (id: string) => void;
  onTabContextMenu?: (e: React.MouseEvent, doc: OpenDoc) => void;
  onTerminalTabContextMenu?: (e: React.MouseEvent) => void;
  onReorder?: (dragId: string, targetId: string | null) => void;
  /** Promote a preview tab (file/diff/commit-diff) to a permanent one — double-clicking it. */
  onPinDoc?: (id: string) => void;
  /** A tab dropped here from the other group's strip; `duplicate` is a Ctrl-drop. */
  onMoveTab?: (
    id: string,
    toGroup: GroupIndex,
    beforeId: string | null,
    duplicate: boolean,
  ) => void;
  /**
   * Re-dock the center (terminal/editor) panel between slots. When present, the tab-bar
   * background itself is the drag surface — dragging an empty area of the bar moves the
   * panel; dragging a tab still does the intra-bar reorder (tabs own their own drag).
   */
  moveGrip?: { onDragStart: () => void; onDragEnd: () => void };
  /** The tab a background open just touched; cued briefly (spec 2026-09-22-middle-click-new-tab §3). */
  flashTabId?: string | null;
  /** Per-path auto-save status, for the conflict marker. Passed in rather than read from the
   *  save store here, which would pull Monaco into the tab strip. */
  saveStatuses?: ReadonlyMap<string, FileSaveStatus>;
}) {
  const [overId, setOverId] = useState<string | null>(null);
  // Hovering the trailing strip past the last tab — drops there move the tab to the end
  // (targetId=null). Without it the rightmost slot was unreachable (R5.6).
  const [overEnd, setOverEnd] = useState(false);
  const dirty = useDirtySet();
  const saves = saveStatuses;

  // The scrollable strip (not the outer wrapper) — for horizontal-on-vertical-wheel and
  // scroll-active-tab-into-view.
  const stripRef = useRef<HTMLDivElement>(null);

  const [dropdownMenu, setDropdownMenu] = useState<MenuState | null>(null);
  const dropdownTriggerRef = useRef<HTMLButtonElement>(null);
  // Whether the menu was open at the trigger's last mousedown, so menuToggleIntent can
  // decide open vs. stay-closed.
  const wasOpenRef = useRef(false);

  // The chevron renders ONLY when the strip overflows (no permanent box when all fits).
  const [hasOverflow, setHasOverflow] = useState(false);

  const scrollTabIntoView = useCallback((tabid: string) => {
    const tabEl = stripRef.current?.querySelector<HTMLElement>(
      `[data-tabid="${CSS.escape(tabid)}"]`,
    );
    tabEl?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, []);

  const measureOverflow = useCallback(() => {
    const el = stripRef.current;
    if (!el) return;
    setHasOverflow(isStripOverflowing(el.scrollWidth, el.clientWidth));
  }, []);

  // Vertical wheel scrolls the strip horizontally.
  useEffect(() => {
    const el = stripRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (e.deltaY === 0) return;
      el.scrollLeft += e.deltaY;
    };
    el.addEventListener('wheel', onWheel, { passive: true });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  useEffect(() => {
    const el = stripRef.current;
    if (!el) return;
    const ro = new ResizeObserver(measureOverflow);
    ro.observe(el);
    return () => ro.disconnect();
  }, [measureOverflow]);

  // ResizeObserver fires on the strip's box, not on content reflow within a fixed-size
  // strip, so a tab opening/closing needs an explicit re-measure.
  // biome-ignore lint/correctness/useExhaustiveDependencies: docs/terminalLabel are intentional re-measure triggers; the effect reads the DOM, not these values.
  useEffect(() => {
    measureOverflow();
  }, [docs, terminalLabel, measureOverflow]);

  // A background open must never scroll the strip (spec §4), so a cued tab that is scrolled out
  // of view cues the overflow chevron instead.
  const [flashClipped, setFlashClipped] = useState(false);
  useLayoutEffect(() => {
    const strip = stripRef.current;
    if (!strip || flashTabId === null) {
      setFlashClipped(false);
      return;
    }
    const tabEl = strip.querySelector<HTMLElement>(`[data-tabid="${CSS.escape(flashTabId)}"]`);
    if (!tabEl) {
      setFlashClipped(false);
      return;
    }
    const s = strip.getBoundingClientRect();
    const t = tabEl.getBoundingClientRect();
    setFlashClipped(t.left < s.left || t.right > s.right);
  }, [flashTabId]);
  const flashTab = flashTabId !== null && !flashClipped ? flashTabId : null;

  // `null` is the terminal/agent tab; resolve every kind to its data-tabid.
  useEffect(() => {
    if (!stripRef.current) return;
    scrollTabIntoView(scrollTargetTabId(activeId));
  }, [activeId, scrollTabIntoView]);

  const openDropdown = useCallback(() => {
    const btn = dropdownTriggerRef.current;
    if (!btn) return;
    const rect = btn.getBoundingClientRect();
    // Give React a tick to commit the active-tab change, then scroll it into view.
    const selectAndScroll = (id: string | null) => {
      onSelect(id);
      setTimeout(() => scrollTabIntoView(scrollTargetTabId(id)), 0);
    };
    const terminalItem = {
      label: terminalLabel,
      icon:
        activeId === null ? (
          <IconCheck size={14} />
        ) : (
          <SessionGlyph icon={terminalIcon} size={13} />
        ),
      onClick: () => selectAndScroll(null),
    };
    const docItems = docs.map((d) => ({
      label: previewIds.has(d.id) ? `${d.title} (preview)` : d.title,
      title: d.path,
      icon:
        activeId === d.id ? (
          <IconCheck size={14} />
        ) : saves.get(d.path)?.phase === 'conflict' ? (
          <span
            className="tab__conflict tab__conflict--inline"
            role="img"
            aria-label={AUTO_SAVE_COPY.tabConflict}
          >
            <IconWarning size={12} />
          </span>
        ) : dirty.has(d.path) ? (
          <span className="tab__dirty tab__dirty--inline" aria-label="Unsaved" />
        ) : undefined,
      onClick: () => selectAndScroll(d.id),
    }));
    setDropdownMenu({
      x: rect.right,
      y: rect.bottom + 2,
      items: showTerminal ? [terminalItem, ...docItems] : docItems,
    });
  }, [
    showTerminal,
    docs,
    activeId,
    previewIds,
    dirty,
    saves,
    terminalLabel,
    terminalIcon,
    onSelect,
    scrollTabIntoView,
  ]);

  const activeClass = groupActive ? 'tab--active' : 'tab--current';

  const dropTab = (e: React.DragEvent, beforeId: string | null) => {
    const dr = tabDragOf(e);
    if (!dr) return;
    e.preventDefault();
    if (dr.group === group) onReorder?.(dr.id, beforeId);
    else onMoveTab?.(dr.id, group, beforeId, e.ctrlKey);
    endTabDrag();
    setOverId(null);
    setOverEnd(false);
  };

  return (
    <div className="tabbar-wrap">
      <div
        ref={stripRef}
        className="tabbar"
        role="tablist"
        aria-label={SPLIT_COPY.tablistLabel(group)}
        onContextMenu={
          onStripContextMenu
            ? (e) => {
                if ((e.target as Element).closest('[data-tabid]')) return;
                onStripContextMenu(e);
              }
            : undefined
        }
        draggable={!!moveGrip}
        onDragStart={
          moveGrip
            ? (e) => {
                if (!isPanelDragTarget(e.target as Element, e.currentTarget)) return;
                e.dataTransfer.effectAllowed = 'move';
                moveGrip.onDragStart();
              }
            : undefined
        }
        onDragEnd={moveGrip?.onDragEnd}
      >
        {showTerminal && (
          <button
            data-tabid={TERMINAL_TABID}
            className={`tab ${activeId === null ? activeClass : ''}`}
            onClick={() => onSelect(null)}
            onContextMenu={onTerminalTabContextMenu}
          >
            <SessionGlyph icon={terminalIcon} size={13} className="tab__spark" />
            <span>{terminalLabel}</span>
          </button>
        )}
        {docs.map((d) => (
          <div
            key={d.id}
            data-tabid={d.id}
            role="tab"
            tabIndex={0}
            aria-selected={activeId === d.id}
            // Preview is signalled visually by italic only; carry it in the accessible
            // name too so it isn't conveyed by styling alone (WCAG 1.4.1, spec §10).
            aria-label={previewIds.has(d.id) ? `${d.title} (preview)` : undefined}
            className={`tab ${activeId === d.id ? activeClass : ''} ${overId === d.id ? 'tab--dropbefore' : ''} ${dirty.has(d.path) ? 'tab--dirty' : ''} ${previewIds.has(d.id) ? 'tab--preview' : ''} ${flashTab === d.id ? 'tab--flash' : ''}`}
            onClick={() => onSelect(d.id)}
            // Middle-click closes the tab (VS Code parity), routing through the same
            // unsaved-changes path as the × button. `auxclick` (down+up on the element)
            // gives WCAG-2.5.2 up-event semantics; the Terminal tab gets none (D7). The
            // helper's mousedown suppression is what keeps it working on an overflowing strip.
            {...middleClickProps(() => onClose(d.id))}
            onDoubleClick={() => {
              if (previewIds.has(d.id)) onPinDoc?.(d.id);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                onSelect(d.id);
              }
            }}
            onContextMenu={onTabContextMenu ? (e) => onTabContextMenu(e, d) : undefined}
            draggable={!!onReorder}
            onDragStart={(e) => {
              beginTabDrag({ id: d.id, group }, e.dataTransfer);
              if (d.kind === 'file') {
                stampFileDrag(e.dataTransfer, d.path, { download: true, terminal: false });
              }
              // Copy is the in-app Ctrl duplicate, and the only effect an OS drop target accepts
              // for a file's drag-out; 'move' alone would refuse both.
              e.dataTransfer.effectAllowed =
                splitBehavior(d.kind) === 'duplicate' ? 'copyMove' : 'move';
            }}
            onDragOver={(e) => {
              const dr = tabDragOf(e);
              if (dr && !(dr.group === group && dr.id === d.id)) {
                acceptTabDrop(e);
                setOverId(d.id);
              }
            }}
            onDragLeave={() => setOverId((o) => (o === d.id ? null : o))}
            onDrop={(e) => dropTab(e, d.id)}
            onDragEnd={() => {
              endTabDrag();
              setOverId(null);
              setOverEnd(false);
            }}
          >
            {d.kind === 'diff' && <IconBranch size={12} className="tab__spark" />}
            {d.kind === 'commit-diff' && <IconBranch size={12} className="tab__spark" />}
            {d.kind === 'review' && <IconReview size={12} className="tab__spark" />}
            <span>{d.title}</span>
            {saves.get(d.path)?.phase === 'conflict' ? (
              <span
                className="tab__conflict"
                role="img"
                aria-label={AUTO_SAVE_COPY.tabConflict}
                title={AUTO_SAVE_COPY.tabConflict}
              >
                <IconWarning size={12} />
              </span>
            ) : (
              dirty.has(d.path) && (
                <span
                  className="tab__dirty"
                  role="button"
                  tabIndex={0}
                  aria-label="Unsaved changes — save"
                  title="Unsaved changes — Ctrl+S to save"
                  onClick={(e) => {
                    e.stopPropagation();
                    saveDocByPath(d.path);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      e.stopPropagation();
                      saveDocByPath(d.path);
                    }
                  }}
                />
              )
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
          </div>
        ))}
        {/* Trailing drop zone: fills the remaining strip width so a drop past the last
            tab (→ end) reaches the rightmost slot (R5.6). Inert unless a tab drag is live. */}
        {onReorder && (
          <div
            className={`tabbar__tail ${overEnd ? 'tabbar__tail--over' : ''}`}
            onDragOver={(e) => {
              if (!tabDragOf(e)) return;
              acceptTabDrop(e);
              setOverEnd(true);
            }}
            onDragLeave={() => setOverEnd(false)}
            onDrop={(e) => dropTab(e, null)}
          />
        )}
      </div>

      {/* Outside the scrollable strip so its width is reserved and the strip clips tabs
          BEFORE the chevron column. Rendered only when the strip overflows. */}
      {hasOverflow && (
        <button
          ref={dropdownTriggerRef}
          className={`tabbar__overflow-btn${flashClipped ? ' tabbar__overflow-btn--flash' : ''}`}
          title="Open editors"
          aria-label="Show all open editors"
          onMouseDown={() => {
            wasOpenRef.current = dropdownMenu !== null;
          }}
          onClick={() => {
            if (menuToggleIntent(wasOpenRef.current) === 'open') {
              openDropdown();
            }
          }}
        >
          <IconChevronDown size={13} />
        </button>
      )}

      <button
        type="button"
        className="tabbar__split"
        aria-label={SPLIT_COPY.splitButton}
        aria-disabled={split.disabledReason !== null || undefined}
        title={split.disabledReason ?? SPLIT_COPY.splitRight}
        onClick={() => {
          if (split.disabledReason === null) split.onSplit();
        }}
      >
        <IconSplit size={13} />
      </button>

      {dropdownMenu && (
        <ContextMenu
          menu={dropdownMenu}
          onClose={() => setDropdownMenu(null)}
          triggerRef={dropdownTriggerRef}
        />
      )}
    </div>
  );
}
