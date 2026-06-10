import { useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { fuzzyScore } from '../../src/fuzzy';

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
  if (!m || !m.positions.length) return <>{text}</>;
  const set = new Set(m.positions);
  return (
    <>
      {[...text].map((ch, i) =>
        set.has(i) ? <b key={i} className="pal__hl">{ch}</b> : <span key={i}>{ch}</span>,
      )}
    </>
  );
}

export function CommandPalette({
  items,
  placeholder,
  onClose,
}: {
  items: PaletteEntry[];
  placeholder: string;
  onClose: () => void;
}) {
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  // Filter per group (preserving group order), then flatten for nav.
  const { groups, flat } = useMemo(() => {
    const order = [...new Set(items.map((i) => i.group))];
    const groups = order
      .map((g) => {
        const rows = items
          .filter((i) => i.group === g)
          .map((i) => ({ i, s: fuzzyScore(query, i.title)?.score ?? null }))
          .filter((r): r is { i: PaletteEntry; s: number } => r.s !== null)
          .sort((a, b) => b.s - a.s)
          .slice(0, 50)
          .map((r) => r.i);
        return { g, rows };
      })
      .filter((x) => x.rows.length);
    const flat = groups.flatMap((x) => x.rows);
    return { groups, flat };
  }, [items, query]);

  useEffect(() => { setActive(0); }, [query]);

  // Keep the active row in view.
  useEffect(() => {
    const el = listRef.current?.querySelector('[data-active="true"]');
    el?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => (flat.length ? (a + 1) % flat.length : 0)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => (flat.length ? (a - 1 + flat.length) % flat.length : 0)); }
    else if (e.key === 'Enter') { e.preventDefault(); const sel = flat[active]; if (sel) { sel.run(); onClose(); } }
    else if (e.key === 'Escape') { e.preventDefault(); onClose(); }
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
                    onClick={() => { entry.run(); onClose(); }}
                  >
                    {entry.icon && <span className="palette__icon">{entry.icon}</span>}
                    <span className="palette__title"><Highlighted text={entry.title} query={query} /></span>
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
