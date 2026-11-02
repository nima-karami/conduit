import type { Session } from '../src/types';
import { CANT_START_TITLE, MISSING_HOME_TITLE, notFoundSegments } from './agent-scope-copy';

type RowField = 'agent' | 'path' | 'worktree';

/** The facts the row tooltip still shows from the old card fields ('' = nothing to show). */
export function fieldValue(session: Session, agentLabel: string, field: RowField): string {
  switch (field) {
    case 'agent':
      return agentLabel;
    case 'path':
      return session.cwd ?? session.home;
    case 'worktree':
      return session.worktree ?? '';
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
