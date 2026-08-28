/**
 * Timed messages for one session (spec 2026-08-28-timed-messages §2 "The dialog", §9).
 * Composer on top, this session's schedules below. Focus-trapped over .modal__backdrop, on the
 * compare-dialog.tsx precedent.
 *
 * Every time it shows is rendered through Intl in the user's locale and zone, so 12h/24h follows
 * the OS (§10); nothing here formats a clock by hand.
 */
import { useCallback, useId, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import {
  buildSchedule,
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
  const rootRef = useRef<HTMLDivElement>(null);
  const messageRef = useRef<HTMLInputElement>(null);

  const [message, setMessage] = useState('Continue');
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
  const canArm = preview.ok && sanitized.length > 0 && snap.loaded;

  const hint = (() => {
    if (!sanitized) return 'Type a message.';
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

  const onRootKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
      return;
    }
    if (e.key === 'Enter' && canArm && !(e.target as HTMLElement).closest('.tmdlg__row')) {
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
    <div className="modal__backdrop" onClick={onClose}>
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
          <button type="button" className="tmdlg__close" aria-label="Close" onClick={onClose}>
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
          {!hasTerminal && (
            <p className="tmdlg__hint tmdlg__hint--muted">
              This session isn't running — it will wait until it starts.
            </p>
          )}

          <div className="tmdlg__actions">
            <button type="button" className="btn" onClick={onClose}>
              Cancel
            </button>
            <button
              type="button"
              className="btn"
              disabled={!hasTerminal || !sanitized}
              aria-disabled={!hasTerminal || !sanitized}
              aria-describedby={hintId}
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
