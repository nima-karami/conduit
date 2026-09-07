/**
 * Pure ordering for the app's single overlay stack (modals + popovers). No DOM, no React —
 * see `webview/overlay-store.ts` for the live singleton that wraps this.
 */
export type OverlayKind = 'modal' | 'popover';

export interface OverlayEntry {
  id: number;
  kind: OverlayKind;
}

export const MODAL_DEPTH_MAX = 19;

/**
 * Appends `entry`. When `entry.kind === 'modal'`, every popover already on the stack is
 * displaced: removed from the returned stack and reported (in stack order) in `dismissed`.
 */
export function pushOverlay(
  stack: readonly OverlayEntry[],
  entry: OverlayEntry,
): { stack: OverlayEntry[]; dismissed: number[] } {
  if (entry.kind !== 'modal') {
    return { stack: [...stack, entry], dismissed: [] };
  }
  const dismissed: number[] = [];
  const kept: OverlayEntry[] = [];
  for (const e of stack) {
    if (e.kind === 'popover') dismissed.push(e.id);
    else kept.push(e);
  }
  return { stack: [...kept, entry], dismissed };
}

export function removeOverlay(stack: readonly OverlayEntry[], id: number): OverlayEntry[] {
  return stack.filter((e) => e.id !== id);
}

export function topOverlay(stack: readonly OverlayEntry[]): OverlayEntry | undefined {
  return stack[stack.length - 1];
}

/** Index among modal entries only, clamped to MODAL_DEPTH_MAX; -1 when `id` is absent. */
export function modalDepth(stack: readonly OverlayEntry[], id: number): number {
  const index = stack.filter((e) => e.kind === 'modal').findIndex((e) => e.id === id);
  if (index === -1) return -1;
  return Math.min(index, MODAL_DEPTH_MAX);
}
