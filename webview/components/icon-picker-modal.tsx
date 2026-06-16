/**
 * Icon picker modal for session icon overrides (D3).
 *
 * Architecture:
 *   - Statically imports the full lucide-react set (IIFE bundler, no code-splitting).
 *   - Virtualizes the icon grid: only icons near the viewport are rendered.
 *   - Debounced search filters by kebab-case name.
 *   - Category sections when not searching (derived from naming conventions — lucide
 *     1.18.0 ships no tag/category metadata; see icon-picker-helper.ts for details).
 *   - Keyboard: Esc closes; search autofocus; click to select.
 *   - Reduced-motion safe (no CSS transitions beyond what the shared modal animation uses).
 */
import * as LucideIcons from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  buildIconEntries,
  filterAndGroupIcons,
  type IconEntry,
  type IconGroup,
} from '../icon-picker-helper';
import { IconClose, IconSearch } from '../icons';
import { useEscapeKey } from '../use-escape-key';

// ── static icon list built once at module load ──────────────────────────────
const ALL_ICONS: IconEntry[] = buildIconEntries(Object.keys(LucideIcons));

// Number of rows to render outside the visible viewport (above + below).
const OVERSCAN_ROWS = 3;
// Icon cell dimensions (px) — kept in sync with CSS below.
const CELL_SIZE = 52;
const SECTION_HEADER_HEIGHT = 32;

// ── Lucide component resolver ────────────────────────────────────────────────
function getLucideComponent(
  pascal: string,
): React.FC<{ size?: number; className?: string; strokeWidth?: number }> | null {
  const c = (LucideIcons as Record<string, unknown>)[pascal];
  if (typeof c === 'function' || (c && typeof c === 'object' && 'render' in (c as object)))
    return c as React.FC<{ size?: number; className?: string; strokeWidth?: number }>;
  return null;
}

// ── virtualized grid ─────────────────────────────────────────────────────────

type VirtualItem =
  | { kind: 'header'; category: string; groupIndex: number }
  | { kind: 'row'; entries: IconEntry[]; rowIndex: number };

/** Flatten groups into a list of virtual items (headers + icon rows). */
function buildVirtualItems(groups: IconGroup[], cols: number): VirtualItem[] {
  const items: VirtualItem[] = [];
  for (let gi = 0; gi < groups.length; gi++) {
    const group = groups[gi];
    if (group.category) {
      items.push({ kind: 'header', category: group.category, groupIndex: gi });
    }
    for (let i = 0; i < group.entries.length; i += cols) {
      items.push({ kind: 'row', entries: group.entries.slice(i, i + cols), rowIndex: i / cols });
    }
  }
  return items;
}

function itemHeight(item: VirtualItem): number {
  return item.kind === 'header' ? SECTION_HEADER_HEIGHT : CELL_SIZE;
}

/** A single icon cell button. */
function IconCell({
  entry,
  selected,
  onSelect,
}: {
  entry: IconEntry;
  selected: boolean;
  onSelect: (kebab: string) => void;
}) {
  const Comp = getLucideComponent(entry.pascal);
  if (!Comp) return null;
  return (
    <button
      className={`iconpicker__cell ${selected ? 'iconpicker__cell--selected' : ''}`}
      title={entry.kebab}
      onClick={() => onSelect(entry.kebab)}
      aria-label={entry.kebab}
      aria-pressed={selected}
    >
      <Comp size={20} strokeWidth={1.5} />
    </button>
  );
}

// ── main modal ───────────────────────────────────────────────────────────────

