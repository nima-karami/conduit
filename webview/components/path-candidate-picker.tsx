/**
 * The ranked picker an ambiguous terminal path link opens (spec 2026-10-16-terminal-path-links
 * §8): one row per candidate naming its repo or worktree, the best one preselected. Filter and
 * keyboard model follow commit-picker-menu.tsx; the frame is the shared Popover, so it portals
 * into the overlay stack. Pure rows/heading: path-candidate-picker-model.ts.
 */
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { IconDoc, IconFolder, IconSearch } from '../icons';
import { isMiddleButton } from '../middle-click';
import { TERM_LINK_STR } from '../term-link-strings';
import type { LinkMenuAction } from '../term-menu';
import {
  FILTER_THRESHOLD,
  filterRows,
  type PickerRow,
  pickerHeading,
} from './path-candidate-picker-model';
import { Popover } from './popover';
import { RepoTagPill } from './repo-picker-menu';

export type PickerMode = { kind: 'open' } | { kind: 'action'; action: LinkMenuAction };

export interface PathCandidatePickerProps {
  at: { x: number; y: number };
  /** Display text of the link. */
  token: string;
  rows: PickerRow[];
  total: number;
  truncated: boolean;
  mode: PickerMode;
  /** background = middle-click, files only. */
  onPick(row: PickerRow, how: 'foreground' | 'background'): void;
  /** "Search all files…" (truncated only). */
  onSearchAll(query: string): void;
  /** Returns focus to the terminal. */
  onClose(): void;
}

type Item = { kind: 'row'; row: PickerRow } | { kind: 'searchAll' };

export function PathCandidatePicker({
  at,
  token,
  rows,
  total,
  truncated,
  mode,
  onPick,
  onSearchAll,
  onClose,
}: PathCandidatePickerProps) {
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const baseId = useId();
  const listId = `${baseId}-list`;
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const withFilter = rows.length >= FILTER_THRESHOLD;
  const heading = pickerHeading(token, total, mode.kind === 'action' ? mode.action : undefined);

  const visible = useMemo(() => filterRows(rows, query), [rows, query]);
  const items: Item[] = useMemo(
    () => [
      ...visible.map((row): Item => ({ kind: 'row', row })),
      ...(truncated ? [{ kind: 'searchAll' } as const] : []),
    ],
    [visible, truncated],
  );
  const clamped = Math.min(active, Math.max(items.length - 1, 0));
  const itemId = (i: number) => `${baseId}-o${i}`;

  useEffect(() => {
    (withFilter ? inputRef.current : listRef.current)?.focus();
  }, [withFilter]);

  useEffect(() => {
    listRef.current
      ?.querySelector<HTMLElement>(`#${CSS.escape(itemId(clamped))}`)
      ?.scrollIntoView({ block: 'nearest' });
  });

  const choose = (item: Item | undefined, how: 'foreground' | 'background') => {
    if (!item) return;
    if (item.kind === 'searchAll') {
      if (how === 'foreground') onSearchAll(token);
      return;
    }
    if (how === 'background' && item.row.cand.isDir) return;
    onPick(item.row, how);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    const last = Math.max(items.length - 1, 0);
    const moves: Record<string, () => number> = {
      ArrowDown: () => Math.min(clamped + 1, last),
      ArrowUp: () => Math.max(clamped - 1, 0),
      Home: () => 0,
      End: () => last,
    };
    const move = moves[e.key];
    if (move) {
      e.preventDefault();
      setActive(move());
    } else if (e.key === 'Enter') {
      e.preventDefault();
      choose(items[clamped], 'foreground');
    }
  };

  const activeDescendant = items.length > 0 ? itemId(clamped) : undefined;

  return (
    <Popover
      at={at}
      className="ctxmenu pathpick"
      onClose={onClose}
      // Escape clears a non-empty filter first, then closes.
      onEscape={() => (query ? setQuery('') : onClose())}
      onKeyDown={onKeyDown}
    >
      {withFilter && (
        <input
          ref={inputRef}
          type="text"
          className="pathpick__filter"
          role="combobox"
          aria-expanded
          aria-controls={listId}
          aria-activedescendant={activeDescendant}
          aria-label={heading}
          value={query}
          placeholder={heading}
          onChange={(e) => {
            setQuery(e.target.value);
            setActive(0);
          }}
        />
      )}
      <div
        ref={listRef}
        id={listId}
        className="ctxmenu__scroll pathpick__list"
        role="listbox"
        aria-label={heading}
        aria-activedescendant={withFilter ? undefined : activeDescendant}
        tabIndex={withFilter ? -1 : 0}
      >
        {visible.length === 0 && (
          <div className="ctxmenu__item pathpick__empty" aria-disabled="true">
            {TERM_LINK_STR.noMatches(query)}
          </div>
        )}
        {items.map((item, i) => {
          const isActive = i === clamped;
          const cls = `ctxmenu__item pathpick__row${isActive ? ' ctxmenu__item--active pathpick__row--active' : ''}`;
          if (item.kind === 'searchAll') {
            return (
              <div
                key="search-all"
                id={itemId(i)}
                role="option"
                aria-selected={isActive}
                className={`${cls} pathpick__search`}
                onMouseDown={(e) => e.preventDefault()}
                onMouseEnter={() => setActive(i)}
                onClick={() => choose(item, 'foreground')}
              >
                <span className="ctxmenu__icon">
                  <IconSearch size={14} />
                </span>
                {TERM_LINK_STR.searchAll}
              </div>
            );
          }
          const { row } = item;
          return (
            <div
              key={row.cand.absPath}
              id={itemId(i)}
              role="option"
              aria-selected={isActive}
              aria-label={row.accessibleName}
              className={cls}
              title={row.cand.absPath}
              onMouseDown={(e) => {
                // Keep focus in the picker; a middle press must not start autoscroll.
                e.preventDefault();
              }}
              onMouseEnter={() => setActive(i)}
              onClick={() => choose(item, 'foreground')}
              onAuxClick={(e) => {
                if (isMiddleButton(e.nativeEvent)) choose(item, 'background');
              }}
            >
              <span className="ctxmenu__icon">
                {row.cand.isDir ? <IconFolder size={14} /> : <IconDoc size={14} />}
              </span>
              <span className="pathpick__repo">{row.repoName}</span>
              {row.tag === 'worktree' ? (
                <span className="repo-head__tag repo-head__tag--worktree">
                  {TERM_LINK_STR.worktree}
                </span>
              ) : (
                row.tag && <RepoTagPill tag={row.tag} />
              )}
              {row.branch && (
                <span className="pathpick__branch" dir="ltr">
                  {row.branch}
                </span>
              )}
              {row.workingHere && (
                <span className="pathpick__here">{TERM_LINK_STR.workingHere}</span>
              )}
              <span className="pathpick__rel" dir="ltr">
                {row.cand.relToRoot || row.cand.absPath}
              </span>
            </div>
          );
        })}
      </div>
      {truncated && (
        <div className="pathpick__foot">{TERM_LINK_STR.showingOf(rows.length, total)}</div>
      )}
    </Popover>
  );
}
