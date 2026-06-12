// Shared assertions for the context-menu builders (editor-menu, term-menu), whose
// items expose the same id / disabled / separatorBefore shape.

import { expect } from 'vitest';

interface MenuItem {
  id: string;
  disabled?: boolean;
  separatorBefore?: boolean;
}

/**
 * Assert a Copy item is disabled with no selection and enabled with one.
 * `copyFor(hasSelection)` looks up the Copy item for the given selection state.
 */
export function expectCopyEnabledOnlyWithSelection(
  copyFor: (hasSelection: boolean) => MenuItem | undefined,
): void {
  expect(copyFor(false)?.disabled).toBe(true);
  expect(copyFor(true)?.disabled).toBe(false);
}

/** A `separatorBefore` accessor over a built menu list (absent => false). */
export function separatorBeforeOf(list: MenuItem[]): (id: string) => boolean {
  return (id) => list.find((i) => i.id === id)?.separatorBefore ?? false;
}
