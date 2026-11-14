import { type KeyboardEvent, useId, useLayoutEffect, useRef } from 'react';
import type { HumanPresence } from '../../src/conduit-mcp/request-types';
import { type AwayChoice, awayLabel, awayUntil } from '../away-view-model';
import { awayStr, REQ_STR } from '../request-strings';

export interface AwayMenuProps {
  presence: HumanPresence;
  now: number;
  onSetAway(away: boolean, until: string | null): void;
  onClose(): void;
}

const ITEM_SELECTOR = '[role="menuitem"]';

export function AwayMenu(p: AwayMenuProps): React.JSX.Element {
  const menuRef = useRef<HTMLDivElement>(null);
  const headingId = useId();
  const away = p.presence.state === 'away';

  useLayoutEffect(() => {
    menuRef.current?.querySelector<HTMLElement>(ITEM_SELECTOR)?.focus();
  }, []);

  const choose = (choice: AwayChoice) => {
    p.onSetAway(true, awayUntil(choice, p.now));
    p.onClose();
  };

  const items = (): HTMLElement[] =>
    Array.from(menuRef.current?.querySelectorAll<HTMLElement>(ITEM_SELECTOR) ?? []);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!(e.target instanceof HTMLElement)) return;
    const list = items();
    const at = list.indexOf(e.target);
    const step = (to: number) => {
      e.preventDefault();
      list[(to + list.length) % list.length]?.focus();
    };
    switch (e.key) {
      case 'ArrowDown':
        return step(at + 1);
      case 'ArrowUp':
        return step(at - 1);
      case 'Escape':
        e.preventDefault();
        return p.onClose();
      case ' ':
      case 'Enter':
        e.preventDefault();
        return e.target.click();
      default:
        return;
    }
  };

  const untilTomorrow = awayLabel(awayUntil('tomorrow9', p.now));

  return (
    <div
      ref={menuRef}
      role="menu"
      aria-labelledby={headingId}
      className="needs-away__menu"
      onKeyDown={onKeyDown}
    >
      <div id={headingId} role="presentation" className="needs-away__heading">
        {awayStr.menuHeading}
      </div>
      <button
        type="button"
        role="menuitem"
        tabIndex={-1}
        className="needs-away__item"
        onClick={() => choose('hour')}
      >
        {REQ_STR.forOneHour}
      </button>
      <button
        type="button"
        role="menuitem"
        tabIndex={-1}
        className="needs-away__item"
        onClick={() => choose('tomorrow9')}
      >
        {REQ_STR.untilTomorrow(untilTomorrow)}
      </button>
      <button
        type="button"
        role="menuitem"
        tabIndex={-1}
        className="needs-away__item"
        onClick={() => choose('untilBack')}
      >
        {REQ_STR.untilBack}
      </button>
      {away && (
        <>
          <div role="separator" className="needs-away__sep" />
          <button
            type="button"
            role="menuitem"
            tabIndex={-1}
            className="needs-away__item"
            onClick={() => {
              p.onSetAway(false, null);
              p.onClose();
            }}
          >
            {REQ_STR.back}
          </button>
        </>
      )}
    </div>
  );
}
