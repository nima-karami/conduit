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
  type AgentTreeGroup,
  type AgentTreeModel,
  buildAgentTree,
  buildSpaceRows,
  revealActive,
  type SpaceRowModel,
} from '../../src/agent-tree';
import type { McpNotConnected, McpSessionBadge } from '../../src/conduit-mcp/ui-types';
import type { MachineError, MachineView } from '../../src/contracts/machines';
import { type Rect, triggerMenu } from '../../src/menu-position';
import { normalizeProjectName, renamedProjectName } from '../../src/project-name';
import {
  deleteProjectDialog,
  openBoardTarget,
  sessionMatchesFilter,
} from '../../src/session-groups';
import type {
  AgentGroupKey,
  AgentState,
  SidebarUiState,
  SpaceSelection,
} from '../../src/sidebar-state';
import { agentKindOf, hasAgentFilters, viewSpaceRows } from '../../src/sidebar-view';
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
import type { RemoteKey, RemoteSessionRow as RemoteRow } from '../remote-sessions';
import {
  applyRowClick,
  descendantIds,
  NO_SELECTION,
  pruneSelection,
  type RowMenuScope,
  type RowSelection,
  selectPlain,
} from '../sidebar-selection';
import { SIDEBAR_STR } from '../sidebar-strings';
import { useSidebarTreeState } from '../sidebar-tree-state';
import { agentViewCounts, buildAgentsViewMenu, buildSpacesViewMenu } from '../sidebar-view-menu';
import { buildAgentsPaneMenu } from '../sort-filter-menu';
import type { ConfirmState } from './confirm-dialog';
import { ContextMenu, type MenuItem, type MenuState } from './context-menu';
import { EmptyState } from './empty-state';
import { type MachineAction, MachinesSection } from './machines-section';
import {
  AgentGroupHeader,
  type MenuAt,
  type SpaceDropHandlers,
  SpaceRow,
} from './project-group-header';
import { RemoteSessionRow } from './remote-session-row';
import { AgentRow, RenameInput, type RowGuides } from './session-card';
import { ViewMenu } from './view-menu';

const GROUP_NAV = 'group:';
const groupNavId = (g: AgentGroupKey) => `${GROUP_NAV}${g}`;
const isGroupNavId = (id: string) => id.startsWith(GROUP_NAV);

/** One rendered local row of the flattened, unfolded forest: the pointer and keyboard order. */
interface FlatRow {
  id: string;
  guides: RowGuides;
  lastChild: boolean;
}

/** One remote session drawn under its lead (plan decision 8). */
interface FlatRemote {
  remote: RemoteRow;
  depth: number;
  guides: RowGuides;
  lastChild: boolean;
}

/** The tree's direct children, in pointer and keyboard order. */
type TreeItem =
  | { kind: 'group'; key: AgentGroupKey; navId: string; group: AgentTreeGroup }
  | { kind: 'row'; key: string; navId: string; row: FlatRow; group: AgentGroupKey }
  | { kind: 'remote'; key: string; navId: string; flat: FlatRemote; group: AgentGroupKey };

const REMOTE_NAV = 'remote:';
const isRemoteNavId = (id: string) => id.startsWith(REMOTE_NAV);

/**
 * Depth-first over each unfolded group, iteratively (ancestry comes from persisted, possibly
 * malformed records). Guides say, per ancestor level, whether that ancestor has a later sibling,
 * so its vertical connector carries on past this row. A lead's remote sessions are its last
 * children, so they follow its local subtree.
 */
