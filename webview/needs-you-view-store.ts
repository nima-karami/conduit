import { useSyncExternalStore } from 'react';
import type { ShowOnCards, SortKey } from './request-view-model';

export interface NeedsYouView {
  sort: SortKey;
  show: ShowOnCards;
}

// A per-viewer convenience, not shared state: it lives in this window's storage only.
const STORAGE_KEY = 'conduit.needsYou.view';
const SORTS: readonly SortKey[] = ['soonest', 'newest', 'oldest', 'session'];
const DEFAULT_VIEW: NeedsYouView = {
  sort: 'soonest',
  show: { space: false, age: false, machine: false },
};

function parseView(raw: unknown): NeedsYouView | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const { sort, show } = raw as { sort?: unknown; show?: unknown };
  if (!SORTS.includes(sort as SortKey)) return null;
  if (typeof show !== 'object' || show === null) return null;
  const { space, age, machine } = show as Record<string, unknown>;
  if (typeof space !== 'boolean' || typeof age !== 'boolean' || typeof machine !== 'boolean') {
    return null;
  }
  return { sort: sort as SortKey, show: { space, age, machine } };
}

function readStored(): NeedsYouView {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === null) return DEFAULT_VIEW;
    return parseView(JSON.parse(raw)) ?? DEFAULT_VIEW;
  } catch {
    return DEFAULT_VIEW;
  }
}

function writeStored(view: NeedsYouView): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(view));
  } catch {
    // Storage may be blocked; the choice still holds for this session.
  }
}

let current: NeedsYouView | null = null;
const listeners = new Set<() => void>();

const snapshot = (): NeedsYouView => {
  current ??= readStored();
  return current;
};

const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

function setView(next: NeedsYouView): void {
  current = next;
  writeStored(next);
  for (const l of listeners) l();
}

export function useNeedsYouView(): [NeedsYouView, (v: NeedsYouView) => void] {
  const view = useSyncExternalStore(subscribe, snapshot, snapshot);
  return [view, setView];
}
