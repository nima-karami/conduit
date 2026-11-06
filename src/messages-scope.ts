import { type Handle, HUMAN_HANDLE } from './conduit-mcp/types';
import type { McpThreadSummary } from './conduit-mcp/ui-types';
import type { SpaceSelection } from './sidebar-state';
import type { Session } from './types';

/** Messages in the sidebar's current Space context (docs/specs/archive/2026-11-02-sidebar-agent-tree.md §7). */
export function scopeMessageThreads(input: {
  threads: readonly McpThreadSummary[];
  sessions: readonly Pick<Session, 'id' | 'projectId'>[];
  handlesBySession: Readonly<Record<string, Handle>>;
  selection: SpaceSelection;
}): McpThreadSummary[] {
  const { threads, sessions, handlesBySession, selection } = input;
  if (selection.kind === 'all') return [...threads];
  const projectByHandle = projectMap(sessions, handlesBySession);
  return threads.filter((thread) =>
    hasParticipantInScope(thread.participants, projectByHandle, selection),
  );
}

function projectMap(
  sessions: readonly Pick<Session, 'id' | 'projectId'>[],
  handlesBySession: Readonly<Record<string, Handle>>,
): Map<Handle, string | null> {
  const projectByHandle = new Map<Handle, string | null>();
  for (const session of sessions) {
    const handle = handlesBySession[session.id];
    if (handle && handle !== HUMAN_HANDLE) projectByHandle.set(handle, session.projectId ?? null);
  }
  return projectByHandle;
}

function hasParticipantInScope(
  participants: readonly Handle[],
  projectByHandle: ReadonlyMap<Handle, string | null>,
  selection: Exclude<SpaceSelection, { kind: 'all' }>,
): boolean {
  return participants.some((handle) => {
    if (handle === HUMAN_HANDLE) return false;
    const projectId = projectByHandle.get(handle);
    return selection.kind === 'none' ? projectId === null : projectId === selection.projectId;
  });
}

export function messageHasParticipantInScope(
  participants: readonly Handle[],
  sessions: readonly Pick<Session, 'id' | 'projectId'>[],
  handlesBySession: Readonly<Record<string, Handle>>,
  selection: Exclude<SpaceSelection, { kind: 'all' }>,
): boolean {
  return hasParticipantInScope(participants, projectMap(sessions, handlesBySession), selection);
}

export function unreadMessagesOutsideScope(input: {
  unreadByThread: readonly { participants: readonly Handle[]; count: number }[];
  sessions: readonly Pick<Session, 'id' | 'projectId'>[];
  handlesBySession: Readonly<Record<string, Handle>>;
  selection: SpaceSelection;
  filterHandle?: Handle | null;
}): number {
  if (input.selection.kind === 'all' && !input.filterHandle) return 0;
  const projectByHandle = projectMap(input.sessions, input.handlesBySession);
  return input.unreadByThread.reduce((count, thread) => {
    const inSpace =
      input.selection.kind === 'all' ||
      hasParticipantInScope(thread.participants, projectByHandle, input.selection);
    const inAgent = !input.filterHandle || thread.participants.includes(input.filterHandle);
    return inSpace && inAgent ? count : count + thread.count;
  }, 0);
}
