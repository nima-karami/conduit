import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { moveBefore } from '../../src/reorder';
import type { CardField, SessionSort } from '../../src/settings';
import type { AgentDefinition, Session } from '../../src/types';
import { fieldValue } from '../card-fields';
import { IconCheck, IconMore, IconPlus, IconSearch, IconSettings } from '../icons';
import { useSettings } from '../settings';
import { buildSortFilterMenuItems } from '../sort-filter-menu';
import { ContextMenu, type MenuState } from './context-menu';

interface CardRoles {
  title: CardField;
  subtitle: CardField;
  detail: CardField;
}

const baseName = (p: string) => p.split(/[\\/]/).filter(Boolean).pop() || p;

const STATUS_RANK: Record<Session['status'], number> = { running: 0, stale: 1, exited: 2 };

/** Apply a sort to a session list. 'manual' keeps the incoming (global) order. */
function sortSessions(list: Session[], sort: SessionSort): Session[] {
  if (sort === 'manual') return list;
  const arr = [...list];
  switch (sort) {
    case 'name':
      arr.sort((a, b) => a.name.localeCompare(b.name));
      break;
    case 'recent':
      arr.sort((a, b) => b.createdAt - a.createdAt);
      break;
    case 'active':
      arr.sort(
        (a, b) => (b.lastActiveAt ?? 0) - (a.lastActiveAt ?? 0) || a.name.localeCompare(b.name),
      );
      break;
    case 'status':
      arr.sort(
        (a, b) => STATUS_RANK[a.status] - STATUS_RANK[b.status] || a.name.localeCompare(b.name),
      );
      break;
    case 'project':
      arr.sort(
        (a, b) =>
          baseName(a.projectPath).localeCompare(baseName(b.projectPath)) ||
          a.name.localeCompare(b.name),
      );
      break;
  }
  return arr;
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
  roles,
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
  roles: CardRoles;
  drag?: {
    onDragStart: (e: React.DragEvent) => void;
    onDragOver: (e: React.DragEvent) => void;
    onDrop: (e: React.DragEvent) => void;
    onDragEnd: (e: React.DragEvent) => void;
  };
  dropTarget?: boolean;
}) {
  const [draft, setDraft] = useState(session.name);
  useEffect(() => {
    if (editing) setDraft(session.name);
  }, [editing, session.name]);
  const commit = () => {
    if (draft.trim() && draft.trim() !== session.name) onRename(draft.trim());
    onEditEnd();
  };

  const titleText = fieldValue(session, agentLabel, roles.title) || session.name;
  const subtitle = roles.subtitle !== 'none' ? fieldValue(session, agentLabel, roles.subtitle) : '';
  const detail = roles.detail !== 'none' ? fieldValue(session, agentLabel, roles.detail) : '';

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
          <span
            className="session__name"
            onDoubleClick={(e) => {
              e.stopPropagation();
              onEditStart();
            }}
          >
            {titleText}
          </span>
        )}
        {subtitle && (
          <span className="session__meta">
            <span className="session__metaitem">{subtitle}</span>
          </span>
        )}
        {detail && (
          <span className="session__path" title={session.projectPath}>
            {detail}
          </span>
        )}
      </span>
      {session.status === 'stale' && (
        <button
          className="session__relaunch"
          title="Relaunch"
          onClick={(e) => {
            e.stopPropagation();
            onRelaunch();
          }}
        >
          ↻
        </button>
      )}
      <button
        className="session__kill"
        title="Close session"
        onClick={(e) => {
          e.stopPropagation();
          onKill();
        }}
      >
        ✕
      </button>
    </div>
  );
}

