import { type RefObject, useCallback, useEffect, useState } from 'react';

const FOCUSABLE = 'button, [href], input, [tabindex]:not([tabindex="-1"])';

export function useFocusTrap(ref: RefObject<HTMLElement | null>): { restoreFocus(): void } {
  // Read during render, not in an effect: a child's autoFocus runs before any effect of ours.
  const [previous] = useState(() => document.activeElement);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Tab') return;
      const items = [...el.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
        (item) => !item.matches(':disabled'),
      );
      if (items.length === 0) {
        e.preventDefault();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement;
      if (e.shiftKey ? active === first : active === last) {
        e.preventDefault();
        (e.shiftKey ? last : first).focus();
      }
    };
    el.addEventListener('keydown', onKeyDown);
    return () => el.removeEventListener('keydown', onKeyDown);
  }, [ref]);

  const restoreFocus = useCallback(() => {
    if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
  }, [previous]);

  return { restoreFocus };
}
