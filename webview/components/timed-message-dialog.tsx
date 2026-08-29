/**
 * Timed messages for one session (spec 2026-08-28-timed-messages §2 "The dialog", §9).
 * Composer on top, this session's schedules below. Focus-trapped over .modal__backdrop, on the
 * compare-dialog.tsx precedent.
 *
 * Every time it shows is rendered through Intl in the user's locale and zone, so 12h/24h follows
 * the OS (§10); nothing here formats a clock by hand.
 */
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import {
  buildSchedule,
  capError,
  DEFAULT_DELAY_MS,
  DEFAULT_REPEATS,
  describeNext,
  formatDuration,
  MAX_REPEATS,
  sanitizeMessage,
  type TimedMessage,
  type TriggerInput,
} from '../../src/timed-messages';
import type { Session } from '../../src/types';
import { IconClock, IconClose, IconTrash } from '../icons';
import { hasRegisteredTerminal, subscribeTerminalBus } from '../terminal-bus';
import {
  armTimedMessage,
  cancelTimedMessage,
  getTimerSnapshot,
  renewTimedMessage,
  resolveLimitOffer,
  schedulesFor,
  sendMessageOnce,
  sendTimedMessageNow,
  subscribeTimers,
} from '../timer-store';
import { SegmentedRadios } from './segmented-radios';

const QUICK_MESSAGES = ['Continue', 'Do this again', 'Think about it again'] as const;

type TriggerKind = 'in' | 'at' | 'every';
type Unit = 'minutes' | 'hours';

const TRIGGERS: readonly { id: TriggerKind; label: string }[] = [
  { id: 'in', label: 'In' },
  { id: 'at', label: 'At' },
  { id: 'every', label: 'Every' },
];

const UNIT_MS: Record<Unit, number> = { minutes: 60_000, hours: 3_600_000 };

