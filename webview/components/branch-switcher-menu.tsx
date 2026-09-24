/**
 * The branch chip menu's "Switch branch" section: an inline list inside the chip's `Popover`,
 * which owns positioning and dismissal (docs/specs/2026-09-23-mf-changes.md §2.3). Fetches the
 * repo's local branches via `git:refs`; the host enumerates and validates, the renderer never
 * spawns git. Rows are `role="menuitemradio"` with the current branch `aria-checked` and
 * pinned first.
 */
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { acceptsRepoResult } from '../../src/branch-chip';
import { branchRow, orderBranches } from '../../src/branch-menu';
import { post, subscribe } from '../bridge';
import { IconCheck } from '../icons';

const STR = {
  filterPlaceholder: 'Filter branches…',
  noOther: 'No other branches',
  noMatch: 'No matching branches',
  notSwitchable: 'No branches to switch to',
  loading: 'Loading branches…',
  switching: 'Switching…',
} as const;

interface RefsState {
  branches: string[];
  current: string | null;
  loaded: boolean;
  error: boolean;
}

export interface BranchSwitcherListProps {
  sessionId: string;
  repoRoot: string;
  switchable: boolean;
  switching: boolean;
  onSelect: (ref: string) => void;
  onArrowUpFromFilter: () => void;
}

export function BranchSwitcherList(props: BranchSwitcherListProps) {
  if (!props.switchable) {
    return (
      <div className="git-branch-menu">
        <div className="ctxmenu__item git-branch-menu__empty" aria-disabled>
          {STR.notSwitchable}
        </div>
      </div>
    );
  }
  return <SwitchableList {...props} />;
}

function SwitchableList({
  sessionId,
  repoRoot,
  switching,
  onSelect,
  onArrowUpFromFilter,
}: BranchSwitcherListProps) {
  const [refs, setRefs] = useState<RefsState>({
    branches: [],
    current: null,
    loaded: false,
    error: false,
  });
  const [filter, setFilter] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const [pending, setPending] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const baseId = useId();

  useEffect(() => {
    post({ type: 'git:refs', sessionId, repoRoot });
    return subscribe((msg) => {
      if (msg.type !== 'git:refsResult' || !acceptsRepoResult(msg, sessionId, repoRoot)) return;
      setRefs({ branches: msg.branches, current: msg.current, loaded: true, error: !!msg.error });
    });
  }, [sessionId, repoRoot]);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const ordered = useMemo(
    () => orderBranches(refs.branches, refs.current),
    [refs.branches, refs.current],
  );
  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return ordered;
    return ordered.filter((b) => b.toLowerCase().includes(q));
  }, [ordered, filter]);
  const selectable = useMemo(() => filtered.filter((b) => b !== refs.current), [filtered, refs]);

  const pick = (ref: string) => {
    setPending(ref);
    onSelect(ref);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActiveIndex((i) => Math.min(i + 1, Math.max(selectable.length - 1, 0)));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (activeIndex === 0) onArrowUpFromFilter();
      else setActiveIndex(activeIndex - 1);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const ref = selectable[activeIndex];
      if (ref && !switching) pick(ref);
    }
  };

  const emptyCopy = refs.error || filter.trim() ? STR.noMatch : STR.noOther;

  return (
    <div className="git-branch-menu" aria-busy={switching || !refs.loaded}>
      <input
        ref={inputRef}
        type="text"
        className="git-branch-menu__filter"
        placeholder={STR.filterPlaceholder}
        value={filter}
        disabled={switching}
        onKeyDown={onKeyDown}
        onChange={(e) => {
          setFilter(e.target.value);
          setActiveIndex(0);
        }}
        aria-label={STR.filterPlaceholder}
      />

      {!refs.loaded && (
        <div className="ctxmenu__item" aria-disabled>
          {STR.loading}
        </div>
      )}

      {refs.loaded &&
        !refs.error &&
        filtered.map((b) => {
          const row = branchRow(b, refs.current, switching);
          const idx = selectable.indexOf(b);
          const isActive = !row.current && idx === activeIndex;
          return (
            <button
              key={b}
              id={`${baseId}-row-${b}`}
              type="button"
              role="menuitemradio"
              // aria-disabled — NOT `disabled` — carries "not a target", so the current
              // branch stops short of actionable without being drained to a disabled grey.
              aria-checked={row.current}
              aria-disabled={row.current || undefined}
              className={`ctxmenu__item git-branch-menu__row${
                isActive ? ' ctxmenu__item--active' : ''
              }`}
              disabled={row.disabled}
              onMouseEnter={() => {
                if (!row.current) setActiveIndex(idx);
              }}
              onClick={() => {
                if (row.actionable) pick(b);
              }}
            >
              <span className="ctxmenu__icon">
                {row.current ? <IconCheck size={13} /> : <span style={{ width: 13 }} />}
              </span>
              <span className="git-branch-menu__name" dir="ltr">
                {b}
              </span>
              {switching && pending === b && (
                <span className="git-branch-menu__hint">{STR.switching}</span>
              )}
            </button>
          );
        })}

      {refs.loaded && (refs.error || selectable.length === 0) && (
        <div className="ctxmenu__item git-branch-menu__empty" aria-disabled>
          {emptyCopy}
        </div>
      )}
    </div>
  );
}
