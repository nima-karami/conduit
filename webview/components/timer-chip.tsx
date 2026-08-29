/**
 * The armed-timer chip over a terminal (spec 2026-08-28-timed-messages §2 "Overlay", §8).
 *
 * There is no `waiting` and no `paused` chip state: a session in either condition has no pane at
 * all (center-pane.tsx filters on `status === 'running'`), so Waiting is signalled on the stale
 * card and the session rail instead (§2 "Waiting").
 */
import { useEffect, useReducer, useSyncExternalStore } from 'react';
import { describeNext, formatDuration, HOUR_MS, type TimedMessage } from '../../src/timed-messages';
import { IconClock } from '../icons';
import {
  cancelTimedMessage,
  getTimerSnapshot,
  liveSchedulesFor,
  subscribeTimers,
} from '../timer-store';

/** How long a fire keeps flashing on the chip before it goes back or goes away (§2). */
const LATE_FLASH_MS = 10_000;

type ChipMode = 'armed' | 'auto' | 'offer' | 'firing' | 'late';

const earliest = (list: TimedMessage[]): TimedMessage | null =>
  list.reduce<TimedMessage | null>((best, s) => (!best || s.nextAt < best.nextAt ? s : best), null);

export function TimerChip({
  sessionId,
  stacked,
  onOpen,
}: {
  sessionId: string;
  stacked: boolean;
  onOpen: () => void;
}) {
  const snap = useSyncExternalStore(subscribeTimers, getTimerSnapshot, getTimerSnapshot);
  const [, tick] = useReducer((n: number) => n + 1, 0);

  const live = liveSchedulesFor(snap, sessionId).filter((s) => s.state === 'armed');
  const next = earliest(live);
  const offer = snap.offer?.sessionId === sessionId ? snap.offer : null;
  const fire = snap.fires.get(sessionId);
  // The record the fire belongs to, NOT `next`: a late `once` fire is `done` the moment it lands,
  // so it is not in `live` — reading the duration off `next` loses it in the headline restart case
  // and the chip says "Sent late" where it should say "Sent 10h late".
  const fired = fire ? snap.schedules.find((s) => s.id === fire.id) : undefined;
  const now = Date.now();

  // §8 lists no chip state for "sent, on time, as asked": the toast already said so, and a bare
  // bordered chip sitting there for ten seconds afterwards is noise.
  const flashUntil = fire && (fire.late || !fire.delivered) ? fire.at + LATE_FLASH_MS : null;

  // The flash is the LAST thing on screen after a once schedule finishes, so nothing else will
  // re-render the chip to clear it. One timeout at its expiry is what makes it disappear.
  useEffect(() => {
    if (flashUntil === null) return;
    const wait = flashUntil - Date.now();
    if (wait <= 0) return;
    const handle = setTimeout(tick, wait);
    return () => clearTimeout(handle);
  }, [flashUntil]);

  /**
   * Presentational only (§2 "The timer" — scope of the no-polling invariant): 1 s under an hour,
   * 1 min above it, and nothing at all while the window is hidden. It may drift, be throttled or
   * be skipped entirely without changing when anything is delivered.
   */
  const nextAt = next?.nextAt ?? null;
  useEffect(() => {
    if (nextAt === null) return;
    let handle: ReturnType<typeof setTimeout> | null = null;
    const arm = () => {
      if (document.visibilityState === 'hidden') return;
      handle = setTimeout(
        () => {
          tick();
          arm();
        },
        nextAt - Date.now() < HOUR_MS ? 1000 : 60_000,
      );
    };
    const onVisibility = () => {
      if (handle) clearTimeout(handle);
      tick();
      arm();
    };
    arm();
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      if (handle) clearTimeout(handle);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [nextAt]);

  const flashing = flashUntil !== null && now < flashUntil;
  if (!next && !offer && !flashing) return null;

  // Transient states win over standing ones: what just happened is the news.
  const firing = !!next && next.nextAt <= now && (!fire || fire.at < next.nextAt);
  const mode: ChipMode = firing
    ? 'firing'
    : flashing && fire?.late
      ? 'late'
      : offer
        ? 'offer'
        : next?.origin === 'limit'
          ? 'auto'
          : 'armed';

  const timeFmt = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });
  const formatTime = (at: number) => timeFmt.format(new Date(at));

  const text = (() => {
    if (mode === 'firing') return 'Sending…';
    if (mode === 'late' && fire && fired)
      return `Sent ${formatDuration(fire.at - fired.nextAt)} late`;
    if (mode === 'late' && fire) return 'Sent late';
    if (mode === 'offer' && offer) return `Resume at ${formatTime(offer.resetAt)}?`;
    return next ? describeNext(next, now, formatTime) : '';
  })();

  const repeatsLeft = next && next.kind === 'interval' ? next.maxRepeats - next.firedCount : 0;
  const label = [
    mode === 'auto' ? 'Automatic timed message' : 'Timed message',
    text,
    repeatsLeft > 1 ? `${repeatsLeft} sends left` : '',
  ]
    .filter(Boolean)
    .join(' — ');

  return (
    <div
      className={`term-timer term-timer--${mode}${stacked ? ' term-timer--stacked' : ''}`}
      role="group"
      aria-label={label}
    >
      <button
        type="button"
        className="term-timer__open"
        // Native title: no floating element, so nothing here can obstruct the terminal.
        title={label}
        aria-label={label}
        onClick={onOpen}
      >
        <span className={`term-timer__glyph${mode === 'firing' ? ' term-timer__spin' : ''}`}>
          {mode === 'offer' ? '!' : <IconClock size={12} />}
        </span>
        {mode === 'auto' && <span className="term-timer__badge">Auto</span>}
        {mode === 'late' && <span className="term-timer__word">late</span>}
        <span>{text}</span>
        {repeatsLeft > 1 && <span className="term-timer__count">{`×${repeatsLeft}`}</span>}
      </button>
      {mode === 'auto' && next && (
        <button
          type="button"
          className="term-timer__cancel"
          aria-label={`Cancel the automatic timed message ${text}`}
          title="Cancel"
          onClick={() => cancelTimedMessage(next.id)}
        >
          ×
        </button>
      )}
    </div>
  );
}
