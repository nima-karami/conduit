import type { MouseEvent, ReactNode } from 'react';
import { useEffect, useReducer, useSyncExternalStore } from 'react';
import { type Rect, triggerMenu } from '../../src/menu-position';
import { describeNext, formatDuration, type TimedMessage } from '../../src/timed-messages';
import { IconClock } from '../icons';
import { startTimerCountdown } from '../timer-countdown';
import {
  cancelTimedMessage,
  getTimerSnapshot,
  liveSchedulesFor,
  sendTimedMessageNow,
  subscribeTimers,
} from '../timer-store';
import type { MenuEntry, MenuState } from './context-menu';

/** How long a fire keeps flashing on the bar before it goes back or goes away (§2). */
const LATE_FLASH_MS = 10_000;

type ScheduleMode = 'idle' | 'armed' | 'auto' | 'offer' | 'firing' | 'late';

const earliest = (list: TimedMessage[]): TimedMessage | null =>
  list.reduce<TimedMessage | null>((best, s) => (!best || s.nextAt < best.nextAt ? s : best), null);

export function SessionBar({
  sessionId,
  name,
  icon,
  role,
  visible,
  autoResume,
  onSessionMenu,
  onPermissions,
  onOpen,
  onScheduleMenu,
}: {
  sessionId: string;
  name: string;
  icon: ReactNode;
  role?: string;
  visible: boolean;
  autoResume?: { on: boolean; set: (on: boolean) => void };
  onSessionMenu: (rect: Rect, keyboard: boolean) => void;
  onPermissions: (opener: HTMLButtonElement) => void;
  onOpen: () => void;
  onScheduleMenu: (menu: MenuState) => void;
}) {
  const snap = useSyncExternalStore(subscribeTimers, getTimerSnapshot, getTimerSnapshot);
  const [, tick] = useReducer((n: number) => n + 1, 0);

  const live = liveSchedulesFor(snap, sessionId).filter((s) => s.state === 'armed');
  const next = earliest(live);
  const offer = snap.offer?.sessionId === sessionId ? snap.offer : null;
  const fire = snap.fires.get(sessionId);
  // A completed one-shot is absent from the live list, but its schedule still gives the fire time.
  const fired = fire ? snap.schedules.find((s) => s.id === fire.id) : undefined;
  const now = Date.now();
  const flashUntil = fire && (fire.late || !fire.delivered) ? fire.at + LATE_FLASH_MS : null;

  // An otherwise idle session has no update that would clear the flash.
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
    return startTimerCountdown(nextAt, visible, tick);
  }, [nextAt, visible]);

  const flashing = flashUntil !== null && now < flashUntil;

  // Transient states win over standing ones: what just happened is the news.
  const sending = snap.jobs.find(
    (job) => job.sessionId === sessionId && (job.state === 'checking' || job.state === 'sending'),
  );
  const firing = !!sending || (!!next && next.nextAt <= now && (!fire || fire.at < next.nextAt));
  const mode: ScheduleMode = firing
    ? 'firing'
    : flashing
      ? 'late'
      : offer
        ? 'offer'
        : next?.origin === 'limit'
          ? 'auto'
          : next
            ? 'armed'
            : 'idle';

  const timeFmt = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });
  const formatTime = (at: number) => timeFmt.format(new Date(at));

  const text = (() => {
    if (mode === 'firing') return 'Sending…';
    if (mode === 'late' && !fire?.delivered) return 'Message undelivered';
    if (mode === 'late' && fire) {
      return fire.scheduledAt === undefined
        ? 'Sent late'
        : `Sent ${formatDuration(fire.at - fire.scheduledAt)} late`;
    }
    if (mode === 'offer' && offer) return `Resume at ${formatTime(offer.resetAt)}?`;
    if (mode === 'auto' && next) return `Auto at ${formatTime(next.nextAt)}`;
    return next ? describeNext(next, now, formatTime) : '';
  })();

  const repeatsLeft =
    mode === 'armed' && next?.kind === 'interval' ? next.maxRepeats - next.firedCount : 0;
  const label =
    mode === 'idle'
      ? 'Timed messages'
      : [
          mode === 'auto' ? 'Automatic timed message' : 'Timed message',
          mode === 'auto' && next ? `at ${formatTime(next.nextAt)}` : text,
          repeatsLeft > 1 ? `${repeatsLeft} sends left` : '',
        ]
          .filter(Boolean)
          .join(' — ');

  const scheduled =
    mode === 'offer'
      ? null
      : mode === 'late'
        ? fired
        : sending
          ? snap.schedules.find((s) => s.id === sending.id)
          : next;
  const openSchedule = (event: MouseEvent<HTMLButtonElement>) => {
    if (!scheduled) {
      onOpen();
      return;
    }
    const auto = scheduled.origin === 'limit';
    const job = snap.jobs.find((j) => j.id === scheduled.id);
    const scheduledAt = (mode === 'late' ? fire?.scheduledAt : job?.nextAt) ?? scheduled.nextAt;
    const at = formatTime(scheduledAt);
    const reset = job?.trigger.kind === 'limit-reset' ? job.trigger.resetAt : undefined;
    const firstLine = scheduled.message.split('\n', 1)[0];
    const description = auto
      ? `Continue at ${at}${
          reset !== undefined && reset < scheduledAt
            ? `, ${formatDuration(scheduledAt - reset)
                .replace(/m$/, ' min')
                .replace(/s$/, ' sec')} after the ${formatTime(reset)} reset`
            : ''
        }`
      : firstLine.length <= 72
        ? firstLine
        : undefined;
    const items: MenuEntry[] = [];
    if (scheduled.state === 'armed' && mode !== 'firing' && mode !== 'late') {
      items.push(
        { label: 'Send now', onClick: () => sendTimedMessageNow(scheduled.id) },
        {
          label: auto ? 'Cancel this resume' : 'Cancel this message',
          onClick: () => cancelTimedMessage(scheduled.id),
        },
      );
    }
    if (autoResume) {
      items.push({
        label: `Turn auto-resume ${autoResume.on ? 'off' : 'on'} for ${name}`,
        onClick: () => autoResume.set(!autoResume.on),
      });
    }
    items.push({ label: 'Timed messages…', separatorBefore: items.length > 0, onClick: onOpen });
    onScheduleMenu({
      ...triggerMenu(event.currentTarget.getBoundingClientRect()),
      keyboard: event.detail === 0,
      heading: { title: auto ? 'Auto-resume' : `Message at ${at}`, description },
      items,
    });
  };

  return (
    <div className="session-bar" role="group" aria-label={`Session controls for ${name}`}>
      <button
        type="button"
        className="session-bar__session"
        aria-label={`Session menu for ${name}`}
        aria-haspopup="menu"
        onClick={(event) =>
          onSessionMenu(event.currentTarget.getBoundingClientRect(), event.detail === 0)
        }
      >
        {icon}
        <span>{name}</span>
      </button>
      {role && (
        <button
          type="button"
          className="session-bar__role"
          aria-label={`Permissions for ${name}, ${role}`}
          onClick={(event) => onPermissions(event.currentTarget)}
        >
          {role}
        </button>
      )}
      <button
        type="button"
        className="session-bar__schedule"
        data-mode={mode}
        title={label}
        aria-label={label}
        aria-haspopup={scheduled ? 'menu' : 'dialog'}
        onClick={openSchedule}
      >
        <span aria-hidden="true" className={mode === 'firing' ? 'session-bar__spin' : undefined}>
          {mode === 'offer' ? '!' : <IconClock size={12} />}
        </span>
        {text && <span>{text}</span>}
      </button>
    </div>
  );
}
