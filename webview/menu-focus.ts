import type { KeyboardEvent } from 'react';

/** Arrow/Home/End focus movement across a menu's enabled items; shared by the dialog's menus. */
export function moveMenuFocus(e: KeyboardEvent<HTMLElement>): void {
  const keys = ['ArrowDown', 'ArrowUp', 'Home', 'End'];
  if (!keys.includes(e.key)) return;
  const items = [
    ...e.currentTarget.querySelectorAll<HTMLElement>(
      '[role^="menuitem"]:not(:disabled):not([aria-disabled="true"])',
    ),
  ];
  if (items.length === 0) return;
  e.preventDefault();
  const at = items.indexOf(document.activeElement as HTMLElement);
  const next =
    e.key === 'Home'
      ? 0
      : e.key === 'End'
        ? items.length - 1
        : (at + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
  items[at < 0 && e.key === 'ArrowUp' ? items.length - 1 : next]?.focus();
}
