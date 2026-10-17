import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { GitRef } from '../../src/protocol';
import { IconCheck, IconChevronDown } from '../icons';
import { ContextMenu, type MenuState } from './context-menu';

const STR = {
  allRefs: 'All branches',
  filterLabel: 'Filter by ref',
};

/**
 * Ref filter as the app's own themed dropdown (not a native <select>, which renders an
 * OS popup that clashes with the rest of the chrome). A trigger button shows the current
 * selection; clicking opens the shared ContextMenu (portal + keyboard nav + dismiss) with
 * "All branches" plus one row per ref, the active one check-marked. Same semantics as the
 * old select: picking a row calls onRefFilter(name | null).
 */
export function RefFilterDropdown({
  refFilter,
  refOptions,
  onRefFilter,
}: {
  refFilter: string | null;
  refOptions: GitRef[];
  onRefFilter: (r: string | null) => void;
}) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [menuPos, setMenuPos] = useState<{ x: number; y: number } | null>(null);
  const onRefFilterRef = useRef(onRefFilter);
  useLayoutEffect(() => {
    onRefFilterRef.current = onRefFilter;
  });

  // A ref that's no longer in the list (e.g. after a refresh) falls back to "All branches",
  // matching the native select's behaviour when its value wasn't among the options.
  const active = refFilter && refOptions.some((r) => r.name === refFilter) ? refFilter : null;
  // ContextMenu restarts its hover gate and highlight on a new menu identity, and a history
  // refresh hands over a fresh refOptions array with the same refs (review r2).
  const namesKey = refOptions.map((r) => r.name).join('\0');

  // biome-ignore lint/correctness/useExhaustiveDependencies: namesKey stands in for refOptions.
  const menu = useMemo((): MenuState | null => {
    if (!menuPos) return null;
    const mark = (on: boolean) =>
      on ? <IconCheck size={13} /> : <span className="gh__reffilter-checkpad" />;
    const names = namesKey ? namesKey.split('\0') : [];
    return {
      ...menuPos,
      items: [
        {
          label: STR.allRefs,
          icon: mark(active === null),
          onClick: () => onRefFilterRef.current(null),
        },
        ...names.map((name) => ({
          label: name,
          icon: mark(active === name),
          onClick: () => onRefFilterRef.current(name),
        })),
      ],
    };
  }, [menuPos, namesKey, active]);

  const toggle = () => {
    if (menuPos) {
      setMenuPos(null);
      return;
    }
    const r = triggerRef.current?.getBoundingClientRect();
    if (r) setMenuPos({ x: r.left, y: r.bottom + 2 });
  };

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className="gh__reffilter"
        aria-haspopup="menu"
        aria-expanded={menuPos !== null}
        aria-label={STR.filterLabel}
        onClick={toggle}
      >
        <span className="gh__reffilter-label">{active ?? STR.allRefs}</span>
        <IconChevronDown size={13} className="gh__reffilter-caret" />
      </button>
      {menu && <ContextMenu menu={menu} onClose={() => setMenuPos(null)} triggerRef={triggerRef} />}
    </>
  );
}
