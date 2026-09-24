import type { HTMLAttributes, ReactNode, Ref, RefObject } from 'react';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  anchorPopover,
  clampMenuPosition,
  type PopoverAlign,
  type PopoverSide,
  type Rect,
} from '../../src/menu-position';
import { useOverlayEntry } from '../use-overlay-entry';

export interface PopoverProps extends Omit<HTMLAttributes<HTMLDivElement>, 'children'> {
  /** Exactly one of `at` (a raw viewport point) or `anchor` (a trigger's rect) is given. */
  at?: { x: number; y: number };
  anchor?: Rect;
  /** Min-width; the frame grows with its content and aligns by its measured width (a caller
   *  wanting an exact width passes `style={{ width }}`). */
  width?: number;
  align?: PopoverAlign;
  /** A PREFERENCE, no flip: a box that does not fit is pinned to the viewport margin and may
   *  overlap its anchor. */
  side?: PopoverSide;
  gap?: number;
  /** Idempotent; fired from outside-mousedown / outside-scroll / blur / resize / Escape (stack). */
  onClose: () => void;
  triggerRef?: RefObject<Element | null>;
  ref?: Ref<HTMLDivElement>;
  children: ReactNode;
}

/**
 * A portaled, anchored (or point-positioned) frame: viewport-clamped, dismissed by outside
 * mousedown/scroll, blur, resize, or Escape via the overlay stack. `ContextMenu` and the
 * combobox/type-picker popups are built on it. The board's pane-local `.queuepopover` is
 * deliberately NOT a `Popover` — it is scoped to its own pane, not the app-wide stack.
 */
export function Popover({
  at,
  anchor,
  width,
  align = 'end',
  side = 'below',
  gap = 4,
  onClose,
  triggerRef,
  ref,
  className,
  style,
  children,
  ...rest
}: PopoverProps) {
  const measureRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x: 0, y: 0 });

  useOverlayEntry('popover', onClose);

  const mergedRef = useCallback(
    (node: HTMLDivElement | null) => {
      measureRef.current = node;
      if (typeof ref === 'function') ref(node);
      else if (ref) ref.current = node;
    },
    [ref],
  );

  // Deps read only the frame's WIDTH and HEIGHT — never its left/top — so setPos(prev => same
  // x/y ? prev : next) converges instead of oscillating against its own last position.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `at` is destructured to its primitive fields (at?.x, at?.y) so a fresh {x,y} literal each render does not re-run this.
  useLayoutEffect(() => {
    const el = measureRef.current;
    if (!el) return;
    const measure = () => {
      const r = el.getBoundingClientRect();
      const requested =
        at ??
        anchorPopover(anchor as Rect, { width: r.width, height: r.height }, { align, side, gap });
      const next = clampMenuPosition(
        requested,
        { width: r.width, height: r.height },
        { width: window.innerWidth, height: window.innerHeight },
      );
      setPos((prev) => (prev.x === next.x && prev.y === next.y ? prev : next));
    };
    measure();
    // Re-run when the content's size changes (loading → list, font swap) without waiting for a
    // prop change.
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [at?.x, at?.y, anchor, width, align, side, gap]);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (measureRef.current?.contains(target)) return;
      // Ignore mousedown on the registered trigger so its onClick can toggle correctly;
      // otherwise the dismiss here + the onClick reopen (close → open, not stay-closed).
      if (triggerRef?.current?.contains(target)) return;
      onClose();
    };
    window.addEventListener('mousedown', onDown, true);
    // Capture-phase so a scroll in ANY container (anchor moved) dismisses, not just window
    // scroll — EXCEPT a scroll inside the frame's own overflow (tall popovers scroll
    // themselves), or it would dismiss the instant you drag its scrollbar.
    const onScroll = (e: Event) => {
      if (measureRef.current?.contains(e.target as Node)) return;
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

  return createPortal(
    <div
      ref={mergedRef}
      className={`popover${className ? ` ${className}` : ''}`}
      style={{ left: pos.x, top: pos.y, minWidth: width, ...style }}
      {...rest}
    >
      {children}
    </div>,
    document.body,
  );
}
