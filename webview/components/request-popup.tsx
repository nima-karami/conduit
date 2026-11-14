import { type KeyboardEvent, useEffect, useRef } from 'react';
import type { RequestView } from '../../src/conduit-mcp/request-types';
import { openRequest, openSessionTerminal, requestPopup, usePopupRequest } from '../request-open';
import { useConduitMcp } from '../use-conduit-mcp';
import { soonestOpen, useNow } from './request-tab';
import { RequestTemplate } from './request-template';

const FOCUSABLE = [
  'button:not([disabled])',
  'input:not([disabled])',
  'textarea:not([disabled])',
  'select:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(', ');

export interface RequestPopupProps {
  sessions: readonly { id: string; name: string }[];
}

/** A non-modal pop-up over the editor: the pick and note survive Esc because the template keeps them. */
export function RequestPopup({ sessions }: RequestPopupProps) {
  const id = usePopupRequest();
  const api = useConduitMcp();
  const now = useNow();
  const boxRef = useRef<HTMLDivElement>(null);
  // Where focus was before the pop-up took it; restored when the pop-up closes.
  const returnTo = useRef<HTMLElement | null>(null);

  const requests = api.state?.requests ?? null;
  const ordered = soonestOpen(requests?.open ?? []);
  const at = id === null ? -1 : ordered.findIndex((r) => r.id === id);
  const current: RequestView | null =
    id === null ? null : at >= 0 ? ordered[at] : (requests?.ended.find((r) => r.id === id) ?? null);
  const shownId = current?.id ?? null;

  useEffect(() => {
    if (id !== null && requests !== null && current === null) requestPopup.close();
  }, [id, requests, current]);

  useEffect(() => {
    if (shownId === null) {
      returnTo.current?.focus();
      returnTo.current = null;
      return;
    }
    if (returnTo.current === null) returnTo.current = document.activeElement as HTMLElement | null;
    boxRef.current?.querySelector<HTMLElement>('.reqtpl-head__title')?.focus();
  }, [shownId]);

  if (current === null) return null;

  // Next walks the soonest order and wraps; the shown request is never its own next.
  const n = ordered.length;
  const next = at < 0 ? ordered[0] : n > 1 ? ordered[(at + 1) % n] : undefined;
  const moreCount = at >= 0 ? n - 1 : n;
  const sessionName = sessions.find((s) => s.id === current.session)?.name ?? '';

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      requestPopup.close();
      return;
    }
    if (e.key !== 'Tab') return;
    const box = boxRef.current;
    if (!box) return;
    const items = box.querySelectorAll<HTMLElement>(FOCUSABLE);
    const first = items[0];
    const last = items[items.length - 1];
    if (!first || !last) return;
    const active = document.activeElement;
    const outside = !box.contains(active);
    if (e.shiftKey) {
      if (outside || active === first) {
        e.preventDefault();
        last.focus();
      }
    } else if (outside || active === last) {
      e.preventDefault();
      first.focus();
    }
  };

  return (
    <div ref={boxRef} className="reqtpl-popup" onKeyDown={onKeyDown}>
      <RequestTemplate
        request={current}
        sessionName={sessionName}
        mode="popup"
        moreCount={moreCount}
        now={now}
        onSend={(answer) => api.answerRequest(current.id, answer)}
        onNext={() => {
          if (next) requestPopup.open(next.id);
        }}
        onOpenAsTab={() => {
          returnTo.current = null;
          requestPopup.close();
          openRequest(current.id, { asTab: true });
        }}
        onOpenTerminal={() => {
          returnTo.current = null;
          requestPopup.close();
          if (current.session !== null) openSessionTerminal(current.session);
        }}
        onClose={() => requestPopup.close()}
      />
    </div>
  );
}
