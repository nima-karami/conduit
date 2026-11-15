import {
  type JSX,
  type KeyboardEvent,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { DRAFT_MAX_BYTES } from '../../src/conduit-mcp/request-args';
import type {
  AnswerInput,
  RequestAnswerResult,
  RequestView,
} from '../../src/conduit-mcp/request-types';
import { clearDraft, setDraft, useDraft } from '../request-drafts';
import { REQ_STR } from '../request-strings';
import { ageLabel, isConduit, type RequestType, typeOf } from '../request-view-model';
import { RequestTypeIcon } from './request-type-icon';

export interface RequestTemplateProps {
  request: RequestView;
  sessionName: string;
  mode: 'popup' | 'tab';
  moreCount: number;
  now: number;
  onSend(answer: AnswerInput): Promise<RequestAnswerResult>;
  onNext(): void;
  onOpenAsTab(): void;
  onOpenTerminal(): void;
  onClose?(): void;
}

// After the request changes, a press this soon was aimed at the request that left.
// Mirrors approval-card.tsx: time, because a screen reader's browse mode clicks without a keydown.
export const SWAP_GUARD_MS = 400;

interface Choice {
  key: string;
  label: string;
  description?: string;
}

const byteLength = (s: string): number => new TextEncoder().encode(s).length;

function choicesOf(r: RequestView): Choice[] {
  switch (r.kind) {
    case 'confirm':
      return [
        { key: 'yes', label: REQ_STR.yes },
        { key: 'no', label: REQ_STR.no },
      ];
    case 'choose':
      return r.options.map((o, i) => ({
        key: String(i),
        label: o.label,
        description: o.description,
      }));
    case 'review':
      return [
        { key: 'edit', label: REQ_STR.approveWithEdits },
        { key: 'written', label: REQ_STR.approveAsWritten },
        { key: 'reject', label: REQ_STR.reject },
      ];
    case 'text':
    case 'attend':
      return [];
  }
}

function sentenceOf(r: RequestView, handle: string): string {
  switch (r.kind) {
    case 'confirm':
      return REQ_STR.asksYouToApprove(handle);
    case 'choose':
      return REQ_STR.asksYouToChoose(handle);
    case 'text':
      return REQ_STR.asksYouToAnswer(handle);
    case 'review':
      return REQ_STR.asksYouToReview(handle);
    case 'attend':
      return REQ_STR.waitingAtPrompt(handle);
  }
}

function endedLine(r: RequestView, handle: string): string | null {
  switch (r.state) {
    case 'open':
      return null;
    case 'answered':
      return r.answer?.answeredBy.kind === 'default' ? REQ_STR.wentWithDefault : REQ_STR.answered;
    case 'expired':
      return REQ_STR.expired;
    case 'withdrawn':
      return r.withdrawnBy === 'requester'
        ? REQ_STR.withdrawnBy(handle)
        : REQ_STR.withdrawnByConduit;
    case 'superseded':
      return REQ_STR.replaced;
    case 'resolved':
      return REQ_STR.clearedByItself;
    case 'orphaned':
      return REQ_STR.notDelivered;
  }
}

function changedLineNumbers(original: string, edited: string): number[] {
  const a = original.split('\n');
  const b = edited.split('\n');
  const out: number[] = [];
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (a[i] !== b[i]) out.push(i + 1);
  }
  return out;
}

const withText = (answer: AnswerInput, own: string): AnswerInput =>
  own ? { ...answer, text: own } : answer;

function answerFor(
  r: RequestView,
  picks: readonly string[],
  text: string,
  edited: string,
): AnswerInput | null {
  const own = text.trim();
  switch (r.kind) {
    case 'confirm': {
      const pick = picks[0];
      if (pick === 'yes') return withText({ outcome: 'approved' }, own);
      if (pick === 'no') return withText({ outcome: 'declined' }, own);
      return own ? { outcome: 'answered', text: own } : null;
    }
    case 'choose': {
      if (picks.length > 0) {
        const values = picks
          .map(Number)
          .sort((a, b) => a - b)
          .map((i) => r.options[i]?.label ?? '');
        return withText({ outcome: 'chosen', values }, own);
      }
      // A scheduler's message can't be answered in words alone: the agent can't read them as a choice.
      if (own && r.source !== 'scheduler') return { outcome: 'answered', text: own };
      return null;
    }
    case 'text':
      return own ? { outcome: 'answered', text: own } : null;
    case 'review': {
      const pick = picks[0];
      if (pick === 'edit') {
        if (edited.trim() === '' || byteLength(edited) > DRAFT_MAX_BYTES) return null;
        return { outcome: 'edited', text: edited };
      }
      if (pick === 'written') return { outcome: 'approved' };
      if (pick === 'reject')
        return own ? { outcome: 'declined', reason: own } : { outcome: 'declined' };
      return null;
    }
    case 'attend':
      return null;
  }
}

