import { useMemo, useRef, useState } from 'react';
import type { ConfirmState } from './components/confirm-dialog';

export type ModalEntry = { kind: 'confirm'; key: number; state: ConfirmState };

export interface ModalSlot {
  readonly current: ModalEntry | null;
  open(entry: ModalEntry): void;
  update(entry: ModalEntry): void;
  close(key: number): void;
  dismiss(): void;
}

let lastKey = 0;
export function nextModalKey(): number {
  lastKey += 1;
  return lastKey;
}

function settle(entry: ModalEntry): void {
  entry.state.onCancel?.();
}

/**
 * The renderer's one modal slot: a displaced entry is settled as Cancel, so nothing that awaits an
 * answer is ever orphaned by a newer dialog (dirty-quit-guard plan, critic B1a).
 */
export function useModalSlot(): ModalSlot {
  const ref = useRef<ModalEntry | null>(null);
  const [, setRendered] = useState<ModalEntry | null>(null);
  return useMemo<ModalSlot>(() => {
    const set = (entry: ModalEntry | null) => {
      ref.current = entry;
      setRendered(entry);
    };
    return {
      get current() {
        return ref.current;
      },
      open(entry) {
        const displaced = ref.current;
        // current first: a settle that closes its own key, or opens another entry, sees the newcomer.
        set(entry);
        if (displaced && displaced.key !== entry.key) settle(displaced);
      },
      update(entry) {
        if (ref.current?.key === entry.key) set(entry);
      },
      close(key) {
        if (ref.current?.key === key) set(null);
      },
      dismiss() {
        const entry = ref.current;
        if (!entry) return;
        settle(entry);
        if (ref.current === entry) set(null);
      },
    };
  }, []);
}

export function focusOpenModal(): void {
  document.querySelector<HTMLElement>('[data-modal-default]')?.focus();
}
