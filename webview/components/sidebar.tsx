import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { anchorMenuToRect } from '../../src/menu-position';
import { menuToggleIntent } from '../../src/menu-toggle';
import { moveBefore, reorderByGroup } from '../../src/reorder';
import { dotClass, dotState, dotTitle, sessionRowClass } from '../../src/session-dot';
import { iconForSession, type SessionIconKind } from '../../src/session-icon';
import type { CardField, SessionSort } from '../../src/settings';
import type { AgentDefinition, Session } from '../../src/types';
import { fieldValue } from '../card-fields';
import { IconCheck, IconMore, IconPlus, IconSettings, IconTrash, SessionGlyph } from '../icons';
import { useSettings } from '../settings';
import { buildSortFilterMenuItems } from '../sort-filter-menu';
import { ContextMenu, type MenuItem, type MenuState } from './context-menu';

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
  iconKind,
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
  iconKind: SessionIconKind;
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
      {(() => {
        // Exactly ONE status dot per card, derived from a single pure function so
        // a status dot and an attention pip can never render side by side (R4.3).
        const dot = dotState(session);
        return <span className={dotClass(dot)} title={dotTitle(dot)} />;
      })()}
      <SessionGlyph kind={iconKind} size={14} />
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
  onCloseAll,
  onRename,
  onRelaunch,
  onOpenSettings,
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
  onCloseAll: () => void;
  onRename: (id: string, name: string) => void;
  onRelaunch: (id: string) => void;
  onOpenSettings: () => void;
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
  // Ref for the three-dot trigger button — passed to ContextMenu so it does NOT
  // dismiss on mousedown events inside the button (which would cause re-open on
  // click). The onClick reads `wasOpenRef` to toggle correctly.
  const sortFilterTriggerRef = useRef<HTMLButtonElement | null>(null);
  // Tracks whether the menu was open at the moment of the last mousedown on the
  // trigger. The onClick uses menuToggleIntent to decide open vs. no-op.
  const wasOpenRef = useRef(false);

  // Three-dot overflow → shared ContextMenu anchored below/right of the button.
  // Sort options are radio-like (active one checked); the group toggle is checked
  // when grouping is on. Selecting an item applies it and closes the menu.
  //
  // Toggle contract: ContextMenu's triggerRef prevents the mousedown-dismiss from
  // firing when the trigger is clicked. The button's onMouseDown snapshots the
  // open state into `wasOpenRef`; this onClick reads it to decide toggle intent.
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
    // Bulk close lives at the foot of the panel menu (Close others needs a target,
    // so only Close all applies here). Danger-styled; disabled with no sessions.
    items.push({
      label: 'Close all sessions',
      icon: <IconTrash size={13} />,
      danger: true,
      disabled: sessions.length === 0,
      separatorBefore: true,
      onClick: onCloseAll,
    });
    // Open below the button, right-aligned to its right edge so the menu falls
    // back over the (narrow) sessions panel rather than spilling into the editor.
    // MENU_W is a comfortable upper bound; the shared menu clamps to the viewport.
    // The rect is in viewport coords; ContextMenu portals to <body> so these
    // coordinates resolve against the viewport (not the backdrop-filtered aside).
    const MENU_W = 200;
    const anchor = anchorMenuToRect(r, MENU_W);
    setMenu({ x: anchor.x, y: anchor.y, items });
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
  // Distinct marker for a *group* drag (project path of the dragged header). Kept
  // separate from `dragIdRef` so a header drag and a card drag never interfere — a
  // group's drop handler only fires when a group drag is in flight, and vice-versa.
  const dragGroupRef = useRef<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);
  const [overGroup, setOverGroup] = useState<string | null>(null);
  const allIds = () => sessions.map((s) => s.id);
  const reset = () => {
    dragIdRef.current = null;
    dragGroup.current = null;
    dragGroupRef.current = null;
    setOverId(null);
    setOverGroup(null);
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

  // Drag a whole project group (the header) to reorder groups among each other. The
  // dragged project's session ids move together as one block before the target
  // project's block, preserving each group's internal order (see reorderByGroup).
  // B1 discipline (header vs card vs panel drag stay separate) is enforced purely by
  // distinct drag-source markers: a header drag sets `dragGroupRef`, a card drag sets
  // `dragIdRef`, and the panel-move drag sets the panel's own `dragRegionRef`. Each
  // path's over/drop handlers act only when *their* marker is set, so the drags never
  // cross-trigger — no stopPropagation needed (the dock handlers ignore us too).
  const groupDrag = (path: string) => ({
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
        onReorderSessions(reorderByGroup(allIds(), groupOf, d, path));
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

  // Float needs-attention sessions toward the top — but only when the order is
  // already derived (sort !== 'manual'), so we never clobber the user's explicit
  // manual order (D2/reorder). Stable: attention sessions keep their relative
  // order, as do the rest. Under grouping this hoists an attention session to the
  // top of its own project group (groups are rebuilt by first appearance below).
  const ordered = useMemo(() => {
    if (sort === 'manual') return sorted;
    const attn = sorted.filter((s) => s.needsAttention);
    if (attn.length === 0) return sorted;
    const rest = sorted.filter((s) => !s.needsAttention);
    return [...attn, ...rest];
  }, [sorted, sort]);

  // Build the render groups: one synthetic group (no header) when ungrouped, or
  // one per project (ordered by first appearance for manual, else by name).
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

  const renderItem = (s: Session, groupPath: string | null) => (
    <SessionItem
      key={s.id}
      session={s}
      agentLabel={labelFor(s.agentId)}
      iconKind={iconForSession(s, agents)}
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
        <span className="panel-title">Sessions</span>
        <div className="sidebar__head-actions">
          {/* Search affordance relocated to the top-center omni-bar (R4.13). */}
          <button className="newbtn" onClick={onNew}>
            <IconPlus size={13} /> New
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
          ref={sortFilterTriggerRef}
          className="iconbtn iconbtn--sm"
          title="Sort & filter sessions"
          aria-label="Sort & filter sessions"
          aria-haspopup="menu"
          aria-expanded={menu !== null}
          onMouseDown={() => {
            // Snapshot menu-open state at mousedown so the subsequent onClick
            // can decide whether to toggle open or stay closed.
            wasOpenRef.current = menu !== null;
          }}
          onClick={toggleSortFilterMenu}
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
        {sessions.length > 0 && ordered.length === 0 && (
          <p className="sidebar__empty">No sessions match “{filter}”.</p>
        )}
        {renderGroups.map((g) =>
          g.path === null ? (
            <div className="proj proj--flat" key="__flat">
              {g.sessions.map((s) => renderItem(s, null))}
            </div>
          ) : (
            <div className="proj" key={g.path}>
              <div
                className={`proj__label ${overGroup === g.path ? 'proj__label--dropbefore' : ''}`}
                title={g.path}
                draggable={canDrag}
                {...(canDrag ? groupDrag(g.path) : {})}
              >
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

      {menu && (
        <ContextMenu menu={menu} onClose={() => setMenu(null)} triggerRef={sortFilterTriggerRef} />
      )}
    </aside>
  );
}
