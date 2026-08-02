/**
 * Branch switcher dropdown (git-indicator Slice B). Opens from the indicator's branch
 * segment, fetches the local-branch list via `git:refs` (host enumerates — the renderer
 * never spawns git), and posts the chosen ref back via the parent's `onSelect`. Reuses the
 * app's `.ctxmenu` styling; rows are `role="menuitemradio"` with the current branch
 * `aria-checked` and pinned first. Type-to-filter, ↑/↓ + Enter + Esc, focus returns to the
 * trigger on close (handled by the parent).
 */
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { branchRow, orderBranches } from '../../src/branch-menu';
import { clampMenuPosition } from '../../src/menu-position';
import { post, subscribe } from '../bridge';
import { IconCheck } from '../icons';
import { useEscapeKey } from '../use-escape-key';

const STR = {
  filterPlaceholder: 'Filter branches…',
  noOther: 'No other branches',
  loading: 'Loading branches…',
  switching: 'Switching…',
} as const;

interface RefsState {
  branches: string[];
  current: string | null;
  loaded: boolean;
}

export function BranchSwitcherMenu({
  sessionId,
  switching,
  triggerRef,
  onSelect,
  onClose,
}: {
  sessionId: string;
  switching: boolean;
  triggerRef: React.RefObject<HTMLButtonElement | null>;
  onSelect: (ref: string) => void;
  onClose: () => void;
}) {
  const [refs, setRefs] = useState<RefsState>({ branches: [], current: null, loaded: false });
  const [filter, setFilter] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  // The ref the user picked, so its row shows the inline switching state (menu disabled).
  const [pending, setPending] = useState<string | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const baseId = useId();
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);

  useEscapeKey(onClose);

  useEffect(() => {
    post({ type: 'git:refs', sessionId });
    const unsub = subscribe((msg) => {
      if (msg.type !== 'git:refsResult' || msg.sessionId !== sessionId) return;
      setRefs({ branches: msg.branches, current: msg.current, loaded: true });
    });
    return unsub;
  }, [sessionId]);

  // Position below the trigger, clamped to the viewport (the menu is portaled + fixed).
  // Re-run once the branch list lands: the loaded menu is taller, so its clamped position
  // (flip-above near the viewport bottom) can only be computed against the real height.
  // biome-ignore lint/correctness/useExhaustiveDependencies: refs.loaded is the reposition trigger, not read in the body.
  useEffect(() => {
    const t = triggerRef.current;
    const el = menuRef.current;
    if (!t || !el) return;
    const r = t.getBoundingClientRect();
    const m = el.getBoundingClientRect();
    setPos(
      clampMenuPosition(
        { x: r.left, y: r.bottom + 2 },
        { width: m.width, height: m.height },
        { width: window.innerWidth, height: window.innerHeight },
      ),
    );
  }, [triggerRef, refs.loaded]);

  // Focus the filter input on open so type-to-filter works without a click.
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Dismiss on outside click / scroll / resize (mirrors ContextMenu). The trigger is
  // excluded so its toggle click doesn't double-fire.
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (menuRef.current?.contains(target)) return;
      if (triggerRef.current?.contains(target)) return;
      onClose();
    };
    window.addEventListener('mousedown', onDown, true);
    window.addEventListener('resize', onClose);
    return () => {
      window.removeEventListener('mousedown', onDown, true);
      window.removeEventListener('resize', onClose);
    };
  }, [onClose, triggerRef]);

  const ordered = useMemo(
    () => orderBranches(refs.branches, refs.current),
    [refs.branches, refs.current],
  );
  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return ordered;
    return ordered.filter((b) => b.toLowerCase().includes(q));
  }, [ordered, filter]);

  // Selectable rows exclude the current branch (switching to it is a no-op) and, when no
  // filter, the case where only the current branch exists shows a disabled "no other" row.
  const selectable = useMemo(() => filtered.filter((b) => b !== refs.current), [filtered, refs]);

  useEffect(() => {
    setActiveIndex(0);
  }, []);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActiveIndex((i) => Math.min(i + 1, Math.max(selectable.length - 1, 0)));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const ref = selectable[activeIndex];
      if (ref && !switching) {
        setPending(ref);
        onSelect(ref);
      }
    }
  };

  const showNoOther = refs.loaded && selectable.length === 0;

  return createPortal(
    <div
      ref={menuRef}
      className="ctxmenu git-branch-menu"
      style={{
        left: pos?.x ?? -9999,
        top: pos?.y ?? -9999,
        visibility: pos ? 'visible' : 'hidden',
      }}
      role="menu"
      aria-label="Switch branch"
      aria-busy={switching || !refs.loaded}
      onKeyDown={onKeyDown}
    >
      <input
        ref={inputRef}
        type="text"
        className="git-branch-menu__filter"
        placeholder={STR.filterPlaceholder}
        value={filter}
        disabled={switching}
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
              // aria-checked drives the selected treatment (.ctxmenu__item[aria-checked]);
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
                if (row.actionable) {
                  setPending(b);
                  onSelect(b);
                }
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

      {showNoOther && (
        <div className="ctxmenu__item git-branch-menu__empty" aria-disabled>
          {STR.noOther}
        </div>
      )}
    </div>,
    document.body,
  );
}
