import { type KeyboardEvent, useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { cliKindOfHandle } from '../../src/conduit-mcp/handles';
import type { AskAnswer, AskSummary } from '../../src/conduit-mcp/ui-types';
import { MCP_STR } from '../conduit-mcp-strings';
import { IconChevron, IconChevronDown } from '../icons';
import { answerAsk, type PendingAskView, subscribeAskFocus, useAsks } from '../mcp-ask-store';

export interface ApprovalCardProps {
  announce(text: string): void;
}

const STR = MCP_STR.ask;
const ANSWERS: readonly AskAnswer[] = ['deny', 'approve', 'always'];

function summaryText(s: AskSummary): string {
  switch (s.tool) {
    case 'open_session':
      return STR.summary.open_session(s);
    case 'open_terminal':
      return STR.summary.open_terminal(s);
    case 'open_file':
      return STR.summary.open_file(s);
  }
}

function reasonText(a: PendingAskView): string {
  if (a.source === 'cli')
    return STR.reason.cli(MCP_STR.tools.cliName[cliKindOfHandle(a.callerHandle)]);
  return STR.reason[a.source];
}

/**
 * The non-modal approval card (spec 2026-10-30-conduit-mcp-tool-policy §2.4, §9, §10). It never
 * takes focus on its own, so keys typed into a terminal can't answer it; the chip and the
 * session card's button move focus here on request.
 */
export function ApprovalCard({ announce }: ApprovalCardProps) {
  const asks = useAsks();
  // By id, not index: an arrival or another ask closing must never swap the ask under the
  // pointer. null, or an ask that has closed, shows the oldest.
  const [shownId, setShownId] = useState<string | null>(null);
  // Keyed by ask: paging to another request starts its arguments collapsed (spec §2.4).
  const [rawOpenFor, setRawOpenFor] = useState<string | null>(null);
  const rawId = useId();
  const regionRef = useRef<HTMLElement>(null);
  const returnTo = useRef<Element | null>(null);
  const announced = useRef(new Set<string>());
  const announceFrame = useRef<number | null>(null);
  // False from an answer until a fresh press on what replaced it: the second click of a
  // double-click, or a repeated Enter, would otherwise answer the next ask.
  const armed = useRef(true);

  useEffect(() => {
    const fresh = asks.filter((a) => !announced.current.has(a.askId));
    const last = fresh.at(-1);
    if (!last) return;
    for (const a of fresh) announced.current.add(a.askId);
    const text = STR.announce(last.callerHandle, last.tool, asks.indexOf(last) + 1, asks.length);
    // A live region speaks only on a change: cleared now and written a frame later, a repeat
    // of the same text is still heard.
    announce('');
    if (announceFrame.current !== null) cancelAnimationFrame(announceFrame.current);
    announceFrame.current = requestAnimationFrame(() => {
      announceFrame.current = null;
      announce(text);
    });
  }, [asks, announce]);

  useEffect(
    () => () => {
      if (announceFrame.current !== null) cancelAnimationFrame(announceFrame.current);
    },
    [],
  );

  useEffect(
    () =>
      subscribeAskFocus(() => {
        const region = regionRef.current;
        if (!region) return;
        if (!region.contains(document.activeElement)) returnTo.current = document.activeElement;
        region.focus();
      }),
    [],
  );

  if (typeof document === 'undefined' || asks.length === 0) return null;
  const at = Math.max(
    0,
    asks.findIndex((a) => a.askId === shownId),
  );
  const ask = asks[at];
  const rawOpen = rawOpenFor === ask.askId;

  const giveBackFocus = () => {
    const back = returnTo.current;
    returnTo.current = null;
    if (back instanceof HTMLElement && back.isConnected) back.focus();
    else if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    if (!e.repeat) armed.current = true;
    if (e.key !== 'Escape') return;
    e.stopPropagation();
    giveBackFocus();
  };

  const onAnswer = (answer: AskAnswer) => {
    if (!armed.current) return;
    armed.current = false;
    const region = regionRef.current;
    const focusInside = !!region && region.contains(document.activeElement);
    const wasLast = asks.length === 1;
    answerAsk(ask.askId, answer);
    if (!focusInside) return;
    // The answered ask's buttons are about to go; the next press must land on the new content.
    if (wasLast) giveBackFocus();
    else region.focus();
  };

  return createPortal(
    <section
      ref={regionRef}
      className="askcard"
      role="region"
      aria-label={STR.region}
      tabIndex={-1}
      onKeyDown={onKeyDown}
      onMouseDown={(e) => {
        // detail is the click count: the second press of a double-click does not arm.
        if (e.detail <= 1) armed.current = true;
      }}
    >
      <div className="askcard__title">{STR.title(ask.callerHandle, ask.tool)}</div>
      <div className="askcard__summary">{summaryText(ask.summary)}</div>
      <div className="askcard__reason">{reasonText(ask)}</div>
      <div className="askcard__raw">
        <button
          type="button"
          className="askcard__rawtoggle"
          aria-expanded={rawOpen}
          aria-controls={rawId}
          onClick={() => setRawOpenFor(rawOpen ? null : ask.askId)}
        >
          <IconChevronDown size={12} className="askcard__rawchev" />
          {STR.rawArgs}
        </button>
        <div id={rawId} hidden={!rawOpen}>
          {rawOpen && <pre className="askcard__args">{JSON.stringify(ask.args, null, 2)}</pre>}
        </div>
      </div>
      <div className="askcard__foot">
        {asks.length > 1 && (
          <div className="askcard__pager">
            <button
              type="button"
              className="btn btn--sm askcard__page"
              aria-label={STR.prev}
              disabled={at === 0}
              onClick={() => setShownId(asks[at - 1].askId)}
            >
              <IconChevron size={12} className="askcard__prevglyph" />
            </button>
            <span>{STR.pager(at + 1, asks.length)}</span>
            <button
              type="button"
              className="btn btn--sm askcard__page"
              aria-label={STR.next}
              disabled={at === asks.length - 1}
              onClick={() => setShownId(asks[at + 1].askId)}
            >
              <IconChevron size={12} />
            </button>
          </div>
        )}
        <div className="askcard__actions" key={ask.askId}>
          {ANSWERS.map((answer) => (
            <button
              key={answer}
              type="button"
              className={answer === 'approve' ? 'btn btn--sm btn--primary' : 'btn btn--sm'}
              data-answer={answer}
              onClick={() => onAnswer(answer)}
            >
              {STR[answer]}
            </button>
          ))}
        </div>
      </div>
    </section>,
    document.body,
  );
}
