import { type KeyboardEvent, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { cliKindOfHandle } from '../../src/conduit-mcp/handles';
import type { AskAnswer, AskSummary } from '../../src/conduit-mcp/ui-types';
import { MCP_STR } from '../conduit-mcp-strings';
import { IconChevron, IconChevronDown } from '../icons';
import { answerAsk, type PendingAskView, subscribeAskFocus, useAsks } from '../mcp-ask-store';
import { requestTerminalFocus } from '../terminal-bus';

export interface ApprovalCardProps {
  announce(text: string): void;
}

const STR = MCP_STR.ask;
const ANSWERS: readonly AskAnswer[] = ['deny', 'approve', 'always'];
// After the shown ask changes without the user paging (answered, expired, cancelled), a press
// this soon was aimed at the ask that left: the second click of a double-click, a repeated
// Enter, or a click already on its way. Time, not a fresh-press rule, because a screen reader's
// browse mode activates with a bare click that no keydown or mousedown precedes.
const SWAP_GUARD_MS = 400;

function summaryText(s: AskSummary): string {
  switch (s.tool) {
    case 'open_session':
      return STR.summary.open_session(s);
    case 'open_terminal':
      return STR.summary.open_terminal(s);
    case 'open_file':
      return STR.summary.open_file(s);
    case 'close_session':
      return STR.summary.close_session(s);
    case 'focus_session':
      return STR.summary.focus_session(s);
    case 'attach_folder':
      return STR.summary.attach_folder(s);
    case 'close_files':
      return STR.summary.close_files(s);
    case 'open_review':
      return STR.summary.open_review(s);
    case 'open_git_history':
      return STR.summary.open_git_history(s);
    case 'open_url':
      return STR.summary.open_url(s);
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
  const lastShown = useRef<string | null>(null);
  const pagedTo = useRef<string | null>(null);
  const guardUntil = useRef(0);
  const guardTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // Shows the guard: a press it ignores reads as disabled rather than as a dead button.
  const [guarded, setGuarded] = useState(false);

  const shown = asks.find((a) => a.askId === shownId) ?? asks[0];
  const shownAskId = shown?.askId ?? null;
  useLayoutEffect(() => {
    const prev = lastShown.current;
    lastShown.current = shownAskId;
    const paged = pagedTo.current === shownAskId;
    pagedTo.current = null;
    // The first ask to appear replaces nothing, so no press can have been aimed elsewhere.
    if (shownAskId === null || prev === null || prev === shownAskId || paged) return;
    guardUntil.current = Date.now() + SWAP_GUARD_MS;
    setGuarded(true);
    clearTimeout(guardTimer.current);
    guardTimer.current = setTimeout(() => setGuarded(false), SWAP_GUARD_MS);
  }, [shownAskId]);

  useEffect(() => () => clearTimeout(guardTimer.current), []);

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

  if (typeof document === 'undefined' || !shown) return null;
  const ask = shown;
  const at = asks.indexOf(ask);
  const pageTo = (askId: string) => {
    pagedTo.current = askId;
    setShownId(askId);
  };
  const rawOpen = rawOpenFor === ask.askId;

  const giveBackFocus = () => {
    const back = returnTo.current;
    returnTo.current = null;
    if (back instanceof HTMLElement && back.isConnected && back !== document.body) {
      back.focus();
      return;
    }
    // Nowhere recorded (tabbed in, or sent from nothing focused): the caller's terminal is where
    // the user works, and body would leave the keyboard nowhere.
    requestTerminalFocus(ask.callerSessionId);
    const left = document.activeElement;
    if (left instanceof HTMLElement && regionRef.current?.contains(left)) left.blur();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    if (e.key !== 'Escape') return;
    e.stopPropagation();
    giveBackFocus();
  };

  const onAnswer = (answer: AskAnswer) => {
    if (Date.now() < guardUntil.current) return;
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
    >
      <div className="askcard__head">
        <div className="askcard__title" title={STR.title(ask.callerHandle, ask.tool)}>
          {STR.title(ask.callerHandle, ask.tool)}
        </div>
        {/* With one ask the pager keeps its slot, unseen, so the head's height never changes. */}
        <div className={asks.length > 1 ? 'askcard__pager' : 'askcard__pager askcard__pager--idle'}>
          <button
            type="button"
            className="btn btn--sm askcard__page"
            aria-label={STR.prev}
            disabled={at === 0}
            onClick={() => pageTo(asks[at - 1].askId)}
          >
            <IconChevron size={12} className="askcard__prevglyph" />
          </button>
          <span>{asks.length > 1 ? STR.pager(at + 1, asks.length) : ''}</span>
          <button
            type="button"
            className="btn btn--sm askcard__page"
            aria-label={STR.next}
            disabled={at === asks.length - 1}
            onClick={() => pageTo(asks[at + 1].askId)}
          >
            <IconChevron size={12} />
          </button>
        </div>
      </div>
      <div className="askcard__actions" key={ask.askId}>
        {ANSWERS.map((answer) => (
          <button
            key={answer}
            type="button"
            className={answer === 'approve' ? 'btn btn--sm btn--primary' : 'btn btn--sm'}
            data-answer={answer}
            aria-disabled={guarded}
            onClick={() => onAnswer(answer)}
          >
            {STR[answer]}
          </button>
        ))}
      </div>
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
    </section>,
    document.body,
  );
}
