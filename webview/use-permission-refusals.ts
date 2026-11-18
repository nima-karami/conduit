import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ActivityEntry } from '../src/conduit-mcp/activity-log';
import type { Session } from '../src/types';
import { subscribe } from './bridge';
import { dismissToast, pushToast } from './toast-store';

type ActivityStamp = Pick<ActivityEntry, 'id' | 'at'>;
type SessionRefusal = { count: number; latest: ActivityStamp; generation: number };
type OwnedSession = Pick<Session, 'id' | 'name' | 'runtime'>;

const liveGeneration = (session: OwnedSession | undefined) =>
  session?.runtime?.spawn === 'live' ? session.runtime.generation : null;
const matchesGeneration = (sessions: readonly OwnedSession[], id: string, generation: number) =>
  liveGeneration(sessions.find((session) => session.id === id)) === generation;

export function usePermissionRefusals(
  sessions: readonly OwnedSession[],
  openActivity: (scope: { sessionId: string; item: ActivityStamp }) => void,
) {
  const [refusals, setRefusals] = useState<ReadonlyMap<string, SessionRefusal>>(() => new Map());
  const sessionRef = useRef(sessions);
  sessionRef.current = sessions;
  const toast = useRef<{ id: string; at: number; sessionId: string; generation: number } | null>(
    null,
  );
  const openRefusal = useCallback(
    (sessionId: string, item: ActivityStamp) => {
      if (!sessionRef.current.some((session) => session.id === sessionId)) return;
      setRefusals((current) => {
        const latest = current.get(sessionId)?.latest;
        if (latest?.id !== item.id || latest.at !== item.at) return current;
        const next = new Map(current);
        next.delete(sessionId);
        return next;
      });
      openActivity({ sessionId, item });
    },
    [openActivity],
  );

  useEffect(() => {
    setRefusals((current) => {
      if (!current.size) return current;
      const next = [...current].filter(([id, row]) =>
        matchesGeneration(sessions, id, row.generation),
      );
      return next.length === current.size ? current : new Map(next);
    });
    const currentToast = toast.current;
    if (
      currentToast &&
      !matchesGeneration(sessions, currentToast.sessionId, currentToast.generation)
    ) {
      dismissToast(currentToast.id);
      toast.current = null;
    }
  }, [sessions]);

  useEffect(() => {
    const unsubscribe = subscribe((message) => {
      if (message.type !== 'mcp:activityRecorded' || message.outcome !== 'denied') return;
      const session = sessionRef.current.find((item) => item.id === message.sessionId);
      if (!session || liveGeneration(session) !== message.generation) return;
      const item = { id: message.id, at: message.at };
      setRefusals((current) => {
        const old = current.get(session.id);
        const previous = old?.generation === message.generation ? old : undefined;
        if (previous?.latest.id === item.id && previous.latest.at === item.at) return current;
        return new Map(current).set(session.id, {
          count: Math.min((previous?.count ?? 0) + 1, 999),
          latest: item,
          generation: message.generation,
        });
      });
      const now = performance.now();
      if (toast.current && now - toast.current.at < 1000) return;
      if (toast.current) dismissToast(toast.current.id);
      toast.current = {
        id: pushToast({
          message: `Conduit refused ${message.tool} for ${session.name}.`,
          variant: 'error',
          action: {
            label: 'Why?',
            run: () => {
              if (matchesGeneration(sessionRef.current, session.id, message.generation))
                openRefusal(session.id, item);
            },
          },
        }),
        at: now,
        sessionId: session.id,
        generation: message.generation,
      };
    });
    return () => {
      unsubscribe();
      if (toast.current) dismissToast(toast.current.id);
      toast.current = null;
    };
  }, [openRefusal]);

  return {
    refusalsBySession: useMemo(
      () =>
        Object.fromEntries(
          [...refusals].filter(([id, row]) => matchesGeneration(sessions, id, row.generation)),
        ),
      [refusals, sessions],
    ),
    openRefusal,
  };
}
