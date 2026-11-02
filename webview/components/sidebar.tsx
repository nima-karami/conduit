import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { resolveAgentIcon } from '../../src/agent-icon';
import { sessionAgentLabel } from '../../src/agent-label';
import {
  type AgentTreeModel,
  buildAgentTree,
  buildSpaceRows,
  type SpaceRowModel,
} from '../../src/agent-tree';
import type { McpNotConnected, McpSessionBadge } from '../../src/conduit-mcp/ui-types';
import { triggerMenu } from '../../src/menu-position';
import { normalizeProjectName, renamedProjectName } from '../../src/project-name';
import {
  deleteProjectDialog,
  openBoardTarget,
  sessionMatchesFilter,
} from '../../src/session-groups';
import type {
  AgentGroup,
  AgentState,
  SidebarUiState,
  SpaceSelection,
} from '../../src/sidebar-state';
import { staleSessionIds } from '../../src/stale-sessions';
import type { AgentDefinition, Project, Session } from '../../src/types';
import { post } from '../bridge';
import { agentRowTooltip } from '../card-fields';
import { MCP_STR } from '../conduit-mcp-strings';
import { requestHost } from '../host-request';
import { IconBoard, IconPencil, IconPlus, IconSearch, IconSettings, IconTrash } from '../icons';
import { cardMcpStatus } from '../mcp-card-status';
import { type MoveGrip, panelMoveDragProps } from '../panel-move-grip';
import { projectAnnouncer } from '../project-announcer';
import { SIDEBAR_STR } from '../sidebar-strings';
import { useSidebarTreeState } from '../sidebar-tree-state';
import { buildAgentsPaneMenu } from '../sort-filter-menu';
import type { ConfirmState } from './confirm-dialog';
import { ContextMenu, type MenuItem, type MenuState } from './context-menu';
import { EmptyState } from './empty-state';
import {
  AgentGroupHeader,
  type MenuAt,
  RenameInput,
  type SpaceDropHandlers,
  SpaceRow,
} from './project-group-header';
import { AgentRow, type RowGuides } from './session-card';

/** One rendered row of the flattened, unfolded forest: the pointer and keyboard order. */
interface FlatRow {
  id: string;
  guides: RowGuides;
  lastChild: boolean;
}

/**
 * Depth-first over each unfolded group, iteratively (ancestry comes from persisted, possibly
 * malformed records). Guides say, per ancestor level, whether that ancestor has a later sibling,
 * so its vertical connector carries on past this row.
 */
function flattenGroup(model: AgentTreeModel, rootIds: readonly string[]): FlatRow[] {
  const out: FlatRow[] = [];
  const stack: { id: string; guides: boolean[]; last: boolean }[] = rootIds
    .map((id) => ({ id, guides: [] as boolean[], last: true }))
    .reverse();
  while (stack.length > 0) {
    const cur = stack.pop() as (typeof stack)[number];
    const row = model.rows[cur.id];
    if (!row) continue;
    out.push({ id: cur.id, guides: cur.guides, lastChild: cur.last });
    if (row.folded) continue;
    const kidGuides = row.depth === 0 ? [] : [...cur.guides, !cur.last];
    for (let i = row.childIds.length - 1; i >= 0; i--)
      stack.push({ id: row.childIds[i], guides: kidGuides, last: i === row.childIds.length - 1 });
  }
  return out;
}

/**
 * One shared clock for every age label (spec §4): it wakes at the next minute boundary of any
 * visible age, never per row, and never remounts a terminal.
 */
function useAgeClock(sinces: readonly number[]): number {
  const [now, setNow] = useState(() => Date.now());
  const key = sinces.join(',');
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = () => {
      const t = Date.now();
      let wait = 60_000;
      for (const since of key ? key.split(',').map(Number) : []) {
        const into = (t - since) % 60_000;
        if (into >= 0) wait = Math.min(wait, 60_000 - into);
      }
      timer = setTimeout(
        () => {
          setNow(Date.now());
          schedule();
        },
        Math.max(1_000, wait),
      );
    };
    setNow(Date.now());
    schedule();
    return () => clearTimeout(timer);
  }, [key]);
  return now;
}

