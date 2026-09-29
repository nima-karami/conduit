// see split-editor spec §10 (focus management)
import { type RefObject, useCallback } from 'react';

export interface FocusTarget {
  focus(): void;
}

const targets = new Map<string, FocusTarget[]>();
/** `armed` is what held focus at the request: a late mount must not take focus the user moved. */
let pending: { key: string; armed: Element | null } | null = null;

export const terminalFocusKey = (sessionId: string) => `terminal:${sessionId}`;
export const terminalTabFocusKey = (sessionId: string) => `terminal-tab:${sessionId}`;

function focusUnmovedSince(armed: Element | null): boolean {
  const now = document.activeElement;
  return now === armed || now === null || now === document.body || !armed?.isConnected;
}

export function registerFocusTarget(key: string, target: FocusTarget): () => void {
  const list = targets.get(key) ?? [];
  list.push(target);
  targets.set(key, list);
  if (pending?.key === key) {
    const { armed } = pending;
    pending = null;
    if (focusUnmovedSince(armed)) target.focus();
  }
  return () => {
    const current = targets.get(key);
    const at = current ? current.indexOf(target) : -1;
    if (!current || at < 0) return;
    current.splice(at, 1);
    if (current.length === 0) targets.delete(key);
  };
}

export function requestDocFocus(key: string): void {
  const list = targets.get(key);
  const target = list?.[list.length - 1];
  pending = target ? null : { key, armed: document.activeElement };
  target?.focus();
}

/** A navigation that is not a user activation supersedes a request still waiting to mount. */
export function cancelDocFocus(): void {
  pending = null;
}

/** A request whose tab is no longer the one its group shows is dropped, not kept for a remount. */
export function dropDocFocusUnless(shown: (key: string) => boolean): void {
  if (pending && !shown(pending.key)) pending = null;
}

export function useFocusTargetRef<T extends HTMLElement>(
  key: string | undefined,
  inner?: RefObject<T | null>,
): (el: T | null) => (() => void) | undefined {
  return useCallback(
    (el: T | null) => {
      if (inner) inner.current = el;
      if (!el) return undefined;
      const off = key === undefined ? undefined : registerFocusTarget(key, el);
      return () => {
        off?.();
        if (inner) inner.current = null;
      };
    },
    [key, inner],
  );
}