function flattenGroup(
  model: AgentTreeModel,
  rootIds: readonly string[],
  remoteByLead: ReadonlyMap<string, readonly RemoteRow[]>,
): (FlatRow | FlatRemote)[] {
  type Entry = {
    id: string;
    remote: RemoteRow | null;
    guides: boolean[];
    last: boolean;
    depth: number;
  };
  const out: (FlatRow | FlatRemote)[] = [];
  const stack: Entry[] = rootIds
    .map((id) => ({
      id,
      remote: null,
      guides: [] as boolean[],
      last: true,
      depth: model.rows[id]?.depth ?? 0,
    }))
    .reverse();
  while (stack.length > 0) {
    const cur = stack.pop() as Entry;
    if (cur.remote) {
      out.push({ remote: cur.remote, depth: cur.depth, guides: cur.guides, lastChild: cur.last });
      continue;
    }
    const row = model.rows[cur.id];
    if (!row) continue;
    out.push({ id: cur.id, guides: cur.guides, lastChild: cur.last });
    if (row.folded) continue;
    const kidGuides = row.depth === 0 ? [] : [...cur.guides, !cur.last];
    const kids: Entry[] = [
      ...row.childIds.map((id) => ({
        id,
        remote: null,
        guides: kidGuides,
        last: false,
        depth: row.depth + 1,
      })),
      ...(remoteByLead.get(cur.id) ?? []).map((r) => ({
        id: r.id,
        remote: r,
        guides: kidGuides,
        last: false,
        depth: row.depth + 1,
      })),
    ];
    for (let i = kids.length - 1; i >= 0; i--)
      stack.push({ ...kids[i], last: i === kids.length - 1 });
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

/** Keeps a repeated announcement distinct, so a live region speaks it again. */
const ZWSP = String.fromCharCode(0x200b);
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
  onRowMenu,
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
  remoteRows,
  machines,
  machineErrors,
  showMachines,
  activeRemoteId,
  onSelectRemote,
  onAddMachine,
  onMachineAction,
  onRenameMachine,
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
  /** `scope` carries the multi-selection and the row's sub-agents, so the menu can act on them. */
  onContextMenu?: (e: React.MouseEvent, session: Session, scope: RowMenuScope) => void;
  /** Shift+F10 / the Menu key on a row: the same menu, anchored to the row. */
  onRowMenu?: (session: Session, at: { anchor: Rect; keyboard: true }, scope: RowMenuScope) => void;
  /** Messaging state by session id, for the row tooltip (conduit-mcp spec §8). */
  mcpBadges: Readonly<Record<string, McpSessionBadge>>;
  /** Sessions whose agent CLI never reached the host, by session id (mcp-install spec §2.5). */
  mcpNotConnected: Readonly<Record<string, McpNotConnected>>;
  mcpEnabled: boolean;
  renamingId?: string;
  onSetRenaming: (id: string | null) => void;
  // Cross-window drag (multi-window Slice C): a row's dragend with the drop's global SCREEN
  // coords. The host hit-tests them — another window → move, empty desktop → tear out, this
  // window → no-op. A drop on a Space row is handled here as well.
  onSessionDragEnd?: (sessionId: string, screenX: number, screenY: number) => void;
  // The panel is rendered barless, so the Spaces header doubles as the panel-move drag surface.
  moveGrip?: MoveGrip;
  /** Remote sessions over ssh links, each with its lead's local id (plan decision 6). */
  remoteRows: readonly RemoteRow[];
  machines: readonly MachineView[];
  machineErrors: ReadonlyMap<string, MachineError>;
  /** The Machines band shows with no machine too (its empty state), when the setting is on. */
  showMachines: boolean;
  activeRemoteId: string | null;
  onSelectRemote: (key: RemoteKey) => void;
  onAddMachine: () => void;
  onMachineAction: (action: MachineAction, machine: MachineView) => void;
  /** The Rename field's result: the owner's new name for a machine (the menu's Rename). */
  onRenameMachine: (machine: MachineView, name: string) => void;
}) {
  const tree = useSidebarTreeState();
  const { ui, runtime, askSessionIds, bindings, updateUi, reportVisibleIds } = tree;
  const { agentsView, spacesView, setAgentsView, setSpacesView } = tree;
  const baseId = useId();
  const filterId = `${baseId}-filter`;
  const treeRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLButtonElement>(null);
  const filterRef = useRef<HTMLInputElement>(null);
  const newAgentRef = useRef<HTMLButtonElement>(null);

  const [filter, setFilter] = useState('');
  const [filterOpen, setFilterOpen] = useState(false);
  const [menu, setMenu] = useState<MenuState | null>(null);
  // Renderer-only multi-selection (CON-167); never persisted.
  const [selection, setSelection] = useState<RowSelection>(NO_SELECTION);
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
        lastFocusedBySpace: tree.lastFocusedBySpace,
      }),
    [projects, sessions, runtime, askSessionIds, tree.lastFocusedBySpace],
  );
  const visibleSpaceRows = useMemo(
    () =>
      viewSpaceRows(spaceRows, spacesView, { sessions, selectedKey: selectionKey(ui.selection) }),
    [spaceRows, spacesView, sessions, ui.selection],
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
  // A session that closes elsewhere drops out of the selection.
  useEffect(() => {
    const live = new Set(sessions.map((s) => s.id));
    setSelection((cur) => pruneSelection(cur, live));
  }, [sessions]);

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
  const kindOf = useCallback(
    (s: Session) =>
      agentKindOf(
        resolveAgentIcon({
          session: s,
          agents,
          boundCli: bindings[s.id]?.cli,
          handle: bindings[s.id]?.handle,
        }),
      ),
    [agents, bindings],
  );
  // The By space groups follow the order the Spaces panel shows.
  const groupSpaces = useMemo(
    () => visibleSpaceRows.flatMap((r) => (r.projectId === null ? [] : [{ id: r.projectId }])),
    [visibleSpaceRows],
  );
  // A remote session is drawn under its local lead only; with no lead it lives under its machine.
  const remoteByLead = useMemo(() => {
    const byLead = new Map<string, RemoteRow[]>();
    for (const r of remoteRows) {
      if (r.parentSessionId === null) continue;
      const list = byLead.get(r.parentSessionId) ?? [];
      list.push(r);
      byLead.set(r.parentSessionId, list);
    }
    return byLead;
  }, [remoteRows]);
  const remoteChildren = useMemo(
    () => new Map([...remoteByLead].map(([id, list]) => [id, list.length] as const)),
    [remoteByLead],
  );
  const remoteById = useMemo(() => new Map(remoteRows.map((r) => [r.id, r])), [remoteRows]);
  const model = useMemo(
    () =>
      buildAgentTree({
        sessions,
        runtime,
        ui,
        matchingIds,
        askSessionIds,
        view: agentsView,
        kindOf,
        spaces: groupSpaces,
        remoteChildren,
      }),
    [
      sessions,
      runtime,
      ui,
      matchingIds,
      askSessionIds,
      agentsView,
      kindOf,
      groupSpaces,
      remoteChildren,
    ],
  );
  // Reveal once per change of the active agent, as soon as its session exists and the saved fold
  // state has landed; a fold the user makes afterwards stays folded.
  const revealedRef = useRef<string | null>(null);
  useEffect(() => {
    if (!tree.hydrated || activeId === undefined || revealedRef.current === activeId) return;
    if (!sessions.some((s) => s.id === activeId)) return;
    // A Space or search that hides the active row consumes the reveal; switching Space later must
    // not unfold what the user folded.
    revealedRef.current = activeId;
    const next = revealActive(ui, model, activeId);
    if (next !== ui) updateUi(next);
  }, [tree.hydrated, activeId, sessions, model, ui, updateUi]);
  // One flat list of direct children of the tree — group headers and rows alike — so a row whose
  // state moves it to another group keeps its DOM node, its focus and an open rename.
  const items = useMemo(() => {
    const out: TreeItem[] = [];
    for (const g of model.groups) {
      // Group: None has no header; its rows are the list.
      if (g.key !== 'flat')
        out.push({ kind: 'group', key: g.key, navId: groupNavId(g.key), group: g });
      if (g.folded) continue;
      for (const f of flattenGroup(model, g.rootIds, remoteByLead)) {
        if ('remote' in f)
          out.push({ kind: 'remote', key: f.remote.id, navId: f.remote.id, flat: f, group: g.key });
        else out.push({ kind: 'row', key: f.id, navId: f.id, row: f, group: g.key });
      }
    }
    return out;
  }, [model, remoteByLead]);
  const navIds = useMemo(() => items.map((it) => it.navId), [items]);
  const groupOfRow = useMemo(
    () =>
      new Map(items.flatMap((it) => (it.kind === 'group' ? [] : [[it.key, it.group] as const]))),
    [items],
  );
  const visibleIds = model.visibleIds;
  // Visible session rows in order: the axis a Shift+click range is cut from.
  const visibleRowIds = useMemo(
    () => items.flatMap((it) => (it.kind === 'row' ? [it.key] : [])),
    [items],
  );
  // A plain click opens the row as it always did; Ctrl/Cmd and Shift only change the selection.
  const onRowClick = (id: string, e: React.MouseEvent) => {
    if (!e.ctrlKey && !e.metaKey && !e.shiftKey) {
      setSelection(selectPlain(id));
      onSelect(id);
      return;
    }
    setSelection(
      applyRowClick(
        selection,
        id,
        { ctrl: e.ctrlKey || e.metaKey, shift: e.shiftKey },
        visibleRowIds,
      ),
    );
  };
  const scopeFor = (id: string): RowMenuScope => ({
    selectedIds: selection.ids.includes(id) ? selection.ids : [],
    subAgentIds: descendantIds((x) => model.rows[x]?.childIds ?? [], id),
  });
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

  // Roving focus: one tab stop in the tree — the focused item, else the selected row, else the
  // first item.
  const [focusId, setFocusId] = useState<string | null>(null);
  const tabId =
    focusId !== null && navIds.includes(focusId)
      ? focusId
      : activeId !== undefined && navIds.includes(activeId)
        ? activeId
        : (navIds[0] ?? null);
  const activeShown = activeId !== undefined && navIds.includes(activeId);
  useEffect(() => {
    if (activeId === undefined || !activeShown) return;
    treeRef.current
      ?.querySelector(`[role="treeitem"][data-sessionid="${cssId(activeId)}"]`)
      ?.scrollIntoView({ block: 'nearest' });
  }, [activeId, activeShown]);
  const focusItem = useCallback((navId: string) => {
    setFocusId(navId);
    const sel = isGroupNavId(navId)
      ? `[role="treeitem"][data-agent-group="${cssId(navId.slice(GROUP_NAV.length))}"]`
      : isRemoteNavId(navId)
        ? `[role="treeitem"][data-remote-id="${cssId(navId)}"]`
        : `[role="treeitem"][data-sessionid="${cssId(navId)}"]`;
    treeRef.current?.querySelector<HTMLElement>(sel)?.focus();
  }, []);

  // A focused item that vanished (closed, folded away, filtered) hands focus to its nearest
  // visible ancestor, else the nearest item, else New agent — only if focus was in the tree when
  // it went, or the item's own menu removed it (spec §9).
  const prevNavRef = useRef<readonly string[]>(navIds);
  const prevGroupOfRowRef = useRef(groupOfRow);
  const treeHadFocusRef = useRef(false);
  useEffect(() => {
    const prev = prevNavRef.current;
    const prevGroups = prevGroupOfRowRef.current;
    prevNavRef.current = navIds;
    prevGroupOfRowRef.current = groupOfRow;
    if (focusId === null || navIds.includes(focusId) || !treeHadFocusRef.current) return;
    const active = document.activeElement;
    if (active && active !== document.body && !treeRef.current?.contains(active)) return;
    let next: string | undefined;
    let p = isRemoteNavId(focusId)
      ? (remoteById.get(focusId)?.parentSessionId ?? null)
      : (model.rows[focusId]?.parentId ?? null);
    while (p !== null && next === undefined) {
      if (navIds.includes(p)) next = p;
      else p = model.rows[p]?.parentId ?? null;
    }
    const formerGroup = prevGroups.get(focusId);
    if (next === undefined && formerGroup !== undefined) {
      const g = groupNavId(formerGroup);
      // Folding a group away: its header is the parent.
      if (navIds.includes(g) && model.groups.find((x) => x.key === formerGroup)?.folded) next = g;
    }
    if (next === undefined) {
      const at = prev.indexOf(focusId);
      for (let i = at; i >= 0 && next === undefined; i--)
        if (navIds.includes(prev[i]) && !isGroupNavId(prev[i])) next = prev[i];
      next ??= prev.slice(at + 1).find((id) => navIds.includes(id) && !isGroupNavId(id));
    }
    if (next !== undefined) focusItem(next);
    else {
      setFocusId(null);
      treeHadFocusRef.current = false;
      newAgentRef.current?.focus();
    }
  }, [navIds, groupOfRow, focusId, model, remoteById, focusItem]);

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
  const toggleGroup = (g: AgentGroupKey) => {
    const folded = ui.foldedGroups.includes(g);
    setUi({
      foldedGroups: folded ? ui.foldedGroups.filter((x) => x !== g) : [...ui.foldedGroups, g],
    });
  };
  // A menu picked from a row may remove it (Close): remember the row so focus can be repaired.
  const noteMenuRow = (id: string) => {
    setFocusId(id);
    treeHadFocusRef.current = true;
  };

  const onTreeKey = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape' && selection.ids.length > 0) {
      e.preventDefault();
      setSelection(NO_SELECTION);
      return;
    }
    const el = e.target as HTMLElement;
    if (el.getAttribute('role') !== 'treeitem') return;
    const groupKey = el.dataset.agentGroup as AgentGroupKey | undefined;
    const navId =
      groupKey !== undefined ? groupNavId(groupKey) : (el.dataset.sessionid ?? el.dataset.remoteId);
    if (navId === undefined) return;
    const at = navIds.indexOf(navId);
    const go = (target: string | undefined) => {
      e.preventDefault();
      if (target !== undefined) focusItem(target);
    };
    switch (e.key) {
      case 'ArrowDown':
        return go(navIds[at + 1]);
      case 'ArrowUp':
        return go(at > 0 ? navIds[at - 1] : undefined);
      case 'Home':
        return go(navIds[0]);
      case 'End':
        return go(navIds[navIds.length - 1]);
    }
    if (groupKey !== undefined) {
      const group = model.groups.find((g) => g.key === groupKey);
      if (!group) return;
      if (e.key === 'ArrowRight') {
        e.preventDefault();
        if (group.folded) toggleGroup(groupKey);
        else if (group.rootIds[0] !== undefined) focusItem(group.rootIds[0]);
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault();
        if (!group.folded) toggleGroup(groupKey);
      }
      // Enter and Space are the header button's own click.
      return;
    }
    if (isRemoteNavId(navId)) {
      const r = remoteById.get(navId);
      if (!r) return;
      if (e.key === 'ArrowLeft') {
        e.preventDefault();
        if (r.parentSessionId !== null && navIds.includes(r.parentSessionId))
          focusItem(r.parentSessionId);
      } else if (e.key === 'Enter') {
        e.preventDefault();
        setFocusId(navId);
        onSelectRemote(r.key);
      }
      return;
    }
    const id = navId;
    const row = model.rows[id];
    if (!row) return;
    const hasKids = row.childIds.length > 0 || row.remoteChildCount > 0;
    switch (e.key) {
      case 'ArrowRight': {
        if (!hasKids) return;
        e.preventDefault();
        if (row.folded) {
          toggleFold(id);
          return;
        }
        const first = row.childIds[0] ?? remoteByLead.get(id)?.[0]?.id;
        if (first !== undefined) focusItem(first);
        return;
      }
      case 'ArrowLeft': {
        e.preventDefault();
        if (hasKids && !row.folded) return toggleFold(id);
        if (row.parentId !== null && navIds.includes(row.parentId)) return focusItem(row.parentId);
        const g = groupOfRow.get(id);
        if (row.depth === 0 && g !== undefined && navIds.includes(groupNavId(g)))
          focusItem(groupNavId(g));
        return;
      }
      case 'Enter':
        e.preventDefault();
        setSelection(selectPlain(id));
        onSelect(id);
        return;
      case 'F2':
        e.preventDefault();
        onSetRenaming(id);
        return;
      case 'ContextMenu':
      case 'F10': {
        if (e.key === 'F10' && !e.shiftKey) return;
        const s = sessionsById.get(id);
        if (!onRowMenu || !s) return;
        // Claimed here, so the browser's own contextmenu event never opens a second menu.
        e.preventDefault();
        const r = el.getBoundingClientRect();
        noteMenuRow(id);
        onRowMenu(
          s,
          {
            anchor: { left: r.left, right: r.right, top: r.top, bottom: r.bottom },
            keyboard: true,
          },
          scopeFor(id),
        );
        return;
      }
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
    // A live region speaks only on a change, so a repeat differs by a zero-width space.
    const text = said.join('. ');
    if (said.length > 0) setTreeAnnouncement((cur) => (cur === text ? `${text}${ZWSP}` : text));
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
        selected={s.id === activeId && activeRemoteId === null}
        multiSelected={selection.ids.includes(s.id)}
        tabbable={s.id === tabId}
        pinned={ui.pinnedIds.includes(s.id)}
        guides={f.guides}
        lastChild={f.lastChild}
        editing={renamingId === s.id}
        onEditStart={() => onSetRenaming(s.id)}
        onEditEnd={() => onSetRenaming(null)}
        onRename={(name) => onRename(s.id, name)}
        onSelect={(e) => onRowClick(s.id, e)}
        onPin={() => togglePin(s.id)}
        onClose={() => onKill(s.id)}
        onRelaunch={() => onRelaunch(s.id)}
        onFold={() => toggleFold(s.id)}
        onContextMenu={
          onContextMenu
            ? (e) => {
                noteMenuRow(s.id);
                // Right-clicking outside the selection moves it to that row, as a file manager does.
                if (!selection.ids.includes(s.id)) setSelection(selectPlain(s.id));
                onContextMenu(e, s, scopeFor(s.id));
              }
            : undefined
        }
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

  const renderRemote = (f: FlatRemote) => (
    <RemoteSessionRow
      key={f.remote.id}
      row={f.remote}
      depth={f.depth}
      level={f.depth + 2}
      guides={f.guides}
      lastChild={f.lastChild}
      selected={activeRemoteId === f.remote.id}
      tabbable={f.remote.id === tabId}
      onSelect={() => {
        setFocusId(f.remote.id);
        onSelectRemote(f.remote.key);
      }}
      onFocus={() => {
        setFocusId(f.remote.id);
        treeHadFocusRef.current = true;
      }}
    />
  );

  const liveCount = sessions.filter((s) => s.status === 'running').length;
  const agentsMenu = buildAgentsViewMenu(
    agentsView,
    agentViewCounts(sessions, runtime, askSessionIds, {
      selection: ui.selection,
      matchingIds,
    }),
    setAgentsView,
  );
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
  else if (!shown && hasAgentFilters(agentsView))
    empty = (
      <p className="agents__nomatch" role="status">
        {SIDEBAR_STR.viewMenu.noAgentsMatch}
        {agentsMenu.reset && (
          <button type="button" className="viewmenu__reset" onClick={agentsMenu.reset}>
            {SIDEBAR_STR.viewMenu.reset}
          </button>
        )}
      </p>
    );
  else if (!shown) empty = <EmptyState title={SIDEBAR_STR.emptySpace} />;

  return (
    <aside className="sidebar">
      <div className="panel-head" {...panelMoveDragProps(moveGrip)}>
        <span className="panel-title">{SIDEBAR_STR.spaces}</span>
        <div className="panel-head__actions">
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
          <ViewMenu
            label={SIDEBAR_STR.viewMenu.spacesLabel}
            model={buildSpacesViewMenu(spacesView, setSpacesView)}
          />
        </div>
      </div>
      <div className="spaces">
        {visibleSpaceRows.map((row) => (
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

      <div className="panel-head">
        <span className="panel-title">{SIDEBAR_STR.agents}</span>
        {liveCount > 0 && <span className="sidebar__live">{SIDEBAR_STR.live(liveCount)}</span>}
        <div className="panel-head__actions">
          <button
            ref={searchRef}
            type="button"
            className="iconbtn iconbtn--sm"
            title={SIDEBAR_STR.searchAgents}
            aria-label={SIDEBAR_STR.searchAgents}
            aria-expanded={showFilter}
            aria-controls={showFilter ? filterId : undefined}
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
          <ViewMenu label={SIDEBAR_STR.viewMenu.agentsLabel} model={agentsMenu} />
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
            aria-multiselectable="true"
            onKeyDown={onTreeKey}
            onBlur={(e) => {
              // Only a move to a real element outside counts: a removed row blurs to nothing.
              const to = e.relatedTarget;
              if (to instanceof Element && !e.currentTarget.contains(to))
                treeHadFocusRef.current = false;
            }}
          >
            {items.map((it) =>
              it.kind === 'group' ? (
                <AgentGroupHeader
                  key={`group:${it.key}`}
                  group={it.group.key}
                  spaceName={
                    it.group.key.startsWith('space:')
                      ? projectName(it.group.key.slice('space:'.length))
                      : undefined
                  }
                  roots={it.group.rootIds.length}
                  folded={it.group.folded}
                  tabbable={it.navId === tabId}
                  onToggle={() => toggleGroup(it.group.key)}
                  onFocus={() => {
                    setFocusId(it.navId);
                    treeHadFocusRef.current = true;
                  }}
                />
              ) : it.kind === 'row' ? (
                renderRow(it.row)
              ) : (
                renderRemote(it.flat)
              ),
            )}
          </div>
        )}
        {(showMachines || machines.length > 0) && (
          <MachinesSection
            machines={machines}
            remoteRows={remoteRows}
            machineErrors={machineErrors}
            activeRemoteId={activeRemoteId}
            onSelectRemote={onSelectRemote}
            onAddMachine={onAddMachine}
            onMachineAction={onMachineAction}
            onRenameMachine={onRenameMachine}
            onConfirm={onConfirm}
          />
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
