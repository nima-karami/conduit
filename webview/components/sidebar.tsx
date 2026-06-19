import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { anchorMenuToRect } from '../../src/menu-position';
import { menuToggleIntent } from '../../src/menu-toggle';
import {
  dropResolvesToManual,
  moveBefore,
  reorderByGroup,
  sortedCanonical,
  toggleCollapsed,
} from '../../src/reorder';
import { sessionRowClass } from '../../src/session-dot';
import {
  type ResolvedSessionIcon,
  resolveSessionIcon,
  sessionIconState,
} from '../../src/session-icon';
import type { CardField, SessionSort } from '../../src/settings';
import type { AgentDefinition, Session } from '../../src/types';
import { fieldValue } from '../card-fields';
import {
  IconCheck,
  IconMore,
  IconPlus,
  IconSearch,
  IconSettings,
  IconTrash,
  SessionGlyph,
} from '../icons';
import { type MoveGrip, panelMoveDragProps } from '../panel-move-grip';
import { useSettings } from '../settings';
import { buildSortFilterMenuItems } from '../sort-filter-menu';
import { ContextMenu, type MenuItem, type MenuState } from './context-menu';
import { EmptyState } from './empty-state';
import { UpdateCard, type UpdateStatus } from './update-card';

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

function SessionItem({
  session,
  agentLabel,
  resolvedIcon,
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
  resolvedIcon: ResolvedSessionIcon;
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
      className={sessionRowClass({
        selected: active,
        needsAttention: !!session.needsAttention,
        dropTarget: !!dropTarget,
      })}
      onClick={() => !editing && onSelect()}
      onContextMenu={onContextMenu}
      draggable={!!drag && !editing}
      onDragStart={drag?.onDragStart}
      onDragOver={drag?.onDragOver}
      onDrop={drag?.onDrop}
      onDragEnd={drag?.onDragEnd}
    >
      {/* D4: status is expressed on the icon itself — no separate dot element. */}
      <SessionGlyph icon={resolvedIcon} size={17} visualState={sessionIconState(session)} />
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
          <span className="session__path" title={session.cwd ?? session.projectPath}>
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
      {!editing && (
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
      )}
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
  onCloseAll,
  onRename,
  onRelaunch,
  onOpenSettings,
  onContextMenu,
  renamingId,
  onSetRenaming,
  onReorderSessions,
  updateStatus,
  updateDismissed,
  onUpdateDismiss,
  moveGrip,
}: {
  sessions: Session[]; // flat list in the global (manual) order
  agents: AgentDefinition[];
  activeId: string | undefined;
  onSelect: (id: string) => void;
  onNew: () => void;
  onKill: (id: string) => void;
  onCloseAll: () => void;
  onRename: (id: string, name: string) => void;
  onRelaunch: (id: string) => void;
  onOpenSettings: () => void;
  onContextMenu?: (e: React.MouseEvent, session: Session) => void;
  renamingId?: string;
  onSetRenaming: (id: string | null) => void;
  onReorderSessions: (order: string[]) => void;
  updateStatus?: UpdateStatus | null;
  updateDismissed?: boolean;
  onUpdateDismiss?: () => void;
  // When the panel is rendered barless (PanelFrame draws no top drag-bar), the header
  // band doubles as the panel-move drag surface (see panelMoveDragProps).
  moveGrip?: MoveGrip;
}) {
  const { settings, update } = useSettings();
  const sort = settings.sessionSort;
  const grouped = settings.sessionGroupByProject;
  const collapsedProjects = settings.collapsedProjects;
  const [filter, setFilter] = useState('');
  const [menu, setMenu] = useState<MenuState | null>(null);
  // Passed to ContextMenu so a mousedown inside the trigger doesn't dismiss-then-reopen.
  const sortFilterTriggerRef = useRef<HTMLButtonElement | null>(null);
  // Menu-open state at the trigger's last mousedown, read by onClick via menuToggleIntent.
  const wasOpenRef = useRef(false);

  const toggleSortFilterMenu = (e: React.MouseEvent<HTMLButtonElement>) => {
    if (menuToggleIntent(wasOpenRef.current) === 'close') {
      setMenu(null);
      return;
    }

    const r = e.currentTarget.getBoundingClientRect();
    const items: MenuItem[] = buildSortFilterMenuItems({ sort, groupByProject: grouped }).map(
      (it) => ({
        label: it.label,
        icon: it.checked ? <IconCheck size={13} /> : undefined,
        disabled: it.header,
        separatorBefore: it.separatorBefore,
        onClick: () => {
          if (!it.action) return;
          if (it.action.kind === 'sort') update({ sessionSort: it.action.sort });
          else update({ sessionGroupByProject: !grouped });
        },
      }),
    );
    items.push({
      label: 'Close all sessions',
      icon: <IconTrash size={13} />,
      danger: true,
      disabled: sessions.length === 0,
      separatorBefore: true,
      onClick: onCloseAll,
    });
    // Right-align to the button so the menu falls back over the narrow panel, not into
    // the editor. MENU_W is an upper bound; the shared menu clamps to the viewport.
    const MENU_W = 200;
    const anchor = anchorMenuToRect(r, MENU_W);
    setMenu({ x: anchor.x, y: anchor.y, items });
  };

  // Pane-level session menu for empty body space. Bail on defaultPrevented so a card's
  // own menu wins; preventDefault here stops the panel's show/hide menu firing (R5.4).
  const onPaneContextMenu = (e: React.MouseEvent) => {
    if (e.defaultPrevented) return;
    e.preventDefault();
    setMenu({
      x: e.clientX,
      y: e.clientY,
      items: [
        { label: 'New session', icon: <IconPlus size={13} />, onClick: onNew },
        {
          label: 'Close all sessions',
          icon: <IconTrash size={13} />,
          danger: true,
          separatorBefore: true,
          disabled: sessions.length === 0,
          onClick: onCloseAll,
        },
      ],
    });
  };

  const labelFor = useCallback(
    (agentId: string) => agents.find((a) => a.id === agentId)?.label ?? agentId,
    [agents],
  );

  // Drag is enabled in every sort mode; disabled only when a text filter is active
  // (reordering a filtered subset is ambiguous). A drop that violates the active sort
  // auto-switches to manual (see sessionDrag / groupDrag drop handlers).
  const canDrag = filter.trim() === '';
  const dragIdRef = useRef<string | null>(null);
  const dragGroup = useRef<string | null>(null); // grouped mode constrains within a project
  // Distinct marker for a *group* (header) drag, kept separate from `dragIdRef` so header
  // and card drags never cross-trigger.
  const dragGroupRef = useRef<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);
  const [overGroup, setOverGroup] = useState<string | null>(null);

  // Lookup map used by sortedCanonical (pure helper, needs Map not array).
  const sessionsById = useMemo(() => new Map(sessions.map((s) => [s.id, s])), [sessions]);

  const reset = () => {
    dragIdRef.current = null;
    dragGroup.current = null;
    dragGroupRef.current = null;
    setOverId(null);
    setOverGroup(null);
  };

  // Persist a candidate reorder AND auto-switch to manual, but only if it differs from
  // the canonical sort order (otherwise a no-op drop).
  const commitReorder = useCallback(
    (candidateIds: string[]) => {
      const canonical = sortedCanonical(candidateIds, sort, sessionsById);
      if (dropResolvesToManual(candidateIds, canonical)) {
        onReorderSessions(candidateIds);
        update({ sessionSort: 'manual' });
      }
    },
    [sort, sessionsById, onReorderSessions, update],
  );

  const sessionDrag = (s: Session, groupPath: string | null, renderedIds: string[]) => ({
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
        commitReorder(moveBefore(renderedIds, d, s.id));
      reset();
    },
    onDragEnd: reset,
  });

  // Drag a project header to reorder whole groups: the dragged project's ids move as one
  // block before the target's, preserving internal order (reorderByGroup). B1 discipline
  // (header/card/panel drags stay separate) comes from each path acting only on its own
  // marker — no stopPropagation needed.
  const groupDrag = (path: string, renderedIds: string[]) => ({
    onDragStart: (e: React.DragEvent) => {
      dragGroupRef.current = path;
      e.dataTransfer.effectAllowed = 'move';
    },
    onDragOver: (e: React.DragEvent) => {
      const d = dragGroupRef.current;
      if (d && d !== path) {
        e.preventDefault();
        setOverGroup(path);
      }
    },
    onDrop: (e: React.DragEvent) => {
      e.preventDefault();
      const d = dragGroupRef.current;
      if (d && d !== path) {
        const groupOf = (id: string) => sessions.find((s) => s.id === id)?.projectPath ?? '';
        commitReorder(reorderByGroup(renderedIds, groupOf, d, path));
      }
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

  // Float needs-attention sessions to the top, but only for a derived order — never
  // clobber the user's explicit manual order (D2). Stable within each partition.
  const ordered = useMemo(() => {
    if (sort === 'manual') return sorted;
    const attn = sorted.filter((s) => s.needsAttention);
    if (attn.length === 0) return sorted;
    const rest = sorted.filter((s) => !s.needsAttention);
    return [...attn, ...rest];
  }, [sorted, sort]);

  // One headerless group when ungrouped, else one per project (first-appearance order for
  // manual, by name otherwise).
  const renderGroups = useMemo<{ path: string | null; sessions: Session[] }[]>(() => {
    if (!grouped) return [{ path: null, sessions: ordered }];
    const map = new Map<string, Session[]>();
    for (const s of ordered) {
      const arr = map.get(s.projectPath) ?? [];
      arr.push(s);
      map.set(s.projectPath, arr);
    }
    const paths = [...map.keys()];
    if (sort !== 'manual') paths.sort((a, b) => baseName(a).localeCompare(baseName(b)));
    return paths.map((path) => ({ path, sessions: map.get(path) ?? [] }));
  }, [ordered, grouped, sort]);

  // The flat rendered order, so drag handlers commit the rendered arrangement (not raw sessions[]).
  const renderedIds = useMemo(() => ordered.map((s) => s.id), [ordered]);

  const renderItem = (s: Session, groupPath: string | null) => (
    <SessionItem
      key={s.id}
      session={s}
      agentLabel={labelFor(s.agentId)}
      resolvedIcon={resolveSessionIcon(s, agents)}
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
      drag={canDrag ? sessionDrag(s, grouped ? groupPath : null, renderedIds) : undefined}
      dropTarget={overId === s.id}
    />
  );

  return (
    <aside className="sidebar">
      <div className="sidebar__head sidebar__head--actions" {...panelMoveDragProps(moveGrip)}>
        <span className="panel-title">Sessions</span>
        <div className="sidebar__head-actions">
          {/* Search lives in the top-center omni-bar (R4.13); the header carries only
              sort/filter (···) and new-session (+). */}
          <button
            ref={sortFilterTriggerRef}
            className="iconbtn iconbtn--sm"
            title="Sort & filter sessions"
            aria-label="Sort & filter sessions"
            aria-haspopup="menu"
            aria-expanded={menu !== null}
            onMouseDown={() => {
              wasOpenRef.current = menu !== null;
            }}
            onClick={toggleSortFilterMenu}
          >
            <IconMore size={16} />
          </button>
          <button
            className="iconbtn iconbtn--sm"
            onClick={onNew}
            title="New session"
            aria-label="New session"
          >
            <IconPlus size={15} />
          </button>
        </div>
      </div>

      {/* Filter row only when there's something to filter — an empty panel shows just
          the start-state. */}
      {sessions.length > 0 && (
        <div className="sessbar">
          <div className="searchbox">
            <IconSearch size={14} />
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
          </div>
        </div>
      )}

      <div className="sidebar__scroll" onContextMenu={onPaneContextMenu}>
        {sessions.length === 0 && (
          <EmptyState
            title={
              <>
                No sessions yet. Hit <IconPlus size={16} className="emptystate__plus" />
              </>
            }
            hint="Start a session to launch an agent in this directory."
          />
        )}
        {sessions.length > 0 && ordered.length === 0 && (
          <EmptyState title={`No sessions match “${filter}”.`} />
        )}
        {renderGroups.map((g) => {
          if (g.path === null) {
            return (
              <div className="proj proj--flat" key="__flat">
                {g.sessions.map((s) => renderItem(s, null))}
              </div>
            );
          }
          const path = g.path;
          const isCollapsed = grouped && collapsedProjects.includes(path);
          // Surface a hidden busy/attention session on the collapsed header so the group still signals.
          const hiddenAttn = isCollapsed && g.sessions.some((s) => s.needsAttention || s.busy);
          return (
            <div className="proj" key={path}>
              <div
                className={`proj__label${overGroup === path ? ' proj__label--dropbefore' : ''}`}
                title={path}
                draggable={canDrag}
                {...(canDrag ? groupDrag(path, renderedIds) : {})}
              >
                {/* Chevron: separate button so clicks never start a drag */}
                <button
                  className="proj__chevron"
                  aria-expanded={!isCollapsed}
                  aria-label={
                    isCollapsed ? `Expand ${baseName(path)}` : `Collapse ${baseName(path)}`
                  }
                  onClick={(e) => {
                    e.stopPropagation();
                    update({ collapsedProjects: toggleCollapsed(collapsedProjects, path) });
                  }}
                  onDragStart={(e) => e.stopPropagation()}
                >
                  {isCollapsed ? '▸' : '▾'}
                </button>
                <span className="proj__name">{baseName(path)}</span>
                {isCollapsed && (
                  <span className={`proj__count${hiddenAttn ? ' proj__count--attn' : ''}`}>
                    {g.sessions.length}
                  </span>
                )}
              </div>
              {!isCollapsed && g.sessions.map((s) => renderItem(s, path))}
            </div>
          );
        })}
      </div>

      {updateStatus && (
        <div className="sidebar__update">
          <UpdateCard
            status={updateStatus}
            dismissed={updateDismissed ?? false}
            onDismiss={onUpdateDismiss ?? (() => {})}
          />
        </div>
      )}

      <div className="sidebar__foot">
        <button className="footbtn" onClick={onOpenSettings} title="Settings (Ctrl+,)">
          <IconSettings size={15} />
          <span>Settings</span>
        </button>
      </div>

      {menu && (
        <ContextMenu menu={menu} onClose={() => setMenu(null)} triggerRef={sortFilterTriggerRef} />
      )}
    </aside>
  );
}
