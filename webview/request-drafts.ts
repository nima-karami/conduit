import { useSyncExternalStore } from 'react';

export interface RequestDraft {
  pick: string[];
  text: string;
}

// Renderer memory only: a draft outlives the pop-up or tab that showed it, and is gone on reload.
const drafts = new Map<string, RequestDraft>();
const listeners = new Set<() => void>();

const emit = () => {
  for (const l of listeners) l();
};

const subscribe = (cb: () => void) => {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
};

export function getDraft(id: string): RequestDraft | undefined {
  return drafts.get(id);
}

export function setDraft(id: string, d: RequestDraft): void {
  drafts.set(id, d);
  emit();
}

export function clearDraft(id: string): void {
  if (drafts.delete(id)) emit();
}

export function useDraft(id: string): RequestDraft | undefined {
  return useSyncExternalStore(subscribe, () => getDraft(id));
}
