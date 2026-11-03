import { useEffect, useMemo, useRef, useState } from 'react';
import type { AgentRuntime } from '../src/sidebar-state';
import { advanceAgentRuntime } from '../src/sidebar-state';
import type { Session } from '../src/types';

export function useAgentRuntime(input: {
  sessionsLoaded: boolean;
  sessions: readonly Session[];
  askSessionIds: ReadonlySet<string>;
  viewedTerminalIds: ReadonlySet<string>;
}): AgentRuntime {
  const [runtime, setRuntime] = useState<AgentRuntime>({ seen: {}, stateSince: {} });
  const stepRef = useRef<{
    previous: AgentRuntime | null;
    before: readonly Session[];
    asks: ReadonlySet<string>;
  }>({ previous: null, before: [], asks: new Set() });

  const next = useMemo(() => {
    if (!input.sessionsLoaded) return runtime;
    const step = stepRef.current;
    return advanceAgentRuntime({
      previous: step.previous,
      before: step.before,
      sessions: input.sessions,
      previousAskSessionIds: step.asks,
      askSessionIds: input.askSessionIds,
      viewedTerminalIds: input.viewedTerminalIds,
      now: Date.now(),
    });
  }, [input.sessionsLoaded, input.sessions, input.askSessionIds, input.viewedTerminalIds, runtime]);

  useEffect(() => {
    if (!input.sessionsLoaded) return;
    stepRef.current = { previous: next, before: input.sessions, asks: input.askSessionIds };
    setRuntime(next);
  }, [input.sessionsLoaded, input.sessions, input.askSessionIds, next]);

  return next;
}