export function Sidebar({
  sessions,
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
  sessions: Session[]; // flat list in the global (manual) order
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
  const { settings, update } = useSettings();
  const sort = settings.sessionSort;
  const grouped = settings.sessionGroupByProject;
  const [filter, setFilter] = useState('');
  const [menu, setMenu] = useState<MenuState | null>(null);

  // Three-dot overflow → shared ContextMenu anchored below/right of the button.
  // Sort options are radio-like (active one checked); the group toggle is checked
  // when grouping is on. Selecting an item applies it and closes the menu.
  const openSortFilterMenu = (e: React.MouseEvent<HTMLButtonElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const items = buildSortFilterMenuItems({ sort, groupByProject: grouped }).map((it) => ({
      label: it.label,
      icon: it.checked ? <IconCheck size={13} /> : undefined,
      disabled: it.header,
      separatorBefore: it.separatorBefore,
      onClick: () => {
        if (!it.action) return;
        if (it.action.kind === 'sort') update({ sessionSort: it.action.sort });
        else update({ sessionGroupByProject: !grouped });
      },
    }));
    // Open below the button, right-aligned to its right edge so the menu falls
    // back over the (narrow) sessions panel rather than spilling into the editor.
    // MENU_W is a comfortable upper bound; the shared menu clamps to the viewport.
    const MENU_W = 200;
    setMenu({ x: Math.max(8, r.right - MENU_W), y: r.bottom + 4, items });
  };

  const labelFor = useCallback(
    (agentId: string) => agents.find((a) => a.id === agentId)?.label ?? agentId,
    [agents],
  );

  // Reorder lives on the global manual order; only meaningful in manual sort with
  // no active filter (otherwise positions are derived, not user-owned).
  const canDrag = sort === 'manual' && filter.trim() === '';
  const dragIdRef = useRef<string | null>(null);
  const dragGroup = useRef<string | null>(null); // grouped mode constrains within a project
  const [overId, setOverId] = useState<string | null>(null);
  const allIds = () => sessions.map((s) => s.id);
  const reset = () => {
    dragIdRef.current = null;
    dragGroup.current = null;
    setOverId(null);
  };
  const sessionDrag = (s: Session, groupPath: string | null) => ({
    onDragStart: (e: React.DragEvent) => {
      dragIdRef.current = s.id;
      dragGroup.current = groupPath;
      e.dataTransfer.effectAllowed = 'move';
    },
    onDragOver: (e: React.DragEvent) => {
      const d = dragIdRef.current;
      if (d && d !== s.id && dragGroup.current === groupPath) {
        e.preventDefault();
        setOverId(s.id);
      }
    },
    onDrop: (e: React.DragEvent) => {
      e.preventDefault();
      const d = dragIdRef.current;
      if (d && d !== s.id && dragGroup.current === groupPath)
        onReorderSessions(moveBefore(allIds(), d, s.id));
      reset();
    },
    onDragEnd: reset,
  });

  const roles: CardRoles = {
    title: settings.cardTitle,
    subtitle: settings.cardSubtitle,
    detail: settings.cardDetail,
  };

  // Filter (name / project / agent), then sort, then optionally group by project.
  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return sessions;
    return sessions.filter(
      (s) =>
        s.name.toLowerCase().includes(q) ||
        baseName(s.projectPath).toLowerCase().includes(q) ||
        labelFor(s.agentId).toLowerCase().includes(q),
    );
  }, [sessions, filter, labelFor]);

  const sorted = useMemo(() => sortSessions(filtered, sort), [filtered, sort]);

  // Build the render groups: one synthetic group (no header) when ungrouped, or
  // one per project (ordered by first appearance for manual, else by name).
  const renderGroups = useMemo<{ path: string | null; sessions: Session[] }[]>(() => {
    if (!grouped) return [{ path: null, sessions: sorted }];
    const map = new Map<string, Session[]>();
    for (const s of sorted) {
      const arr = map.get(s.projectPath) ?? [];
      arr.push(s);
      map.set(s.projectPath, arr);
    }
    const paths = [...map.keys()];
    if (sort !== 'manual') paths.sort((a, b) => baseName(a).localeCompare(baseName(b)));
    return paths.map((path) => ({ path, sessions: map.get(path) ?? [] }));
  }, [sorted, grouped, sort]);

  const renderItem = (s: Session, groupPath: string | null) => (
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
      roles={roles}
      drag={canDrag ? sessionDrag(s, grouped ? groupPath : null) : undefined}
      dropTarget={overId === s.id}
    />
  );

  return (
    <aside className="sidebar">
      <div className="sidebar__head sidebar__head--actions">
        <div className="sidebar__head-actions">
          <button className="newbtn" onClick={onNew}>
            <IconPlus size={13} /> New
          </button>
          <button className="iconbtn iconbtn--sm" title="Search (Ctrl+P)" onClick={onOpenSearch}>
            <IconSearch size={14} />
          </button>
        </div>
      </div>

      <div className="sessbar">
        <input
          className="sessbar__filter"
          placeholder="Filter sessions…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        {filter && (
          <button className="sessbar__clear" title="Clear filter" onClick={() => setFilter('')}>
            ✕
          </button>
        )}
        <button
          className="iconbtn iconbtn--sm"
          title="Sort & filter sessions"
          aria-label="Sort & filter sessions"
          aria-haspopup="menu"
          onClick={openSortFilterMenu}
        >
          <IconMore size={16} />
        </button>
      </div>

      <div className="sidebar__scroll">
        {sessions.length === 0 && (
          <p className="sidebar__empty">
            No sessions yet. Hit <strong>New</strong>.
          </p>
        )}
        {sessions.length > 0 && sorted.length === 0 && (
          <p className="sidebar__empty">No sessions match “{filter}”.</p>
        )}
        {renderGroups.map((g) =>
          g.path === null ? (
            <div className="proj proj--flat" key="__flat">
              {g.sessions.map((s) => renderItem(s, null))}
            </div>
          ) : (
            <div className="proj" key={g.path}>
              <div className="proj__label" title={g.path}>
                {baseName(g.path)}
              </div>
              {g.sessions.map((s) => renderItem(s, g.path))}
            </div>
          ),
        )}
      </div>

      <div className="sidebar__foot">
        <button className="footbtn" onClick={onOpenSettings} title="Settings (Ctrl+,)">
          <IconSettings size={15} />
          <span>Settings</span>
        </button>
      </div>

      {menu && <ContextMenu menu={menu} onClose={() => setMenu(null)} />}
    </aside>
  );
}