const SPACE_KEY_ALL = 'all';
const SPACE_KEY_NONE = 'no-space';

function selectionKey(sel: SpaceSelection): string {
  return sel.kind === 'all' ? SPACE_KEY_ALL : sel.kind === 'none' ? SPACE_KEY_NONE : sel.projectId;
}

function selectionOf(row: SpaceRowModel): SpaceSelection {
  if (row.key === SPACE_KEY_ALL) return { kind: 'all' };
  if (row.projectId === null) return { kind: 'none' };
  return { kind: 'space', projectId: row.projectId };
}

const cssId = (id: string) =>
  typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(id) : id.replace(/["\\]/g, '\\$&');

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
  mcpBadges,
  mcpNotConnected,
  mcpEnabled,
  renamingId,
  onSetRenaming,
  onSessionDragEnd,
  moveGrip,
  windowCount,
  onNewInProject,
  onOpenBoard,
  onConfirm,
  sessionsLoaded = true,
}: {
  /** This window's sessions; the tree orders them, so the incoming order is not used. */
  sessions: Session[];
  projects: Project[];
  /** Open windows; the delete copy can only count this window's sessions (spec D13). */
  windowCount: number;
  onNewInProject: (projectId: string | null) => void;
  onOpenBoard: (sessionId: string) => void;
  onConfirm: (c: ConfirmState) => void;
  /** False until the first authoritative snapshot: the list shows a placeholder, never a
   *  first-run flash (spec §9 Hydrating). */
  sessionsLoaded?: boolean;
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
  /** Legacy, unused: Snooze moved to the session menu (spec §6); the lead drops the argument. */
  onSnooze?: (id: string) => void;
  /** Messaging state by session id, for the row tooltip (conduit-mcp spec §8). */
  mcpBadges: Readonly<Record<string, McpSessionBadge>>;
  /** Sessions whose agent CLI never reached the host, by session id (mcp-install spec §2.5). */
  mcpNotConnected: Readonly<Record<string, McpNotConnected>>;
  mcpEnabled: boolean;
  /** Legacy, unused: the tree reads waiting asks from its context. */
  awaitingApproval?: ReadonlySet<string>;
  /** Legacy, unused: View approval moved to the session menu. */
  onFocusAsk?: () => void;
  renamingId?: string;
  onSetRenaming: (id: string | null) => void;
  /** Legacy, unused: the tree has no manual order (spec §6). */
  onReorderSessions?: (order: string[]) => void;
  // Cross-window drag (multi-window Slice C): a row's dragend with the drop's global SCREEN
  // coords. The host hit-tests them — another window → move, empty desktop → tear out, this
  // window → no-op. A drop on a Space row is handled here as well.
  onSessionDragEnd?: (sessionId: string, screenX: number, screenY: number) => void;
  /** Legacy, unused: updates render as a floating toast (spec §7 Revision 2). */
  updateStatus?: unknown;
  updateDismissed?: boolean;
  onUpdateDismiss?: () => void;
  // The panel is rendered barless, so the Spaces header doubles as the panel-move drag surface.
  moveGrip?: MoveGrip;
}) {
  const tree = useSidebarTreeState();
  const { ui, runtime, askSessionIds, bindings, updateUi, reportVisibleIds } = tree;
  const baseId = useId();
  const filterId = `${baseId}-filter`;
  const treeRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLButtonElement>(null);
  const filterRef = useRef<HTMLInputElement>(null);
  const newAgentRef = useRef<HTMLButtonElement>(null);

  const [filter, setFilter] = useState('');
  const [filterOpen, setFilterOpen] = useState(false);
  const [menu, setMenu] = useState<MenuState | null>(null);
  useEffect(() => {
    const open = menu;
    return () => open?.onClosed?.();
  }, [menu]);

  // ---- Spaces -------------------------------------------------------------------------------
  const [renamingProjectId, setRenamingProjectId] = useState<string | null>(null);
  const [creatingSpace, setCreatingSpace] = useState(false);
  const [createHint, setCreateHint] = useState<string | null>(null);
  // A project deleted elsewhere closes its rename without posting (mf-sidebar spec §4).
  useEffect(() => {
    if (renamingProjectId !== null && !projects.some((p) => p.id === renamingProjectId))
      setRenamingProjectId(null);
  }, [projects, renamingProjectId]);
  useEffect(() => projectAnnouncer.observeProjects(projects), [projects]);
  const announcement = useSyncExternalStore(
    projectAnnouncer.subscribe,
    projectAnnouncer.getSnapshot,
    projectAnnouncer.getSnapshot,
  );

  const projectName = useCallback(
    (id: string | undefined) =>
      id === undefined ? undefined : projects.find((p) => p.id === id)?.name,
    [projects],
  );
  const labelFor = useCallback((s: Session) => sessionAgentLabel(agents, s), [agents]);

  const spaceRows = useMemo(
    () =>
      buildSpaceRows({
        projects,
        sessions,
        runtime,
        askSessionIds,
        lastFocusedId: tree.lastFocusedId,
      }),
    [projects, sessions, runtime, askSessionIds, tree.lastFocusedId],
  );
  const spaceName = (row: SpaceRowModel) =>
    row.key === SPACE_KEY_ALL
      ? SIDEBAR_STR.all
      : row.key === SPACE_KEY_NONE
        ? SIDEBAR_STR.noSpace
        : row.name;
  const spaceDetail = (row: SpaceRowModel) =>
    row.key === SPACE_KEY_ALL ? SIDEBAR_STR.agentCount(row.count) : row.branch;

  const setUi = (patch: Partial<SidebarUiState>) => updateUi({ ...ui, ...patch });

  const confirmDelete = (project: Project) => {
    const count = sessions.filter((s) => s.projectId === project.id).length;
    onConfirm({
      ...deleteProjectDialog(project.name, count, windowCount),
      confirmLabel: SIDEBAR_STR.deleteSpaceConfirm,
      danger: true,
      focusCancel: true,
      onConfirm: () => {
        post({ type: 'project:delete', id: project.id });
        projectAnnouncer.noteDelete(project.id, project.name);
      },
    });
  };

  const openMenu = (items: MenuItem[], at: MenuAt, returnFocus: HTMLElement | null) => {
    // Focus goes back to the trigger only on a dismiss: after a pick it belongs to what the
    // pick opened (the rename input, the delete dialog, New agent).
    let picked = false;
    const tracked = items.map((it) => ({
      ...it,
      onClick: (a?: Parameters<MenuItem['onClick']>[0]) => {
        picked = true;
        it.onClick(a);
      },
    }));
    const onClosed = returnFocus
      ? () => {
          if (!picked && returnFocus.isConnected) returnFocus.focus();
        }
      : undefined;
    setMenu(
      'anchor' in at
        ? { ...triggerMenu(at.anchor), keyboard: true, items: tracked, onClosed }
        : { x: at.x, y: at.y, items: tracked, onClosed },
    );
  };

  const openSpaceMenu = (row: SpaceRowModel, at: MenuAt, returnFocus: HTMLElement | null) => {
    const project = row.projectId === null ? null : projects.find((p) => p.id === row.projectId);
    let items: MenuItem[];
    if (project) {
      const target = openBoardTarget(project.id, sessions, activeId);
      items = [
        {
          label: SIDEBAR_STR.newAgentInSpace,
          icon: <IconPlus size={13} />,
          onClick: () => onNewInProject(project.id),
        },
        {
          label: SIDEBAR_STR.openBoard,
          icon: <IconBoard size={13} />,
          disabled: target === undefined,
          onClick: () => target !== undefined && onOpenBoard(target),
        },
        {
          label: SIDEBAR_STR.renameSpace,
          icon: <IconPencil size={13} />,
          onClick: () => setRenamingProjectId(project.id),
        },
        {
          label: SIDEBAR_STR.deleteSpace,
          icon: <IconTrash size={13} />,
          danger: true,
          separatorBefore: true,
          onClick: () => confirmDelete(project),
        },
      ];
    } else if (row.key === SPACE_KEY_NONE) {
      items = [
        {
          label: SIDEBAR_STR.newAgentNoSpace,
          icon: <IconPlus size={13} />,
          onClick: () => onNewInProject(null),
        },
      ];
    } else {
      items = [{ label: SIDEBAR_STR.newAgent, icon: <IconPlus size={13} />, onClick: onNew }];
    }
    openMenu(items, at, returnFocus);
  };

  const createSpace = async (raw: string | null) => {
    if (raw === null || raw.trim() === '') {
      setCreatingSpace(false);
      setCreateHint(null);
      return;
    }
    const name = normalizeProjectName(raw);
    if (name === null) {
      setCreateHint(SIDEBAR_STR.spaceNameHint);
      return;
    }
    setCreatingSpace(false);
    setCreateHint(null);
    const reply = await requestHost(
      (requestId) => ({ type: 'project:create', name, requestId }),
      ['project:created', 'project:opResult'],
      5000,
    );
    if (reply?.type === 'project:opResult') setCreateHint(SIDEBAR_STR.createSpaceFailed);
  };

  // ---- Drag a row onto a Space (spec §6): only that session moves; All is never a target. ----
  const dragIdRef = useRef<string | null>(null);
  const [dropKey, setDropKey] = useState<string | null>(null);
  const sessionsById = useMemo(() => new Map(sessions.map((s) => [s.id, s])), [sessions]);

  const spaceDrop = (row: SpaceRowModel): SpaceDropHandlers | undefined => {
    if (row.key === SPACE_KEY_ALL) return undefined;
    const target = row.projectId ?? undefined;
    const accepts = () => {
      const s = dragIdRef.current ? sessionsById.get(dragIdRef.current) : undefined;
      return s !== undefined && s.projectId !== target ? s : undefined;
    };
    return {
      onDragOver: (e) => {
        if (!accepts()) return;
        e.preventDefault();
        setDropKey(row.key);
      },
      onDragLeave: (e) => {
        if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
        setDropKey((k) => (k === row.key ? null : k));
      },
      onDrop: (e) => {
        e.preventDefault();
        const s = accepts();
        if (s)
          projectAnnouncer.moveSession(s.id, row.projectId, {
            session: s.name,
            target: spaceName(row),
          });
        dragIdRef.current = null;
        setDropKey(null);
      },
    };
  };

  // ---- Agents tree --------------------------------------------------------------------------
  const matchingIds = useMemo(
    () =>
      new Set(
        sessions
          .filter((s) =>
            sessionMatchesFilter(s, filter, {
              projectName: projectName(s.projectId),
              agentLabel: labelFor(s),
            }),
          )
          .map((s) => s.id),
      ),
    [sessions, filter, projectName, labelFor],
  );
  const model = useMemo(
    () => buildAgentTree({ sessions, runtime, ui, matchingIds, askSessionIds }),
    [sessions, runtime, ui, matchingIds, askSessionIds],
  );
  const flat = useMemo(
    () =>
      model.groups.map((g) => ({
        group: g,
        rows: g.folded ? [] : flattenGroup(model, g.rootIds),
      })),
    [model],
  );
  const visibleIds = model.visibleIds;
  // Reported only when the order changes, not on every rebuild of the model.
  const reportedRef = useRef<readonly string[] | null>(null);
  useEffect(() => {
    const prev = reportedRef.current;
    if (prev && prev.length === visibleIds.length && prev.every((id, i) => id === visibleIds[i]))
      return;
    reportedRef.current = visibleIds;
    reportVisibleIds(visibleIds);
  }, [visibleIds, reportVisibleIds]);

  const sinces = useMemo(
    () => visibleIds.map((id) => model.rows[id].stateSince),
    [visibleIds, model],
  );
  const now = useAgeClock(sinces);

  // Roving focus: one tab stop in the tree, on the focused row, else the selected, else the first.
  const [focusId, setFocusId] = useState<string | null>(null);
  const tabId =
    focusId !== null && visibleIds.includes(focusId)
      ? focusId
      : activeId !== undefined && visibleIds.includes(activeId)
        ? activeId
        : (visibleIds[0] ?? null);
  const focusRow = useCallback((id: string) => {
    setFocusId(id);
    treeRef.current
      ?.querySelector<HTMLElement>(`[role="treeitem"][data-sessionid="${cssId(id)}"]`)
      ?.focus();
  }, []);

  // A focused row that vanished (closed, folded away, filtered) hands focus to its parent, else
  // the nearest row, else New agent — only if focus was in the tree when it went (spec §9).
  const prevVisibleRef = useRef<readonly string[]>(visibleIds);
  const treeHadFocusRef = useRef(false);
  useEffect(() => {
    const prev = prevVisibleRef.current;
    prevVisibleRef.current = visibleIds;
    if (focusId === null || visibleIds.includes(focusId) || !treeHadFocusRef.current) return;
    const active = document.activeElement;
    if (active && active !== document.body && !treeRef.current?.contains(active)) return;
    let next: string | undefined;
    let p = model.rows[focusId]?.parentId ?? null;
    while (p !== null && next === undefined) {
      if (visibleIds.includes(p)) next = p;
      else p = model.rows[p]?.parentId ?? null;
    }
    if (next === undefined) {
      const at = prev.indexOf(focusId);
      for (let i = at; i >= 0 && next === undefined; i--)
        if (visibleIds.includes(prev[i])) next = prev[i];
      next ??= prev.slice(at + 1).find((id) => visibleIds.includes(id)) ?? visibleIds[0];
    }
    if (next !== undefined) focusRow(next);
    else {
      setFocusId(null);
      newAgentRef.current?.focus();
    }
  }, [visibleIds, focusId, model, focusRow]);

  const toggleFold = (id: string) => {
    const folded = ui.foldedSessions.includes(id);
    setUi({
      foldedSessions: folded
        ? ui.foldedSessions.filter((x) => x !== id)
        : [...ui.foldedSessions, id],
    });
  };
  const togglePin = (id: string) => {
    const pinned = ui.pinnedIds.includes(id);
    setUi({ pinnedIds: pinned ? ui.pinnedIds.filter((x) => x !== id) : [...ui.pinnedIds, id] });
  };
  const toggleGroup = (g: AgentGroup) => {
    const folded = ui.foldedGroups.includes(g);
    setUi({
      foldedGroups: folded ? ui.foldedGroups.filter((x) => x !== g) : [...ui.foldedGroups, g],
    });
  };

  const onTreeKey = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const el = e.target as HTMLElement;
    if (el.getAttribute('role') !== 'treeitem') return;
    const id = el.dataset.sessionid;
    if (id === undefined) return;
    const row = model.rows[id];
    const at = visibleIds.indexOf(id);
    const go = (target: string | undefined) => {
      e.preventDefault();
      if (target !== undefined) focusRow(target);
    };
    switch (e.key) {
      case 'ArrowDown':
        return go(visibleIds[at + 1]);
      case 'ArrowUp':
        return go(at > 0 ? visibleIds[at - 1] : undefined);
      case 'Home':
        return go(visibleIds[0]);
      case 'End':
        return go(visibleIds[visibleIds.length - 1]);
      case 'ArrowRight':
        if (!row || row.childIds.length === 0) return;
        e.preventDefault();
        if (row.folded) toggleFold(id);
        else focusRow(row.childIds[0]);
        return;
      case 'ArrowLeft':
        if (!row) return;
        e.preventDefault();
        if (row.childIds.length > 0 && !row.folded) toggleFold(id);
        else if (row.parentId !== null && visibleIds.includes(row.parentId)) focusRow(row.parentId);
        return;
      case 'Enter':
        e.preventDefault();
        onSelect(id);
        return;
      case 'F2':
        e.preventDefault();
        onSetRenaming(id);
        return;
    }
  };

  // Status changes into Needs you or Done are announced once; ages never are (spec §9).
  const [treeAnnouncement, setTreeAnnouncement] = useState('');
  const lastStatesRef = useRef<Map<string, AgentState> | null>(null);
  useEffect(() => {
    const next = new Map(Object.values(model.rows).map((r) => [r.sessionId, r.state]));
    const prev = lastStatesRef.current;
    lastStatesRef.current = next;
    if (!prev) return;
    const said: string[] = [];
    for (const [id, st] of next) {
      if (prev.get(id) === undefined || prev.get(id) === st) continue;
      if (st !== 'blocked' && st !== 'done') continue;
      const s = sessionsById.get(id);
      if (s) said.push(`${s.name}: ${SIDEBAR_STR.state(st)}`);
    }
    if (said.length > 0) setTreeAnnouncement(said.join('. '));
  }, [model, sessionsById]);

  // ---- Search ---------------------------------------------------------------------------------
  // Bumped on every reveal, so a reveal of an already open filter still moves focus to it.
  const [revealTick, setRevealTick] = useState(0);
  const revealFilter = useCallback(() => {
    setFilterOpen(true);
    setRevealTick((n) => n + 1);
  }, []);
  useEffect(() => {
    if (revealTick > 0) filterRef.current?.focus();
  }, [revealTick]);
  const filterRequestRef = useRef(tree.filterRequest);
  useEffect(() => {
    if (tree.filterRequest === filterRequestRef.current) return;
    filterRequestRef.current = tree.filterRequest;
    revealFilter();
  }, [tree.filterRequest, revealFilter]);
  const showFilter = filterOpen || filter !== '';

  // ---- Pane menu ------------------------------------------------------------------------------
  const onPaneContextMenu = (e: React.MouseEvent) => {
    // A row's or Space's own menu wins; preventDefault here stops the panel's show/hide menu.
    if (e.defaultPrevented) return;
    e.preventDefault();
    const run = { new: onNew, closeAll: onCloseAll, closeAllStale: onCloseAllStale };
    setMenu({
      x: e.clientX,
      y: e.clientY,
      items: buildAgentsPaneMenu({
        sessionCount: sessions.length,
        staleCount: staleSessionIds(sessions).length,
      }).map((it) => ({
        label: it.label,
        icon: it.action === 'new' ? <IconPlus size={13} /> : <IconTrash size={13} />,
        danger: it.danger,
        disabled: it.disabled,
        separatorBefore: it.separatorBefore,
        onClick: run[it.action],
      })),
    });
  };

  // ---- Rows -----------------------------------------------------------------------------------
  const showAll = ui.selection.kind === 'all';
  const tooltipExtra = (s: Session): (string | undefined)[] => {
    const badge = mcpBadges[s.id];
    const link = cardMcpStatus(badge, mcpNotConnected[s.id], mcpEnabled);
    return [
      badge?.unavailable
        ? MCP_STR.unavailable[badge.unavailable]
        : badge?.gate && badge.gate !== 'open'
          ? MCP_STR.gate[badge.gate]
          : undefined,
      s.openedBy && MCP_STR.tools.openedBy(s.openedBy.handle),
      !link
        ? undefined
        : link.kind === 'connected'
          ? MCP_STR.install.connectedTip(link.handle)
          : link.install === 'installed'
            ? MCP_STR.install.notConnectedInstalledTip(link.cli)
            : MCP_STR.install.notConnectedTip(link.cli),
    ];
  };

  const renderRow = (f: FlatRow) => {
    const s = sessionsById.get(f.id);
    const row = model.rows[f.id];
    if (!s || !row) return null;
    const space = showAll ? projectName(s.projectId) : undefined;
    const descendantNeedsYou = row.state !== 'blocked' && row.effectiveState === 'blocked';
    const binding = bindings[s.id];
    return (
      <AgentRow
        key={s.id}
        session={s}
        row={row}
        icon={resolveAgentIcon({
          session: s,
          agents,
          boundCli: binding?.cli,
          handle: binding?.handle,
        })}
        label={SIDEBAR_STR.rowLabel({ name: s.name, state: row.state, space, descendantNeedsYou })}
        tooltip={agentRowTooltip({
          session: s,
          agentLabel: labelFor(s),
          state: SIDEBAR_STR.markTip(row.state),
          space,
          extra: tooltipExtra(s),
        })}
        space={row.depth === 0 ? space : undefined}
        now={now}
        selected={s.id === activeId}
        tabbable={s.id === tabId}
        pinned={ui.pinnedIds.includes(s.id)}
        guides={f.guides}
        lastChild={f.lastChild}
        editing={renamingId === s.id}
        onEditStart={() => onSetRenaming(s.id)}
        onEditEnd={() => onSetRenaming(null)}
        onRename={(name) => onRename(s.id, name)}
        onSelect={() => onSelect(s.id)}
        onPin={() => togglePin(s.id)}
        onClose={() => onKill(s.id)}
        onRelaunch={() => onRelaunch(s.id)}
        onFold={() => toggleFold(s.id)}
        onContextMenu={onContextMenu ? (e) => onContextMenu(e, s) : undefined}
        onFocus={() => {
          setFocusId(s.id);
          treeHadFocusRef.current = true;
        }}
        drag={{
          onDragStart: (e) => {
            dragIdRef.current = s.id;
            e.dataTransfer.effectAllowed = 'move';
          },
          onDragEnd: (e) => {
            onSessionDragEnd?.(s.id, e.screenX, e.screenY);
            dragIdRef.current = null;
            setDropKey(null);
          },
        }}
      />
    );
  };

  const liveCount = sessions.filter((s) => s.status === 'running').length;
  const selected = selectionKey(ui.selection);
  const shown = model.groups.length > 0;

  let empty: React.ReactNode = null;
  if (!sessionsLoaded) empty = <EmptyState role="status" title={SIDEBAR_STR.loading} />;
  else if (sessions.length === 0)
    empty = (
      <EmptyState
        variant="panel"
        title={SIDEBAR_STR.firstRunTitle}
        hint={SIDEBAR_STR.firstRunHint}
        action={
          <button type="button" className="btn btn--primary" onClick={onNew}>
            {SIDEBAR_STR.startAgent}
          </button>
        }
      />
    );
  else if (!shown && filter.trim() !== '')
    empty = (
      <EmptyState
        title={SIDEBAR_STR.noMatch(filter.trim())}
        action={
          <button type="button" className="btn" onClick={() => setFilter('')}>
            {SIDEBAR_STR.clearFilter}
          </button>
        }
      />
    );
  else if (!shown) empty = <EmptyState title={SIDEBAR_STR.emptySpace} />;

  return (
    <aside className="sidebar">
      <div className="sidebar__head" {...panelMoveDragProps(moveGrip)}>
        <span className="panel-title">{SIDEBAR_STR.spaces}</span>
        <div className="sidebar__head-actions">
          <button
            type="button"
            className="iconbtn iconbtn--sm"
            title={SIDEBAR_STR.addSpace}
            aria-label={SIDEBAR_STR.addSpace}
            onClick={() => {
              setCreateHint(null);
              setCreatingSpace(true);
            }}
          >
            <IconPlus size={15} />
          </button>
        </div>
      </div>
      <div className="spaces">
        {spaceRows.map((row) => (
          <SpaceRow
            key={row.key}
            row={row}
            name={spaceName(row)}
            detail={spaceDetail(row)}
            selected={selected === row.key}
            renaming={row.projectId !== null && renamingProjectId === row.projectId}
            dropCue={dropKey === row.key}
            drop={spaceDrop(row)}
            onPick={() => setUi({ selection: selectionOf(row) })}
            onMenu={(at, returnFocus) => openSpaceMenu(row, at, returnFocus)}
            onStartRename={() => setRenamingProjectId(row.projectId)}
            onRenameEnd={(draft) => {
              setRenamingProjectId(null);
              const project = projects.find((p) => p.id === row.projectId);
              const next =
                project && draft !== null ? renamedProjectName(draft, project.name) : null;
              if (project && next !== null)
                post({ type: 'project:rename', id: project.id, name: next });
            }}
          />
        ))}
        {creatingSpace && (
          <div className="space space--neutral">
            <span className="space__tile" aria-hidden />
            <RenameInput
              name=""
              label={SIDEBAR_STR.newSpaceName}
              onEnd={(d) => void createSpace(d)}
            />
          </div>
        )}
        {createHint && (
          <p className="spaces__hint" role="status">
            {createHint}
          </p>
        )}
      </div>

      <div className="sidebar__head">
        <span className="panel-title">{SIDEBAR_STR.agents}</span>
        {liveCount > 0 && <span className="sidebar__live">{SIDEBAR_STR.live(liveCount)}</span>}
        <div className="sidebar__head-actions">
          <button
            ref={searchRef}
            type="button"
            className="iconbtn iconbtn--sm"
            title={SIDEBAR_STR.searchAgents}
            aria-label={SIDEBAR_STR.searchAgents}
            aria-expanded={showFilter}
            aria-controls={filterId}
            // Keeps the filter's blur from hiding it before this click decides.
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => (showFilter && filter === '' ? setFilterOpen(false) : revealFilter())}
          >
            <IconSearch size={14} />
          </button>
          <button
            ref={newAgentRef}
            type="button"
            className="iconbtn iconbtn--sm"
            title={SIDEBAR_STR.newAgent}
            aria-label={SIDEBAR_STR.newAgent}
            onClick={onNew}
          >
            <IconPlus size={15} />
          </button>
        </div>
      </div>

      {showFilter && (
        <div className="sessbar" id={filterId}>
          <div className="searchbox">
            <IconSearch size={14} />
            <input
              ref={filterRef}
              className="sessbar__filter"
              placeholder={SIDEBAR_STR.filterPlaceholder}
              aria-label={SIDEBAR_STR.filterLabel}
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              onBlur={() => setFilterOpen(false)}
              onKeyDown={(e) => {
                if (e.key !== 'Escape') return;
                e.preventDefault();
                e.stopPropagation();
                setFilter('');
                setFilterOpen(false);
                searchRef.current?.focus();
              }}
            />
            {filter && (
              <button
                type="button"
                className="sessbar__clear"
                title={SIDEBAR_STR.clearFilter}
                aria-label={SIDEBAR_STR.clearFilter}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  setFilter('');
                  filterRef.current?.focus();
                }}
              >
                ✕
              </button>
            )}
          </div>
        </div>
      )}

      <div
        className={`sidebar__scroll${sessions.length === 0 ? ' sidebar__scroll--empty' : ''}`}
        onContextMenu={onPaneContextMenu}
      >
        {empty}
        {shown && (
          <div
            ref={treeRef}
            className="agents"
            data-agent-tree=""
            role="tree"
            aria-label={SIDEBAR_STR.agents}
            onKeyDown={onTreeKey}
            onBlur={(e) => {
              if (!e.currentTarget.contains(e.relatedTarget as Node | null))
                treeHadFocusRef.current = false;
            }}
          >
            {flat.map(({ group, rows }) => {
              const contentId = `${baseId}-group-${group.key}`;
              return (
                <div className="agents__section" role="none" key={group.key}>
                  <AgentGroupHeader
                    group={group.key}
                    roots={group.rootIds.length}
                    folded={group.folded}
                    controls={contentId}
                    onToggle={() => toggleGroup(group.key)}
                  />
                  <div
                    className="agents__group"
                    role="group"
                    id={contentId}
                    aria-label={SIDEBAR_STR.group(group.key)}
                  >
                    {rows.map(renderRow)}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      <div className="sidebar__foot">
        <button
          type="button"
          className="footbtn"
          onClick={onOpenSettings}
          title={SIDEBAR_STR.settingsTip}
        >
          <IconSettings size={15} />
          <span>{SIDEBAR_STR.settings}</span>
        </button>
      </div>

      {menu && <ContextMenu menu={menu} onClose={() => setMenu(null)} />}
      <div className="sr-only" aria-live="polite">
        {announcement}
      </div>
      <div className="sr-only" aria-live="polite">
        {treeAnnouncement}
      </div>
    </aside>
  );
}
