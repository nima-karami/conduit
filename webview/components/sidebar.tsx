import { useCallback, useId, useMemo, useRef, useState } from 'react';
import { anchorMenuToRect } from '../../src/menu-position';
import { menuToggleIntent } from '../../src/menu-toggle';
import { moveBefore, reorderPersists, toggleCollapsed } from '../../src/reorder';
import {
  groupSessions,
  orderSessions,
  projectOrderAfterDrop,
  type SessionGroup,
  STANDALONE_KEY,
  sessionMatchesFilter,
} from '../../src/session-groups';
import { resolveSessionIcon, sessionIconState } from '../../src/session-icon';
import { staleSessionIds } from '../../src/stale-sessions';
import type { AgentDefinition, Project, Session } from '../../src/types';
import { post } from '../bridge';
import {
  IconCheck,
  IconChevron,
  IconChevronDown,
  IconMore,
  IconPlus,
  IconSearch,
  IconSettings,
  IconTrash,
} from '../icons';
import { type MoveGrip, panelMoveDragProps } from '../panel-move-grip';
import { useSettings } from '../settings';
import { buildSortFilterMenuItems } from '../sort-filter-menu';
import { ContextMenu, type MenuItem, type MenuState } from './context-menu';
import { EmptyState } from './empty-state';
import { type CardRoles, SessionCard } from './session-card';
import { UpdateCard, type UpdateStatus } from './update-card';

