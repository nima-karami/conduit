import { useRef, useState } from 'react';
import { anchorMenuToRect } from '../../src/menu-position';
import { menuToggleIntent } from '../../src/menu-toggle';
import { IconCheck, IconChevronDown } from '../icons';
import { ContextMenu, type MenuState } from './context-menu';

export interface SelectOption {
  value: string;
  label: string;
}

/**
 * The app's dropdown. A native `<select>` renders its popup with the OS widget: it ignores
 * every theme token, keeps square Windows corners under Neon, and cannot show a check or a
 * chevron of ours — so a settings pane full of them read as borrowed chrome.
 *
 * Built on the same floating menu the branch switcher and commit picker use, so it inherits
 * viewport clamping, keyboard nav, Escape, outside-click and the portal that escapes our
 * blurred panels — rather than being a second menu implementation.
 *
 * `menuToggleIntent` + `triggerRef` give the trigger the toggle contract: clicking an open
 * menu's own trigger closes it instead of dismiss-then-reopen.
 */
export function SelectField({
  value,
  options,
  onChange,
  ariaLabel,
  disabled,
}: {
  value: string;
  options: SelectOption[];
  onChange: (value: string) => void;
  ariaLabel?: string;
  disabled?: boolean;
}) {
  const [menu, setMenu] = useState<MenuState | null>(null);
  const openAtMouseDown = useRef(false);
  const triggerRef = useRef<HTMLButtonElement>(null);

  const current = options.find((o) => o.value === value);

  const open = () => {
    const el = triggerRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    // Match the trigger's width so the menu reads as the field expanding, not as a popup
    // that happens to be nearby.
    const width = Math.max(rect.width, 160);
    const { x, y } = anchorMenuToRect(rect, width);
    setMenu({
      x,
      y,
      items: options.map((o) => ({
        label: o.label,
        icon: o.value === value ? <IconCheck size={13} /> : undefined,
        onClick: () => onChange(o.value),
      })),
    });
  };

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={`selectfield${menu ? ' selectfield--open' : ''}`}
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={menu !== null}
        disabled={disabled}
        onMouseDown={() => {
          openAtMouseDown.current = menu !== null;
        }}
        onClick={() => {
          if (menuToggleIntent(openAtMouseDown.current) === 'close') setMenu(null);
          else open();
        }}
      >
        <span className="selectfield__value">{current?.label ?? value}</span>
        <IconChevronDown size={13} className="selectfield__caret" />
      </button>
      {menu && (
        <ContextMenu
          menu={menu}
          onClose={() => setMenu(null)}
          triggerRef={triggerRef}
          minWidth={Math.max(triggerRef.current?.getBoundingClientRect().width ?? 0, 160)}
        />
      )}
    </>
  );
}