function isTextField(el: EventTarget | null): boolean {
  return (
    el instanceof HTMLTextAreaElement || (el instanceof HTMLInputElement && el.type === 'text')
  );
}

type DraftView = 'edited' | 'original' | 'changes';

export function RequestTemplate(p: RequestTemplateProps): JSX.Element {
  const { request: r, sessionName, mode, moreCount, now, onSend, onNext } = p;
  const titleId = useId();
  const groupId = useId();
  const noteId = useId();
  const editId = useId();
  const ownId = useId();

  const handle = r.requester === 'conduit' ? sessionName : r.requester;
  const type: RequestType = typeOf(r);
  const conduit = isConduit(r);
  const quoted = !conduit;
  const ended = r.state !== 'open';
  const editKey = `${r.id}#draft`;

  const draft = useDraft(r.id);
  const editDraft = useDraft(editKey);
  const picks = draft?.pick ?? [];
  const text = draft?.text ?? '';
  const edited = editDraft?.text ?? r.draft ?? '';
  const choices = choicesOf(r);
  const multi = r.kind === 'choose' && r.multi;
  const answer = answerFor(r, picks, text, edited);
  const scheduledNeedsPick = r.source === 'scheduler' && r.kind === 'choose' && picks.length === 0;
  const tooLong =
    r.kind === 'review' && picks[0] === 'edit' && byteLength(edited) > DRAFT_MAX_BYTES;

  const [view, setView] = useState<DraftView>('edited');
  const [guarded, setGuarded] = useState(false);
  const [sent, setSent] = useState(false);
  const [receipt, setReceipt] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const guardUntil = useRef(0);
  const guardTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const nextTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const inFlight = useRef(false);
  const prevId = useRef<string | null>(null);

  useLayoutEffect(() => {
    const prev = prevId.current;
    prevId.current = r.id;
    if (prev === null || prev === r.id) return;
    guardUntil.current = Date.now() + SWAP_GUARD_MS;
    setGuarded(true);
    clearTimeout(guardTimer.current);
    guardTimer.current = setTimeout(() => setGuarded(false), SWAP_GUARD_MS);
    clearTimeout(nextTimer.current);
    setSent(false);
    setReceipt(null);
    setFailure(null);
    setView('edited');
  }, [r.id]);

  useEffect(
    () => () => {
      clearTimeout(guardTimer.current);
      clearTimeout(nextTimer.current);
    },
    [],
  );

  const guardedNow = () => Date.now() < guardUntil.current;

  const writePicks = (next: string[]) => setDraft(r.id, { pick: next, text });
  const writeText = (next: string) => setDraft(r.id, { pick: picks, text: next });

  const pick = (key: string) => {
    if (ended) return;
    if (multi) writePicks(picks.includes(key) ? picks.filter((k) => k !== key) : [...picks, key]);
    else writePicks([key]);
  };

  const send = async (a: AnswerInput) => {
    if (guardedNow() || inFlight.current || sent || ended) return;
    inFlight.current = true;
    setFailure(null);
    let result: RequestAnswerResult;
    try {
      result = await onSend(a);
    } finally {
      inFlight.current = false;
    }
    if (!result.ok) {
      setFailure(result.message);
      return;
    }
    setSent(true);
    setReceipt(REQ_STR.receipt(handle));
    clearDraft(r.id);
    clearDraft(editKey);
    clearTimeout(nextTimer.current);
    nextTimer.current = setTimeout(onNext, SWAP_GUARD_MS);
  };

  const pickByNumber = (n: number) => {
    const c = choices[n - 1];
    if (!c || guardedNow()) return;
    pick(c.key);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const inText = isTextField(e.target);
    if (e.key === 'Enter' && e.ctrlKey) {
      e.preventDefault();
      if (answer) void send(answer);
      return;
    }
    if (
      e.key === 'Enter' &&
      e.target instanceof HTMLInputElement &&
      e.target.dataset.key !== undefined
    ) {
      if (!picks.includes(e.target.dataset.key)) return;
      e.preventDefault();
      if (answer) void send(answer);
      return;
    }
    if (/^[1-8]$/.test(e.key) && !inText && !e.altKey && !e.metaKey && !e.ctrlKey) {
      e.preventDefault();
      pickByNumber(Number(e.key));
      return;
    }
    if (e.key === 'ArrowRight' && (inText ? e.altKey : !e.altKey) && moreCount > 0) {
      e.preventDefault();
      if (!guardedNow()) onNext();
    }
  };

  const showOpenAsTab = mode === 'popup' && r.kind !== 'attend';
  const endedText = endedLine(r, handle);
  const waitingSecs =
    r.waitingUntil === null
      ? null
      : Math.max(0, Math.ceil((Date.parse(r.waitingUntil) - now) / 1000));
  const timeText = waitingSecs === null ? ageLabel(r.createdAt, now) : REQ_STR.waiting(waitingSecs);
  const ownLabel = r.kind === 'confirm' ? REQ_STR.ownWordsPlaceholder : REQ_STR.ownWordsLabel;

  const contextFrame = (
    <>
      <p className="reqtpl-title">{r.title}</p>
      {r.body !== '' && <div className="reqtpl-body">{r.body}</div>}
    </>
  );

  const reviewPanel = r.kind === 'review' && (
    <div className="reqtpl-review">
      <div className="reqtpl-views" role="group" aria-label={REQ_STR.reqTpl.draftViews}>
        {(['edited', 'original', 'changes'] as const).map((v) => (
          <button
            key={v}
            type="button"
            className="reqtpl-views__btn"
            aria-pressed={view === v}
            onClick={() => setView(v)}
          >
            {v === 'edited'
              ? REQ_STR.reqTpl.editedTab
              : v === 'original'
                ? REQ_STR.reqTpl.originalTab
                : REQ_STR.reqTpl.changesTab}
          </button>
        ))}
      </div>
      {view === 'edited' && (
        <>
          <label className="reqtpl-field__label" htmlFor={editId}>
            {REQ_STR.reqTpl.editedLabel}
          </label>
          <textarea
            id={editId}
            className="reqtpl-edit"
            value={edited}
            disabled={ended}
            onChange={(e) => setDraft(editKey, { pick: [], text: e.target.value })}
          />
        </>
      )}
      {view === 'original' && <pre className="reqtpl-original">{r.draft ?? ''}</pre>}
      {view === 'changes' && <ChangesList original={r.draft ?? ''} edited={edited} />}
    </div>
  );

  return (
    <div className="reqtpl" role="dialog" aria-labelledby={titleId} onKeyDown={onKeyDown}>
      <header className="reqtpl-head">
        <RequestTypeIcon type={type} conduit={conduit} label={REQ_STR.typeWord[type]} />
        <div className="reqtpl-head__main">
          <div className="reqtpl-head__line">
            <h2 id={titleId} tabIndex={-1} className="reqtpl-head__title">
              {sentenceOf(r, handle)}
            </h2>
            {conduit && (
              <span className="reqtpl-chip">
                <span aria-hidden="true">⛨ </span>
                {REQ_STR.conduit}
              </span>
            )}
            {r.priority === 'urgent' && <span className="reqtpl-urgent">{REQ_STR.urgent}</span>}
          </div>
          <div className="reqtpl-head__meta">{sessionName}</div>
        </div>
        <div
          className={
            waitingSecs === null ? 'reqtpl-head__time' : 'reqtpl-head__time reqtpl-head__time--wait'
          }
        >
          {timeText}
        </div>
        {mode === 'popup' && p.onClose && (
          <button
            type="button"
            className="reqtpl-close"
            aria-label={REQ_STR.reqTpl.close}
            onClick={p.onClose}
          >
            ×
          </button>
        )}
      </header>

      <section className="reqtpl-context">
        {quoted ? (
          <div className="needs-quote" dir="auto">
            {contextFrame}
          </div>
        ) : (
          contextFrame
        )}
        {reviewPanel}
      </section>

      <section className="reqtpl-answer">
        {endedText !== null && <div className="reqtpl-ended">{endedText}</div>}

        {r.kind === 'attend' ? (
          <div className="reqtpl-attend">
            <p>{REQ_STR.reqTpl.attendLine}</p>
            <button type="button" className="btn btn--primary" onClick={p.onOpenTerminal}>
              {REQ_STR.openTerminal}
            </button>
          </div>
        ) : (
          <>
            {choices.length > 0 && (
              <div
                className="reqtpl-options"
                role={multi ? 'group' : 'radiogroup'}
                aria-labelledby={titleId}
              >
                {choices.map((c, i) => {
                  const checked = picks.includes(c.key);
                  return (
                    <label
                      key={c.key}
                      className={checked ? 'reqtpl-option reqtpl-option--picked' : 'reqtpl-option'}
                    >
                      <input
                        type={multi ? 'checkbox' : 'radio'}
                        name={groupId}
                        value={c.key}
                        data-key={c.key}
                        checked={checked}
                        disabled={ended}
                        onChange={() => pick(c.key)}
                      />
                      <span className="reqtpl-option__num" aria-hidden="true">
                        {i + 1}
                      </span>
                      <span className="reqtpl-option__text">
                        <span className="reqtpl-option__label">{c.label}</span>
                        {c.description && (
                          <span className="reqtpl-option__desc">{c.description}</span>
                        )}
                      </span>
                    </label>
                  );
                })}
              </div>
            )}

            {r.kind === 'text' && (
              <div className="reqtpl-field">
                <label className="reqtpl-field__label" htmlFor={ownId}>
                  {REQ_STR.reqTpl.answerLabel}
                </label>
                <textarea
                  id={ownId}
                  className="reqtpl-field__input"
                  value={text}
                  disabled={ended}
                  onChange={(e) => writeText(e.target.value)}
                />
              </div>
            )}

            {(r.kind === 'confirm' || r.kind === 'choose') && (
              <div className="reqtpl-field">
                <label className="reqtpl-field__label" htmlFor={ownId}>
                  {ownLabel}
                </label>
                <textarea
                  id={ownId}
                  className="reqtpl-field__input"
                  value={text}
                  disabled={ended}
                  onChange={(e) => writeText(e.target.value)}
                />
              </div>
            )}

            {r.kind === 'review' && (
              <div className="reqtpl-field">
                <label className="reqtpl-field__label" htmlFor={noteId}>
                  {REQ_STR.noteLabel}
                </label>
                <textarea
                  id={noteId}
                  className="reqtpl-field__input"
                  value={text}
                  disabled={ended}
                  onChange={(e) => writeText(e.target.value)}
                />
              </div>
            )}

            <div className="reqtpl-send">
              {tooLong && (
                <p className="reqtpl-reason" role="status">
                  {REQ_STR.reqTpl.draftTooLong(DRAFT_MAX_BYTES)}
                </p>
              )}
              {scheduledNeedsPick && !ended && text.trim() !== '' && (
                <p className="reqtpl-reason">{REQ_STR.reqTpl.needPick}</p>
              )}
              <button
                type="button"
                className="btn btn--primary reqtpl-send__btn"
                aria-disabled={guarded}
                aria-keyshortcuts="Control+Enter"
                disabled={answer === null || ended || sent}
                onClick={() => {
                  if (answer) void send(answer);
                }}
              >
                {REQ_STR.send}
              </button>
            </div>
          </>
        )}

        <div className="reqtpl-receipt" aria-live="polite">
          {receipt}
        </div>
        {failure !== null && (
          <p className="reqtpl-error" role="alert">
            {failure}
          </p>
        )}
      </section>

      <footer className="reqtpl-footer">
        <div className="reqtpl-footer__this">
          {showOpenAsTab && (
            <button type="button" className="btn btn--sm" onClick={p.onOpenAsTab}>
              {REQ_STR.openAsTab}
            </button>
          )}
          {r.session !== null && r.kind !== 'attend' && (
            <button type="button" className="btn btn--sm" onClick={p.onOpenTerminal}>
              {REQ_STR.openTerminal}
            </button>
          )}
        </div>
        <div className="reqtpl-footer__queue">
          {r.kind !== 'attend' && (
            <button
              type="button"
              className="btn btn--sm"
              aria-disabled={guarded}
              disabled={ended || sent}
              onClick={() => {
                if (!guardedNow()) void send({ outcome: 'dismissed' });
              }}
            >
              {REQ_STR.skip}
            </button>
          )}
          {moreCount > 0 && (
            <button
              type="button"
              className="btn btn--sm"
              aria-disabled={guarded}
              onClick={() => {
                if (!guardedNow()) onNext();
              }}
            >
              {`${REQ_STR.next(moreCount)} →`}
            </button>
          )}
        </div>
      </footer>
    </div>
  );
}

function ChangesList({ original, edited }: { original: string; edited: string }) {
  const lines = changedLineNumbers(original, edited);
  if (lines.length === 0) return <p className="reqtpl-changes">{REQ_STR.reqTpl.noChanges}</p>;
  return (
    <div className="reqtpl-changes">
      <p>{REQ_STR.reqTpl.linesChanged(lines.length)}</p>
      <p>{REQ_STR.reqTpl.changedLines(lines.join(', '))}</p>
    </div>
  );
}