export function IconPickerModal({
  currentIcon,
  onSelect,
  onClear,
  onClose,
}: {
  /** The currently active iconOverride (kebab-case), or undefined if none. */
  currentIcon: string | undefined;
  /** Called with the chosen kebab-case icon name. */
  onSelect: (name: string) => void;
  /** Called when the user wants to reset to the auto-derived icon. */
  onClear: () => void;
  onClose: () => void;
}) {
  const [rawQuery, setRawQuery] = useState('');
  // Debounced query: avoids re-filtering 1960 icons on every keystroke.
  const [query, setQuery] = useState('');
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [containerHeight, setContainerHeight] = useState(400);
  // Column count derived from container width (measured after mount).
  const [cols, setCols] = useState(8);
  const containerRef = useRef<HTMLDivElement>(null);

  useEscapeKey(onClose);

  // Autofocus the search input.
  useEffect(() => {
    searchRef.current?.focus();
  }, []);

  // Measure container width for column count.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const measure = () => {
      const w = el.clientWidth;
      setCols(Math.max(1, Math.floor(w / CELL_SIZE)));
      setContainerHeight(el.clientHeight);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Debounce query updates.
  const handleQueryChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value;
    setRawQuery(val);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => setQuery(val), 150);
  };

  // Reset scroll when search query changes. `query` is an intentional trigger dep
  // (the effect body reads the DOM via scrollRef, not query directly).
  // biome-ignore lint/correctness/useExhaustiveDependencies: query is used as a trigger, not read inside
  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = 0;
    setScrollTop(0);
  }, [query]);

  const groups = useMemo(() => filterAndGroupIcons(ALL_ICONS, query), [query]);
  const virtualItems = useMemo(() => buildVirtualItems(groups, cols), [groups, cols]);

  // Total scrollable height.
  const totalHeight = useMemo(
    () => virtualItems.reduce((sum, item) => sum + itemHeight(item), 0),
    [virtualItems],
  );

  // Find which items are in the visible window (+ overscan).
  const visibleItems = useMemo(() => {
    const result: { item: VirtualItem; top: number }[] = [];
    let y = 0;
    for (const item of virtualItems) {
      const h = itemHeight(item);
      const top = y;
      y += h;
      const inView =
        top + h >= scrollTop - OVERSCAN_ROWS * CELL_SIZE &&
        top <= scrollTop + containerHeight + OVERSCAN_ROWS * CELL_SIZE;
      if (inView) result.push({ item, top });
    }
    return result;
  }, [virtualItems, scrollTop, containerHeight]);

  const handleScroll = useCallback(() => {
    setScrollTop(scrollRef.current?.scrollTop ?? 0);
  }, []);

  const handleSelect = useCallback(
    (name: string) => {
      onSelect(name);
      onClose();
    },
    [onSelect, onClose],
  );

  return (
    <div className="modal__backdrop" onClick={onClose}>
      <div
        className="modal iconpicker"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Choose session icon"
      >
        {/* Header */}
        <div className="modal__head iconpicker__head">
          <span className="modal__title">Choose icon</span>
          <span className="modal__sub">
            {currentIcon ? (
              <>
                Current: <span className="iconpicker__current-name">{currentIcon}</span>
              </>
            ) : (
              'Set a custom icon for this session'
            )}
          </span>
          <button
            className="iconbtn iconpicker__close"
            onClick={onClose}
            aria-label="Close icon picker"
          >
            <IconClose size={15} />
          </button>
        </div>

        {/* Search bar */}
        <div className="iconpicker__search">
          <IconSearch size={14} className="iconpicker__search-icon" />
          <input
            ref={searchRef}
            className="iconpicker__search-input"
            placeholder="Search icons…"
            value={rawQuery}
            onChange={handleQueryChange}
            aria-label="Search icons"
          />
          {rawQuery && (
            <button
              className="iconpicker__search-clear"
              onClick={() => {
                setRawQuery('');
                setQuery('');
                searchRef.current?.focus();
              }}
              aria-label="Clear search"
            >
              ✕
            </button>
          )}
        </div>

        {/* Virtualized grid */}
        <div
          ref={(el) => {
            // Assign to both refs.
            (containerRef as React.MutableRefObject<HTMLDivElement | null>).current = el;
            (scrollRef as React.MutableRefObject<HTMLDivElement | null>).current = el;
          }}
          className="iconpicker__grid-container"
          onScroll={handleScroll}
        >
          {/* Sentinel div to make the scrollbar correct */}
          <div style={{ height: totalHeight, position: 'relative', width: '100%' }}>
            {visibleItems.map(({ item, top }) => {
              if (item.kind === 'header') {
                return (
                  <div
                    key={`h-${item.groupIndex}`}
                    className="iconpicker__section-header"
                    style={{ position: 'absolute', top, left: 0, right: 0 }}
                  >
                    {item.category}
                  </div>
                );
              }
              // Row of icon cells
              const rowKey = `r-${item.rowIndex}-${item.entries[0]?.kebab ?? ''}`;
              return (
                <div
                  key={rowKey}
                  className="iconpicker__row"
                  style={{ position: 'absolute', top, left: 0, right: 0 }}
                >
                  {item.entries.map((entry) => (
                    <IconCell
                      key={entry.kebab}
                      entry={entry}
                      selected={entry.kebab === currentIcon}
                      onSelect={handleSelect}
                    />
                  ))}
                </div>
              );
            })}
          </div>

          {groups.length === 0 && (
            <div className="iconpicker__empty">No icons match &ldquo;{query}&rdquo;</div>
          )}
        </div>

        {/* Footer */}
        <div className="modal__foot iconpicker__foot">
          <span className="iconpicker__count">{ALL_ICONS.length.toLocaleString()} icons</span>
          <div className="modal__actions">
            {currentIcon && (
              <button
                className="btn"
                onClick={() => {
                  onClear();
                  onClose();
                }}
              >
                Reset to auto
              </button>
            )}
            <button className="btn" onClick={onClose}>
              Cancel
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
