import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { activeCwd } from '../src/active-cwd';
import { centerFacingEdge, parseLayout, type Region, serializeLayout } from '../src/layout';
import type { NavLoc } from '../src/nav-history';
import { resolveOwningSession } from '../src/owning-session';
import type { FileContentDTO, FileDiffDTO, HostToWebview, SearchHit } from '../src/protocol';
import { quitConfirmCopy } from '../src/quit-guard';
import { staleRelaunchTargets } from '../src/stale-sessions';
import type { AgentDefinition, Session } from '../src/types';
import { fsDndCopy, fsDndMove, fsMutate, gitAction, logToHost, post, subscribe } from './bridge';
import { closeAllIds, closeOthersIds } from './bulk-close';
import { type CenterView, centerViewForAction, nextCenterView } from './center-view';
import { AnimatedBg } from './components/animated-bg';
import { ArchitectureView } from './components/architecture-view';
import { BoardView } from './components/board-view';
import { CenterPane } from './components/center-pane';
import { CommandPalette, type PaletteEntry } from './components/command-palette';
import { ConfirmDialog, type ConfirmState } from './components/confirm-dialog';
import { ContextMenu, type MenuItem, type MenuState } from './components/context-menu';
import { ErrorBoundary } from './components/error-boundary';
import { IconPickerModal } from './components/icon-picker-modal';
import { NewSessionModal } from './components/new-session-modal';
import { type DockHandlers, PanelFrame } from './components/panel-frame';
import { type GitActionIntent, RightPane, type RightPaneHandle } from './components/right-pane';
import { SettingsModal } from './components/settings-modal';
import { Sidebar } from './components/sidebar';
import { Toasts } from './components/toasts';
import { TopBar } from './components/top-bar';
import type { UpdateStatus } from './components/update-card';
import { WebPromptModal } from './components/web-prompt-modal';
import { clearDirty, getDirtySnapshot, subscribeDirty } from './dirty-store';
import { reorderDock } from './dock-reorder';
import type { OpenDoc } from './docs';
import {
  docsReducer,
  GIT_HISTORY_DOC_PATH,
  initialDocs,
  REVIEW_DOC_ID,
  REVIEW_DOC_PATH,
} from './docs';
import { shouldReplaceContent } from './file-freshness';
import {
  affectedDirs,
  applyRedo,
  applyUndo,
  type FsOp,
  type FsUndoState,
  type InverseAction,
  invert,
  pushOp,
  redoActions,
} from './fs-undo';
import {
  IconBoard,
  IconBranch,
  IconCheck,
  IconClose,
  IconCommand,
  IconCopy,
  IconDoc,
  IconDuplicate,
  IconExternal,
  IconGraph,
  IconPencil,
  IconPlus,
  IconReview,
  IconSearch,
  IconSettings,
  IconSidebar,
  IconSparkle,
  IconTerminal,
  IconTrash,
} from './icons';
import { formatMention } from './mention';
import { setMentionSink } from './mention-bus';
import { warmWorkerFromMonaco } from './monaco-warmup-bind';
import { buildPanelToggleItems, type HideablePanel, paletteCommandTitle } from './panel-visibility';
import { indexModels, setDefinitionOpener, setReveal } from './project-index';
import {
  getSaveEntry,
  onFileSaved,
  revertDocByPath,
  saveActiveDoc,
  saveAllDirtyDocs,
} from './save-registry';
import { useSettings } from './settings';
import { effectiveCombo, matchCombo, SHORTCUT_ACTIONS } from './shortcuts';
import { closeTabSelection } from './tab-close-selection';
import { THEMES } from './themes';
import { pushToast } from './toast-store';
import { isComboAllowedWhileTyping, isTypingEntry } from './typing-guard';
import { useNavHistory } from './use-nav-history';

type StateMsg = Extract<HostToWebview, { type: 'state' }>;
type ProjectMsg = Extract<HostToWebview, { type: 'project' }>;
type SettingsTab = 'general' | 'appearance' | 'shortcuts' | 'about';
const baseName = (p: string) => p.split(/[\\/]/).filter(Boolean).pop() || p;

const joinPath = (base: string, rel: string) =>
  `${base.replace(/[\\/]+$/, '')}/${rel}`.replace(/\\/g, '/');

const isCodeFile = (p: string) => /\.(ts|tsx|js|jsx|mts|cts|mjs|cjs)$/i.test(p);

