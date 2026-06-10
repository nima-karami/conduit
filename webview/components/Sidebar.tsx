import { useState } from 'react';
import type { AgentDefinition, Session } from '../../src/types';
import type { ProjectGroupDTO } from '../../src/protocol';
import { VMCustomization } from '../viewModel';
import { IconPlus, IconSearch, IconChevron, IconSettings, customIcon } from '../icons';

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
}: {
  session: Session;
  agentLabel: string;
  active: boolean;
  onSelect: () => void;
  onKill: () => void;
  onRename: (name: string) => void;
  onRelaunch: () => void;
  onContextMenu?: (e: React.MouseEvent) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(session.name);
  const commit = () => {
    if (draft.trim() && draft.trim() !== session.name) onRename(draft.trim());
    setEditing(false);
  };

  return (
    <div
      className={`session ${active ? 'session--active' : ''}`}
      onClick={() => !editing && onSelect()}
      onContextMenu={onContextMenu}
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
              else if (e.key === 'Escape') setEditing(false);
            }}
          />
        ) : (
          <span className="session__name" onDoubleClick={(e) => { e.stopPropagation(); setDraft(session.name); setEditing(true); }}>
            {session.name}
          </span>
        )}
        <span className="session__meta">
          <span className="session__agent">{agentLabel}</span>
          <span className="session__dotsep">·</span>
          <span className="session__time">{relativeTime(session.createdAt)}</span>
          {session.status === 'stale' && (
            <button
              className="session__relaunch"
              title="Relaunch"
              onClick={(e) => { e.stopPropagation(); onRelaunch(); }}
            >
              ↻
            </button>
          )}
        </span>
      </span>
      <button className="session__kill" title="Close session" onClick={(e) => { e.stopPropagation(); onKill(); }}>
        ✕
      </button>
    </div>
  );
}

export function Sidebar({
  groups,
  agents,
  customizations,
  activeId,
  onSelect,
  onNew,
  onKill,
  onRename,
  onRelaunch,
  onOpenSettings,
  onOpenSearch,
  onContextMenu,
}: {
  groups: ProjectGroupDTO[];
  agents: AgentDefinition[];
  customizations: VMCustomization[];
  activeId: string | undefined;
  onSelect: (id: string) => void;
  onNew: () => void;
  onKill: (id: string) => void;
  onRename: (id: string, name: string) => void;
  onRelaunch: (id: string) => void;
  onOpenSettings: () => void;
  onOpenSearch: () => void;
  onContextMenu?: (e: React.MouseEvent, session: Session) => void;
}) {
  const [custOpen, setCustOpen] = useState(true);
  const labelFor = (agentId: string) => agents.find((a) => a.id === agentId)?.label ?? agentId;

  return (
    <aside className="sidebar">
      <div className="sidebar__head">
        <span className="sidebar__title">Sessions</span>
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
              />
            ))}
          </div>
        ))}
      </div>

      <div className="cust">
        <button className="cust__head" onClick={() => setCustOpen((v) => !v)}>
          <span>Customizations</span>
          <IconChevron size={14} className={`cust__chev ${custOpen ? 'cust__chev--open' : ''}`} />
        </button>
        {custOpen && (
          <div className="cust__list">
            {customizations.map((c) => {
              const Ico = customIcon[c.icon];
              return (
                <div className="cust__item cust__item--static" key={c.id}>
                  <Ico size={15} className="cust__icon" />
                  <span className="cust__label">{c.label}</span>
                  {typeof c.count === 'number' && <span className="cust__count">{c.count}</span>}
                </div>
              );
            })}
          </div>
        )}
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
