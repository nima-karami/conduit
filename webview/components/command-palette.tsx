import type { ReactNode } from 'react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { fuzzyScore } from '../../src/fuzzy';
import { useEscapeKey } from '../use-escape-key';

export interface PaletteEntry {
  id: string;
  title: string;
  subtitle?: string;
  group: string;
  icon?: ReactNode;
  run: () => void;
}

/** Render a title with the fuzzy-matched characters emphasised. */
function Highlighted({ text, query }: { text: string; query: string }) {
  const m = query ? fuzzyScore(query, text) : null;
  if (!m?.positions.length) return <>{text}</>;
  const set = new Set(m.positions);
  return (
    <>
      {[...text].map((ch, i) =>
        set.has(i) ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: key is the character's position in a static, never-reordered string
          <b key={i} className="pal__hl">
            {ch}
          </b>
        ) : (
          // biome-ignore lint/suspicious/noArrayIndexKey: key is the character's position in a static, never-reordered string
          <span key={i}>{ch}</span>
        ),
      )}
    </>
  );
}

export function CommandPalette({
  items,
  commandItems = [],
  recentItems = [],
  placeholder,
  initialQuery = '',
  onClose,
}: {
  items: PaletteEntry[];
  commandItems?: PaletteEntry[];
  recentItems?: PaletteEntry[];
  placeholder: string;
  initialQuery?: string;
  onClose: () => void;
}) {
  const [query, setQuery] = useState(initialQuery);
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  // Pick the active item set + the text to fuzz against, based on the `>` prefix
  // and whether the query is empty (recents).
  const { source, term } = useMemo(() => {
    if (query.startsWith('>')) return { source: commandItems, term: query.slice(1).trim() };
    const q = query.trim();
    if (q === '') {
      const sessions = items.filter((i) => i.group === 'Sessions');
      return { source: [...recentItems, ...sessions], term: '' };
    }
    return { source: items, term: q };
  }, [query, items, commandItems, recentItems]);

  // Filter per group (preserving group order), then flatten for nav.
  const { groups, flat } = useMemo(() => {
    const order = [...new Set(source.map((i) => i.group))];
    const groups = order
      .map((g) => {
        const rows = source
          .filter((i) => i.group === g)
          .map((i) => ({ i, s: fuzzyScore(term, i.title)?.score ?? null }))
          .filter((r): r is { i: PaletteEntry; s: number } => r.s !== null)
          .sort((a, b) => b.s - a.s)
          .slice(0, 50)
          .map((r) => r.i);
        return { g, rows };
      })
      .filter((x) => x.rows.length);
    const flat = groups.flatMap((x) => x.rows);
    return { groups, flat };
  }, [source, term]);

  // Keep the active row in view whenever active changes (arrow-key nav).
  // biome-ignore lint/correctness/useExhaustiveDependencies: `active` is an intentional trigger — the DOM query uses data-active not the value directly
  useEffect(() => {
    const el = listRef.current?.querySelector('[data-active="true"]');
    el?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  // Robust Escape even if focus leaves the input.
  useEscapeKey(onClose);

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((a) => (flat.length ? (a + 1) % flat.length : 0));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((a) => (flat.length ? (a - 1 + flat.length) % flat.length : 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const sel = flat[active];
      if (sel) {
        sel.run();
        onClose();
      }
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    }
  };

  let idx = -1;
  return (
    <div className="modal__backdrop palette__backdrop" onClick={onClose}>
      <div className="palette" onClick={(e) => e.stopPropagation()}>
        <input
          className="palette__input"
          autoFocus
          placeholder={placeholder}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKey}
        />
        <div className="palette__list" ref={listRef}>
          {flat.length === 0 && <div className="palette__empty">No matches</div>}
          {groups.map(({ g, rows }) => (
            <div className="palette__group" key={g}>
              <div className="palette__gtitle">{g}</div>
              {rows.map((entry) => {
                idx++;
                const isActive = idx === active;
                const myIdx = idx;
                return (
                  <div
                    key={entry.id}
                    className={`palette__row ${isActive ? 'palette__row--active' : ''}`}
                    data-active={isActive}
                    onMouseMove={() => setActive(myIdx)}
                    onClick={() => {
                      entry.run();
                      onClose();
                    }}
                  >
                    {entry.icon && <span className="palette__icon">{entry.icon}</span>}
                    <span className="palette__title">
                      <Highlighted text={entry.title} query={term} />
                    </span>
                    {entry.subtitle && <span className="palette__sub">{entry.subtitle}</span>}
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
