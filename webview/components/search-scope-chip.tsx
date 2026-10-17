import {
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  useCallback,
  useRef,
  useState,
} from 'react';
import { anchorPopover } from '../../src/menu-position';
import { menuToggleIntent } from '../../src/menu-toggle';
import type { SearchScope } from '../../src/search-scope';
import { IconCheck, IconChevronDown, IconFolder } from '../icons';
import { ContextMenu, type MenuState } from './context-menu';

// Spec docs/specs/2026-10-16-multi-repo-tracking.md §8–§9. No tracked set exists (parked, §6),
// so the default scope is every repo the session found — named for what it is.
const STR = {
  tracked: 'All repos',
  trackedTitle:
    "Each repo's files as git lists them, plus files outside any repo. Gitignored files are left out.",
  repo: (name: string) => name,
  repoTitle: 'Only the active repo',
  noRepo: 'This repo',
  noRepoTitle: 'No active repo in this session',
  everything: 'Everything (may be slow)',
  everythingTitle:
    'Every file under the folder, gitignored ones too (not node_modules, dist, build or other generated folders), up to 20,000 files',
  aria: (label: string) => `Search scope: ${label}`,
};

export interface SearchScopeChipProps {
  scope: SearchScope;
  /** Active repo display name; undefined disables "This repo". */
  repoLabel: string | undefined;
  onPick: (scope: SearchScope) => void;
}

function labelOf(scope: SearchScope, repoLabel: string | undefined): string {
  if (scope === 'repo') return repoLabel === undefined ? STR.noRepo : STR.repo(repoLabel);
  return scope === 'everything' ? STR.everything : STR.tracked;
}

function titleOf(scope: SearchScope): string {
  if (scope === 'repo') return STR.repoTitle;
  return scope === 'everything' ? STR.everythingTitle : STR.trackedTitle;
}

export function SearchScopeChip({ scope, repoLabel, onPick }: SearchScopeChipProps) {
  const [menu, setMenu] = useState<MenuState | null>(null);
  const chipRef = useRef<HTMLButtonElement | null>(null);
  const wasOpenRef = useRef(false);

  const open = useCallback(
    (anchor: DOMRect, keyboard: boolean) => {
      const at = anchorPopover(
        anchor,
        { width: 0, height: 0 },
        {
          align: 'start',
          side: 'below',
          gap: 4,
        },
      );
      const item = (value: SearchScope, label: string, title: string, disabled = false) => ({
        label,
        key: value,
        radio: true,
        checked: scope === value,
        icon: scope === value ? <IconCheck size={13} /> : undefined,
        title,
        disabled,
        onClick: () => onPick(value),
      });
      setMenu({
        x: at.x,
        y: at.y,
        keyboard,
        items: [
          item('tracked', STR.tracked, STR.trackedTitle),
          repoLabel === undefined
            ? item('repo', STR.noRepo, STR.noRepoTitle, true)
            : item('repo', STR.repo(repoLabel), STR.repoTitle),
          item('everything', STR.everything, STR.everythingTitle),
        ],
      });
    },
    [scope, repoLabel, onPick],
  );

  const onClick = useCallback(
    (e: ReactMouseEvent<HTMLButtonElement>) => {
      const wasOpen = wasOpenRef.current;
      // A keyboard click has no mousedown to refresh this, so a stale `true` would eat it.
      wasOpenRef.current = false;
      if (menuToggleIntent(wasOpen) === 'close') {
        setMenu(null);
        return;
      }
      open(e.currentTarget.getBoundingClientRect(), e.detail === 0);
    },
    [open],
  );

  const onKeyDown = useCallback(
    (e: ReactKeyboardEvent<HTMLButtonElement>) => {
      if (e.key !== 'ArrowDown' || menu) return;
      e.preventDefault();
      open(e.currentTarget.getBoundingClientRect(), true);
    },
    [open, menu],
  );

  const closeMenu = useCallback(() => {
    setMenu(null);
    chipRef.current?.focus();
  }, []);

  const label = labelOf(scope, repoLabel);
  return (
    <>
      <button
        ref={chipRef}
        type="button"
        className="gh__reffilter search__scopechip"
        aria-haspopup="menu"
        aria-expanded={menu !== null}
        aria-label={STR.aria(label)}
        title={titleOf(scope)}
        onMouseDown={() => {
          wasOpenRef.current = menu !== null;
        }}
        onClick={onClick}
        onKeyDown={onKeyDown}
      >
        <IconFolder size={13} />
        <span className="gh__reffilter-label">{label}</span>
        <IconChevronDown size={13} className="gh__reffilter-caret" />
      </button>
      {menu && <ContextMenu menu={menu} onClose={closeMenu} triggerRef={chipRef} />}
    </>
  );
}
