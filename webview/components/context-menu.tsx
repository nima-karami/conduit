import type { ReactNode, RefObject } from 'react';
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import type { Point, PopoverSide, Rect } from '../../src/menu-position';
import { useHoverGate } from '../hover-gate';
import { middleClickProps } from '../middle-click';
import { Popover } from './popover';

/** How a row was activated — its rect, so an item can anchor what it opens beside the row. */
export interface MenuActivation {
  rect: Rect;
}

/** Matches `.ctxmenu`'s `min-width` in styles.css — the floor when no anchor supplies a width. */
const MENU_MIN_W = 184;

interface MenuRow {
  label: string;
  /** Dim secondary text after the label (a repo name): kept in its own case under an
   *  uppercasing theme, and the part that ellipsizes when the menu is narrower than the row. */
  detail?: string;
  /** Row identity when labels can repeat (two folders of the same name). Defaults to the label. */
  key?: string;
  icon?: ReactNode;
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
  /** With `checked` set, one of a mutually exclusive set (menuitemradio, not checkbox). */
  radio?: boolean;
}

export interface MenuItem extends MenuRow {
  /** The activation is optional because programmatic callers invoke items bare. */
  onClick: (activation?: MenuActivation) => void;
  submenu?: never;
  /** A middle-click on the row (a file list's background open). Absent → the row has no middle
   *  action. Either way the menu's own middle-click default is suppressed. */
  onMiddleClick?: () => void;
}

export type MenuEntry =
  | MenuItem
  | (MenuRow & {
      submenu: () => MenuItem[];
      onClick?: never;
      onMiddleClick?: never;
    });

