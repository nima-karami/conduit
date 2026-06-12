import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { menuToggleIntent } from '../../src/menu-toggle';
import { getDirtySnapshot, subscribeDirty } from '../dirty-store';
import type { OpenDoc } from '../docs';
import { isPanelDragTarget } from '../drag-guard';
import {
  IconBranch,
  IconCheck,
  IconChevronDown,
  IconClose,
  IconReview,
  IconSparkle,
} from '../icons';
import { saveDocByPath } from '../save-registry';
import { isStripOverflowing, scrollTargetTabId, TERMINAL_TABID } from '../tab-overflow';
import { ContextMenu, type MenuState } from './context-menu';

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

  // Ref to the scrollable tab strip (not the outer wrapper) so we can:
  //   1. Scroll horizontally on vertical wheel.
  //   2. Scroll the active tab into view.
  const stripRef = useRef<HTMLDivElement>(null);

  // Open-editors dropdown state.
  const [dropdownMenu, setDropdownMenu] = useState<MenuState | null>(null);
  const dropdownTriggerRef = useRef<HTMLButtonElement>(null);
  // Track whether the menu was open at the last mousedown on the trigger button
  // so menuToggleIntent can decide open vs. stay-closed (toggle contract).
  const wasOpenRef = useRef(false);

  // Whether the strip overflows its visible width. The chevron renders ONLY
  // when this is true (no permanent black box when everything fits).
  const [hasOverflow, setHasOverflow] = useState(false);

  // Scroll a tab into view by its data-tabid. Works for the terminal tab
  // (sentinel) and every doc tab alike.
  const scrollTabIntoView = useCallback((tabid: string) => {
    const tabEl = stripRef.current?.querySelector<HTMLElement>(
      `[data-tabid="${CSS.escape(tabid)}"]`,
    );
    tabEl?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, []);

  // Measure whether the strip overflows its visible width. Stable callback so
  // both the ResizeObserver and the tab-change effect can share it.
  const measureOverflow = useCallback(() => {
    const el = stripRef.current;
    if (!el) return;
    setHasOverflow(isStripOverflowing(el.scrollWidth, el.clientWidth));
  }, []);

  // ---- Wheel → horizontal scroll ----
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

  // ---- Overflow detection (gates the chevron) ----
  // Observe the strip's size so the chevron toggles on pane resize, density
  // change, or when the chevron's own column appears/disappears. The strip's
  // scrollWidth > clientWidth means some tabs are clipped behind the (reserved)
  // chevron column.
  useEffect(() => {
    const el = stripRef.current;
    if (!el) return;
    const ro = new ResizeObserver(measureOverflow);
    ro.observe(el);
    return () => ro.disconnect();
  }, [measureOverflow]);

  // Re-measure when the set of tabs (or the terminal label width) changes —
  // ResizeObserver fires on the strip's box, not on content reflow within a
  // fixed-size strip, so a tab opening/closing needs an explicit re-measure.
  // biome-ignore lint/correctness/useExhaustiveDependencies: docs/terminalLabel are intentional re-measure triggers; the effect reads the DOM, not these values.
  useEffect(() => {
    measureOverflow();
  }, [docs, terminalLabel, measureOverflow]);

  // ---- Active tab → scroll into view ----
  // stripRef is a stable ref — no need to list it as a dependency.
  // `null` is the terminal/agent tab; resolve every kind to its data-tabid.
  useEffect(() => {
    if (!stripRef.current) return;
    scrollTabIntoView(scrollTargetTabId(activeId));
  }, [activeId, scrollTabIntoView]);

  // ---- Open-editors dropdown builder ----
  const openDropdown = useCallback(() => {
    const btn = dropdownTriggerRef.current;
    if (!btn) return;
    const rect = btn.getBoundingClientRect();
    // Items: terminal first, then all open docs.
    // After any selection, give React a tick to commit the active-tab change,
    // then scroll the chosen tab into view — terminal/agent and docs alike.
    const selectAndScroll = (id: string | null) => {
      onSelect(id);
      setTimeout(() => scrollTabIntoView(scrollTargetTabId(id)), 0);
    };
    const terminalItem = {
      label: terminalLabel,
      icon: activeId === null ? <IconCheck size={14} /> : <IconSparkle size={13} />,
      onClick: () => selectAndScroll(null),
    };
    const docItems = docs.map((d) => ({
      label: d.title,
      title: d.path,
      icon:
        activeId === d.id ? (
          <IconCheck size={14} />
        ) : dirty.has(d.path) ? (
          <span className="tab__dirty tab__dirty--inline" aria-label="Unsaved" />
        ) : undefined,
      onClick: () => selectAndScroll(d.id),
    }));
    setDropdownMenu({
      x: rect.right,
      y: rect.bottom + 2,
      items: [terminalItem, ...docItems],
    });
  }, [docs, activeId, dirty, terminalLabel, onSelect, scrollTabIntoView]);

  return (
    <div className="tabbar-wrap">
      {/* Scrollable strip */}
      <div
        ref={stripRef}
        className="tabbar"
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
        <button
          data-tabid={TERMINAL_TABID}
          className={`tab ${activeId === null ? 'tab--active' : ''}`}
          onClick={() => onSelect(null)}
        >
          <IconSparkle size={13} className="tab__spark" />
          <span>{terminalLabel}</span>
        </button>
        {docs.map((d) => (
          <div
            key={d.id}
            data-tabid={d.id}
            role="tab"
            tabIndex={0}
            aria-selected={activeId === d.id}
            className={`tab ${activeId === d.id ? 'tab--active' : ''} ${overId === d.id ? 'tab--dropbefore' : ''} ${dirty.has(d.path) ? 'tab--dirty' : ''}`}
            onClick={() => onSelect(d.id)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                onSelect(d.id);
              }
            }}
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
            {d.kind === 'review' && <IconReview size={12} className="tab__spark" />}
            <span>{d.title}</span>
            {dirty.has(d.path) && (
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
      </div>

      {/* Open-editors dropdown trigger — fixed at the right edge, outside the
          scrollable strip so its width is reserved and the strip clips its tabs
          BEFORE the chevron column. Rendered only when the strip overflows. */}
      {hasOverflow && (
        <button
          ref={dropdownTriggerRef}
          className="tabbar__overflow-btn"
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
