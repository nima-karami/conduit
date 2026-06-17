import type { ReactNode, RefObject } from 'react';
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { clampMenuPosition } from '../../src/menu-position';
import { useEscapeKey } from '../use-escape-key';

export interface MenuItem {
  label: string;
  icon?: ReactNode;
  onClick: () => void;
  danger?: boolean;
  separatorBefore?: boolean;
  disabled?: boolean;
}

export interface MenuState {
  x: number;
  y: number;
  items: MenuItem[];
}

/**
 * The app's single floating context menu. Consumers supply only `menu` ({x, y, items})
 * and an idempotent `onClose` (it fires from many listeners: Escape, outside-click,
 * scroll, blur, resize, activation). Self-positions at the cursor, clamps to the viewport,
 * and supports keyboard nav (Up/Down/Home/End/Enter).
 *
 * Portaled to `document.body` because the menu is `position: fixed` with viewport `{x, y}`,
 * but our panels carry `backdrop-filter` (background blur) — any non-`none`
 * filter/backdrop-filter/transform makes that ancestor the containing block for fixed
 * descendants, which offset an inline menu by the panel's top-left. The portal escapes them.
 *
 * `triggerRef` — when set, mousedown inside it is NOT an outside-click, preventing the
 * dismiss→reopen double-fire when the open menu's trigger is clicked. Pair with
 * `menuToggleIntent` on the trigger's onClick to complete the toggle contract.
 */
export function ContextMenu({
  menu,
  onClose,
  triggerRef,
}: {
  menu: MenuState;
  onClose: () => void;
  triggerRef?: RefObject<Element | null>;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x: menu.x, y: menu.y });
  // Keyboard-highlighted item; -1 = none (pointer mode). The ref mirror lets the keydown
  // handler read the current index without re-binding.
  const [activeIndex, setActiveIndex] = useState(-1);
  const activeRef = useRef(-1);
  const baseId = useId();

  const setActive = useCallback((i: number) => {
    activeRef.current = i;
    setActiveIndex(i);
  }, []);

  // Reset the keyboard highlight whenever the menu (re)opens or its items change.
  // biome-ignore lint/correctness/useExhaustiveDependencies: items identity is the trigger.
  useLayoutEffect(() => {
    setActive(-1);
  }, [menu]);

  // Keep the menu within the viewport (pure, tested clamp).
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setPos(
      clampMenuPosition(
        { x: menu.x, y: menu.y },
        { width: r.width, height: r.height },
        { width: window.innerWidth, height: window.innerHeight },
      ),
    );
  }, [menu]);

  useEscapeKey(onClose);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (ref.current?.contains(target)) return;
      // Ignore mousedown on the registered trigger so its onClick can toggle correctly;
      // otherwise the dismiss here + the onClick reopen (close → open, not stay-closed).
      if (triggerRef?.current?.contains(target)) return;
      onClose();
    };
    window.addEventListener('mousedown', onDown, true);
    // Capture-phase so a scroll in ANY container (anchor moved) dismisses, not just
    // window scroll — EXCEPT a scroll inside the menu's own overflow (tall menus scroll
    // themselves), or it would dismiss the instant you drag its scrollbar.
    const onScroll = (e: Event) => {
      if (ref.current?.contains(e.target as Node)) return;
      onClose();
    };
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('blur', onClose);
    window.addEventListener('resize', onClose);
    return () => {
      window.removeEventListener('mousedown', onDown, true);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('blur', onClose);
      window.removeEventListener('resize', onClose);
    };
  }, [onClose, triggerRef]);

  // Keyboard navigation across enabled items. Escape is handled by useEscapeKey.
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

  return createPortal(
    <div
      className="ctxmenu"
      ref={ref}
      style={{ left: pos.x, top: pos.y }}
      role="menu"
      aria-activedescendant={activeId}
    >
      {menu.items.map((it, i) => (
        <div key={it.label}>
          {it.separatorBefore && <div className="ctxmenu__sep" />}
          <button
            id={`${baseId}-item-${i}`}
            type="button"
            role="menuitem"
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
          </button>
        </div>
      ))}
    </div>,
    document.body,
  );
}
