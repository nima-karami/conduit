import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  applySnooze,
  nextSnoozeExpiry,
  pruneSnoozed,
  SNOOZE_MS,
  type SnoozeMap,
} from '../src/attention';
import type { Session } from '../src/types';

const EMPTY: SnoozeMap = new Map();

/**
 * Renderer-side Snooze (conductor decision D16). Applied to the session list ONCE, above
 * both the sessions rail and the topbar's aggregate chip, so a snoozed session disappears
 * from both counts together.
 *
 * One timeout armed at the earliest expiry rather than a polling tick: when it fires the
 * lapsed entries are pruned, the list re-derives, and the session raises its hand again —
 * the host never stopped waiting, we only stopped showing it.
 */
export function useSnooze(sessions: Session[]): {
  sessions: Session[];
  snooze: (id: string) => void;
} {
  const [snoozed, setSnoozed] = useState<SnoozeMap>(EMPTY);

  useEffect(() => {
    const next = nextSnoozeExpiry(snoozed);
    if (next === undefined) return;
    const t = setTimeout(
      () => setSnoozed((cur) => pruneSnoozed(cur, Date.now())),
      Math.max(0, next - Date.now()) + 50,
    );
    return () => clearTimeout(t);
  }, [snoozed]);

  const snooze = useCallback((id: string) => {
    setSnoozed((cur) => new Map(cur).set(id, Date.now() + SNOOZE_MS));
  }, []);

  // Prune here too: the visible list must never be one render behind the timer.
  const visible = useMemo(() => {
    const now = Date.now();
    return applySnooze(sessions, pruneSnoozed(snoozed, now), now);
  }, [sessions, snoozed]);

  return { sessions: visible, snooze };
}
