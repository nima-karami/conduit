import { attentionSessions } from './attention';
import type { RuntimeHealth } from './contracts/server-protocol';
import type { TrayCounts } from './contracts/tray-protocol';
import { runningSessions } from './quit-guard';
import type { SessionStateFields } from './session-icon';

// See docs/specs/2026-11-03-tray-helper.md §5 and §8 (L7).
export function trayCounts(
  sessions: readonly SessionStateFields[],
  health: RuntimeHealth['state'],
  stopping: TrayCounts['stopping'],
): TrayCounts {
  const running = runningSessions(sessions);
  return { running: running.length, needsYou: attentionSessions(running).length, health, stopping };
}
