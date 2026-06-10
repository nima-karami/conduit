import { useEffect, useRef, useState } from 'react';
import type { AgentDefinition, Session } from '../../src/types';
import type { ProjectGroupDTO } from '../../src/protocol';
import { useSettings } from '../settings';
import { moveBefore } from '../../src/reorder';
import { IconPlus, IconSearch, IconSettings } from '../icons';

export interface CardFields {
  agent: boolean;
  time: boolean;
  statusText: boolean;
  path: boolean;
  worktree: boolean;
}

const STATUS_TEXT: Record<Session['status'], string> = {
  running: 'running', stale: 'idle', exited: 'exited',
};

function relativeTime(ts: number): string {
  const s = Math.max(1, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min${m === 1 ? '' : 's'} ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} hr${h === 1 ? '' : 's'} ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function statusClass(s: Session['status']): string {
  return s === 'running' ? 'active' : s === 'exited' ? 'done' : 'idle';
}

function SessionItem({
  session,
  agentLabel,
  active,
  onSelect,
  onKill,
  onRename,
  onRelaunch,
  onContextMenu,
  editing,
  onEditStart,
  onEditEnd,
  fields,
  drag,
  dropTarget,
}: {
  session: Session;
  agentLabel: string;
  active: boolean;
  onSelect: () => void;
  onKill: () => void;
  onRename: (name: string) => void;
  onRelaunch: () => void;
  onContextMenu?: (e: React.MouseEvent) => void;
  editing: boolean;
  onEditStart: () => void;
  onEditEnd: () => void;
  fields: CardFields;
  drag?: {
    onDragStart: (e: React.DragEvent) => void;
    onDragOver: (e: React.DragEvent) => void;
    onDrop: (e: React.DragEvent) => void;
    onDragEnd: (e: React.DragEvent) => void;
  };
  dropTarget?: boolean;
}) {
  const [draft, setDraft] = useState(session.name);
  useEffect(() => { if (editing) setDraft(session.name); }, [editing, session.name]);
  const commit = () => {
    if (draft.trim() && draft.trim() !== session.name) onRename(draft.trim());
    onEditEnd();
  };

  const folder = session.projectPath.split(/[\\/]/).filter(Boolean).pop();
  const meta: string[] = [];
  if (fields.agent) meta.push(agentLabel);
  if (fields.time) meta.push(relativeTime(session.createdAt));
  if (fields.statusText) meta.push(STATUS_TEXT[session.status]);
  if (fields.worktree && session.worktree) meta.push(session.worktree);

  return (
    <div
      className={`session ${active ? 'session--active' : ''} ${dropTarget ? 'session--dropbefore' : ''}`}
      onClick={() => !editing && onSelect()}
      onContextMenu={onContextMenu}
      draggable={!!drag && !editing}
      onDragStart={drag?.onDragStart}
      onDragOver={drag?.onDragOver}
      onDrop={drag?.onDrop}
      onDragEnd={drag?.onDragEnd}
    >
      <span className={`dot dot--${statusClass(session.status)}`} />
      <span className="session__body">
        {editing ? (
          <input
            className="session__edit"
            autoFocus
            value={draft}
            onClick={(e) => e.stopPropagation()}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commit();
              else if (e.key === 'Escape') onEditEnd();
            }}
          />
        ) : (
          <span className="session__name" onDoubleClick={(e) => { e.stopPropagation(); onEditStart(); }}>
            {session.name}
          </span>
        )}
        {meta.length > 0 && (
          <span className="session__meta">
            {meta.map((m, i) => (
              <span key={i}>
                {i > 0 && <span className="session__dotsep">·</span>}
                <span className="session__metaitem">{m}</span>
              </span>
            ))}
          </span>
        )}
        {fields.path && (
          <span className="session__path" title={session.projectPath}>{folder}</span>
        )}
      </span>
      {session.status === 'stale' && (
        <button className="session__relaunch" title="Relaunch" onClick={(e) => { e.stopPropagation(); onRelaunch(); }}>↻</button>
      )}
      <button className="session__kill" title="Close session" onClick={(e) => { e.stopPropagation(); onKill(); }}>
        ✕
      </button>
    </div>
  );
}

