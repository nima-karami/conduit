import type { ReactNode } from 'react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { fuzzyScore } from '../../src/fuzzy';
import type { PaletteBadgeTone } from '../../src/palette-state';
import { useEscapeKey } from '../use-escape-key';

export interface PaletteEntry {
  id: string;
  title: string;
  subtitle?: string;
  group: string;
  icon?: ReactNode;
  // Human-readable key combo (e.g. "Ctrl + Shift + P"), shown right-aligned for
  // discoverability. Absent for commands with no bound shortcut.
  combo?: string;
  // One short word of state for rows whose target is a live thing — a session's "Busy".
  badge?: string;
  badgeTone?: PaletteBadgeTone;
  // The row's target is what the user is already looking at. Kept separate from the
  // keyboard cursor (`--active`), which is about this list rather than about the app.
  current?: boolean;
  // Alternate words a query can match by when the title itself doesn't. Never rendered —
  // purely for discoverability. Always ranked below any title match.
  keywords?: string[];
  run: () => void;
}

/**
 * Rank `source` against `term`: a title match always outranks a keyword-only match,
 * regardless of the keyword match's own score. Within each tier, higher fuzzyScore wins.
 */
export function rankEntries(source: PaletteEntry[], term: string): PaletteEntry[] {
  return source
    .map((i) => {
      const titleMatch = fuzzyScore(term, i.title);
      if (titleMatch) return { i, s: titleMatch.score, tier: 0 as const };
      const kwScore = (i.keywords ?? []).reduce<number | null>((best, k) => {
        const m = fuzzyScore(term, k);
        return m && (best === null || m.score > best) ? m.score : best;
      }, null);
      if (kwScore === null) return null;
      return { i, s: kwScore, tier: 1 as const };
    })
    .filter((r): r is { i: PaletteEntry; s: number; tier: 0 | 1 } => r !== null)
    .sort((a, b) => a.tier - b.tier || b.s - a.s)
    .map((r) => r.i);
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

  // `>` prefix switches to commands; an empty query shows recents.
  const { source, term } = useMemo(() => {
    if (query.startsWith('>')) return { source: commandItems, term: query.slice(1).trim() };
    const q = query.trim();
    if (q === '') {
      const sessions = items.filter((i) => i.group === 'Sessions');
      return { source: [...recentItems, ...sessions], term: '' };
    }
    return { source: items, term: q };
  }, [query, items, commandItems, recentItems]);

  const { groups, flat } = useMemo(() => {
    const order = [...new Set(source.map((i) => i.group))];
    const groups = order
      .map((g) => {
        const rows = rankEntries(
          source.filter((i) => i.group === g),
          term,
        ).slice(0, 50);
        return { g, rows };
      })
      .filter((x) => x.rows.length);
    const flat = groups.flatMap((x) => x.rows);
    return { groups, flat };
  }, [source, term]);

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
      <div className="palette chamfer" onClick={(e) => e.stopPropagation()}>
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
                    className={`palette__row ${isActive ? 'palette__row--active' : ''} ${
                      entry.current ? 'palette__row--current' : ''
                    }`}
                    data-active={isActive}
                    aria-current={entry.current || undefined}
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
                    {entry.current && <span className="palette__current">Current</span>}
                    {entry.badge && (
                      <span className="palette__badge" data-tone={entry.badgeTone ?? 'neutral'}>
                        {entry.badge}
                      </span>
                    )}
                    {entry.combo && <kbd className="palette__combo">{entry.combo}</kbd>}
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