export function Sidebar({
  sessions,
  projects,
  agents,
  activeId,
  onSelect,
  onNew,
  onKill,
  onCloseAll,
  onCloseAllStale,
  onRename,
  onRelaunch,
  onOpenSettings,
  onContextMenu,
  onSnooze,
  onOpenReview,
  renamingId,
  onSetRenaming,
  onReorderSessions,
  onSessionDragEnd,
  updateStatus,
  updateDismissed,
  onUpdateDismiss,
  moveGrip,
}: {
  sessions: Session[]; // flat list in the global (manual) order
  projects: Project[];
  agents: AgentDefinition[];
  activeId: string | undefined;
  onSelect: (id: string) => void;
  onNew: () => void;
  onKill: (id: string) => void;
  onCloseAll: () => void;
  onCloseAllStale: () => void;
  onRename: (id: string, name: string) => void;
  onRelaunch: (id: string) => void;
  onOpenSettings: () => void;
  onContextMenu?: (e: React.MouseEvent, session: Session) => void;
  /** Silence one session's "needs you" for 10 minutes (D16). Held above the rail so the
   *  topbar's aggregate chip drops the same session at the same moment. */
  onSnooze: (id: string) => void;
  /** Open Review changes for a session — the Review state's way into the diff. */
  onOpenReview?: (id: string) => void;
  renamingId?: string;
  onSetRenaming: (id: string | null) => void;
  onReorderSessions: (order: string[]) => void;
  // Cross-window drag (multi-window Slice C): fires on a session tab's dragend with the
  // drop's global SCREEN coords. The host hit-tests them — drop over another window → move,
  // empty desktop → tear out a new window, over this window → no-op (the in-strip reorder
  // above already applied). Additive to the reorder drag; never blocks it.
  onSessionDragEnd?: (sessionId: string, screenX: number, screenY: number) => void;
  updateStatus?: UpdateStatus | null;
  updateDismissed?: boolean;
  onUpdateDismiss?: () => void;
  // When the panel is rendered barless (PanelFrame draws no top drag-bar), the header
  // band doubles as the panel-move drag surface (see panelMoveDragProps).
  moveGrip?: MoveGrip;
}) {
  const { settings, update } = useSettings();
  const groupIdBase = useId();
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
    items.push({
      label: 'Close all stale sessions',
      icon: <IconTrash size={13} />,
      danger: true,
      disabled: staleSessionIds(sessions).length === 0,
      onClick: onCloseAllStale,
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
        {
          label: 'Close all stale sessions',
          icon: <IconTrash size={13} />,
          danger: true,
          disabled: staleSessionIds(sessions).length === 0,
          onClick: onCloseAllStale,
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

  // Lookup map used by reorderPersists (pure helper, needs Map not array).
  const sessionsById = useMemo(() => new Map(sessions.map((s) => [s.id, s])), [sessions]);

  const reset = () => {
    dragIdRef.current = null;
    dragGroup.current = null;
    dragGroupRef.current = null;
    setOverId(null);
    setOverGroup(null);
  };

  // Persist a candidate reorder AND auto-switch to manual, but only if it changes the
  // baseline (otherwise a no-op drop). In manual mode the baseline is the rendered order,
  // not sortedCanonical (which returns the candidate unchanged → would never persist).
  const commitReorder = useCallback(
    (candidateIds: string[], currentIds: string[]) => {
      if (reorderPersists(candidateIds, currentIds, sort, sessionsById, projects)) {
        onReorderSessions(candidateIds);
        if (sort !== 'manual') update({ sessionSort: 'manual' });
      }
    },
    [sort, sessionsById, projects, onReorderSessions, update],
  );

  const sessionDrag = (s: Session, groupKey: string | null, renderedIds: string[]) => ({
    onDragStart: (e: React.DragEvent) => {
      dragIdRef.current = s.id;
      dragGroup.current = groupKey;
      e.dataTransfer.effectAllowed = 'move';
    },
    onDragOver: (e: React.DragEvent) => {
      const d = dragIdRef.current;
      if (d && d !== s.id && dragGroup.current === groupKey) {
        e.preventDefault();
        setOverId(s.id);
      }
    },
    onDrop: (e: React.DragEvent) => {
      e.preventDefault();
      const d = dragIdRef.current;
      if (d && d !== s.id && dragGroup.current === groupKey)
        commitReorder(moveBefore(renderedIds, d, s.id), renderedIds);
      reset();
    },
    // Fires after any drop (in-strip or onto another window/desktop). Report the global drop
    // point so the host can hit-test for a cross-window move / tear-out; the host no-ops when
    // the drop was over this same window, so the in-strip reorder above stands.
    onDragEnd: (e: React.DragEvent) => {
      onSessionDragEnd?.(s.id, e.screenX, e.screenY);
      reset();
    },
  });

  const roles: CardRoles = {
    title: settings.cardTitle,
    subtitle: settings.cardSubtitle,
    detail: settings.cardDetail,
  };

  const projectName = useCallback(
    (id: string | undefined) =>
      id === undefined ? undefined : projects.find((p) => p.id === id)?.name,
    [projects],
  );

  const filtered = useMemo(
    () =>
      sessions.filter((s) =>
        sessionMatchesFilter(s, filter, {
          projectName: projectName(s.projectId),
          agentLabel: labelFor(s.agentId),
        }),
      ),
    [sessions, filter, projectName, labelFor],
  );

  const ordered = useMemo(
    () => orderSessions(filtered, sort, projects),
    [filtered, sort, projects],
  );

  const renderGroups = useMemo<SessionGroup[] | null>(
    () => (grouped ? groupSessions(filtered, projects, { sort, filterActive: !canDrag }) : null),
    [grouped, filtered, projects, sort, canDrag],
  );

  // Header drag is only on while unfiltered, where every project renders, so the rendered
  // project order is the full one (plan decision 8).
  const renderedProjectIds = useMemo(
    () => (renderGroups ?? []).flatMap((g) => (g.project ? [g.project.id] : [])),
    [renderGroups],
  );

  const groupDrag = (key: string) => ({
    onDragStart: (e: React.DragEvent) => {
      dragGroupRef.current = key;
      e.dataTransfer.effectAllowed = 'move';
    },
    onDragOver: (e: React.DragEvent) => {
      const d = dragGroupRef.current;
      if (d && d !== key) {
        e.preventDefault();
        setOverGroup(key);
      }
    },
    onDrop: (e: React.DragEvent) => {
      e.preventDefault();
      const d = dragGroupRef.current;
      const ids =
        d === null
          ? null
          : projectOrderAfterDrop(
              renderedProjectIds,
              d,
              key,
              projects.map((p) => p.id),
            );
      if (ids) {
        post({ type: 'project:reorder', ids });
        if (sort !== 'manual') update({ sessionSort: 'manual' });
      }
      reset();
    },
    onDragEnd: reset,
  });

  const renderedIds = useMemo(() => ordered.map((s) => s.id), [ordered]);

  const liveCount = sessions.filter((s) => s.status === 'running').length;

  const renderItem = (s: Session, groupKey: string | null) => (
    <SessionCard
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
      onSnooze={() => onSnooze(s.id)}
      onOpenReview={onOpenReview ? () => onOpenReview(s.id) : undefined}
      editing={renamingId === s.id}
      onEditStart={() => onSetRenaming(s.id)}
      onEditEnd={() => onSetRenaming(null)}
      roles={roles}
      drag={canDrag ? sessionDrag(s, groupKey, renderedIds) : undefined}
      dropTarget={overId === s.id}
    />
  );

  const renderGroup = (g: SessionGroup) => {
    const name = g.project?.name ?? 'Standalone';
    const labelId = `${groupIdBase}-${g.key}`;
    const isCollapsed = collapsedProjects.includes(g.key);
    // Surface a hidden busy/attention session on the collapsed header so the group still
    // signals. Reads the shared derivation, never the raw flags, so it can't drift.
    const hiddenAttn =
      isCollapsed &&
      g.sessions.some((s) => {
        const st = sessionIconState(s);
        return st === 'attention' || st === 'busy';
      });
    const reorderable = canDrag && g.key !== STANDALONE_KEY;
    return (
      <div className="proj" role="group" aria-labelledby={labelId} key={g.key}>
        <div
          className={`proj__label${overGroup === g.key ? ' proj__label--dropbefore' : ''}`}
          title={name}
          draggable={reorderable}
          {...(reorderable ? groupDrag(g.key) : {})}
        >
          {/* Chevron: separate button so clicks never start a drag */}
          <button
            className="proj__chevron"
            aria-expanded={!isCollapsed}
            aria-label={isCollapsed ? `Expand ${name}` : `Collapse ${name}`}
            onClick={(e) => {
              e.stopPropagation();
              update({ collapsedProjects: toggleCollapsed(collapsedProjects, g.key) });
            }}
            onDragStart={(e) => e.stopPropagation()}
          >
            {isCollapsed ? <IconChevron size={12} /> : <IconChevronDown size={12} />}
          </button>
          <span className="proj__name" id={labelId}>
            {name}
          </span>
          <span className={`proj__count${hiddenAttn ? ' proj__count--attn' : ''}`}>
            {g.sessions.length}
          </span>
        </div>
        {!isCollapsed && g.sessions.map((s) => renderItem(s, g.key))}
      </div>
    );
  };

  // Projects stay reachable with no sessions while grouped (spec §2.11, D10).
  const firstRun = sessions.length === 0 && (projects.length === 0 || !grouped);

  return (
    <aside className="sidebar">
      <div className="sidebar__head sidebar__head--actions" {...panelMoveDragProps(moveGrip)}>
        <span className="panel-title">Sessions</span>
        {liveCount > 0 && <span className="sidebar__live">{liveCount} live</span>}
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

      {/* The list's own padding would stack on the start-state's, pushing it out of line with
          the header label — the empty rail is one block of prose, not an indented row. */}
      <div
        className={`sidebar__scroll ${firstRun ? 'sidebar__scroll--empty' : ''}`}
        onContextMenu={onPaneContextMenu}
      >
        {firstRun && (
          <EmptyState
            variant="panel"
            title="No sessions yet"
            hint="A session is one terminal working across one or more folders. Run four at once."
          />
        )}
        {sessions.length > 0 && ordered.length === 0 && (
          <EmptyState title={`No sessions match “${filter}”.`} />
        )}
        {renderGroups ? (
          renderGroups.map(renderGroup)
        ) : (
          <div className="proj proj--flat">{ordered.map((s) => renderItem(s, null))}</div>
        )}
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