export function Sidebar({
  groups,
  agents,
  activeId,
  onSelect,
  onNew,
  onKill,
  onRename,
  onRelaunch,
  onOpenSettings,
  onOpenSearch,
  onContextMenu,
  renamingId,
  onSetRenaming,
  onReorderSessions,
}: {
  groups: ProjectGroupDTO[];
  agents: AgentDefinition[];
  activeId: string | undefined;
  onSelect: (id: string) => void;
  onNew: () => void;
  onKill: (id: string) => void;
  onRename: (id: string, name: string) => void;
  onRelaunch: (id: string) => void;
  onOpenSettings: () => void;
  onOpenSearch: () => void;
  onContextMenu?: (e: React.MouseEvent, session: Session) => void;
  renamingId?: string;
  onSetRenaming: (id: string | null) => void;
  onReorderSessions: (order: string[]) => void;
}) {
  const { settings } = useSettings();
  // Drag-to-reorder sessions (constrained to within a project group). The drag id
  // + group live in refs so the logic is independent of React re-render timing;
  // overId is state purely for the drop indicator.
  const dragIdRef = useRef<string | null>(null);
  const dragGroup = useRef<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);
  const allIds = () => groups.flatMap((g) => g.sessions.map((s) => s.id));
  const reset = () => { dragIdRef.current = null; dragGroup.current = null; setOverId(null); };
  const sessionDrag = (s: Session, groupPath: string) => ({
    onDragStart: (e: React.DragEvent) => { dragIdRef.current = s.id; dragGroup.current = groupPath; e.dataTransfer.effectAllowed = 'move'; },
    onDragOver: (e: React.DragEvent) => {
      const d = dragIdRef.current;
      if (d && d !== s.id && dragGroup.current === groupPath) { e.preventDefault(); setOverId(s.id); }
    },
    onDrop: (e: React.DragEvent) => {
      e.preventDefault();
      const d = dragIdRef.current;
      if (d && dragGroup.current === groupPath && d !== s.id) {
        onReorderSessions(moveBefore(allIds(), d, s.id));
      }
      reset();
    },
    onDragEnd: reset,
  });
  const fields: CardFields = {
    agent: settings.cardAgent,
    time: settings.cardTime,
    statusText: settings.cardStatusText,
    path: settings.cardPath,
    worktree: settings.cardWorktree,
  };
  const labelFor = (agentId: string) => agents.find((a) => a.id === agentId)?.label ?? agentId;

  return (
    <aside className="sidebar">
      <div className="sidebar__head sidebar__head--actions">
        <div className="sidebar__head-actions">
          <button className="newbtn" onClick={onNew}>
            <IconPlus size={13} /> New
          </button>
          <button className="iconbtn iconbtn--sm" title="Search (Ctrl+P)" onClick={onOpenSearch}><IconSearch size={14} /></button>
        </div>
      </div>

      <div className="sidebar__scroll">
        {groups.length === 0 && <p className="sidebar__empty">No sessions yet. Hit <strong>New</strong>.</p>}
        {groups.map((g) => (
          <div className="proj" key={g.projectPath}>
            <div className="proj__label" title={g.projectPath}>
              {g.projectPath.split(/[\\/]/).filter(Boolean).pop()}
            </div>
            {g.sessions.map((s) => (
              <SessionItem
                key={s.id}
                session={s}
                agentLabel={labelFor(s.agentId)}
                active={s.id === activeId}
                onSelect={() => onSelect(s.id)}
                onKill={() => onKill(s.id)}
                onRename={(name) => onRename(s.id, name)}
                onRelaunch={() => onRelaunch(s.id)}
                onContextMenu={onContextMenu ? (e) => onContextMenu(e, s) : undefined}
                editing={renamingId === s.id}
                onEditStart={() => onSetRenaming(s.id)}
                onEditEnd={() => onSetRenaming(null)}
                fields={fields}
                drag={sessionDrag(s, g.projectPath)}
                dropTarget={overId === s.id}
              />
            ))}
          </div>
        ))}
      </div>

      <div className="sidebar__foot">
        <button className="footbtn" onClick={onOpenSettings} title="Settings (Ctrl+,)">
          <IconSettings size={15} />
          <span>Settings</span>
        </button>
      </div>
    </aside>
  );
}
