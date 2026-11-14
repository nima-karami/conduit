import { useSyncExternalStore } from 'react';
import type { RequestView } from '../src/conduit-mcp/request-types';
import { type OpenAs, openAsOf } from './request-view-model';
import { getRequestsSnapshot } from './use-conduit-mcp';

export interface RequestOpeners {
  openTab(r: RequestView): void;
  openTerminal(sessionId: string): void;
}

export interface RequestPopupStore {
  open(id: string): void;
  close(): void;
  current(): string | null;
  subscribe(cb: () => void): () => void;
}

export interface RequestOpenDeps {
  openAs(r: RequestView): OpenAs;
  requests(): readonly RequestView[];
}

export function createRequestOpen(deps: RequestOpenDeps) {
  let openers: RequestOpeners | null = null;
  let popupId: string | null = null;
  const popupListeners = new Set<() => void>();
  const emitPopup = () => {
    for (const l of popupListeners) l();
  };

  const requestPopup: RequestPopupStore = {
    open(id) {
      popupId = id;
      emitPopup();
    },
    close() {
      if (popupId === null) return;
      popupId = null;
      emitPopup();
    },
    current: () => popupId,
    subscribe(cb) {
      popupListeners.add(cb);
      return () => {
        popupListeners.delete(cb);
      };
    },
  };

  function setRequestOpeners(o: RequestOpeners | null): void {
    openers = o;
  }

  function openRequest(id: string, opts?: { asTab?: boolean }): boolean {
    const o = openers;
    const r = deps.requests().find((x) => x.id === id);
    if (!o || !r) return false;
    let as = deps.openAs(r);
    if (opts?.asTab && as !== 'terminal') as = 'tab';
    if (as === 'popup') {
      requestPopup.open(id);
      return true;
    }
    if (as === 'tab') {
      o.openTab(r);
      return true;
    }
    if (r.session === null) return false;
    o.openTerminal(r.session);
    return true;
  }

  function openSessionTerminal(sessionId: string): boolean {
    const o = openers;
    if (!o) return false;
    o.openTerminal(sessionId);
    return true;
  }

  return { openRequest, openSessionTerminal, requestPopup, setRequestOpeners };
}

const instance = createRequestOpen({
  openAs: openAsOf,
  requests: () => getRequestsSnapshot()?.open ?? [],
});

export const { openRequest, openSessionTerminal, requestPopup, setRequestOpeners } = instance;

export function usePopupRequest(): string | null {
  return useSyncExternalStore(requestPopup.subscribe, requestPopup.current);
}
