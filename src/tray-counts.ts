import { attentionSessions } from './attention';
import type { RequestView } from './conduit-mcp/request-types';
import type { RuntimeHealth } from './contracts/server-protocol';
import type { TrayCounts } from './contracts/tray-protocol';
import { runningSessions } from './quit-guard';
import type { SessionStateFields } from './session-icon';

export interface TrayNeeds {
  openRequests: readonly Pick<RequestView, 'session'>[];
  waitingAsks: number;
}

// See docs/specs/archive/2026-11-03-tray-helper.md §5 and §8 (L7).
export function trayCounts<T extends SessionStateFields & { id: string }>(
  sessions: readonly T[],
  health: RuntimeHealth['state'],
  stopping: TrayCounts['stopping'],
  needs: TrayNeeds,
): TrayCounts {
  const running = runningSessions(sessions);
  // A session with an open request is already counted by it: an agent that asked and went idle
  // would otherwise read as two things needing you.
  const attention = attentionSessions(running).filter(
    (s) => !needs.openRequests.some((r) => r.session === s.id),
  );
  const needsYou = needs.openRequests.length + needs.waitingAsks + attention.length;
  return { running: running.length, needsYou, health, stopping };
}
