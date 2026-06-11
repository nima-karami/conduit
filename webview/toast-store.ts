/**
 * Toast store (K2 — save reliability). A minimal subscribe/push store for transient,
 * unmissable notifications. The save path uses it to surface a rejection/failure
 * (out-of-root reject, permission denied, file deleted) that was previously only shown
 * in a small, easy-to-miss in-editor banner — the "it silently doesn't save" half of
 * the bug.
 *
 * Convention: silence = success. A successful save raises NO toast (the dirty dot
 * clearing is the signal); only failures toast.
 *
 * Same external-store shape as dirty-store.ts so the renderer can consume it with
 * useSyncExternalStore.
 */

export type ToastVariant = 'info' | 'error';

export interface Toast {
  id: string;
  message: string;
  variant: ToastVariant;
}

export interface PushToastInput {
  message: string;
  variant: ToastVariant;
  /** Auto-dismiss delay in ms. Default ~5s. Pass 0 to disable the auto-dismiss timer. */
  durationMs?: number;
}

type Listener = () => void;

const DEFAULT_DURATION_MS = 5000;

let toasts: readonly Toast[] = [];
const listeners = new Set<Listener>();
let seq = 0;

function notify(next: readonly Toast[]): void {
  toasts = next;
  listeners.forEach((l) => {
    l();
  });
}

/** Push a toast; returns its id. Auto-dismisses after `durationMs` unless that is 0. */
export function pushToast(input: PushToastInput): string {
  const id = `t${++seq}`;
  notify([...toasts, { id, message: input.message, variant: input.variant }]);
  const duration = input.durationMs ?? DEFAULT_DURATION_MS;
  if (duration > 0 && typeof setTimeout !== 'undefined') {
    setTimeout(() => dismissToast(id), duration);
  }
  return id;
}

/** Remove a toast by id. Unknown id is a harmless no-op. */
export function dismissToast(id: string): void {
  if (!toasts.some((t) => t.id === id)) return;
  notify(toasts.filter((t) => t.id !== id));
}

/** Stable snapshot reference until the list changes (for useSyncExternalStore). */
export function getToastsSnapshot(): readonly Toast[] {
  return toasts;
}

export function subscribeToasts(cb: Listener): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/** Test-only: clear all toasts + listeners between cases. */
export function __resetToastsForTest(): void {
  toasts = [];
  listeners.clear();
}