export function App() {
  const [state, setState] = useState<StateMsg | null>(null);
  const [activeId, setActiveId] = useState<string | undefined>();
  const [project, setProject] = useState<ProjectMsg | null>(null);
  // The new-session flow. `null` = closed. A non-null object opens the modal; an
  // optional prefill (N2) preselects the board's project + carries the originating
  // card id so the created session can be stamped with it.
  const [newSession, setNewSession] = useState<{
    path?: string;
    cardId?: string;
    cardTitle?: string;
    // R4.13: when the omni-bar picks an Agent, preselect that agent/terminal in the flow.
    agentId?: string;
  } | null>(null);
  const openNewSession = useCallback(() => setNewSession({}), []);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [webPromptOpen, setWebPromptOpen] = useState(false);
  const [docState, dispatchDocs] = useReducer(docsReducer, initialDocs);
  const [files, setFiles] = useState<Map<string, FileContentDTO>>(new Map());
  const [diffs, setDiffs] = useState<Map<string, FileDiffDTO>>(new Map());
  const [palette, setPalette] = useState<{ initialQuery: string } | null>(null);
  const [settingsTab, setSettingsTab] = useState<SettingsTab>('general');
  const [recentsBySession, setRecentsBySession] = useState<
    Record<string, { kind: 'file' | 'diff'; path: string }[]>
  >({});
  const [search, setSearch] = useState<{ root: string; results: SearchHit[] }>({
    root: '',
    results: [],
  });
  const [menu, setMenu] = useState<MenuState | null>(null);
  // Multi-window Slice B: the other open windows for the "Move to window…" picker. Updated
  // from the host's `win:list` broadcast; this window's own id comes from `state.windowId`.
  const [winList, setWinList] = useState<{ id: number; title: string; sessionCount: number }[]>([]);
  const [renamingId, setRenamingId] = useState<string | undefined>(undefined);
  const [confirm, setConfirm] = useState<ConfirmState | null>(null);
  const [updateStatus, setUpdateStatus] = useState<UpdateStatus | null>(null);
  const [updateDismissed, setUpdateDismissed] = useState(false);
  // D3: session icon-picker modal state. `null` = closed; non-null = picker open for session.id.
  const [iconPickerSessionId, setIconPickerSessionId] = useState<string | null>(null);
  const [centerView, setCenterView] = useState<CenterView>('editor');
  const [splitId, setSplitId] = useState<string | null>(null);
  const dragRegionRef = useRef<Region | null>(null);
  const [overRegion, setOverRegion] = useState<Region | null>(null);
  // W2: holds the cancel-reply callback when a host `confirmQuit` dialog is open.
  // Called by the ConfirmDialog onClose wrapper so reply(false) fires on Cancel/Esc.
  const quitCancelRef = useRef<(() => void) | null>(null);
  const { hydrate, settings, update } = useSettings();

  // ---- App-level undo/redo for file-explorer operations ----
  const [fsUndoState, setFsUndoState] = useState<FsUndoState>({ undo: [], redo: [] });
  // Keep undo state in a ref so the async executor can always read the latest value.
  const fsUndoRef = useRef(fsUndoState);
  fsUndoRef.current = fsUndoState;

  // Subscribe to the shared dirty set so we can check dirty state on tab close.
  const dirtySet = useSyncExternalStore(subscribeDirty, getDirtySnapshot, getDirtySnapshot);

  // Panel visibility is persisted LAYOUT state (mirrors panel order/widths), so a
  // hidden panel stays hidden across reloads. The center column is flex, so
  // filtering a hidden region out of `visibleOrder` reflows the center wider.
  const sidebarCollapsed = settings.sidebarCollapsed;
  const explorerCollapsed = settings.explorerCollapsed;
  const toggleSidebar = useCallback(
    () => update({ sidebarCollapsed: !settings.sidebarCollapsed }),
    [settings.sidebarCollapsed, update],
  );
  const toggleExplorer = useCallback(
    () => update({ explorerCollapsed: !settings.explorerCollapsed }),
    [settings.explorerCollapsed, update],
  );
  const togglePanel = useCallback(
    (panel: HideablePanel) => (panel === 'sessions' ? toggleSidebar() : toggleExplorer()),
    [toggleSidebar, toggleExplorer],
  );

  useEffect(() => {
    return subscribe((msg) => {
      if (msg.type === 'state') {
        setState(msg);
        hydrate(msg.settings);
      } else if (msg.type === 'win:list') setWinList(msg.windows);
      else if (msg.type === 'project') setProject(msg);
      else if (msg.type === 'fileContent') {
        // K3 dirty-buffer protection: a fresh disk read must NOT replace the map entry
        // for a path whose Monaco buffer is dirty — CodeViewer's seed effect is keyed on
        // `doc.content`, so re-seeding would destroy the user's unsaved edits. A clean
        // path picks up the fresh content. See file-freshness.ts.
        const path = msg.doc.path;
        if (shouldReplaceContent(path, getDirtySnapshot().has(path))) {
          setFiles((m) => new Map(m).set(path, msg.doc));
        }
      } else if (msg.type === 'fileDiff') setDiffs((m) => new Map(m).set(msg.doc.path, msg.doc));
      else if (msg.type === 'searchResults') setSearch({ root: msg.root, results: msg.results });
      else if (msg.type === 'projectFiles') {
        indexModels(msg.files);
        // Once-guarded inside: warms the TS-worker early so the first go-to-definition
        // isn't paying a cold start (wishlist E1).
        warmWorkerFromMonaco();
      } else if (msg.type === 'error') {
        // A host-side failure (e.g. a failed `.conduit/` save) must be VISIBLE, not
        // silently dropped (ADR §5), so the user never "thinks it saved and didn't."
        logToHost(`host error: ${msg.message}`);
        setConfirm({
          title: 'Something went wrong',
          message: msg.message,
          confirmLabel: 'Dismiss',
          onConfirm: () => {},
        });
      } else if (msg.type === 'activateSession') {
        // Host requests the renderer to bring a session into focus — e.g. after the
        // user clicks an OS notification for a backgrounded session (T1A).
        setActiveId(msg.sessionId);
      } else if (msg.type === 'openFileInEditor') {
        // OS "Open with Conduit": enqueue the open; the flush effect opens it once the
        // target session is present in state (it may have just been created host-side).
        pendingOsOpensRef.current.push({ path: msg.path, sessionId: msg.sessionId });
        flushOsOpensRef.current();
      } else if (msg.type === 'fileChanged') {
        // A file open in a tab changed on disk. Re-read it; the fileContent handler's
        // dirty-buffer protection still withholds clobbering an unsaved buffer.
        post({ type: 'readFile', path: msg.path });
      } else if (msg.type === 'updateStatus') {
        setUpdateStatus(msg);
        // A freshly-staged update un-dismisses the sidebar card (the user may have
        // dismissed it during a prior download). The Settings → About row reflects the
        // rest of the lifecycle inline, so no toast is needed.
        if (msg.status === 'ready') setUpdateDismissed(false);
      } else if (msg.type === 'confirmQuit') {
        // W2: main asks us to confirm quit/close/update-relaunch for running sessions.
        // focusCancel makes Cancel the keyboard default so an accidental Enter does not
        // quit. Esc = cancel via onClose wrapper.
        const fakeSessions = Array.from({ length: msg.running }, (_, i) => ({
          id: `run-${i}`,
          name: '',
          agentId: '',
          projectPath: '',
          status: 'running' as const,
          createdAt: 0,
          lastActiveAt: 0,
        }));
        const copy = quitConfirmCopy({ running: fakeSessions, busy: msg.busy, reason: msg.reason });
        const reply = (proceed: boolean) => post({ type: 'quitDecision', proceed });
        quitCancelRef.current = () => reply(false);
        // ACK that the dialog is on screen so the host disarms its wedged-renderer
        // fallback: a dialog the user is reading must never auto-resolve.
        post({ type: 'quitDialogShown' });
        setConfirm({
          title: copy.title,
          message: copy.body,
          confirmLabel: copy.confirmLabel,
          danger: true,
          focusCancel: true,
          onConfirm: () => {
            quitCancelRef.current = null;
            reply(true);
          },
        });
      }
    });
  }, [hydrate]);

  // K3: subscribe to successful saves so the files map is updated immediately
  // (without a host round-trip). This ensures the markdown rendered view shows
  // fresh content after an in-editor save, regardless of which path triggered it.
  useEffect(() => {
    return onFileSaved((path, content) => {
      setFiles((m) => {
        const existing = m.get(path);
        if (!existing) return m;
        return new Map(m).set(path, { ...existing, content });
      });
    });
  }, []);

  // Best-effort save-all on browser navigation/refresh (beforeunload). This fires
  // reliably in the browser preview; in the Electron host it rarely fires on OS-level
  // window close (the host closes windows directly, bypassing beforeunload). A proper
  // Electron close interceptor is out of scope — see docs/specs/archive/2026-06-11-editor-depth.md.
  useEffect(() => {
    const onUnload = () => {
      const dirty = getDirtySnapshot();
      if (dirty.size > 0) void saveAllDirtyDocs(dirty);
    };
    window.addEventListener('beforeunload', onUnload);
    return () => window.removeEventListener('beforeunload', onUnload);
  }, []);

  const sessions: Session[] = useMemo(
    () => state?.sessions ?? (state?.groups ?? []).flatMap((g) => g.sessions),
    [state],
  );
  const agents: AgentDefinition[] = state?.agents ?? [];

  // Auto-switch to a newly created (running) session (when enabled).
  const knownIds = useRef<Set<string>>(new Set());
  useEffect(() => {
    const added = sessions.filter((s) => !knownIds.current.has(s.id));
    knownIds.current = new Set(sessions.map((s) => s.id));
    if (!settings.autoSwitchSession) return;
    const newest = added
      .filter((s) => s.status === 'running')
      .sort((a, b) => b.createdAt - a.createdAt)[0];
    if (newest) setActiveId(newest.id);
  }, [sessions, settings.autoSwitchSession]);

  // Auto-relaunch stale sessions on the FIRST state message after startup (T1B).
  // A ref guards against re-firing on every subsequent state broadcast. Only fires
  // when the setting is ON; default is OFF so no behavior change for existing users.
  const autoRelaunchDoneRef = useRef(false);
  useEffect(() => {
    if (autoRelaunchDoneRef.current) return;
    if (!state) return;
    autoRelaunchDoneRef.current = true;
    if (!settings.autoRelaunchStale) return;
    const targets = staleRelaunchTargets(sessions);
    for (const id of targets) {
      post({ type: 'relaunch', id });
    }
  }, [state, sessions, settings.autoRelaunchStale]);

  // Relaunch all sessions that are currently stale (manual trigger — also used by
  // the "Relaunch all stale" command palette entry).
  const relaunchAllStale = useCallback(() => {
    const targets = staleRelaunchTargets(sessions);
    for (const id of targets) {
      post({ type: 'relaunch', id });
    }
  }, [sessions]);

  // Imperative bridge to the Explorer's RightPane so Mod+Shift+F can switch it to the
  // Search tab and focus the query input (L5).
  const rightPaneRef = useRef<RightPaneHandle | null>(null);
  // Open global search: ensure the Explorer panel is visible, then focus the Search tab.
  // `update` persists the un-collapse; the focus call is deferred a frame inside openSearch.
  const openGlobalSearch = useCallback(() => {
    if (settings.explorerCollapsed) update({ explorerCollapsed: false });
    requestAnimationFrame(() => rightPaneRef.current?.openSearch());
  }, [settings.explorerCollapsed, update]);

  // Switch the center pane from an action id, via the single tested mapping.
  const openView = useCallback((actionId: string) => {
    const view = centerViewForAction(actionId);
    if (view) setCenterView(view);
  }, []);

  // R5.5: open the Review-changes view as a singleton editor tab (not a center-view
  // overlay). Ensure the center is on the editor so the tab area is visible, then
  // open/activate the review doc. Opening it again just re-activates the one tab.
  const openReviewTab = useCallback(() => {
    setCenterView('editor');
    dispatchDocs({
      type: 'open',
      kind: 'review',
      path: REVIEW_DOC_PATH,
      sessionId: activeIdRef.current ?? '',
    });
  }, []);

  // git-history Slice A: open the commit-graph as a singleton center-pane doc for the
  // active session (scoped to its repo), mirroring openReviewTab. Re-opening just
  // re-activates the one tab (and transfers ownership to the now-active session).
  const openGitHistoryTab = useCallback(() => {
    setCenterView('editor');
    dispatchDocs({
      type: 'open',
      kind: 'git-history',
      path: GIT_HISTORY_DOC_PATH,
      sessionId: activeIdRef.current ?? '',
    });
  }, []);

  // Latest docs snapshot in a ref so the global Mod+S handler (bound once) can route to
  // the ACTIVE doc's registered save without re-binding the listener on every doc change.
  const docStateRef = useRef(docState);
  docStateRef.current = docState;
  // Latest active session id in a ref so doc-open callbacks can stamp the owning
  // session without re-binding on every active-session change (see closeSession).
  const activeIdRef = useRef(activeId);
  activeIdRef.current = activeId;

  // OS file-open requests (openFileInEditor) that arrived before their target session
  // landed in `state`. The host may create a session and immediately send the open; the
  // session id only becomes addressable once its `state` broadcast arrives. We enqueue
  // every request and drain it from the sessions-flush effect once the session exists, so
  // a just-created-session open is never dropped (open-after-ready). See electron/main.ts.
  const pendingOsOpensRef = useRef<{ path: string; sessionId: string }[]>([]);

  // Stable refs for the fs-undo handlers — populated after their useCallback
  // declarations below. Using refs keeps actionMap free of those deps (which
  // would otherwise create a circular ordering problem: actionMap is declared
  // before `active` is derived, but doUndo/doRedo depend on active-derived hooks).
  const doUndoRef = useRef<() => void>(() => {});
  const doRedoRef = useRef<() => void>(() => {});

  // Global shortcuts — data-driven from the (rebindable, persisted) bindings.
  const actionMap = useMemo<Record<string, () => void>>(
    () => ({
      openSearch: () => setPalette({ initialQuery: '' }),
      openCommands: () => setPalette({ initialQuery: '>' }),
      // View-switch actions route through centerViewForAction so the action→view
      // mapping has a single, unit-tested source of truth (no inline drift).
      openBoard: () => openView('openBoard'),
      openArchitecture: () => openView('openArchitecture'),
      openReview: openReviewTab,
      openEditor: () => openView('openEditor'),
      openGlobalSearch,
      toggleSidebar,
      toggleExplorer,
      newSession: () => openNewSession(),
      // Multi-window Slice A: open a new empty window (host owns the window registry).
      newWindow: () => post({ type: 'win:new' }),
      openSettings: () => {
        setSettingsTab('general');
        setSettingsOpen(true);
      },
      // Global save (K2): route Mod+S — pressed ANYWHERE, including the terminal or
      // sidebar — to the active doc's registered save. Self-guarded (no active doc /
      // clean / in-flight → no-op), so it never fights Monaco's own focused binding.
      save: () => saveActiveDoc(docStateRef.current.docs, docStateRef.current.activeId),
      // File-explorer undo/redo. NOT in isComboAllowedWhileTyping, so these fire only
      // when focus is outside any text-entry element (input, textarea, contenteditable).
      // Monaco's textarea.inputarea is a TEXTAREA → isTypingEntry returns true for it,
      // so Ctrl+Z inside the editor always goes to Monaco, never here.
      // Invoked via stable refs to avoid ordering issues (doUndo/doRedo are declared
      // after active is derived, which is after this useMemo).
      undo: () => doUndoRef.current(),
      redo: () => doRedoRef.current(),
    }),
    [openView, toggleSidebar, toggleExplorer, openGlobalSearch, openNewSession, openReviewTab],
  );
  const bindingsRef = useRef(settings.shortcuts);
  bindingsRef.current = settings.shortcuts;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      for (const action of SHORTCUT_ACTIONS) {
        const combo = effectiveCombo(action, bindingsRef.current);
        if (!matchCombo(e, combo)) continue;
        if (!actionMap[action.id]) continue;
        // Block global shortcuts when focus is in a text-entry element,
        // unless the combo is explicitly allowed while typing (e.g. Mod+S).
        if (isTypingEntry(e.target as Element | null) && !isComboAllowedWhileTyping(combo))
          continue;
        e.preventDefault();
        // Stop the focused widget (xterm, Monaco) from ALSO acting on this combo.
        e.stopPropagation();
        actionMap[action.id]();
        return;
      }
    };
    // CAPTURE phase: xterm.js (and Monaco) call stopPropagation on their textarea's
    // keydown, so a bubble-phase window listener never sees a combo pressed while a
    // terminal/editor is focused — every global shortcut would be dead there. Listening
    // in the capture phase runs this handler BEFORE the focused widget consumes the
    // event; the typing-guard above still defers to real form inputs.
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [actionMap]);

  // Keep a valid active session selected, and keep the center view coherent with
  // the session count. Closing the last session must land on the same initial
  // start state as a fresh launch (empty editor) — so when the count hits zero we
  // both clear the active id and fall the center view back to 'editor', otherwise
  // a Board/Canvas overlay would keep floating over an empty workbench.
  useEffect(() => {
    if (sessions.length === 0) {
      setActiveId(undefined);
    } else if (!activeId || !sessions.some((s) => s.id === activeId)) {
      setActiveId(sessions[0].id);
    }
    setCenterView((v) => nextCenterView(v, sessions.length));
  }, [sessions, activeId]);

  // When a session is removed, close the editors/docs it owned so they don't
  // orphan onto another session (close session B → B's tabs go, A's untouched).
  const prevSessionIdsRef = useRef<string[]>([]);
  useEffect(() => {
    const current = new Set(sessions.map((s) => s.id));
    for (const id of prevSessionIdsRef.current) {
      if (!current.has(id)) dispatchDocs({ type: 'closeSession', sessionId: id });
    }
    prevSessionIdsRef.current = sessions.map((s) => s.id);
  }, [sessions]);

  // Tell the host which session is focused so it can clear that session's
  // needs-attention flag (the focused session never needs attention). No-op in
  // the browser preview (the mock ignores `focus`).
  useEffect(() => {
    if (activeId) post({ type: 'focus', id: activeId });
  }, [activeId]);

  const active = sessions.find((s) => s.id === activeId);
  const activeProject = active
    ? active.projectPath.split(/[\\/]/).filter(Boolean).pop()
    : undefined;

  // Editor tabs are scoped to their session: only the active session's docs are shown,
  // so you never see another session's editors. Switching sessions restores that
  // session's remembered view (its last active doc, or the Terminal).
  const visibleDocs = useMemo(
    () => docState.docs.filter((d) => d.sessionId === activeId),
    [docState.docs, activeId],
  );
  useEffect(() => {
    dispatchDocs({ type: 'switchSession', sessionId: activeId ?? '' });
  }, [activeId]);

  // Tell the host which files are open in editor/markdown tabs so it watches them on
  // disk and pings us (fileChanged) when one changes externally. Sorted + joined into a
  // stable key so an unrelated docs change (reorder/active) doesn't re-send the set.
  const openFilePathsKey = useMemo(
    () =>
      Array.from(new Set(docState.docs.filter((d) => d.kind === 'file').map((d) => d.path)))
        .sort()
        .join('\n'),
    [docState.docs],
  );
  useEffect(() => {
    post({ type: 'watchFiles', paths: openFilePathsKey ? openFilePathsKey.split('\n') : [] });
  }, [openFilePathsKey]);

  // The path of the active editor/markdown tab (undefined when the active doc is the
  // Terminal, a diff, or the review view). Drives the on-focus re-read below.
  const activeFilePath = useMemo(() => {
    const d = docState.docs.find((x) => x.id === docState.activeId);
    return d?.kind === 'file' ? d.path : undefined;
  }, [docState.docs, docState.activeId]);
  // When a tab becomes active, re-read it so we show the latest on-disk content (an agent
  // or external editor may have changed it while another tab was focused). The fileContent
  // handler's dirty-buffer protection still withholds clobbering an unsaved buffer.
  useEffect(() => {
    if (activeFilePath) post({ type: 'readFile', path: activeFilePath });
  }, [activeFilePath]);
  // Latest active file path in a ref so the window-focus handler can re-read it without
  // re-binding its listeners on every tab switch.
  const activeFilePathRef = useRef(activeFilePath);
  activeFilePathRef.current = activeFilePath;

  // Ask the host for git changes + file tree whenever the active cwd changes.
  // activeCwd(active) prefers the live cd-tracked dir (cwd) over projectPath.
  // Depend on projectPath + cwd (not the whole session object) so a rename or
  // icon change does NOT retrigger a potentially-expensive project reload.
  // biome-ignore lint/correctness/useExhaustiveDependencies: intentional fine-grained dep
  useEffect(() => {
    if (active) post({ type: 'requestProject', path: activeCwd(active) });
  }, [active?.projectPath, active?.cwd]);

  // Re-read the working-tree change list (R5.3). Used both by the manual refresh button
  // in the Changes tab and by the focus/visibility auto-refresh below.
  // biome-ignore lint/correctness/useExhaustiveDependencies: intentional fine-grained dep (cwd + projectPath only)
  const refreshChanges = useCallback(() => {
    if (active) post({ type: 'requestProject', path: activeCwd(active) });
  }, [active?.projectPath, active?.cwd]);

  // ---- FS undo/redo: record, execute, and refresh ----

  /** Record a successful fs op into the undo stack (called by FilesView on success). */
  const recordFsOp = useCallback((op: FsOp) => {
    setFsUndoState((s) => pushOp(s, op));
  }, []);

  /**
   * Execute a list of InverseActions sequentially via the bridge.
   * Returns true if all succeeded, false on the first failure (which is toasted).
   */
  const execActions = useCallback(async (actions: InverseAction[]): Promise<boolean> => {
    for (const action of actions) {
      let ok = false;
      let errorMsg = '';
      if (action.call === 'mutate') {
        const res = await fsMutate(action.req);
        ok = res.ok;
        if (!res.ok) errorMsg = res.error;
      } else if (action.call === 'move') {
        const res = await fsDndMove(action.from, action.to);
        ok = res.ok;
        if (!res.ok) errorMsg = res.error;
      } else {
        // action.call === 'copy'
        const res = await fsDndCopy(action.from, action.to);
        ok = res.ok;
        if (!res.ok) errorMsg = res.error;
      }
      if (!ok) {
        pushToast({ message: errorMsg, variant: 'error' });
        return false;
      }
    }
    return true;
  }, []);

  // `activeRef` avoids re-binding refreshAfterFsOp on every session change.
  const activeRef = useRef(active);
  activeRef.current = active;

  const refreshAfterFsOp = useCallback((op: FsOp) => {
    const dirs = affectedDirs(op);
    for (const dir of dirs) {
      post({ type: 'readDir', path: dir });
    }
    const cur = activeRef.current;
    if (cur) post({ type: 'requestProject', path: activeCwd(cur) });
  }, []);

  const doUndo = useCallback(async () => {
    const { state: next, op } = applyUndo(fsUndoRef.current);
    if (!op) {
      pushToast({ message: 'Nothing to undo.', variant: 'info' });
      return;
    }
    const ok = await execActions(invert(op));
    if (ok) {
      setFsUndoState(next);
      refreshAfterFsOp(op);
    }
    // On failure: execActions already toasted; discard the entry so we don't retry.
    else {
      setFsUndoState(next);
    }
  }, [execActions, refreshAfterFsOp]);

  const doRedo = useCallback(async () => {
    const { state: next, op } = applyRedo(fsUndoRef.current);
    if (!op) {
      pushToast({ message: 'Nothing to redo.', variant: 'info' });
      return;
    }
    const ok = await execActions(redoActions(op));
    if (ok) {
      setFsUndoState(next);
      refreshAfterFsOp(op);
    } else {
      setFsUndoState(next);
    }
  }, [execActions, refreshAfterFsOp]);

  // Wire the stable refs so actionMap's undo/redo delegates hit the latest handlers.
  doUndoRef.current = () => void doUndo();
  doRedoRef.current = () => void doRedo();

  // Auto-refresh the change list when the window regains focus or becomes visible again
  // (R5.3). While the app is in the background an edit, an agent, or a terminal command
  // may have changed the working tree; on returning we re-read it so the Changes tab
  // reflects reality without a manual poke — mirrors the Files tree's focus refresh (J5).
  // biome-ignore lint/correctness/useExhaustiveDependencies: intentional fine-grained dep (cwd + projectPath gate, not full active obj)
  useEffect(() => {
    if (!active) return;
    // On regaining focus, also re-read the active file tab so it reflects any on-disk
    // change made while the app was backgrounded (dirty-buffer protection still applies).
    const rereadActiveFile = () => {
      if (activeFilePathRef.current) post({ type: 'readFile', path: activeFilePathRef.current });
    };
    const onFocus = () => {
      if (document.visibilityState !== 'hidden') {
        refreshChanges();
        rereadActiveFile();
      }
    };
    const onVisibility = () => {
      if (document.visibilityState === 'visible') {
        refreshChanges();
        rereadActiveFile();
      }
    };
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [active?.projectPath, active?.cwd, refreshChanges]);

  // Live working-tree monitoring: the host watches the active project and pushes `fsChanged`
  // (debounced, noise-filtered) when anything changes on disk. Re-read the change list right
  // away so the Changes tab + git decorations stay current WITHOUT needing a window refocus.
  // (Open editor tabs are reconciled separately via `fileChanged`; the file tree re-reads
  // itself on `fsChanged` in FilesView.)
  useEffect(() => {
    return subscribe((msg) => {
      if (msg.type === 'fsChanged') refreshChanges();
    });
  }, [refreshChanges]);

  // When the palette opens, ask the host to (re)index the active project.
  useEffect(() => {
    if (palette && active?.projectPath && search.root !== active.projectPath) {
      post({ type: 'searchFiles', root: active.projectPath, query: '' });
    }
  }, [palette, active?.projectPath, search.root]);

  // Clear a split that became invalid (equals active, or its session stopped).
  useEffect(() => {
    if (
      splitId &&
      (splitId === activeId || !sessions.some((s) => s.id === splitId && s.status === 'running'))
    ) {
      setSplitId(null);
    }
  }, [splitId, activeId, sessions]);

  const projectData = project && active && project.path === activeCwd(active) ? project : null;

  const pushRecent = useCallback(
    (kind: 'file' | 'diff', path: string, sessionId: string) =>
      setRecentsBySession((prev) => {
        const prevList = prev[sessionId] ?? [];
        const next = [
          { kind, path },
          ...prevList.filter((r) => !(r.kind === kind && r.path === path)),
        ].slice(0, 10);
        return { ...prev, [sessionId]: next };
      }),
    [],
  );

  // Immediately close a doc tab (no dirty check). Also drops any dirty-state entry.
  const forceCloseDoc = useCallback(
    (id: string) => {
      const doc = docState.docs.find((d) => d.id === id);
      if (doc) clearDirty(doc.path);
      dispatchDocs({ type: 'close', id });
    },
    [docState.docs],
  );

  // Close a doc tab. If the doc has unsaved changes, show a 3-way Save/Discard/Cancel
  // dialog. Save path invokes the registered save; tab closes only on success.
  // Discard path clears dirty state and closes immediately. Cancel is a no-op.
  const closeDoc = useCallback(
    (id: string) => {
      const doc = docState.docs.find((d) => d.id === id);
      if (!doc) return;
      if (!dirtySet.has(doc.path)) {
        forceCloseDoc(id);
        return;
      }
      const fileName = baseName(doc.path);
      setConfirm({
        title: `Unsaved changes in ${fileName}`,
        message: `"${fileName}" has unsaved changes. Save before closing, or discard them?`,
        confirmLabel: 'Save',
        secondaryLabel: 'Discard',
        onSecondary: () => {
          clearDirty(doc.path);
          dispatchDocs({ type: 'close', id });
        },
        onConfirm: () => {
          const entry = getSaveEntry(doc.path);
          if (!entry) {
            // No registry entry (shouldn't happen for a dirty doc, but be safe).
            forceCloseDoc(id);
            return;
          }
          void entry.save().then((ok) => {
            if (ok) forceCloseDoc(id);
            // On failure: toast already shown by CodeViewer — do not close.
          });
        },
      });
    },
    [docState.docs, dirtySet, forceCloseDoc],
  );

  const indexedRoots = useRef<Set<string>>(new Set());
  const openFile = useCallback(
    (path: string, targetSessionId?: string) => {
      // If a target session is provided and differs from the active one, switch first.
      const effectiveSessionId = targetSessionId ?? activeIdRef.current ?? '';
      if (targetSessionId && targetSessionId !== activeIdRef.current) {
        setActiveId(targetSessionId);
        dispatchDocs({ type: 'switchSession', sessionId: targetSessionId });
      }
      // K3: always request a fresh read — the file may have changed on disk since the
      // last read (agent/external editor). A cached copy stays shown until the host
      // replies (no flicker). If the buffer is dirty the read still keeps the map fresh
      // for the markdown view, but CodeViewer won't re-seed Monaco (keyed on path).
      post({ type: 'readFile', path });
      dispatchDocs({ type: 'open', kind: 'file', path, sessionId: effectiveSessionId });
      pushRecent('file', path, effectiveSessionId);
      // Surface the file in the explorer wherever it was opened from (tree click, search,
      // palette, go-to-definition, terminal link): switch to the Files tab and reveal it.
      rightPaneRef.current?.revealInTree(path);
      // Index the project's source files once so go-to-definition resolves cross-file.
      const effectiveSession = sessions.find((s) => s.id === effectiveSessionId) ?? active;
      if (
        isCodeFile(path) &&
        effectiveSession?.projectPath &&
        !indexedRoots.current.has(effectiveSession.projectPath)
      ) {
        indexedRoots.current.add(effectiveSession.projectPath);
        post({ type: 'indexProject', root: effectiveSession.projectPath });
      }
    },
    [active, sessions, pushRecent],
  );
  const openDiff = useCallback(
    (path: string, targetSessionId?: string) => {
      const effectiveSessionId = targetSessionId ?? activeIdRef.current ?? '';
      if (targetSessionId && targetSessionId !== activeIdRef.current) {
        setActiveId(targetSessionId);
        dispatchDocs({ type: 'switchSession', sessionId: targetSessionId });
      }
      post({ type: 'readDiff', path });
      dispatchDocs({ type: 'open', kind: 'diff', path, sessionId: effectiveSessionId });
      pushRecent('diff', path, effectiveSessionId);
    },
    [pushRecent],
  );
  // Open an http(s) URL as a web tab owned by the active session. No host read — the
  // <webview> guest fetches the page itself (path = URL); ownership mirrors files.
  const openWeb = useCallback((url: string) => {
    const sessionId = activeIdRef.current ?? '';
    dispatchDocs({ type: 'open', kind: 'web', path: url, sessionId });
  }, []);

  // Open a content-search hit at its line/column (L5). Stage the reveal target, THEN open
  // the file — CodeViewer consumes the reveal on mount via takeReveal() and centers the
  // line + sets the cursor (the same seam cross-file go-to-definition uses). Switch the
  // center pane to the editor so a freshly-opened doc isn't hidden behind a Board/Canvas.
  const openMatch = useCallback(
    (abs: string, line: number, column: number) => {
      setReveal(abs, { line, column });
      setCenterView('editor');
      openFile(abs);
    },
    [openFile],
  );

  // R3 Review: open a changed file in the editor revealed at a hunk's WORK line. Reuses
  // the same reveal seam as search-jump / go-to-definition (setReveal → CodeViewer).
  const jumpToHunk = useCallback(
    (abs: string, line: number) => {
      setReveal(abs, { line, column: 1 });
      setCenterView('editor');
      openFile(abs);
    },
    [openFile],
  );

  // D11: open a terminal path link at an optional position. Resolves the owning session
  // so the file opens in the session that owns the path, then stages a reveal if a line
  // (and optionally col) was given. Switches the center pane to the editor.
  const openTerminalFileLink = useCallback(
    (path: string, line?: number, col?: number) => {
      const owningId = resolveOwningSession({
        path,
        sessions,
        openDocs: docState.docs,
        activeId: activeId ?? null,
      });
      if (line !== undefined) {
        setReveal(path, { line, column: col ?? 1 });
      }
      setCenterView('editor');
      openFile(path, owningId ?? undefined);
    },
    [sessions, docState.docs, activeId, openFile],
  );

  // Close the singleton Review-changes tab (R5.5) — used by ReviewView's own
  // close button + Esc. Defined here because it needs forceCloseDoc (declared above).
  const closeReviewTab = useCallback(() => forceCloseDoc(REVIEW_DOC_ID), [forceCloseDoc]);

  const openSettingsAt = useCallback((tab: SettingsTab) => {
    setSettingsTab(tab);
    setSettingsOpen(true);
  }, []);

  // Cross-file go-to-definition: CodeViewer resolves the target (worker) and calls
  // this to open it as a doc tab (the reveal position is set alongside).
  const openFileRef = useRef(openFile);
  openFileRef.current = openFile;
  useEffect(() => {
    setDefinitionOpener((abs) => openFileRef.current(abs));
  }, []);

  // Drain queued OS file-open requests whose target session now exists in state. Opening
  // switches to the editor center view + the owning session and focuses it, so a doc
  // launched from Explorer lands visibly. Requests for not-yet-present sessions stay queued
  // and are retried when `sessions` next changes (a just-created session's state arrives).
  const flushOsOpens = useCallback(() => {
    if (pendingOsOpensRef.current.length === 0) return;
    const known = new Set(sessions.map((s) => s.id));
    const remaining: { path: string; sessionId: string }[] = [];
    for (const req of pendingOsOpensRef.current) {
      if (known.has(req.sessionId)) {
        setCenterView('editor');
        openFile(req.path, req.sessionId);
      } else {
        remaining.push(req);
      }
    }
    pendingOsOpensRef.current = remaining;
  }, [sessions, openFile]);
  const flushOsOpensRef = useRef(flushOsOpens);
  flushOsOpensRef.current = flushOsOpens;
  useEffect(() => {
    flushOsOpens();
  }, [flushOsOpens]);

  const copyToClipboard = useCallback((text: string) => {
    void navigator.clipboard?.writeText(text);
  }, []);

  // Close a session — confirm first if it's running and the setting is on.
  const requestKill = useCallback(
    (id: string) => {
      const s = sessions.find((x) => x.id === id);
      if (s && s.status === 'running' && settings.confirmCloseRunning) {
        setConfirm({
          title: 'Close session?',
          message: `"${s.name}" is running. Closing it will terminate its terminal.`,
          confirmLabel: 'Close session',
          danger: true,
          onConfirm: () => post({ type: 'kill', id }),
        });
      } else {
        post({ type: 'kill', id });
      }
    },
    [sessions, settings.confirmCloseRunning],
  );

  // Close a set of sessions via the single-close path (`kill` per id) so each pty is
  // torn down properly. Confirm once (not per-session) if the setting is on and any
  // target is running, mirroring single-close's `confirmCloseRunning` gate.
  const closeSessions = useCallback(
    (ids: string[], confirmTitle: string, confirmMessage: string) => {
      if (ids.length === 0) return;
      const killAll = () => {
        for (const id of ids) post({ type: 'kill', id });
      };
      const anyRunning = ids.some((id) => sessions.find((x) => x.id === id)?.status === 'running');
      if (anyRunning && settings.confirmCloseRunning) {
        setConfirm({
          title: confirmTitle,
          message: confirmMessage,
          confirmLabel: confirmTitle,
          danger: true,
          onConfirm: killAll,
        });
      } else {
        killAll();
      }
    },
    [sessions, settings.confirmCloseRunning],
  );

  // Multi-window Slice B: "Move to new window" + one "Move to {title}" entry per OTHER open
  // window (this window's own id comes from state.windowId). The flat context menu has no
  // submenus, so the targets are inlined as sibling items. The move never restarts the PTY —
  // the host reassigns ownership and the target re-mounts the same sessionId.
  const moveMenuItems = (sessionId: string): MenuItem[] => {
    const ownId = state?.windowId;
    const others = winList.filter((w) => w.id !== ownId);
    return [
      {
        label: 'Move to new window',
        icon: <IconPlus size={14} />,
        separatorBefore: true,
        onClick: () => post({ type: 'session:move', sessionId, target: { kind: 'new' } }),
      },
      ...others.map((w) => ({
        label: `Move to ${w.title}`,
        icon: <IconExternal size={14} />,
        onClick: () =>
          post({ type: 'session:move', sessionId, target: { kind: 'window', windowId: w.id } }),
      })),
    ];
  };

  const onSessionContextMenu = (e: React.MouseEvent, s: Session) => {
    e.preventDefault();
    const others = closeOthersIds(
      sessions.map((x) => x.id),
      s.id,
    );
    const all = closeAllIds(sessions.map((x) => x.id));
    setMenu({
      x: e.clientX,
      y: e.clientY,
      items: [
        {
          label: 'Reveal in Explorer',
          icon: <IconExternal size={14} />,
          onClick: () => post({ type: 'revealInExplorer', path: s.projectPath }),
        },
        {
          label: 'Duplicate session',
          icon: <IconDuplicate size={14} />,
          onClick: () => post({ type: 'duplicate', id: s.id }),
        },
        ...(s.status === 'running' && s.id !== activeId
          ? [
              {
                label: 'Open in split pane',
                icon: <IconSidebar size={14} />,
                onClick: () => setSplitId(s.id),
              },
            ]
          : []),
        ...(s.status !== 'running'
          ? [
              {
                label: 'Relaunch',
                icon: <IconSparkle size={14} />,
                onClick: () => post({ type: 'relaunch' as const, id: s.id }),
              },
            ]
          : []),
        {
          label: 'Copy path',
          icon: <IconCopy size={14} />,
          separatorBefore: true,
          onClick: () => copyToClipboard(s.projectPath),
        },
        {
          label: 'Copy name',
          icon: <IconCopy size={14} />,
          onClick: () => copyToClipboard(s.name),
        },
        {
          label: 'Rename',
          icon: <IconPencil size={14} />,
          onClick: () => {
            setActiveId(s.id);
            setRenamingId(s.id);
          },
        },
        {
          label: 'Set icon…',
          icon: <IconSparkle size={14} />,
          onClick: () => setIconPickerSessionId(s.id),
        },
        ...moveMenuItems(s.id),
        {
          label: 'Close',
          icon: <IconTrash size={14} />,
          danger: true,
          separatorBefore: true,
          onClick: () => requestKill(s.id),
        },
        {
          label: 'Close others',
          icon: <IconTrash size={14} />,
          danger: true,
          disabled: others.length === 0,
          onClick: () =>
            closeSessions(
              others,
              'Close other sessions',
              `Close ${others.length} other session${others.length === 1 ? '' : 's'}? Running terminals will be terminated.`,
            ),
        },
        {
          label: 'Close all',
          icon: <IconTrash size={14} />,
          danger: true,
          onClick: () =>
            closeSessions(
              all,
              'Close all sessions',
              `Close all ${all.length} session${all.length === 1 ? '' : 's'}? Running terminals will be terminated.`,
            ),
        },
      ],
    });
  };

  const onTabContextMenu = (e: React.MouseEvent, doc: OpenDoc) => {
    e.preventDefault();
    // Scope close-others/left/right/all to the active session's tabs only — the bar
    // never shows another session's editors, so those actions must not touch them.
    const allPaths = visibleDocs.map((d) => d.path);
    const toRight = closeTabSelection(allPaths, doc.path, 'right');
    const toLeft = closeTabSelection(allPaths, doc.path, 'left');
    const others = closeTabSelection(allPaths, doc.path, 'others');
    const all = closeTabSelection(allPaths, doc.path, 'all');
    setMenu({
      x: e.clientX,
      y: e.clientY,
      items: [
        {
          label: 'Close',
          icon: <IconClose size={14} />,
          onClick: () => closeDoc(doc.id),
        },
        {
          label: 'Close Others',
          onClick: () => {
            const idsToClose = docState.docs
              .filter((d) => others.includes(d.path))
              .map((d) => d.id);
            for (const id of idsToClose) closeDoc(id);
          },
          disabled: others.length === 0,
        },
        {
          label: 'Close to the Right',
          onClick: () => {
            const idsToClose = docState.docs
              .filter((d) => toRight.includes(d.path))
              .map((d) => d.id);
            for (const id of idsToClose) closeDoc(id);
          },
          disabled: toRight.length === 0,
        },
        {
          label: 'Close to the Left',
          onClick: () => {
            const idsToClose = docState.docs
              .filter((d) => toLeft.includes(d.path))
              .map((d) => d.id);
            for (const id of idsToClose) closeDoc(id);
          },
          disabled: toLeft.length === 0,
        },
        {
          label: 'Close All',
          onClick: () => {
            const idsToClose = docState.docs.filter((d) => all.includes(d.path)).map((d) => d.id);
            for (const id of idsToClose) closeDoc(id);
          },
          disabled: all.length === 0,
        },
        {
          label: 'Copy path',
          icon: <IconCopy size={14} />,
          separatorBefore: true,
          onClick: () => copyToClipboard(doc.path),
        },
        {
          label: 'Copy file name',
          icon: <IconCopy size={14} />,
          onClick: () => copyToClipboard(baseName(doc.path)),
        },
        {
          label: 'Reveal in Explorer',
          icon: <IconExternal size={14} />,
          onClick: () => post({ type: 'revealInExplorer', path: doc.path }),
        },
      ],
    });
  };

  // Right-click the terminal/session tab → a menu for the ACTIVE session (the tab the
  // terminal tab represents): duplicate / reveal its folder / close its editor tabs /
  // close the session. Mirrors the session-card and editor-tab menus.
  const onTerminalTabContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    if (!active) return;
    const s = active;
    // Only this session's editor tabs (the bar is session-scoped).
    const docIds = visibleDocs.map((d) => d.id);
    setMenu({
      x: e.clientX,
      y: e.clientY,
      items: [
        {
          label: 'Duplicate session',
          icon: <IconDuplicate size={14} />,
          onClick: () => post({ type: 'duplicate', id: s.id }),
        },
        {
          label: 'Reveal in Explorer',
          icon: <IconExternal size={14} />,
          onClick: () => post({ type: 'revealInExplorer', path: s.projectPath }),
        },
        {
          label: 'Rename',
          icon: <IconPencil size={14} />,
          onClick: () => setRenamingId(s.id),
        },
        {
          label: 'Set icon…',
          icon: <IconSparkle size={14} />,
          onClick: () => setIconPickerSessionId(s.id),
        },
        ...moveMenuItems(s.id),
        {
          label: 'Close editor tabs',
          icon: <IconClose size={14} />,
          separatorBefore: true,
          disabled: docIds.length === 0,
          onClick: () => {
            for (const id of docIds) closeDoc(id);
          },
        },
        {
          label: 'Close session',
          icon: <IconTrash size={14} />,
          danger: true,
          onClick: () => requestKill(s.id),
        },
      ],
    });
  };

  // Deliver an editor "Mention in terminal" to the active session: format an
  // @path#Lx-Ly reference (relative to the session's project root) and type it into
  // the terminal, then switch the center to the terminal view so the user sees it land.
  // Re-installed whenever the active session changes so the sink targets the right pty.
  useEffect(() => {
    setMentionSink((req) => {
      if (!active) {
        pushToast({ message: 'Open a session to mention a selection.', variant: 'error' });
        return;
      }
      const ref = formatMention(active.projectPath, req.path, req.startLine, req.endLine);
      dispatchDocs({ type: 'activate', id: null, sessionId: active.id }); // show the terminal
      post({ type: 'term:input', sessionId: active.id, data: `${ref} ` });
    });
    return () => setMentionSink(null);
  }, [active]);

  // Force-close any open doc tab(s) for `path` WITHOUT a dirty re-prompt. Used after a
  // delete/rename the user already confirmed: re-prompting "save unsaved changes?" for a
  // file the user just chose to delete would be contradictory (documented rule). Both
  // the file doc and any open diff for the same path are dropped.
  const dropDocsFor = useCallback(
    (path: string) => {
      const norm = path.replace(/[\\/]+$/, '');
      for (const d of docStateRef.current.docs) {
        if (d.path.replace(/[\\/]+$/, '') === norm) forceCloseDoc(d.id);
      }
    },
    [forceCloseDoc],
  );

  // Move a file/folder to the recycle bin (L2). Confirm first; on a trash failure offer
  // a second, explicit permanent-delete confirm (which calls removePermanent). On
  // success, drop any open tab for the file and run the caller's tree refresh.
  const onDeleteFile = useCallback(
    (node: { path: string; kind: 'dir' | 'file' }, afterDeleted: () => void) => {
      const name = baseName(node.path);
      const succeed = () => {
        if (node.kind === 'file') dropDocsFor(node.path);
        afterDeleted();
      };
      const permanently = () => {
        setConfirm({
          title: 'Delete permanently',
          message: `Couldn't move "${name}" to the Recycle Bin. Delete it permanently? This cannot be undone.`,
          confirmLabel: 'Delete permanently',
          danger: true,
          onConfirm: () => {
            void fsMutate({ op: 'removePermanent', path: node.path }).then((res) => {
              if (res.ok) succeed();
              else pushToast({ message: res.error, variant: 'error' });
            });
          },
        });
      };
      setConfirm({
        title: 'Move to Recycle Bin',
        message: `Move "${name}" to the Recycle Bin?`,
        confirmLabel: 'Move to Recycle Bin',
        danger: true,
        onConfirm: () => {
          void fsMutate({ op: 'remove', path: node.path }).then((res) => {
            if (res.ok) succeed();
            else permanently();
          });
        },
      });
    },
    [dropDocsFor],
  );

  // A file was renamed on disk. The doc id is keyed on path and re-keying the Monaco
  // model + dirty-state across a path change is cross-cutting, so the cheap, correct
  // behavior is to close the old tab and reopen at the new path (documented rule).
  const onFileRenamed = useCallback(
    (fromPath: string, toPath: string) => {
      const norm = fromPath.replace(/[\\/]+$/, '');
      const wasOpen = docStateRef.current.docs.some((d) => d.path.replace(/[\\/]+$/, '') === norm);
      if (!wasOpen) return;
      dropDocsFor(fromPath);
      openFile(toPath);
    },
    [dropDocsFor, openFile],
  );

  const onChangeContextMenu = (e: React.MouseEvent, rel: string) => {
    e.preventDefault();
    if (!active) return;
    const abs = joinPath(activeCwd(active), rel);
    const changes = projectData?.changes ?? [];
    const staged = changes.filter((c) => c.staged);
    const unstaged = changes.filter((c) => !c.staged);
    setMenu({
      x: e.clientX,
      y: e.clientY,
      items: [
        { label: 'Open diff', icon: <IconBranch size={14} />, onClick: () => openDiff(abs) },
        { label: 'Open file', icon: <IconDoc size={14} />, onClick: () => openFile(abs) },
        {
          label: 'Reveal in Explorer',
          icon: <IconExternal size={14} />,
          separatorBefore: true,
          onClick: () => post({ type: 'revealInExplorer', path: abs }),
        },
        { label: 'Copy path', icon: <IconCopy size={14} />, onClick: () => copyToClipboard(abs) },
        {
          label: 'Stage all',
          icon: <IconBranch size={14} />,
          separatorBefore: true,
          disabled: unstaged.length === 0,
          onClick: () => onGitAction({ op: 'stageAll' }),
        },
        {
          label: 'Unstage all',
          icon: <IconBranch size={14} />,
          disabled: staged.length === 0,
          onClick: () => onGitAction({ op: 'unstageAll' }),
        },
        {
          label: 'Stash changes',
          icon: <IconBranch size={14} />,
          onClick: () => onGitAction({ op: 'stashPush' }),
        },
        {
          label: 'Pop stash',
          icon: <IconBranch size={14} />,
          onClick: () => onGitAction({ op: 'stashPop' }),
        },
        {
          label: 'Discard all changes',
          icon: <IconTrash size={14} />,
          danger: true,
          disabled: changes.length === 0,
          onClick: () => onGitAction({ op: 'discardAll' }),
        },
      ],
    });
  };

  // Run a git action (stage/unstage/discard/stash) for the active cwd, then
  // re-fetch the change list so the UI reflects the new state. Failures toast.
  // biome-ignore lint/correctness/useExhaustiveDependencies: intentional fine-grained dep (cwd + projectPath only)
  const runGit = useCallback(
    async (op: GitActionIntent['op'], path?: string) => {
      if (!active) return;
      const root = activeCwd(active);
      // 'discardAll' is a renderer-only intent; map it to a real bulk discard below.
      const hostOp = op as Exclude<GitActionIntent['op'], 'discardAll'>;
      const res = await gitAction({ root, op: hostOp, path });
      if (!res.ok) pushToast({ message: `Git: ${res.error}`, variant: 'error' });
      // Always refresh — even on failure the on-disk state may have partially changed.
      post({ type: 'requestProject', path: root });
    },
    [active?.projectPath, active?.cwd],
  );

  // Discard every change: unstage all, then restore tracked files, then delete
  // untracked. Sequenced so staged-and-modified files end up clean. Refresh once.
  // biome-ignore lint/correctness/useExhaustiveDependencies: intentional fine-grained dep (cwd + projectPath only)
  const discardAll = useCallback(async () => {
    if (!active) return;
    const root = activeCwd(active);
    const list = projectData?.changes ?? [];
    await gitAction({ root, op: 'unstageAll' });
    // Distinct paths: tracked → restore; untracked → delete.
    const untracked = new Set<string>();
    const tracked = new Set<string>();
    for (const c of list) {
      if (c.kind === 'U') untracked.add(c.path);
      else tracked.add(c.path);
    }
    for (const p of tracked) {
      const r = await gitAction({ root, op: 'discardTracked', path: p });
      if (!r.ok) pushToast({ message: `Git: ${r.error}`, variant: 'error' });
    }
    for (const p of untracked) {
      const r = await gitAction({ root, op: 'discardUntracked', path: p });
      if (!r.ok) pushToast({ message: `Git: ${r.error}`, variant: 'error' });
    }
    post({ type: 'requestProject', path: root });
  }, [active?.projectPath, active?.cwd, projectData?.changes]);

  // Entry point from the Changes tab. Destructive ops get a 2-way confirm first;
  // everything else runs immediately.
  const onGitAction = useCallback(
    (intent: GitActionIntent) => {
      const { op, path } = intent;
      if (op === 'discardUntracked' && path) {
        setConfirm({
          title: 'Delete untracked file',
          message: `Delete untracked file ${baseName(path)}? This cannot be undone.`,
          confirmLabel: 'Delete',
          danger: true,
          onConfirm: () => void runGit('discardUntracked', path),
        });
        return;
      }
      if (op === 'discardTracked' && path) {
        setConfirm({
          title: 'Discard changes',
          message: `Discard changes to ${baseName(path)}? This cannot be undone.`,
          confirmLabel: 'Discard',
          danger: true,
          onConfirm: () => void runGit('discardTracked', path),
        });
        return;
      }
      if (op === 'discardAll') {
        const n = projectData?.changes.length ?? 0;
        setConfirm({
          title: 'Discard all changes',
          message: `Discard all ${n} change${n === 1 ? '' : 's'}? This cannot be undone.`,
          confirmLabel: 'Discard all',
          danger: true,
          onConfirm: () => void discardAll(),
        });
        return;
      }
      void runGit(op, path);
    },
    [runGit, discardAll, projectData?.changes.length],
  );

  // Right-click anywhere on a side panel (bar or body background) or the top bar
  // opens a menu to show/hide each side panel; a check marks each visible panel.
  // Bound at the panel root so the whole panel surface is a target, but item
  // menus win: file/change/session/tab handlers call preventDefault and set their
  // own menu, so by the time the event bubbles here `defaultPrevented` is set and
  // this no-ops — no hijack of the existing item menus.
  const onPanelTogglesMenu = (e: React.MouseEvent) => {
    if (e.defaultPrevented) return;
    e.preventDefault();
    setMenu({
      x: e.clientX,
      y: e.clientY,
      items: buildPanelToggleItems({ sidebarCollapsed, explorerCollapsed }).map((spec) => ({
        label: spec.label,
        icon: spec.visible ? <IconCheck size={14} /> : undefined,
        onClick: () => togglePanel(spec.panel),
      })),
    });
  };

  // Back/forward navigation across visited views (session terminal / doc tabs).
  const applyNav = useCallback(
    (l: NavLoc) => {
      setActiveId(l.sessionId);
      const exists = l.docId !== null && docState.docs.some((d) => d.id === l.docId);
      dispatchDocs({ type: 'activate', id: exists ? l.docId : null, sessionId: l.sessionId });
    },
    [docState.docs],
  );
  const { goBack, goForward, canBack, canForward } = useNavHistory(
    { sessionId: activeId, docId: docState.activeId },
    applyNav,
  );

  // Omni-search set (R4.13): sessions (by title) + agents (by name) + files (by path).
  // Routing: a session activates it; an agent opens the new-session flow preselected;
  // a file opens it. Group order (Sessions, Agents, Files) mirrors the pure ranker in
  // src/omni-search.ts (pinned by unit tests). This bar is name/title matching only —
  // file *content* search stays in L5's Search panel (see src/omni-search.ts header).
  const searchItems: PaletteEntry[] = useMemo(() => {
    const sessionEntries: PaletteEntry[] = sessions.map((s) => ({
      id: `session:${s.id}`,
      title: s.name,
      subtitle: baseName(s.projectPath),
      group: 'Sessions',
      icon: <IconTerminal size={14} />,
      run: () => setActiveId(s.id),
    }));
    const agentEntries: PaletteEntry[] = agents.map((a) => ({
      id: `agent:${a.id}`,
      title: a.label,
      subtitle: 'Start a session',
      group: 'Agents',
      icon: <IconSparkle size={14} />,
      run: () => setNewSession({ agentId: a.id }),
    }));
    const fileEntries: PaletteEntry[] =
      active && search.root === active.projectPath
        ? search.results.map((h) => ({
            id: `file:${h.abs}`,
            title: h.rel,
            group: 'Files',
            icon: <IconDoc size={14} />,
            run: () => {
              const owningId = resolveOwningSession({
                path: h.abs,
                sessions,
                openDocs: docState.docs,
                activeId: activeId ?? null,
              });
              openFile(h.abs, owningId ?? undefined);
            },
          }))
        : [];
    return [...sessionEntries, ...agentEntries, ...fileEntries];
  }, [sessions, agents, active, activeId, search, openFile, docState.docs]);

  // Recently opened documents for the active session (shown when the query is empty).
  const recentItems: PaletteEntry[] = useMemo(() => {
    const activeRecents = (activeId ? recentsBySession[activeId] : undefined) ?? [];
    return activeRecents.map((r) => ({
      id: `recent:${r.kind}:${r.path}`,
      title: baseName(r.path),
      subtitle: r.kind === 'diff' ? 'diff' : undefined,
      group: 'Recent',
      icon: <IconDoc size={14} />,
      run: () => (r.kind === 'file' ? openFile(r.path) : openDiff(r.path)),
    }));
  }, [recentsBySession, activeId, openDiff, openFile]);

  // Command set (accessed via the `>` prefix).
  const commandItems: PaletteEntry[] = useMemo(() => {
    const cmds: PaletteEntry[] = [
      {
        id: 'cmd:new',
        title: 'New session',
        group: 'Commands',
        icon: <IconPlus size={14} />,
        run: () => openNewSession(),
      },
      {
        id: 'cmd:newWindow',
        title: 'New window',
        group: 'Commands',
        icon: <IconPlus size={14} />,
        run: () => post({ type: 'win:new' }),
      },
      {
        id: 'cmd:editor',
        title: 'Open editor',
        group: 'Commands',
        icon: <IconDoc size={14} />,
        run: () => openView('openEditor'),
      },
      {
        id: 'cmd:web',
        title: 'Open web page…',
        group: 'Commands',
        icon: <IconExternal size={14} />,
        run: () => setWebPromptOpen(true),
      },
      {
        id: 'cmd:board',
        title: 'Open feature board',
        group: 'Commands',
        icon: <IconBoard size={14} />,
        run: () => openView('openBoard'),
      },
      {
        id: 'cmd:arch',
        title: 'Open architecture canvas',
        group: 'Commands',
        icon: <IconGraph size={14} />,
        run: () => openView('openArchitecture'),
      },
      {
        id: 'cmd:review',
        title: 'Review all changes',
        group: 'Commands',
        icon: <IconReview size={14} />,
        run: openReviewTab,
      },
      {
        id: 'cmd:gitHistory',
        title: 'View commit history',
        group: 'Commands',
        icon: <IconBranch size={14} />,
        run: openGitHistoryTab,
      },
      {
        id: 'cmd:findInFiles',
        title: 'Find in files',
        group: 'Commands',
        icon: <IconSearch size={14} />,
        run: openGlobalSearch,
      },
      {
        id: 'cmd:toggleSidebar',
        title: paletteCommandTitle('sessions', !sidebarCollapsed),
        group: 'Commands',
        icon: <IconSidebar size={14} />,
        run: toggleSidebar,
      },
      {
        id: 'cmd:toggleExplorer',
        title: paletteCommandTitle('explorer', !explorerCollapsed),
        group: 'Commands',
        icon: <IconDoc size={14} />,
        run: toggleExplorer,
      },
      {
        id: 'cmd:back',
        title: 'Go back',
        group: 'Commands',
        icon: <IconCommand size={14} />,
        run: goBack,
      },
      {
        id: 'cmd:forward',
        title: 'Go forward',
        group: 'Commands',
        icon: <IconCommand size={14} />,
        run: goForward,
      },
      {
        id: 'cmd:reduceMotion',
        title: settings.reduceMotion ? 'Reduce motion: off' : 'Reduce motion: on',
        group: 'Commands',
        icon: <IconSparkle size={14} />,
        run: () => update({ reduceMotion: !settings.reduceMotion }),
      },
      {
        id: 'cmd:cycleTheme',
        title: 'Cycle theme',
        group: 'Commands',
        icon: <IconSettings size={14} />,
        run: () => {
          const i = THEMES.findIndex((t) => t.id === settings.theme);
          update({ theme: THEMES[(i + 1) % THEMES.length].id });
        },
      },
    ];
    if (active) {
      cmds.push(
        {
          id: 'cmd:reveal',
          title: 'Reveal project in Explorer',
          group: 'Commands',
          icon: <IconExternal size={14} />,
          run: () => post({ type: 'revealInExplorer', path: active.projectPath }),
        },
        {
          id: 'cmd:close',
          title: 'Close active session',
          group: 'Commands',
          icon: <IconTrash size={14} />,
          run: () => requestKill(active.id),
        },
        {
          id: 'cmd:moveSessionNewWindow',
          title: 'Move session to new window',
          group: 'Commands',
          icon: <IconExternal size={14} />,
          run: () => post({ type: 'session:move', sessionId: active.id, target: { kind: 'new' } }),
        },
      );
      if (active.status !== 'running')
        cmds.push({
          id: 'cmd:relaunch',
          title: 'Relaunch active session',
          group: 'Commands',
          icon: <IconSparkle size={14} />,
          run: () => post({ type: 'relaunch', id: active.id }),
        });
    }
    const activeDoc = docState.docs.find((d) => d.id === docState.activeId);
    if (activeDoc) {
      cmds.push(
        {
          id: 'cmd:revealFile',
          title: 'Reveal active file in Explorer',
          group: 'Commands',
          icon: <IconExternal size={14} />,
          run: () => post({ type: 'revealInExplorer', path: activeDoc.path }),
        },
        {
          id: 'cmd:copyFile',
          title: 'Copy active file path',
          group: 'Commands',
          icon: <IconCopy size={14} />,
          run: () => copyToClipboard(activeDoc.path),
        },
        {
          id: 'cmd:closeOthers',
          title: 'Close other tabs',
          group: 'Commands',
          icon: <IconClose size={14} />,
          run: () =>
            docState.docs
              .filter((d) => d.sessionId === activeId && d.id !== activeDoc.id)
              .forEach((d) => {
                closeDoc(d.id);
              }),
        },
      );
      if (dirtySet.has(activeDoc.path)) {
        cmds.push({
          id: 'cmd:revertFile',
          title: 'Revert File',
          group: 'Commands',
          icon: <IconDoc size={14} />,
          run: () => revertDocByPath(activeDoc.path),
        });
      }
    }
    if (staleRelaunchTargets(sessions).length > 0)
      cmds.push({
        id: 'cmd:relaunchAllStale',
        title: 'Relaunch all stale sessions',
        group: 'Commands',
        icon: <IconSparkle size={14} />,
        run: relaunchAllStale,
      });
    cmds.push({
      id: 'cmd:saveAll',
      title: 'Save All',
      group: 'Commands',
      icon: <IconDoc size={14} />,
      run: () => {
        void saveAllDirtyDocs(getDirtySnapshot()).then((failed) => {
          if (failed.length > 0) {
            const names = failed.map(baseName).join(', ');
            pushToast({
              message: `Could not save ${failed.length} file${failed.length === 1 ? '' : 's'}: ${names}`,
              variant: 'error',
            });
          }
        });
      },
    });
    const settingsCmds: PaletteEntry[] = [
      {
        id: 'set:general',
        title: 'Open Settings: General',
        group: 'Settings',
        icon: <IconSettings size={14} />,
        run: () => openSettingsAt('general'),
      },
      {
        id: 'set:appearance',
        title: 'Open Settings: Appearance',
        group: 'Settings',
        icon: <IconSettings size={14} />,
        run: () => openSettingsAt('appearance'),
      },
      {
        id: 'set:shortcuts',
        title: 'Open Settings: Shortcuts',
        group: 'Settings',
        icon: <IconSettings size={14} />,
        run: () => openSettingsAt('shortcuts'),
      },
    ];
    const themeCmds: PaletteEntry[] = THEMES.map((t) => ({
      id: `theme:${t.id}`,
      title: `Theme: ${t.label}`,
      group: 'Appearance',
      icon: <IconSettings size={14} />,
      run: () => update({ theme: t.id }),
    }));
    const sessionSwitch: PaletteEntry[] = sessions.map((s) => ({
      id: `goto:${s.id}`,
      title: `Switch to: ${s.name}`,
      group: 'Sessions',
      icon: <IconTerminal size={14} />,
      run: () => setActiveId(s.id),
    }));
    const splitCmds: PaletteEntry[] = sessions
      .filter((s) => s.status === 'running' && s.id !== activeId)
      .map((s) => ({
        id: `split:${s.id}`,
        title: `Split with: ${s.name}`,
        group: 'Sessions',
        icon: <IconSidebar size={14} />,
        run: () => setSplitId(s.id),
      }));
    if (splitId)
      splitCmds.push({
        id: 'split:close',
        title: 'Close split pane',
        group: 'Sessions',
        icon: <IconClose size={14} />,
        run: () => setSplitId(null),
      });
    return [...cmds, ...settingsCmds, ...themeCmds, ...sessionSwitch, ...splitCmds];
  }, [
    active,
    sessions,
    settings,
    docState,
    goBack,
    goForward,
    activeId,
    splitId,
    update,
    requestKill,
    openSettingsAt,
    copyToClipboard,
    openView,
    openReviewTab,
    openGitHistoryTab,
    openGlobalSearch,
    sidebarCollapsed,
    explorerCollapsed,
    toggleSidebar,
    toggleExplorer,
    closeDoc,
    dirtySet,
    openNewSession,
    relaunchAllStale,
  ]);

  // ---- Dockable layout: render the three regions in the persisted order ----
  const order = parseLayout(settings.layout);
  const visibleOrder = order.filter(
    (r) => !(r === 'sessions' && sidebarCollapsed) && !(r === 'explorer' && explorerCollapsed),
  );
  const resetDock = () => {
    dragRegionRef.current = null;
    setOverRegion(null);
  };
  const dockHandlers = (region: Region): DockHandlers => ({
    isOver: overRegion === region,
    onDragStart: () => {
      dragRegionRef.current = region;
    },
    onDragEnd: resetDock,
    onDragOver: (e) => {
      const d = dragRegionRef.current;
      if (d && d !== region) {
        e.preventDefault();
        setOverRegion(region);
      }
    },
    onDrop: () => {
      const d = dragRegionRef.current;
      if (d && d !== region) update({ layout: serializeLayout(reorderDock(order, d, region)) });
      resetDock();
    },
  });
  const commitWidth = (region: Region, w: number) =>
    update(region === 'sessions' ? { leftWidth: w } : { rightWidth: w });

  const renderRegion = (region: Region) => {
    if (region === 'center') {
      return (
        // Guard the center pane: a render/teardown throw here (e.g. the xterm
        // WebGL addon failing to dispose when a running session is closed) would
        // otherwise blank the whole React root to black. The boundary catches it
        // and falls back to the editor start state instead of a void.
        <ErrorBoundary key="center" onReset={() => setCenterView('editor')}>
          <CenterPane
            sessions={sessions}
            agents={agents}
            activeId={activeId}
            docs={visibleDocs}
            activeDocId={docState.activeId}
            files={files}
            diffs={diffs}
            onSelectDoc={(id) =>
              dispatchDocs({ type: 'activate', id, sessionId: activeIdRef.current ?? '' })
            }
            onCloseDoc={closeDoc}
            onRelaunch={(id) => post({ type: 'relaunch', id })}
            onTabContextMenu={onTabContextMenu}
            onTerminalTabContextMenu={onTerminalTabContextMenu}
            onReorderDoc={(dragId, targetId) => dispatchDocs({ type: 'reorder', dragId, targetId })}
            dock={dockHandlers('center')}
            splitId={splitId}
            onCloseSplit={() => setSplitId(null)}
            onOpenFile={openFile}
            onOpenFileAt={openTerminalFileLink}
            onRevealFolder={(path) => post({ type: 'revealInExplorer', path })}
            projectPath={active?.projectPath}
            changes={projectData?.changes ?? []}
            onReviewRequestDiff={(abs) => post({ type: 'readDiff', path: abs })}
            onJumpToHunk={jumpToHunk}
            onCloseReview={closeReviewTab}
            onNewSession={openNewSession}
            showGitIndicator={settings.showGitIndicator}
            onOpenGitHistory={openGitHistoryTab}
            onDocTitle={(id, title) => dispatchDocs({ type: 'setTitle', id, title })}
          />
        </ErrorBoundary>
      );
    }
    if (region === 'sessions') {
      // One dock object shared by the frame (drop target + resize) and the Sidebar's
      // own header band (the panel-move drag source, via moveGrip). barless: the
      // Sidebar's header IS the bar, so it aligns with the center tab strip.
      const sdock = dockHandlers('sessions');
      return (
        <PanelFrame
          key="sessions"
          region="sessions"
          title="Sessions"
          widthVar="--left-w"
          edge={centerFacingEdge(visibleOrder, 'sessions')}
          onWidthCommit={(w) => commitWidth('sessions', w)}
          dock={sdock}
          onPanelContextMenu={onPanelTogglesMenu}
          barless
        >
          <Sidebar
            sessions={sessions}
            agents={agents}
            activeId={activeId}
            moveGrip={{ onDragStart: sdock.onDragStart, onDragEnd: sdock.onDragEnd }}
            onSelect={setActiveId}
            onNew={() => openNewSession()}
            onKill={requestKill}
            onCloseAll={() =>
              closeSessions(
                closeAllIds(sessions.map((x) => x.id)),
                'Close all sessions',
                `Close all ${sessions.length} session${sessions.length === 1 ? '' : 's'}? Running terminals will be terminated.`,
              )
            }
            onRename={(id, name) => post({ type: 'rename', id, name })}
            onRelaunch={(id) => post({ type: 'relaunch', id })}
            onOpenSettings={() => openSettingsAt('general')}
            onContextMenu={onSessionContextMenu}
            renamingId={renamingId}
            onSetRenaming={(id) => setRenamingId(id ?? undefined)}
            onReorderSessions={(o) => post({ type: 'reorderSessions', order: o })}
            updateStatus={updateStatus}
            updateDismissed={updateDismissed}
            onUpdateDismiss={() => setUpdateDismissed(true)}
          />
        </PanelFrame>
      );
    }
    // Like sessions: barless, with the RightPane's tab row (Changes/Search/Files)
    // doubling as the panel's top band + move-drag surface, so it aligns with the
    // sessions header and the center tab strip.
    const edock = dockHandlers('explorer');
    return (
      <PanelFrame
        key="explorer"
        region="explorer"
        title="Explorer"
        widthVar="--right-w"
        edge={centerFacingEdge(visibleOrder, 'explorer')}
        onWidthCommit={(w) => commitWidth('explorer', w)}
        dock={edock}
        onPanelContextMenu={onPanelTogglesMenu}
        barless
      >
        <RightPane
          projectPath={active ? activeCwd(active) : undefined}
          changes={projectData?.changes ?? []}
          moveGrip={{ onDragStart: edock.onDragStart, onDragEnd: edock.onDragEnd }}
          onOpenFile={openFile}
          onOpenMatch={openMatch}
          paneRef={rightPaneRef}
          onOpenDiff={(rel) => active && openDiff(joinPath(activeCwd(active), rel))}
          onGitAction={onGitAction}
          setMenu={setMenu}
          revealPath={(path) => post({ type: 'revealInExplorer', path })}
          openExternalApp={(path) => post({ type: 'openExternalPath', path })}
          openWithChooser={(path) => post({ type: 'openWith', path })}
          copyToClipboard={copyToClipboard}
          onDeleteFile={onDeleteFile}
          onFileRenamed={onFileRenamed}
          onChangeContextMenu={onChangeContextMenu}
          onReviewAll={openReviewTab}
          onRefreshChanges={refreshChanges}
          recordFsOp={recordFsOp}
        />
      </PanelFrame>
    );
  };

  return (
    <div className="shell">
      <AnimatedBg />
      <TopBar
        onOpenSearch={() => setPalette({ initialQuery: '' })}
        onToggleSidebar={toggleSidebar}
        sidebarCollapsed={sidebarCollapsed}
        onBack={goBack}
        onForward={goForward}
        canBack={canBack}
        canForward={canForward}
        centerView={centerView}
        onSelectView={setCenterView}
        onContextMenu={onPanelTogglesMenu}
      />
      <div className="workbench">{visibleOrder.map(renderRegion)}</div>
      {newSession && (
        <NewSessionModal
          repos={state?.repos ?? []}
          agents={agents}
          initialPath={newSession.path}
          initialAgentId={newSession.agentId}
          subtitle={
            newSession.cardTitle ? `Start a session for "${newSession.cardTitle}"` : undefined
          }
          onClose={() => setNewSession(null)}
          onOpen={(path, agentId) => {
            // Stamp the originating board card (N2) so the created session links back to it.
            post({ type: 'openRepo', path, agentId, cardId: newSession.cardId });
            setNewSession(null);
          }}
          onBrowse={(agentId) => {
            post({ type: 'browseRepo', agentId });
            setNewSession(null);
          }}
        />
      )}
      {settingsOpen && (
        <SettingsModal
          agents={agents}
          initialTab={settingsTab}
          about={state?.about}
          onClose={() => setSettingsOpen(false)}
          onCheckUpdate={() => post({ type: 'updateCheck' })}
          onRelaunch={() => post({ type: 'updateRelaunch' })}
          updateStatus={updateStatus}
        />
      )}
      {webPromptOpen && (
        <WebPromptModal onClose={() => setWebPromptOpen(false)} onSubmit={openWeb} />
      )}
      {palette && (
        <CommandPalette
          key={palette.initialQuery}
          items={searchItems}
          commandItems={commandItems}
          recentItems={recentItems}
          initialQuery={palette.initialQuery}
          placeholder="Search files & sessions, or type > for commands…"
          onClose={() => setPalette(null)}
        />
      )}
      {centerView === 'board' && (
        <BoardView
          projectPath={active?.projectPath}
          sessions={sessions}
          onStartSessionForCard={(card) =>
            setNewSession({ path: active?.projectPath, cardId: card.id, cardTitle: card.title })
          }
          onActivateSession={(id) => {
            setActiveId(id);
            setCenterView('editor');
          }}
          onClose={() => setCenterView('editor')}
        />
      )}
      {centerView === 'canvas' && (
        <ArchitectureView
          projectPath={active?.projectPath}
          projectName={activeProject}
          onClose={() => setCenterView('editor')}
        />
      )}
      {menu && <ContextMenu menu={menu} onClose={() => setMenu(null)} />}
      {confirm && (
        <ConfirmDialog
          state={confirm}
          onClose={() => {
            // W2: if a quit-confirm is open, reply cancel to the host before closing.
            const cancelFn = quitCancelRef.current;
            quitCancelRef.current = null;
            cancelFn?.();
            setConfirm(null);
          }}
        />
      )}
      {iconPickerSessionId &&
        (() => {
          const pickerSession = sessions.find((s) => s.id === iconPickerSessionId);
          return pickerSession ? (
            <IconPickerModal
              currentIcon={pickerSession.iconOverride}
              onSelect={(name) =>
                post({ type: 'setSessionIcon', id: pickerSession.id, icon: name })
              }
              onClear={() => post({ type: 'setSessionIcon', id: pickerSession.id, icon: null })}
              onClose={() => setIconPickerSessionId(null)}
            />
          ) : null;
        })()}
      <Toasts />
    </div>
  );
}
