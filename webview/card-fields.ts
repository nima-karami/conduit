import type { CardField } from '../src/settings';
import type { Session } from '../src/types';
import { CANT_START_TITLE, MISSING_HOME_TITLE, notFoundSegments } from './agent-scope-copy';
import { relativeTime } from './relative-time';

const STATUS_TEXT: Record<Session['status'], string> = {
  running: 'running',
  stale: 'idle',
  exited: 'exited',
};

const basename = (p: string) => p.split(/[/]/).filter(Boolean).pop() || p;

/** Resolve a session field to its display string ('' = nothing to show). */
export function fieldValue(session: Session, agentLabel: string, field: CardField): string {
  switch (field) {
    case 'name':
      return session.name;
    case 'live':
      return session.lastLine ?? '';
    case 'agent':
      return agentLabel;
    case 'folder':
      return basename(session.cwd ?? session.home);
    case 'path':
      return session.cwd ?? session.home;
    case 'worktree':
      return session.worktree ?? '';
    case 'time':
      return relativeTime(session.createdAt);
    case 'active':
      return typeof session.lastActiveAt === 'number' ? relativeTime(session.lastActiveAt) : '';
    case 'status':
      return STATUS_TEXT[session.status];
    case 'none':
      return '';
  }
}

/** Why a stopped session will not start, for the row's tooltip (spec §6 relocation table). */
export function cantStartReason(session: Session): string {
  if (session.homeMissing) return `${CANT_START_TITLE}: ${MISSING_HOME_TITLE}`;
  if (session.startRefusal)
    return `${CANT_START_TITLE}: ${notFoundSegments(session.startRefusal.command)
      .map((s) => s.text)
      .join('')}`;
  return '';
}

/**
 * The agent row's tooltip. The old card's subtitle and detail fields went away; their facts
 * (agent, folder, worktree) stay reachable here, one per line (spec §6).
 */
export function agentRowTooltip(o: {
  session: Session;
  agentLabel: string;
  state: string;
  space?: string;
  extra?: readonly (string | undefined)[];
}): string {
  const { session } = o;
  const worktree = fieldValue(session, o.agentLabel, 'worktree');
  return [
    session.name,
    [o.state, o.space].filter(Boolean).join(' · '),
    fieldValue(session, o.agentLabel, 'agent'),
    fieldValue(session, o.agentLabel, 'path'),
    worktree ? `worktree ${worktree}` : '',
    cantStartReason(session),
    ...(o.extra ?? []),
  ]
    .filter(Boolean)
    .join('\n');
}