export interface MenuState {
  x: number;
  y: number;
  items: MenuEntry[];
  /** Opened via the keyboard (Shift+F10) — start the highlight on the first enabled item so arrow
   *  keys and Enter work immediately, instead of pointer mode's -1 (no highlight). */
  keyboard?: boolean;
  /** When set, the menu anchors to this trigger rect (via `Popover`) instead of `{x, y}`. */
  anchor?: Rect;
  side?: PopoverSide;
  /** Fires once when this menu stops being the open one — picked, dismissed or replaced. */
  onClosed?: () => void;
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
  maxWidth,
}: {
  menu: MenuState;
  onClose: () => void;
  triggerRef?: RefObject<Element | null>;
  /** Floor for the menu's width. A select's menu matches its field so it reads as the field
   *  expanding rather than as a popup that happens to be nearby. */
  minWidth?: number;
  /** Ceiling for the menu's width, below the viewport's (a menu kept inside its pane). */
  maxWidth?: number;
}) {
  const baseId = useId();
  const rootFrame = useRef<HTMLDivElement>(null);
  const childFrame = useRef<HTMLDivElement>(null);
  const priorFocus = useRef<HTMLElement | null>(null);
  const path = useRef<{ origin: Point; previous: Point } | null>(null);
  const towardChild = useRef(false);
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const hoverTarget = useRef<number | null | undefined>(undefined);
  const [activeIndex, setActive] = useState(-1);
  const [childIndex, setChildIndex] = useState(-1);
  const [child, setChild] = useState<{
    parent: number;
    anchor: Rect;
    items: MenuItem[];
    keyboard: boolean;
  } | null>(null);
  const { pointer, moved } = useHoverGate(menu);
  const rootId = (i: number) => `${baseId}-item-${i}`;
  const childId = `${baseId}-submenu`;

  const cancelHover = useCallback(() => {
    clearTimeout(hoverTimer.current);
    hoverTarget.current = undefined;
  }, []);

  const restoreFocus = useCallback(() => {
    if (childFrame.current?.contains(document.activeElement)) priorFocus.current?.focus();
    priorFocus.current = null;
  }, []);

  const closeChild = useCallback(() => {
    cancelHover();
    restoreFocus();
    towardChild.current = false;
    setChild(null);
  }, [cancelHover, restoreFocus]);

  useLayoutEffect(() => {
    setActive(menu.keyboard ? menu.items.findIndex((item) => !item.disabled) : -1);
    closeChild();
    path.current = null;
    if (!menu.keyboard && menu.items.some((item) => item.submenu)) {
      moved({ clientX: menu.x, clientY: menu.y });
    }
    return cancelHover;
  }, [menu, closeChild, cancelHover, moved]);

  useLayoutEffect(() => {
    if (!child?.keyboard) return;
    if (
      document.activeElement instanceof HTMLElement &&
      document.activeElement !== childFrame.current
    ) {
      priorFocus.current = document.activeElement;
    }
    childFrame.current?.focus({ preventScroll: true });
  }, [child]);

  const openChild = useCallback(
    (parent: number, keyboard: boolean) => {
      cancelHover();
      if (child?.parent === parent && !keyboard) return;
      const row = document.getElementById(`${baseId}-item-${parent}`);
      const frame = rootFrame.current;
      const items = menu.items[parent]?.submenu?.();
      if (!row || !frame || !items?.length) return;
      const { left, right } = frame.getBoundingClientRect();
      const { top, bottom } = row.getBoundingClientRect();
      setActive(parent);
      setChildIndex(keyboard ? items.findIndex((item) => !item.disabled) : -1);
      setChild({ parent, anchor: { left, right, top, bottom }, items, keyboard });
    },
    [baseId, cancelHover, child?.parent, menu.items],
  );

  const dismiss = useCallback(() => {
    cancelHover();
    restoreFocus();
    onClose();
  }, [cancelHover, restoreFocus, onClose]);

  const activate = useCallback(
    (item: MenuEntry, index: number, row: HTMLElement | null, keyboard: boolean) => {
      if (item.submenu) {
        openChild(index, keyboard);
      } else {
        restoreFocus();
        const rect = row?.getBoundingClientRect();
        item.onClick(rect ? { rect } : undefined);
        dismiss();
      }
    },
    [openChild, restoreFocus, dismiss],
  );

  const scheduleHover = useCallback(
    (index: number | null) => {
      if (hoverTarget.current === index) return;
      cancelHover();
      hoverTarget.current = index;
      hoverTimer.current = setTimeout(
        () => {
          hoverTarget.current = undefined;
          const item = index === null ? undefined : menu.items[index];
          if (index !== null && item?.submenu && !item.disabled) {
            openChild(index, false);
          } else {
            closeChild();
            if (index !== null) setActive(item?.disabled ? -1 : index);
          }
        },
        child ? 350 : 140,
      );
    },
    [cancelHover, child, closeChild, menu.items, openChild],
  );

  useEffect(() => {
    if (!child) return;
    const trackPointer = (e: PointerEvent) => {
      const transit = path.current;
      const frame = childFrame.current?.getBoundingClientRect();
      if (!transit || !frame) return;
      // A slow diagonal can cross other rows. Keep the submenu open while the pointer advances
      // through the triangle to its near edge, even when the child was flipped or clamped.
      const { origin, previous } = transit;
      const edge = frame.left >= origin.x ? frame.left : frame.right;
      const distance = edge - origin.x;
      const progress = (e.clientX - origin.x) / distance;
      const top = origin.y + (frame.top - origin.y) * progress;
      const bottom = origin.y + (frame.bottom - origin.y) * progress;
      towardChild.current =
        progress > 0 &&
        progress <= 1 &&
        (e.clientX - previous.x) * distance > 0 &&
        e.clientY >= top &&
        e.clientY <= bottom;
      transit.previous = { x: e.clientX, y: e.clientY };
      const target = e.target as Node;
      if (towardChild.current) cancelHover();
      else if (!rootFrame.current?.contains(target) && !childFrame.current?.contains(target)) {
        scheduleHover(null);
      }
    };
    window.addEventListener('pointermove', trackPointer, true);
    return () => window.removeEventListener('pointermove', trackPointer, true);
  }, [child, cancelHover, scheduleHover]);

  useEffect(() => {
    const items = child?.items ?? menu.items;
    const index = child ? childIndex : activeIndex;
    const select = child ? setChildIndex : setActive;
    const enabled = items.flatMap((item, i) => (item.disabled ? [] : [i]));
    const onKey = (e: KeyboardEvent) => {
      // Xterm acts on keydown without reading defaultPrevented.
      const claim = () => {
        e.preventDefault();
        e.stopPropagation();
        cancelHover();
      };
      if (e.key === 'ArrowLeft' && child) {
        claim();
        closeChild();
        return;
      }
      if (enabled.length === 0) return;
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        claim();
        const at = enabled.indexOf(index);
        const down = e.key === 'ArrowDown';
        const next = at === -1 ? (down ? 0 : enabled.length - 1) : at + (down ? 1 : -1);
        select(enabled[(next + enabled.length) % enabled.length]);
      } else if (e.key === 'Home' || e.key === 'End') {
        claim();
        select(e.key === 'Home' ? enabled[0] : enabled[enabled.length - 1]);
      } else if (e.key === 'Enter' || (e.key === 'ArrowRight' && !child)) {
        const item = items[index];
        if (!item || item.disabled || (e.key === 'ArrowRight' && !item.submenu)) return;
        claim();
        const rowId = child ? `${childId}-item-${index}` : `${baseId}-item-${index}`;
        activate(item, index, document.getElementById(rowId), true);
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [
    menu.items,
    child,
    childIndex,
    activeIndex,
    baseId,
    childId,
    activate,
    closeChild,
    cancelHover,
  ]);

  const rows = (items: readonly MenuEntry[], inChild: boolean) => (
    <div className="ctxmenu__scroll" onScroll={inChild ? undefined : closeChild}>
      {items.map((it, i) => (
        <div
          key={it.key ?? it.label}
          title={it.title}
          onPointerMove={(e) => {
            if (inChild) {
              cancelHover();
              setChildIndex(it.disabled ? -1 : i);
              return;
            }
            if (!moved(e)) return;
            if (it.submenu && (!child || child.parent === i)) {
              const point = { x: e.clientX, y: e.clientY };
              path.current = { origin: point, previous: point };
            }
            if (child?.parent === i) {
              cancelHover();
              return;
            }
            if (!child) setActive(it.disabled ? -1 : i);
            if (towardChild.current) return;
            if (child || (!it.disabled && it.submenu)) scheduleHover(i);
            else cancelHover();
          }}
        >
          {it.separatorBefore && <div className="ctxmenu__sep" />}
          <button
            id={inChild ? `${childId}-item-${i}` : rootId(i)}
            type="button"
            role={
              it.checked === undefined
                ? 'menuitem'
                : it.radio
                  ? 'menuitemradio'
                  : 'menuitemcheckbox'
            }
            aria-checked={it.checked}
            aria-haspopup={it.submenu ? 'menu' : undefined}
            aria-expanded={it.submenu ? child?.parent === i : undefined}
            aria-controls={it.submenu && child?.parent === i ? childId : undefined}
            className={`ctxmenu__item ${it.danger ? 'ctxmenu__item--danger' : ''} ${
              i === (inChild ? childIndex : activeIndex) ? 'ctxmenu__item--active' : ''
            }`}
            disabled={it.disabled}
            aria-disabled={it.disabled || undefined}
            onClick={(e) => activate(it, i, e.currentTarget, e.detail === 0)}
            {...middleClickProps(
              it.onMiddleClick
                ? () => {
                    it.onMiddleClick?.();
                    dismiss();
                  }
                : null,
            )}
          >
            {it.icon && <span className="ctxmenu__icon">{it.icon}</span>}
            <span className="ctxmenu__label">{it.label}</span>
            {it.detail !== undefined && <span className="ctxmenu__detail">{it.detail}</span>}
            {it.submenu ? (
              <span className="ctxmenu__hint" aria-hidden="true">
                ▸
              </span>
            ) : (
              it.hint && <span className="ctxmenu__hint">{it.hint}</span>
            )}
          </button>
        </div>
      ))}
    </div>
  );

  return (
    <>
      <Popover
        ref={rootFrame}
        insideRef={childFrame}
        anchor={menu.anchor}
        at={menu.anchor ? undefined : { x: menu.x, y: menu.y }}
        width={menu.anchor ? (minWidth ?? MENU_MIN_W) : undefined}
        side={menu.side}
        onClose={dismiss}
        triggerRef={triggerRef}
        className="ctxmenu"
        role="menu"
        aria-activedescendant={activeIndex >= 0 ? rootId(activeIndex) : undefined}
        data-pointer={pointer}
        style={menu.anchor ? { maxWidth } : { minWidth, maxWidth }}
        onPointerLeave={(e) => {
          if (e.relatedTarget instanceof Node && childFrame.current?.contains(e.relatedTarget))
            return;
          if (child && !towardChild.current) scheduleHover(null);
          else cancelHover();
        }}
      >
        {rows(menu.items, false)}
      </Popover>
      {child && (
        <Popover
          ref={childFrame}
          insideRef={rootFrame}
          id={childId}
          anchor={child.anchor}
          beside
          gap={0}
          onClose={closeChild}
          className="ctxmenu"
          role="menu"
          tabIndex={-1}
          aria-labelledby={rootId(child.parent)}
          aria-activedescendant={childIndex >= 0 ? `${childId}-item-${childIndex}` : undefined}
          onPointerEnter={cancelHover}
          onPointerLeave={(e) => {
            if (e.relatedTarget instanceof Node && rootFrame.current?.contains(e.relatedTarget))
              return;
            scheduleHover(null);
          }}
        >
          {rows(child.items, true)}
        </Popover>
      )}
    </>
  );
}
