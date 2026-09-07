import {
  type OverlayEntry,
  type OverlayKind,
  pushOverlay,
  removeOverlay,
  topOverlay,
} from '../src/overlay-stack';

export type { OverlayEntry, OverlayKind };

type Listener = () => void;

let idCounter = 0;
let stack: OverlayEntry[] = [];
const dismissCallbacks = new Map<number, () => void>();
const listeners = new Set<Listener>();

function onKeydown(e: KeyboardEvent): void {
  if (e.key !== 'Escape') return;
  const top = topOverlay(stack);
  if (!top) return;
  e.stopPropagation();
  e.preventDefault();
  dismissCallbacks.get(top.id)?.();
}

function notify(): void {
  for (const l of listeners) l();
}

export function nextOverlayId(): number {
  idCounter += 1;
  return idCounter;
}

/** Installs the window listener on 0→1. */
export function registerOverlay(id: number, kind: OverlayKind, onDismiss: () => void): void {
  dismissCallbacks.set(id, onDismiss);
  const wasEmpty = stack.length === 0;
  // Commit the push first: a callback invoked below (synchronously) may itself register or
  // unregister, and must see the modal already on the stack rather than a half-applied push.
  const { stack: nextStack, dismissed } = pushOverlay(stack, { id, kind });
  stack = nextStack;
  if (wasEmpty) window.addEventListener('keydown', onKeydown, true);
  notify();
  // Snapshot before invoking: a callback may mutate dismissCallbacks (e.g. unregister a sibling
  // also in `dismissed`), which must not stop the others in this batch from firing.
  const callbacks = dismissed.map((dismissedId) => dismissCallbacks.get(dismissedId));
  for (const cb of callbacks) cb?.();
}

/** Removes the window listener on 1→0. */
export function unregisterOverlay(id: number): void {
  dismissCallbacks.delete(id);
  stack = removeOverlay(stack, id);
  notify();
  if (stack.length === 0) window.removeEventListener('keydown', onKeydown, true);
}

export function subscribeOverlays(cb: Listener): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

export function getOverlays(): readonly OverlayEntry[] {
  return stack;
}
