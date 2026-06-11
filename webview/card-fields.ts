import type { CardField } from '../src/settings';
import type { Session } from '../src/types';
import { relativeTime } from './relative-time';

export const CARD_FIELD_LABELS: { id: CardField; label: string }[] = [
  { id: 'name', label: 'Session name' },
  { id: 'agent', label: 'Agent' },
  { id: 'folder', label: 'Folder' },
  { id: 'path', label: 'Full path' },
  { id: 'worktree', label: 'Worktree' },
  { id: 'time', label: 'Created time' },
  { id: 'active', label: 'Last active' },
  { id: 'status', label: 'Status' },
  { id: 'none', label: '(none)' },
];

const STATUS_TEXT: Record<Session['status'], string> = {
  running: 'running',
  stale: 'idle',
  exited: 'exited',
};

const basename = (p: string) => p.split(/[\\/]/).filter(Boolean).pop() || p;

/** Resolve a card field to its display string for a session ('' = nothing to show). */
export function fieldValue(session: Session, agentLabel: string, field: CardField): string {
  switch (field) {
    case 'name':
      return session.name;
    case 'agent':
      return agentLabel;
    case 'folder':
      return basename(session.projectPath);
    case 'path':
      return session.projectPath;
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
