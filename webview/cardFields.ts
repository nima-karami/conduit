import type { Session } from '../src/types';
import type { CardField } from '../src/settings';

export const CARD_FIELD_LABELS: { id: CardField; label: string }[] = [
  { id: 'name', label: 'Session name' },
  { id: 'agent', label: 'Agent' },
  { id: 'folder', label: 'Folder' },
  { id: 'path', label: 'Full path' },
  { id: 'worktree', label: 'Worktree' },
  { id: 'time', label: 'Created time' },
  { id: 'status', label: 'Status' },
  { id: 'none', label: '(none)' },
];

const STATUS_TEXT: Record<Session['status'], string> = {
  running: 'running', stale: 'idle', exited: 'exited',
};

export function relativeTime(ts: number): string {
  const s = Math.max(1, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min${m === 1 ? '' : 's'} ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} hr${h === 1 ? '' : 's'} ago`;
  return `${Math.floor(h / 24)}d ago`;
}

const basename = (p: string) => p.split(/[\\/]/).filter(Boolean).pop() || p;

/** Resolve a card field to its display string for a session ('' = nothing to show). */
export function fieldValue(session: Session, agentLabel: string, field: CardField): string {
  switch (field) {
    case 'name': return session.name;
    case 'agent': return agentLabel;
    case 'folder': return basename(session.projectPath);
    case 'path': return session.projectPath;
    case 'worktree': return session.worktree ?? '';
    case 'time': return relativeTime(session.createdAt);
    case 'status': return STATUS_TEXT[session.status];
    case 'none': return '';
  }
}
