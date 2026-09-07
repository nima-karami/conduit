import type { ReactNode, RefObject } from 'react';
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import type { PopoverSide, Rect } from '../../src/menu-position';
import { Popover } from './popover';

/** Matches `.ctxmenu`'s `min-width` in styles.css — the floor when no anchor supplies a width. */
const MENU_MIN_W = 184;

export interface MenuItem {
  label: string;
  icon?: ReactNode;
  onClick: () => void;
  danger?: boolean;
  separatorBefore?: boolean;
  disabled?: boolean;
  /** Right-aligned accelerator (e.g. "F12"). Presentational only — the key is bound
   *  elsewhere; this just tells the user it exists, the way VS Code's menus do. */
  hint?: string;
  /** Native tooltip, rendered on the row WRAPPER: its main job is saying why a row is greyed
   *  out, and a disabled <button> never shows a title of its own (no hover on a disabled
   *  control). */
  title?: string;
  checked?: boolean;
}

export interface MenuState {
  x: number;
  y: number;
  items: MenuItem[];
  /** Opened via the keyboard (Shift+F10) — start the highlight on the first enabled item so arrow
   *  keys and Enter work immediately, instead of pointer mode's -1 (no highlight). */
  keyboard?: boolean;
  /** When set, the menu anchors to this trigger rect (via `Popover`) instead of `{x, y}`. */
  anchor?: Rect;
  side?: PopoverSide;
}

/**
 * The app's single floating context menu. Consumers supply only `menu` ({x, y, items})
 * and an idempotent `onClose` (it fires from many listeners: Escape, outside-click,
 * scroll, blur, resize, activation). Built on `Popover` for positioning, clamping, the
 * portal and the dismiss listeners; adds keyboard nav (Up/Down/Home/End/Enter).
 *
 * `triggerRef` — when set, mousedown inside it is NOT an outside-click, preventing the
 * dismiss→reopen double-fire when the open menu's trigger is clicked. Pair with
 * `menuToggleIntent` on the trigger's onClick to complete the toggle contract.
 */
export function ContextMenu({
  menu,
  onClose,
  triggerRef,
  minWidth,
}: {
  menu: MenuState;
  onClose: () => void;
  triggerRef?: RefObject<Element | null>;
  /** Floor for the menu's width. A select's menu matches its field so it reads as the field
   *  expanding rather than as a popup that happens to be nearby. */
  minWidth?: number;
}) {
  // Keyboard-highlighted item; -1 = none (pointer mode). The ref mirror lets the keydown
  // handler read the current index without re-binding.
  const [activeIndex, setActiveIndex] = useState(-1);
  const activeRef = useRef(-1);
  const baseId = useId();

  const setActive = useCallback((i: number) => {
    activeRef.current = i;
    setActiveIndex(i);
  }, []);

  // Reset the keyboard highlight whenever the menu (re)opens or its items change. A keyboard-invoked
  // menu (Shift+F10) starts on its first enabled item so arrow/Enter work without a pointer.
  // biome-ignore lint/correctness/useExhaustiveDependencies: items identity is the trigger.
  useLayoutEffect(() => {
    if (menu.keyboard) {
      const first = menu.items.findIndex((it) => !it.disabled);
      setActive(first);
    } else {
      setActive(-1);
    }
  }, [menu]);

  // Keyboard navigation across enabled items. Escape is handled by the overlay stack (Popover).
  useEffect(() => {
    const enabled = menu.items.map((it, i) => (it.disabled ? -1 : i)).filter((i) => i >= 0);
    if (enabled.length === 0) return;

    const onKey = (e: KeyboardEvent) => {
      const step = (dir: 1 | -1) => {
        e.preventDefault();
        const cur = activeRef.current;
        const at = enabled.indexOf(cur);
        if (at === -1) {
          setActive(dir === 1 ? enabled[0] : enabled[enabled.length - 1]);
        } else {
          setActive(enabled[(at + dir + enabled.length) % enabled.length]);
        }
      };
      if (e.key === 'ArrowDown') step(1);
      else if (e.key === 'ArrowUp') step(-1);
      else if (e.key === 'Home') {
        e.preventDefault();
        setActive(enabled[0]);
      } else if (e.key === 'End') {
        e.preventDefault();
        setActive(enabled[enabled.length - 1]);
      } else if (e.key === 'Enter') {
        const it = menu.items[activeRef.current];
        if (it && !it.disabled) {
          e.preventDefault();
          it.onClick();
          onClose();
        }
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [menu.items, onClose, setActive]);

  const activeId = activeIndex >= 0 ? `${baseId}-item-${activeIndex}` : undefined;

  const content = (
    // The scroll lives on an inner element so the frame itself never scrolls: Neon's
    // chamfer draws its diagonal at the surface's bottom-right, and on a scrolling
    // element that is the bottom of the CONTENT, not of the visible edge (blockers Q4).
    <div className="ctxmenu__scroll">
      {menu.items.map((it, i) => (
        <div key={it.label} title={it.title}>
          {it.separatorBefore && <div className="ctxmenu__sep" />}
          <button
            id={`${baseId}-item-${i}`}
            type="button"
            role={it.checked === undefined ? 'menuitem' : 'menuitemcheckbox'}
            aria-checked={it.checked}
            className={`ctxmenu__item ${it.danger ? 'ctxmenu__item--danger' : ''} ${
              i === activeIndex ? 'ctxmenu__item--active' : ''
            }`}
            disabled={it.disabled}
            aria-disabled={it.disabled || undefined}
            onMouseEnter={() => setActive(it.disabled ? -1 : i)}
            onClick={() => {
              it.onClick();
              onClose();
            }}
          >
            {it.icon && <span className="ctxmenu__icon">{it.icon}</span>}
            <span>{it.label}</span>
            {it.hint && <span className="ctxmenu__hint">{it.hint}</span>}
          </button>
        </div>
      ))}
    </div>
  );

  return menu.anchor ? (
    <Popover
      anchor={menu.anchor}
      width={minWidth ?? MENU_MIN_W}
      align="end"
      side={menu.side}
      onClose={onClose}
      triggerRef={triggerRef}
      className="ctxmenu"
      role="menu"
      aria-activedescendant={activeId}
    >
      {content}
    </Popover>
  ) : (
    <Popover
      at={{ x: menu.x, y: menu.y }}
      onClose={onClose}
      triggerRef={triggerRef}
      className="ctxmenu"
      role="menu"
      aria-activedescendant={activeId}
      style={{ minWidth }}
    >
      {content}
    </Popover>
  );
}
