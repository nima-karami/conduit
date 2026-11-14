import { type KeyboardEvent, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { RequestView } from '../../src/conduit-mcp/request-types';
import { REQ_STR } from '../request-strings';
import { cardsOf, type SessionInfo, shortestWaiting, sortRequests } from '../request-view-model';

const NO_SESSIONS: ReadonlyMap<string, SessionInfo> = new Map();
const NO_SPACES: ReadonlyMap<string, string> = new Map();
const ITEM_SELECTOR = '[role="menuitem"]';

const itemsOf = (menu: HTMLElement | null): HTMLElement[] =>
  menu ? Array.from(menu.querySelectorAll<HTMLElement>(ITEM_SELECTOR)) : [];

// The pill sits in the session's own tab bar; a session's requests are one thread, so the
// pill counts only the ones whose session is this one. Waiting first, so the countdown leads.
export function SessionPill({
  sessionId,
  requests,
  now,
  onOpen,
}: {
  sessionId: string;
  requests: readonly RequestView[];
  now: number;
  onOpen(requestId: string): void;
}): React.JSX.Element | null {
  const mine = requests.filter((r) => r.session === sessionId);
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const count = mine.length;

  useLayoutEffect(() => {
    if (open) itemsOf(menuRef.current)[0]?.focus();
  }, [open]);

  useEffect(() => {
    if (count < 2) setOpen(false);
  }, [count]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (e.target instanceof Node && !rootRef.current?.contains(e.target)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  if (count === 0) return null;

  const soonest = shortestWaiting(mine, now);
  const label =
    soonest !== null
      ? REQ_STR.pillStr.waiting(soonest.secondsLeft, count)
      : REQ_STR.pillStr.count(count);
  const waitingClass = soonest !== null ? ' needs-pill--waiting' : '';

  if (count === 1) {
    return (
      <button
        type="button"
        className={`needs-pill${waitingClass}`}
        onClick={() => onOpen(mine[0].id)}
      >
        {label}
      </button>
    );
  }

  const ordered = sortRequests(mine, 'soonest', NO_SESSIONS);
  const cards = cardsOf(ordered, { now, sessions: NO_SESSIONS, spaces: NO_SPACES });

  const close = () => {
    setOpen(false);
    triggerRef.current?.focus();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const list = itemsOf(menuRef.current);
    const onTrigger = e.target === triggerRef.current;
    switch (e.key) {
      case 'ArrowDown':
      case 'ArrowUp': {
        if (!open) {
          if (onTrigger) {
            e.preventDefault();
            setOpen(true);
          }
          return;
        }
        e.preventDefault();
        const at = list.indexOf(e.target as HTMLElement);
        const down = e.key === 'ArrowDown';
        const first = down ? 0 : list.length - 1;
        const next = at < 0 ? first : (at + (down ? 1 : -1) + list.length) % list.length;
        list[next]?.focus();
        return;
      }
      case 'Escape':
        if (open) {
          e.preventDefault();
          close();
        }
        return;
      case 'Tab':
        if (open) setOpen(false);
        return;
      default:
        return;
    }
  };

  return (
    <div ref={rootRef} className="needs-pill-wrap" onKeyDown={onKeyDown}>
      <button
        ref={triggerRef}
        type="button"
        className={`needs-pill${waitingClass}`}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        {label}
      </button>
      {open && (
        <div
          ref={menuRef}
          role="menu"
          aria-label={REQ_STR.pillStr.menu}
          className="needs-pill__menu"
        >
          {ordered.map((r, i) => {
            const why = cards[i].whyNow;
            const state =
              why.kind === 'waiting'
                ? REQ_STR.waiting(why.secondsLeft)
                : why.kind === 'urgent'
                  ? REQ_STR.urgent
                  : null;
            return (
              <button
                key={r.id}
                type="button"
                role="menuitem"
                className="needs-pill__item"
                onClick={() => {
                  setOpen(false);
                  onOpen(r.id);
                }}
              >
                <span className="needs-pill__title">{r.title}</span>
                {state !== null && (
                  <span
                    className={`needs-pill__state${why.kind === 'waiting' ? ' needs-pill__state--attn' : ''}`}
                  >
                    {state}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
