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
 * The app's single, reusable floating context menu. Open it by passing a
 * `menu` ({ x, y, items }) — typically built from a `contextmenu` event's
 * clientX/clientY — and an `onClose` to clear that state. It positions itself
 * at the cursor, clamps into the viewport, and dismisses on Escape,
 * click-outside, scroll, window blur/resize, and item activation. Keyboard nav
 * (Up/Down/Home/End/Enter) moves an active highlight across enabled items.
 *
 * Consumers (file/change/session/tab menus today; canvas/board/editor/panel
 * menus later) only supply the item list and positioning — no positioning or
 * dismissal logic of their own.
 *
 * `onClose` may be called from several listeners (Escape, outside-click,
 * scroll, blur, resize, activation), so it MUST be idempotent — clearing
 * already-cleared menu state must be a no-op.
 *
 * The menu is rendered through a portal into `document.body`. It is
 * `position: fixed` and its `{x, y}` are viewport coordinates (typically a
 * `contextmenu` event's clientX/clientY, or a trigger button's
 * `getBoundingClientRect()`). A `position: fixed` box only resolves against the
 * viewport when no ancestor establishes a containing block — but our panels
 * (`.sidebar`, `.right`, `.termwrap`, …) carry a `backdrop-filter` (the
 * background-blur feature), and any non-`none` filter/backdrop-filter/transform
 * makes that ancestor the containing block for fixed descendants. Rendering the
 * menu inline (as a child of those panels) therefore offset it by the panel's
 * top-left — the editor menu drifted from the cursor and the sessions overflow
 * menu landed in the middle of the sidebar. Portaling to `<body>` escapes every
 * such ancestor so the coordinates mean what consumers expect.
 *
 * `triggerRef` — optional ref to the button that opened this menu. When
 * provided, mousedown events whose target is inside that element are NOT treated
 * as outside-clicks, preventing the dismiss→reopen double-fire that occurs when
 * the trigger is clicked while the menu is already open. The trigger's own
 * onClick should use `menuToggleIntent` (src/menu-toggle.ts) to decide whether
 * to open or stay closed, completing the toggle contract.
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
  // Index of the keyboard-highlighted item; -1 = none (pointer mode). A ref
  // mirror lets the keydown handler read the current index without re-binding.
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
      // Never self-dismiss when the click is inside the menu itself.
      if (ref.current?.contains(target)) return;
      // When a trigger element is registered, ignore mousedown on it so the
      // trigger's onClick can observe `wasOpenAtMousedown` and toggle correctly.
      // Without this guard the dismiss fires here and the onClick re-opens the
      // menu (close → open instead of close → stay closed).
      if (triggerRef?.current?.contains(target)) return;
      onClose();
    };
    window.addEventListener('mousedown', onDown, true);
    // Capture-phase so a scroll in ANY container (the anchor moved) dismisses,
    // not just window scroll. The menu has no internal scroll, so this can't
    // self-dismiss. Consumers that live inside scroll containers (canvas/board/
    // tree) should be aware: any scroll while open closes the menu.
    window.addEventListener('scroll', onClose, true);
    window.addEventListener('blur', onClose);
    window.addEventListener('resize', onClose);
    return () => {
      window.removeEventListener('mousedown', onDown, true);
      window.removeEventListener('scroll', onClose, true);
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