/** `HH:MM` in the browser's own zone, which is what `<input type="time">` produces. */
function clockNow(offsetMs: number): string {
  const d = new Date(Date.now() + offsetMs);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export function TimedMessageDialog({
  session,
  onClose,
  requestConfirm,
}: {
  session: Session;
  onClose: () => void;
  requestConfirm: (state: {
    title: string;
    message: string;
    confirmLabel?: string;
    danger?: boolean;
    focusCancel?: boolean;
    onConfirm: () => void;
  }) => void;
}) {
  const snap = useSyncExternalStore(subscribeTimers, getTimerSnapshot, getTimerSnapshot);
  // Registry presence only — the bracketed-paste gate is Lane F's and is not consulted here.
  const hasTerminal = useSyncExternalStore(
    subscribeTerminalBus,
    () => hasRegisteredTerminal(session.id),
    () => hasRegisteredTerminal(session.id),
  );
  const titleId = useId();
  const messageId = useId();
  const hintId = useId();
  const sendReasonId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const messageRef = useRef<HTMLInputElement>(null);
  // Whatever opened this — the chip, the stale card's line, or whatever had focus when the
  // palette ran. compare-dialog.tsx is the precedent; without it focus lands on <body> and a
  // keyboard user restarts from the top of the document (§10 "Focus").
  const openerRef = useRef<HTMLElement | null>(
    typeof document === 'undefined' ? null : (document.activeElement as HTMLElement | null),
  );
  useEffect(() => {
    const opener = openerRef.current;
    return () => {
      if (opener?.isConnected) opener.focus();
    };
  }, []);

  const [message, setMessage] = useState('Continue');
  /** What the composer was last SEEDED with, so Edit does not read as unsaved typing. */
  const seededRef = useRef('Continue');
  const [kind, setKind] = useState<TriggerKind>('in');
  const [delay, setDelay] = useState(DEFAULT_DELAY_MS / UNIT_MS.minutes);
  const [delayUnit, setDelayUnit] = useState<Unit>('minutes');
  const [clock, setClock] = useState(() => clockNow(DEFAULT_DELAY_MS));
  const [every, setEvery] = useState(1);
  const [everyUnit, setEveryUnit] = useState<Unit>('hours');
  const [repeats, setRepeats] = useState(DEFAULT_REPEATS);
  const [editingId, setEditingId] = useState<string | null>(null);

  const timeFmt = useMemo(
    () => new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }),
    [],
  );
  const dayFmt = useMemo(
    () =>
      new Intl.DateTimeFormat(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' }),
    [],
  );
  const formatTime = useCallback((at: number) => timeFmt.format(new Date(at)), [timeFmt]);

  const rows = schedulesFor(snap, session.id);
  const offer = snap.offer?.sessionId === session.id ? snap.offer : null;

  const trigger: TriggerInput = useMemo(() => {
    if (kind === 'at') return { kind: 'at', clock };
    if (kind === 'every')
      return { kind: 'every', everyMs: every * UNIT_MS[everyUnit], maxRepeats: repeats };
    return { kind: 'in', delayMs: delay * UNIT_MS[delayUnit] };
  }, [kind, clock, every, everyUnit, repeats, delay, delayUnit]);

  // The same builder the host runs, so the hint can never promise a time the host would refuse.
  // The floor is dropped here only to preview; the host applies the real one (§3).
  const preview = useMemo(
    () =>
      buildSchedule(
        { sessionId: session.id, message, trigger, ...(editingId ? { id: editingId } : {}) },
        Date.now(),
        { minDelayMs: 0, minIntervalMs: 0 },
      ),
    [session.id, message, trigger, editingId],
  );

  const sanitized = sanitizeMessage(message);
  // The host re-checks and would reject with a toast; showing it here is what §8 asks for — the
  // reason sits next to the disabled button instead of arriving after the click.
  const capped = capError(snap.schedules, session.id, editingId ?? undefined);
  const canArm = preview.ok && sanitized.length > 0 && snap.loaded && !capped;

  const hint = (() => {
    if (!sanitized) return 'Type a message.';
    if (capped) return capped;
    if (!preview.ok) return preview.error;
    const at = preview.schedule.nextAt;
    const first = `First send ${dayFmt.format(new Date(at))} — in ${formatDuration(at - Date.now())}`;
    if (kind !== 'every') return `${first}.`;
    return `${first}, then every ${formatDuration(every * UNIT_MS[everyUnit])}, ${repeats} times.`;
  })();

  const arm = () => {
    if (!canArm) return;
    armTimedMessage({
      sessionId: session.id,
      message: sanitized,
      trigger,
      ...(editingId ? { id: editingId } : {}),
    });
    setEditingId(null);
    onClose();
  };

  const edit = (s: TimedMessage) => {
    setEditingId(s.id);
    setMessage(s.message);
    seededRef.current = sanitizeMessage(s.message);
    if (s.kind === 'interval') {
      setKind('every');
      setEvery(Math.max(Math.round((s.everyMs ?? UNIT_MS.hours) / UNIT_MS.hours), 1));
      setEveryUnit('hours');
      setRepeats(s.maxRepeats);
    } else if (s.spec) {
      setKind('at');
      setClock(s.spec.clock);
    } else {
      setKind('in');
      setDelay(Math.max(Math.round((s.nextAt - s.createdAt) / UNIT_MS.minutes), 1));
      setDelayUnit('minutes');
    }
    messageRef.current?.focus();
  };

  const confirmCancel = (s: TimedMessage) => {
    // Always confirms: an armed timer is the thing the user walked away trusting (§2).
    requestConfirm({
      title: 'Cancel timed message',
      message: `Stop sending "${s.message}" to ${session.name}?`,
      confirmLabel: 'Cancel it',
      danger: true,
      focusCancel: true,
      onConfirm: () => cancelTimedMessage(s.id),
    });
  };

  /** Dirty = the composer holds something other than what it was last seeded with. */
  const dirty = sanitized.length > 0 && sanitized !== seededRef.current;

  const requestClose = () => {
    if (!dirty) {
      onClose();
      return;
    }
    requestConfirm({
      title: 'Discard this message',
      message: `Close without arming "${sanitized}"?`,
      confirmLabel: 'Discard',
      danger: true,
      focusCancel: true,
      onConfirm: onClose,
    });
  };

  const onRootKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      requestClose();
      return;
    }
    // Enter is the composer's shortcut, not the whole dialog's: on a button it must do what the
    // button says. Cancel, Send now, ×, and every row control are all buttons, and arming from
    // any of them is a wrong, unattended write.
    const target = e.target as HTMLElement;
    if (
      e.key === 'Enter' &&
      canArm &&
      target.tagName !== 'BUTTON' &&
      !target.closest('.tmdlg__row')
    ) {
      e.preventDefault();
      arm();
      return;
    }
    if (e.key !== 'Tab') return;
    const root = rootRef.current;
    if (!root) return;
    const focusables = [
      ...root.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ),
    ].filter((el) => el.offsetParent !== null);
    if (focusables.length === 0) return;
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  };

  return (
    <div className="modal__backdrop" onClick={requestClose}>
      <div
        ref={rootRef}
        className="tmdlg chamfer"
        role="dialog"
        aria-modal
        aria-labelledby={titleId}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={onRootKeyDown}
      >
        <div className="tmdlg__head">
          <IconClock size={15} />
          <span className="tmdlg__title" id={titleId}>{`Timed messages — ${session.name}`}</span>
          <button type="button" className="tmdlg__close" aria-label="Close" onClick={requestClose}>
            <IconClose size={12} />
          </button>
        </div>

        {offer && (
          <div className="tmdlg__offer" role="group" aria-label="Usage limit detected">
            <span className="tmdlg__offertext">
              {`Session limit — resets ${formatTime(offer.resetAt)}. Resume then?`}
            </span>
            <span className="tmdlg__offerline">{offer.line}</span>
            <div className="tmdlg__offeractions">
              <button
                type="button"
                className="btn btn--primary"
                onClick={() => resolveLimitOffer(session.id, 'arm')}
              >
                Resume then
              </button>
              <button
                type="button"
                className="btn"
                onClick={() => resolveLimitOffer(session.id, 'dismiss')}
              >
                Dismiss
              </button>
            </div>
          </div>
        )}

        <div className="tmdlg__composer">
          <label className="tmdlg__label" htmlFor={messageId}>
            Message
          </label>
          <input
            id={messageId}
            ref={messageRef}
            className="tmdlg__input"
            autoFocus
            value={message}
            aria-describedby={hintId}
            onChange={(e) => setMessage(e.target.value)}
          />
          <div className="tmdlg__quick">
            {QUICK_MESSAGES.map((q) => (
              <button key={q} type="button" className="tmdlg__chip" onClick={() => setMessage(q)}>
                {q}
              </button>
            ))}
          </div>

          <SegmentedRadios
            label="When"
            className="tmdlg__trigger"
            value={kind}
            options={TRIGGERS}
            onChange={setKind}
          />

          {kind === 'in' && (
            <div className="tmdlg__fields">
              <input
                type="number"
                min={1}
                className="tmdlg__num"
                aria-label="Delay"
                value={delay}
                onChange={(e) => setDelay(Math.max(Number(e.target.value) || 1, 1))}
              />
              <select
                className="tmdlg__unit"
                aria-label="Delay unit"
                value={delayUnit}
                onChange={(e) => setDelayUnit(e.target.value as Unit)}
              >
                <option value="minutes">minutes</option>
                <option value="hours">hours</option>
              </select>
            </div>
          )}

          {kind === 'at' && (
            <div className="tmdlg__fields">
              {/* A native time input rather than a hand-rolled HH:MM + am/pm pair: it is already
                  keyboard-operable and already follows the OS's 12h/24h preference (§10), and it
                  hands back the 24-hour string resolveClockTime wants. */}
              <input
                type="time"
                className="tmdlg__time"
                aria-label="Time of day"
                value={clock}
                onChange={(e) => setClock(e.target.value)}
              />
            </div>
          )}

          {kind === 'every' && (
            <div className="tmdlg__fields">
              <input
                type="number"
                min={1}
                className="tmdlg__num"
                aria-label="Interval"
                value={every}
                onChange={(e) => setEvery(Math.max(Number(e.target.value) || 1, 1))}
              />
              <select
                className="tmdlg__unit"
                aria-label="Interval unit"
                value={everyUnit}
                onChange={(e) => setEveryUnit(e.target.value as Unit)}
              >
                <option value="minutes">minutes</option>
                <option value="hours">hours</option>
              </select>
              <label className="tmdlg__label tmdlg__label--inline" htmlFor={`${hintId}-repeats`}>
                Repeats
              </label>
              <input
                id={`${hintId}-repeats`}
                type="number"
                min={1}
                max={MAX_REPEATS}
                className="tmdlg__num"
                aria-describedby={hintId}
                value={repeats}
                onChange={(e) =>
                  setRepeats(Math.min(Math.max(Number(e.target.value) || 1, 1), MAX_REPEATS))
                }
              />
            </div>
          )}

          <p className="tmdlg__hint" id={hintId}>
            {hint}
          </p>
          {/* Send now's own reason, so a screen reader that follows aria-describedby is told why
              the button is dead rather than being read the trigger hint again (§9). */}
          <p className="tmdlg__hint tmdlg__hint--muted" id={sendReasonId}>
            {hasTerminal
              ? 'Send now delivers immediately and changes nothing about the schedule.'
              : "This session isn't running — Send now is unavailable, and an armed message will wait until it starts."}
          </p>

          <div className="tmdlg__actions">
            <button type="button" className="btn" onClick={requestClose}>
              Cancel
            </button>
            <button
              type="button"
              className="btn"
              disabled={!hasTerminal || !sanitized}
              aria-disabled={!hasTerminal || !sanitized}
              aria-describedby={sendReasonId}
              onClick={() => {
                sendMessageOnce(session.id, sanitized);
                onClose();
              }}
            >
              Send now
            </button>
            <button
              type="button"
              className="btn btn--primary"
              disabled={!canArm}
              aria-keyshortcuts="Enter"
              onClick={arm}
            >
              {editingId ? 'Save' : 'Arm'}
            </button>
          </div>
        </div>

        <div className="tmdlg__list">
          {rows.length === 0 ? (
            <p className="tmdlg__empty">Nothing armed for this session.</p>
          ) : (
            rows.map((s) => (
              <div key={s.id} className="tmdlg__row" role="group" aria-label={s.message}>
                <span className="tmdlg__rowmsg" title={s.message}>
                  {s.message}
                </span>
                <span className="tmdlg__rowwhen">
                  {s.state === 'waiting'
                    ? 'Waiting — will send when this session starts'
                    : describeNext(s, Date.now(), formatTime)}
                </span>
                <span className="tmdlg__rowbadge">{s.origin === 'limit' ? 'Auto' : 'Manual'}</span>
                {s.kind === 'interval' && s.state !== 'done' && (
                  <span className="tmdlg__rowleft">{`${s.maxRepeats - s.firedCount} left`}</span>
                )}
                {s.lastFire && (
                  <span className="tmdlg__rowlast">
                    {s.lastFire.reason === 'expired'
                      ? `· missed (too old)`
                      : `· last ${formatTime(s.lastFire.at)}${s.lastFire.late ? ' · late' : ''}`}
                  </span>
                )}
                <span className="tmdlg__rowactions">
                  {s.state !== 'done' && (
                    <button type="button" className="btn btn--sm" onClick={() => edit(s)}>
                      Edit
                    </button>
                  )}
                  {s.state === 'armed' && (
                    <button
                      type="button"
                      className="btn btn--sm"
                      disabled={!hasTerminal}
                      aria-disabled={!hasTerminal}
                      onClick={() => sendTimedMessageNow(s.id)}
                    >
                      Send now
                    </button>
                  )}
                  <button
                    type="button"
                    className="btn btn--sm"
                    onClick={() => renewTimedMessage(s.id)}
                  >
                    Renew
                  </button>
                  <button
                    type="button"
                    className="btn btn--sm btn--danger"
                    aria-label={`Cancel ${s.message}`}
                    onClick={() => confirmCancel(s)}
                  >
                    <IconTrash size={12} />
                  </button>
                </span>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
