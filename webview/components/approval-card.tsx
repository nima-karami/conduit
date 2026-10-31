import { type KeyboardEvent, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { cliKindOfHandle } from '../../src/conduit-mcp/handles';
import type { AskAnswer, AskSummary } from '../../src/conduit-mcp/ui-types';
import { MCP_STR } from '../conduit-mcp-strings';
import { IconChevron } from '../icons';
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
  const [index, setIndex] = useState(0);
  const regionRef = useRef<HTMLElement>(null);
  const returnTo = useRef<Element | null>(null);
  const announced = useRef(new Set<string>());

  useEffect(() => {
    for (const a of asks) {
      if (announced.current.has(a.askId)) continue;
      announced.current.add(a.askId);
      announce(STR.title(a.callerHandle, a.tool));
    }
  }, [asks, announce]);

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
  const at = Math.min(index, asks.length - 1);
  const ask = asks[at];

  const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    if (e.key !== 'Escape') return;
    e.stopPropagation();
    const back = returnTo.current;
    returnTo.current = null;
    if (back instanceof HTMLElement && back.isConnected) back.focus();
    else if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
  };

  return createPortal(
    <section
      ref={regionRef}
      className="askcard"
      role="region"
      aria-label={STR.region}
      tabIndex={-1}
      onKeyDown={onKeyDown}
    >
      <div className="askcard__title">{STR.title(ask.callerHandle, ask.tool)}</div>
      <div className="askcard__summary">{summaryText(ask.summary)}</div>
      <div className="askcard__reason">{reasonText(ask)}</div>
      <details className="askcard__raw">
        <summary>{STR.rawArgs}</summary>
        <pre className="askcard__args">{JSON.stringify(ask.args, null, 2)}</pre>
      </details>
      <div className="askcard__foot">
        {asks.length > 1 && (
          <div className="askcard__pager">
            <button
              type="button"
              className="btn btn--sm askcard__page"
              aria-label={STR.prev}
              disabled={at === 0}
              onClick={() => setIndex(at - 1)}
            >
              <IconChevron size={12} className="askcard__prevglyph" />
            </button>
            <span>{STR.pager(at + 1, asks.length)}</span>
            <button
              type="button"
              className="btn btn--sm askcard__page"
              aria-label={STR.next}
              disabled={at === asks.length - 1}
              onClick={() => setIndex(at + 1)}
            >
              <IconChevron size={12} />
            </button>
          </div>
        )}
        <div className="askcard__actions">
          {ANSWERS.map((answer) => (
            <button
              key={answer}
              type="button"
              className={answer === 'approve' ? 'btn btn--sm btn--primary' : 'btn btn--sm'}
              data-answer={answer}
              onClick={() => answerAsk(ask.askId, answer)}
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
