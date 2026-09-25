import { type MouseEvent as ReactMouseEvent, useCallback, useRef, useState } from 'react';
import { anchorPopover } from '../../src/menu-position';
import { menuToggleIntent } from '../../src/menu-toggle';
import { IconCheck, IconChevronDown, IconFolder } from '../icons';
import type { RepoChipRow } from '../review-repos';
import { ContextMenu, type MenuState } from './context-menu';

export interface ReviewRepoChipProps {
  rows: RepoChipRow[];
  label: string;
  title: string;
  compact: boolean;
  onPick: (root: string | null) => void;
}

export function ReviewRepoChip({ rows, label, title, compact, onPick }: ReviewRepoChipProps) {
  const [menu, setMenu] = useState<MenuState | null>(null);
  const chipRef = useRef<HTMLButtonElement | null>(null);
  const wasOpenRef = useRef(false);

  const openMenu = useCallback(
    (e: ReactMouseEvent<HTMLButtonElement>) => {
      const wasOpen = wasOpenRef.current;
      // A keyboard click has no mousedown to refresh this, so a stale `true` would eat it.
      wasOpenRef.current = false;
      if (menuToggleIntent(wasOpen) === 'close') {
        setMenu(null);
        return;
      }
      // Start-aligned, unlike `···`'s anchorMenuToRect: the chip leads the header, so an
      // end-aligned menu would hang off the pane's left edge.
      const at = anchorPopover(
        e.currentTarget.getBoundingClientRect(),
        { width: 0, height: 0 },
        { align: 'start', side: 'below', gap: 4 },
      );
      setMenu({
        x: at.x,
        y: at.y,
        keyboard: e.detail === 0,
        items: rows.map((row, i) => ({
          label: row.label,
          radio: true,
          checked: row.checked,
          icon: row.checked ? <IconCheck size={13} /> : undefined,
          hint: row.hint,
          separatorBefore: i === 1,
          onClick: () => onPick(row.root),
        })),
      });
    },
    [rows, onPick],
  );

  const closeMenu = useCallback(() => {
    setMenu(null);
    chipRef.current?.focus();
  }, []);

  return (
    <>
      <button
        ref={chipRef}
        type="button"
        className="gh__reffilter review__chip"
        aria-haspopup="menu"
        aria-expanded={menu !== null}
        aria-label={`Review repo: ${label}`}
        title={title}
        onMouseDown={() => {
          wasOpenRef.current = menu !== null;
        }}
        onClick={openMenu}
      >
        <IconFolder size={13} />
        {!compact && <span className="gh__reffilter-label">{label}</span>}
        <IconChevronDown size={13} className="gh__reffilter-caret" />
      </button>
      {menu && <ContextMenu menu={menu} onClose={closeMenu} triggerRef={chipRef} />}
    </>
  );
}
