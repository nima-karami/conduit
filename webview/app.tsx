import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { activeCwd, gitRootForSession } from '../src/active-cwd';
import { sessionExitAction, shouldConfirmClose } from '../src/close-decision';
import { centerFacingEdge, parseLayout, type Region, serializeLayout } from '../src/layout';
import type { NavLoc } from '../src/nav-history';
import { resolveOwningSession } from '../src/owning-session';
import type {
  FileContentDTO,
  FileDiffDTO,
  HostToWebview,
  PersistedDoc,
  SearchHit,
} from '../src/protocol';
import { quitConfirmCopy } from '../src/quit-guard';
import { staleRelaunchTargets } from '../src/stale-sessions';
import type { AgentDefinition, Session } from '../src/types';
import { fsDndCopy, fsDndMove, fsMutate, gitAction, logToHost, post, subscribe } from './bridge';
import { closeAllIds, closeOthersIds } from './bulk-close';
import { type CenterView, centerViewForAction, nextCenterView } from './center-view';
import { type ClosedTab, popClosedTab, pushClosedTab, toClosedTab } from './closed-tabs';
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
import type { OpenDoc, OpenMode } from './docs';
import {
  docsReducer,
  GIT_HISTORY_DOC_PATH,
  initialDocs,
  REVIEW_DOC_ID,
  type ReviewSource,
  toPersistedDocs,
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
import {
  effectiveCombo,
  formatCombo,
  isMac,
  isWindows,
  matchCombo,
  SHORTCUT_ACTIONS,
} from './shortcuts';
import { closeTabSelection } from './tab-close-selection';
import { requestTerminalFocus } from './terminal-focus-bus';
import { THEMES } from './themes';
import { pushToast } from './toast-store';
import { isComboAllowedWhileTyping, isEditorEntry, isTypingEntry } from './typing-guard';
import { useNavHistory } from './use-nav-history';
import { markClosing } from './view-state-store';

type StateMsg = Extract<HostToWebview, { type: 'state' }>;
type ProjectMsg = Extract<HostToWebview, { type: 'project' }>;
type SettingsTab = 'general' | 'appearance' | 'shortcuts' | 'about';
const baseName = (p: string) => p.split(/[\\/]/).filter(Boolean).pop() || p;

const joinPath = (base: string, rel: string) =>
  `${base.replace(/[\\/]+$/, '')}/${rel}`.replace(/\\/g, '/');

const isCodeFile = (p: string) => /\.(ts|tsx|js|jsx|mts|cts|mjs|cjs)$/i.test(p);
const isHtmlFile = (p: string) => /\.html?$/i.test(p);

// App shortcuts that must defer to Monaco's own handler when the editor is focused (its
// model-level undo/redo). Every other app shortcut passes through the editor, VS Code-style.
const EDITOR_OWNED_ACTIONS = new Set(['undo', 'redo']);

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
  // Latest docs for effects that must read them without re-firing on every docs change (the
  // closeSession view-state eviction sweep is keyed on the session set, not on docs).
  const docsRef = useRef(docState.docs);
  docsRef.current = docState.docs;
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
      } else if (msg.type === 'restoreDocs') {
        // editor-tabs-persist: buffer the persisted tabs and apply once this window's sessions
        // are known (see applyRestore). One-shot — a re-sent `restoreDocs` (e.g. a second
        // `ready`) is ignored so it can't wipe tabs the user has since opened.
        if (!restoredOnceRef.current) {
          pendingRestoreDocsRef.current = msg.docs;
          applyRestoreRef.current();
        }
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

  // When a session's PTY exits on its own (e.g. the user typed `exit`), close plain
  // shells automatically — warning first if the session owns open editor tabs. Agent
  // sessions keep their "Process exited / Restart" card. Each window only sees the
  // sessions it owns (host postState), so the owner reacts once; no double-handling.
  const prevStatusRef = useRef<Map<string, string>>(new Map());
  useEffect(() => {
    const prev = prevStatusRef.current;
    for (const s of sessions) {
      if (prev.get(s.id) === 'running' && s.status === 'exited') {
        const hasOpenEditors = docState.docs.some((d) => d.sessionId === s.id);
        const action = sessionExitAction({ agentId: s.agentId, hasOpenEditors });
        if (action === 'close') {
          post({ type: 'kill', id: s.id });
        } else if (action === 'warn') {
          setConfirm({
            title: 'Terminal exited',
            message: `"${s.name}" exited and has open editor tabs. Close the session and its tabs?`,
            confirmLabel: 'Close session',
            danger: true,
            onConfirm: () => post({ type: 'kill', id: s.id }),
          });
        }
      }
    }
    prevStatusRef.current = new Map(sessions.map((s) => [s.id, s.status]));
  }, [sessions, docState.docs]);

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
      type: 'openReview',
      sessionId: activeIdRef.current ?? '',
      source: { kind: 'working' },
    });
  }, []);

  // Open/activate the singleton Review tab scoped to a COMMIT (source = that commit). Switches
  // the active session first when a target is given (like openFile), so a later terminal
  // commit-link can route to the clicked terminal's session. See
  // docs/specs/2026-06-29-review-commit-source.md §3.1.
  const openReviewForCommit = useCallback(
    (sha: string, targetSessionId?: string, subject?: string) => {
      setCenterView('editor');
      if (targetSessionId && targetSessionId !== activeIdRef.current) {
        setActiveId(targetSessionId);
        dispatchDocs({ type: 'switchSession', sessionId: targetSessionId });
      }
      dispatchDocs({
        type: 'openReview',
        sessionId: targetSessionId ?? activeIdRef.current ?? '',
        source: { kind: 'commit', sha, ...(subject ? { subject } : {}) },
      });
    },
    [],
  );

  // Retarget the open Review tab from its breadcrumb selector (working ⇄ a commit ⇄ a compare).
  const setReviewSource = useCallback(
    (s: ReviewSource) => {
      if (s.kind === 'working') return openReviewTab();
      if (s.kind === 'commit') return openReviewForCommit(s.sha, undefined, s.subject);
      // range: a two-ref comparison rides the singleton review doc like any other source.
      setCenterView('editor');
      dispatchDocs({ type: 'openReview', sessionId: activeIdRef.current ?? '', source: s });
    },
    [openReviewTab, openReviewForCommit],
  );

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

  // Open one of a commit's files as a `commit-diff` tab — from the commit detail rendered
  // inline in the history view (single-click = preview, double-click = pin).
  const openCommitFile = useCallback((sha: string, file: string, pin: boolean) => {
    setCenterView('editor');
    dispatchDocs({
      type: 'openCommitFile',
      sha,
      file,
      sessionId: activeIdRef.current ?? '',
      pin,
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

  // editor-tabs-persist: the one-shot `restoreDocs` payload, buffered until this window's
  // sessions land (so owner sessionIds resolve), then applied exactly once. `applyRestoreRef`
  // lets the message handler trigger the apply without depending on the (sessions-keyed) callback.
  const pendingRestoreDocsRef = useRef<PersistedDoc[] | null>(null);
  const restoredOnceRef = useRef(false);
  const applyRestoreRef = useRef<() => void>(() => {});

  // Stable refs for the fs-undo handlers — populated after their useCallback
  // declarations below. Using refs keeps actionMap free of those deps (which
  // would otherwise create a circular ordering problem: actionMap is declared
  // before `active` is derived, but doUndo/doRedo depend on active-derived hooks).
  const doUndoRef = useRef<() => void>(() => {});
  const doRedoRef = useRef<() => void>(() => {});
  // closeDoc is declared later (it depends on hooks below); the shortcut handler reaches
  // it through this ref to avoid the same ordering problem as undo/redo.
  const closeDocRef = useRef<(id: string) => void>(() => {});
  // Nav back/forward (modal-guarded) are declared after useNavHistory below; actionMap
  // reaches them through refs to avoid the same ordering problem as undo/redo.
  const navBackRef = useRef<() => void>(() => {});
  const navForwardRef = useRef<() => void>(() => {});
  // Reopen-closed-tab (Mod+Shift+T): a bounded LIFO of recently-closed reopenable docs and
  // the reopen action. Both are refs so closeDoc/actionMap don't re-bind on every close;
  // reopenClosedTab depends on openFile/openDiff/openWeb declared further below.
  const closedTabsRef = useRef<ClosedTab[]>([]);
  const reopenClosedTabRef = useRef<() => void>(() => {});
  // Polite live region announcing the landed location after a Back/Forward traversal — a
  // same-type editor→editor jump isn't conveyed by focus alone (spec §10).
  const navLiveRef = useRef<HTMLDivElement>(null);

  // Global shortcuts — data-driven from the (rebindable, persisted) bindings.
  const actionMap = useMemo<Record<string, () => void>>(
    () => ({
      openSearch: () => setPalette({ initialQuery: '' }),
      openCommands: () => setPalette({ initialQuery: '>' }),
      // Alt+Left/Right parity for the mouse thumb buttons; guarded against modal surfaces
      // inside navBack/navForward (the keydown form-field guard alone misses non-input modals).
      navBack: () => navBackRef.current(),
      navForward: () => navForwardRef.current(),
      // View-switch actions route through centerViewForAction so the action→view
      // mapping has a single, unit-tested source of truth (no inline drift).
      openBoard: () => openView('openBoard'),
      openArchitecture: () => openView('openArchitecture'),
      openReview: openReviewTab,
      openGitHistory: openGitHistoryTab,
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
      // File-explorer undo/redo. Listed in EDITOR_OWNED_ACTIONS so Ctrl+Z/Ctrl+Shift+Z
      // defer to Monaco's model-level undo while the editor is focused, and blocked in
      // form fields by isFormFieldEntry; they fire here only elsewhere (explorer, terminal).
      // Invoked via stable refs to avoid ordering issues (doUndo/doRedo are declared
      // after active is derived, which is after this useMemo).
      undo: () => doUndoRef.current(),
      redo: () => doRedoRef.current(),
      // Close the active editor tab (VS Code Mod+W). No-op when the Terminal is active.
      closeTab: () => {
        const id = docStateRef.current.activeId;
        if (id) closeDocRef.current(id);
      },
      // Reopen the most recently closed tab (VS Code Mod+Shift+T). Invoked via a stable ref
      // for the same ordering reason as undo/redo (openFile/openDiff are declared later).
      reopenClosedTab: () => reopenClosedTabRef.current(),
    }),
    [
      openView,
      toggleSidebar,
      toggleExplorer,
      openGlobalSearch,
      openNewSession,
      openReviewTab,
      openGitHistoryTab,
    ],
  );
  const bindingsRef = useRef(settings.shortcuts);
  bindingsRef.current = settings.shortcuts;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as Element | null;
      // Resolve the editor surface once (a DOM ancestor walk on the keystroke hot path):
      // a form field is a typing surface that ISN'T the editor (which gets pass-through).
      const inEditor = isEditorEntry(target);
      const inFormField = !inEditor && isTypingEntry(target);
      for (const action of SHORTCUT_ACTIONS) {
        // `fixed` rows are cheat-sheet display only — the hardcoded block below owns them.
        if (action.fixed) continue;
        const combo = effectiveCombo(action, bindingsRef.current);
        if (!matchCombo(e, combo)) continue;
        if (!actionMap[action.id]) continue;
        // Real form fields (modal inputs, filters, address bar) swallow app shortcuts
        // unless the combo is explicitly allowed while typing (e.g. Mod+S).
        if (inFormField && !isComboAllowedWhileTyping(combo)) continue;
        // The Monaco editor gets VS Code-style pass-through: app shortcuts fire over it,
        // except its own editing actions (undo/redo), which must reach Monaco. The
        // terminal already passes everything through (it isn't a form field).
        if (inEditor && EDITOR_OWNED_ACTIONS.has(action.id)) continue;
        e.preventDefault();
        // Stop the focused widget (xterm, Monaco) from ALSO acting on this combo.
        e.stopPropagation();
        actionMap[action.id]();
        return;
      }

      // Fixed editor-navigation shortcuts (VS Code parity). Their combos use a literal
      // Ctrl or a bare digit the Mod-combo grammar can't express, so they live here, not
      // in SHORTCUT_ACTIONS. Suppressed in real form fields so typing Tab/digits there is
      // unaffected; they DO fire over the editor and terminal.
      if (inFormField) return;
      const primary = isMac ? e.metaKey : e.ctrlKey;
      const ctrlOnly = e.ctrlKey && !e.metaKey && !e.altKey;
      // Bail before the doc lookup unless this is a Ctrl/primary chord a branch below
      // could claim — ordinary typing never reaches the per-key tests.
      if (!ctrlOnly && !primary) return;
      const sessionId = activeIdRef.current ?? '';
      const sessionDocs = docStateRef.current.docs.filter((d) => d.sessionId === sessionId);
      const activate = (id: string | null) => dispatchDocs({ type: 'activate', id, sessionId });
      // Ctrl+Tab everywhere — Cmd+Tab is OS-reserved on macOS. The Terminal (null) is the
      // first stop, then each open doc; Shift reverses.
      if (ctrlOnly && e.key === 'Tab') {
        e.preventDefault();
        e.stopPropagation();
        const stops: (string | null)[] = [null, ...sessionDocs.map((d) => d.id)];
        const cur = stops.indexOf(docStateRef.current.activeId);
        const dir = e.shiftKey ? -1 : 1;
        const next = stops[(cur + dir + stops.length) % stops.length];
        activate(next);
        return;
      }
      // Ctrl+PageUp/PageDown = previous/next tab (VS Code parity), same stops as Ctrl+Tab.
      if (ctrlOnly && (e.key === 'PageUp' || e.key === 'PageDown')) {
        e.preventDefault();
        e.stopPropagation();
        const stops: (string | null)[] = [null, ...sessionDocs.map((d) => d.id)];
        const cur = stops.indexOf(docStateRef.current.activeId);
        const dir = e.key === 'PageUp' ? -1 : 1;
        const next = stops[(cur + dir + stops.length) % stops.length];
        activate(next);
        return;
      }
      // Ctrl+` everywhere (VS Code parity, not Cmd-based).
      if (ctrlOnly && (e.key === '`' || e.code === 'Backquote')) {
        e.preventDefault();
        e.stopPropagation();
        activate(null);
        // Focus after the re-render has made the terminal visible.
        requestAnimationFrame(() => requestTerminalFocus(sessionId));
        return;
      }
      // Cmd/Ctrl+1-9 → the Nth open doc; no-op past the count.
      if (primary && !e.altKey && !e.shiftKey && /^[1-9]$/.test(e.key)) {
        const doc = sessionDocs[Number(e.key) - 1];
        if (!doc) return;
        e.preventDefault();
        e.stopPropagation();
        activate(doc.id);
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
      if (!current.has(id)) {
        for (const d of docsRef.current) {
          if (d.sessionId === id) markClosing(d.id);
        }
        dispatchDocs({ type: 'closeSession', sessionId: id });
      }
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
    if (active)
      post({ type: 'requestProject', path: activeCwd(active), changesRoot: active.activeRepoRoot });
  }, [active?.projectPath, active?.cwd, active?.activeRepoRoot]);

  // Multi-repo auto-follow: when the focused editor doc changes, tell the host so the active repo
  // follows the file you're reading (host maps it to the containing sub-repo; ignored while pinned).
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed on focus change (activeId) only
  useEffect(() => {
    const d = docState.docs.find((x) => x.id === docState.activeId);
    if (d?.kind === 'file' && d.path)
      post({ type: 'repo:context', sessionId: d.sessionId, path: d.path });
  }, [docState.activeId]);

  // Re-read the working-tree change list (R5.3). Used both by the manual refresh button
  // in the Changes tab and by the focus/visibility auto-refresh below.
  // biome-ignore lint/correctness/useExhaustiveDependencies: intentional fine-grained dep (cwd + projectPath only)
  const refreshChanges = useCallback(() => {
    if (active)
      post({ type: 'requestProject', path: activeCwd(active), changesRoot: active.activeRepoRoot });
  }, [active?.projectPath, active?.cwd, active?.activeRepoRoot]);

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
    if (cur)
      post({ type: 'requestProject', path: activeCwd(cur), changesRoot: cur.activeRepoRoot });
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

  // Immediately close a doc tab (no dirty check). Also drops any dirty- and view-state entry.
  const forceCloseDoc = useCallback(
    (id: string) => {
      const doc = docState.docs.find((d) => d.id === id);
      if (doc) {
        clearDirty(doc.path);
        const closed = toClosedTab(doc);
        if (closed) closedTabsRef.current = pushClosedTab(closedTabsRef.current, closed);
      }
      markClosing(id);
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
        onSecondary: () => forceCloseDoc(id),
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
  closeDocRef.current = closeDoc;

  const indexedRoots = useRef<Set<string>>(new Set());
  const openFile = useCallback(
    (path: string, targetSessionId?: string, mode: OpenMode = 'preview') => {
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
      dispatchDocs({ type: 'open', kind: 'file', path, sessionId: effectiveSessionId, mode });
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

  // Reopen the last closed tab (Mod+Shift+T). Files/diffs restore under their original
  // session as permanent tabs; a web tab reopens under the active session (openWeb owns no
  // session param). A no-op when the stack is empty.
  const reopenClosedTab = useCallback(() => {
    const { tab, rest } = popClosedTab(closedTabsRef.current);
    closedTabsRef.current = rest;
    if (!tab) return;
    if (tab.kind === 'file') openFile(tab.path, tab.sessionId, 'permanent');
    else if (tab.kind === 'diff') openDiff(tab.path, tab.sessionId);
    else openWeb(tab.path);
  }, [openFile, openDiff, openWeb]);
  reopenClosedTabRef.current = reopenClosedTab;

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

  // Stable so ReviewView's fetch effect runs once, not on every diff arrival: an inline
  // arrow here changes identity each app render → re-requests every diff → O(N^2) reads.
  const requestReviewDiff = useCallback((abs: string) => post({ type: 'readDiff', path: abs }), []);

  // D11: open a terminal path link at an optional position. Resolves the owning session
  // so the file opens in the session that owns the path, then stages a reveal if a line
  // (and optionally col) was given. Switches the center pane to the editor.
  const openTerminalFileLink = useCallback(
    (path: string, line?: number, col?: number, originSessionId?: string) => {
      const owningId = resolveOwningSession({
        path,
        sessions,
        openDocs: docState.docs,
        activeId: activeId ?? null,
        originSessionId,
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

  // Edit-promotes (spec §3.1, data-safety invariant): when a previewed file's buffer
  // goes dirty, promote it to permanent so a later single-click can't silently replace
  // unsaved work via the reused preview slot.
  useEffect(
    () =>
      subscribeDirty(() => {
        const dirty = getDirtySnapshot();
        for (const d of docStateRef.current.docs) {
          if (d.preview && (d.kind === 'file' || d.kind === 'diff') && dirty.has(d.path)) {
            dispatchDocs({ type: 'pinDoc', id: d.id });
          }
        }
      }),
    [],
  );

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
        // OS/external open is a deliberate "work on this" act → permanent (spec §9 D7).
        openFile(req.path, req.sessionId, 'permanent');
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

  // editor-tabs-persist: apply the buffered `restoreDocs` once this window's sessions are known,
  // so each persisted doc attaches to its (restored, stale) session and orphans are dropped.
  // Runs from the message handler and again whenever `sessions` changes (the first `state` after
  // restore), mirroring flushOsOpens. switchSession then reveals the active session's tab.
  const applyRestore = useCallback(() => {
    if (restoredOnceRef.current) return;
    const pending = pendingRestoreDocsRef.current;
    if (!pending || sessions.length === 0) return;
    restoredOnceRef.current = true;
    pendingRestoreDocsRef.current = null;
    dispatchDocs({ type: 'restore', docs: pending, knownSessionIds: sessions.map((s) => s.id) });
    dispatchDocs({ type: 'switchSession', sessionId: activeIdRef.current ?? sessions[0].id });
  }, [sessions]);
  applyRestoreRef.current = applyRestore;
  useEffect(() => {
    applyRestore();
  }, [applyRestore]);

  // editor-tabs-persist: send the persisted slice of docState to the host, debounced so a burst
  // of tab changes coalesces into one write. The host stores it for the before-quit sync flush
  // and atomic-writes docs.json. The fire-time guard skips while a buffered restore is still
  // pending (sessions not yet landed) so an empty docState can't clobber docs.json before restore
  // seeds it; once restore applies (or there was none), the resulting docState change re-arms this.
  const persistedDocs = useMemo(() => toPersistedDocs(docState), [docState]);
  useEffect(() => {
    const t = setTimeout(() => {
      if (pendingRestoreDocsRef.current !== null) return;
      post({ type: 'persistDocs', docs: persistedDocs });
    }, 400);
    return () => clearTimeout(t);
  }, [persistedDocs]);

  const copyToClipboard = useCallback((text: string) => {
    void navigator.clipboard?.writeText(text);
  }, []);

  // Close a session — confirm only when there's something to lose (a running agent or
  // open editor tabs); a plain idle shell closes silently. See shouldConfirmClose.
  const requestKill = useCallback(
    (id: string) => {
      const s = sessions.find((x) => x.id === id);
      const hasOpenEditors = docState.docs.some((d) => d.sessionId === id);
      if (
        s &&
        shouldConfirmClose({
          status: s.status,
          agentId: s.agentId,
          hasOpenEditors,
          confirmEnabled: settings.confirmCloseRunning,
        })
      ) {
        setConfirm({
          title: 'Close session?',
          message: hasOpenEditors
            ? `"${s.name}" has open editor tabs. Closing it will terminate the session and close its tabs.`
            : `"${s.name}" is running. Closing it will terminate its terminal.`,
          confirmLabel: 'Close session',
          danger: true,
          onConfirm: () => post({ type: 'kill', id }),
        });
      } else {
        post({ type: 'kill', id });
      }
    },
    [sessions, docState.docs, settings.confirmCloseRunning],
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
    // Primary/lifecycle group — present only for the relevant session state, so it can be empty
    // (e.g. the active running session); the edit group's separator is gated on it below to avoid
    // a leading divider.
    const lifecycle: MenuItem[] = [];
    if (s.status === 'running' && s.id !== activeId) {
      lifecycle.push({
        label: 'Open in split pane',
        icon: <IconSidebar size={14} />,
        onClick: () => setSplitId(s.id),
      });
    }
    if (s.status !== 'running') {
      lifecycle.push({
        label: 'Relaunch',
        icon: <IconSparkle size={14} />,
        onClick: () => post({ type: 'relaunch' as const, id: s.id }),
      });
    }
    setMenu({
      x: e.clientX,
      y: e.clientY,
      items: [
        ...lifecycle,
        {
          label: 'Rename',
          icon: <IconPencil size={14} />,
          separatorBefore: lifecycle.length > 0,
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
        {
          label: 'Duplicate session',
          icon: <IconDuplicate size={14} />,
          onClick: () => post({ type: 'duplicate', id: s.id }),
        },
        ...moveMenuItems(s.id),
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
          label: 'Reveal in Explorer',
          icon: <IconExternal size={14} />,
          onClick: () => post({ type: 'revealInExplorer', path: s.projectPath }),
        },
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
        // Keyboard-reachable pin pathway (a11y) — the only non-pointer way to promote a
        // preview, since double-click and drag are pointer-only (spec §10).
        ...(doc.preview
          ? [
              {
                label: 'Keep Open',
                onClick: () => dispatchDocs({ type: 'pinDoc', id: doc.id }),
              },
            ]
          : []),
        {
          label: 'Close',
          icon: <IconClose size={14} />,
          onClick: () => closeDoc(doc.id),
        },
        {
          label: 'Close others',
          onClick: () => {
            const idsToClose = docState.docs
              .filter((d) => others.includes(d.path))
              .map((d) => d.id);
            for (const id of idsToClose) closeDoc(id);
          },
          disabled: others.length === 0,
        },
        {
          label: 'Close to the right',
          onClick: () => {
            const idsToClose = docState.docs
              .filter((d) => toRight.includes(d.path))
              .map((d) => d.id);
            for (const id of idsToClose) closeDoc(id);
          },
          disabled: toRight.length === 0,
        },
        {
          label: 'Close to the left',
          onClick: () => {
            const idsToClose = docState.docs
              .filter((d) => toLeft.includes(d.path))
              .map((d) => d.id);
            for (const id of idsToClose) closeDoc(id);
          },
          disabled: toLeft.length === 0,
        },
        {
          label: 'Close all',
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
          label: 'Copy name',
          icon: <IconCopy size={14} />,
          onClick: () => copyToClipboard(baseName(doc.path)),
        },
        {
          label: 'Reveal in Explorer',
          icon: <IconExternal size={14} />,
          onClick: () => post({ type: 'revealInExplorer', path: doc.path }),
        },
        // HTML files have no faithful in-editor render (the in-app webview is http(s)-only
        // by design); offer the OS default browser instead.
        ...(doc.kind === 'file' && isHtmlFile(doc.path)
          ? [
              {
                label: 'Open in browser',
                icon: <IconExternal size={14} />,
                onClick: () => post({ type: 'openExternalPath', path: doc.path }),
              },
            ]
          : []),
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
          label: 'Rename',
          icon: <IconPencil size={14} />,
          onClick: () => setRenamingId(s.id),
        },
        {
          label: 'Set icon…',
          icon: <IconSparkle size={14} />,
          onClick: () => setIconPickerSessionId(s.id),
        },
        {
          label: 'Duplicate session',
          icon: <IconDuplicate size={14} />,
          onClick: () => post({ type: 'duplicate', id: s.id }),
        },
        ...moveMenuItems(s.id),
        {
          label: 'Reveal in Explorer',
          icon: <IconExternal size={14} />,
          separatorBefore: true,
          onClick: () => post({ type: 'revealInExplorer', path: s.projectPath }),
        },
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
      // A rename re-targets a tab the user already had open for real → keep it permanent.
      openFile(toPath, undefined, 'permanent');
    },
    [dropDocsFor, openFile],
  );

  const onChangeContextMenu = (e: React.MouseEvent, rel: string) => {
    e.preventDefault();
    if (!active) return;
    // Change paths are relative to the active repo, not the opened/cwd folder.
    const abs = joinPath(gitRootForSession(active), rel);
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
          label: 'Copy path',
          icon: <IconCopy size={14} />,
          separatorBefore: true,
          onClick: () => copyToClipboard(abs),
        },
        {
          label: 'Reveal in Explorer',
          icon: <IconExternal size={14} />,
          onClick: () => post({ type: 'revealInExplorer', path: abs }),
        },
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
          separatorBefore: true,
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
          separatorBefore: true,
          disabled: changes.length === 0,
          onClick: () => onGitAction({ op: 'discardAll' }),
        },
      ],
    });
  };

  // Run a git action (stage/unstage/discard/stash) in the active repo, then re-fetch the
  // change list so the UI reflects the new state. Failures toast.
  // biome-ignore lint/correctness/useExhaustiveDependencies: active read via its fine-grained fields
  const runGit = useCallback(
    async (op: GitActionIntent['op'], path?: string) => {
      if (!active) return;
      // Stage/unstage/discard must run in the active repo — change paths are relative to it.
      const root = gitRootForSession(active);
      // 'discardAll' is a renderer-only intent; map it to a real bulk discard below.
      const hostOp = op as Exclude<GitActionIntent['op'], 'discardAll'>;
      const res = await gitAction({ root, op: hostOp, path });
      if (!res.ok) pushToast({ message: `Git: ${res.error}`, variant: 'error' });
      // Always refresh — even on failure the on-disk state may have partially changed.
      refreshChanges();
    },
    [active?.projectPath, active?.cwd, active?.activeRepoRoot, refreshChanges],
  );

  // Discard every change: unstage all, then restore tracked files, then delete
  // untracked. Sequenced so staged-and-modified files end up clean. Refresh once.
  // biome-ignore lint/correctness/useExhaustiveDependencies: active read via its fine-grained fields
  const discardAll = useCallback(async () => {
    if (!active) return;
    const root = gitRootForSession(active);
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
    refreshChanges();
  }, [
    active?.projectPath,
    active?.cwd,
    active?.activeRepoRoot,
    projectData?.changes,
    refreshChanges,
  ]);

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

  // A recorded location is alive when its session still exists and (for a doc) the doc is
  // still open. Injected into traversal so Back/Forward skip closed tabs/sessions instead
  // of landing on the Terminal-as-fallback (spec §3.1a, AC8).
  const isAlive = useCallback(
    (l: NavLoc): boolean => {
      if (l.sessionId === undefined || !sessions.some((s) => s.id === l.sessionId)) return false;
      return l.docId === null || docState.docs.some((d) => d.id === l.docId);
    },
    [sessions, docState.docs],
  );

  // Back/forward navigation across visited views (session terminal / doc tabs). The landed
  // location is guaranteed alive by isAlive, so the docId applies directly (no fallback).
  const applyNav = useCallback(
    (l: NavLoc) => {
      setActiveId(l.sessionId);
      dispatchDocs({ type: 'activate', id: l.docId, sessionId: l.sessionId });
      const label =
        l.docId === null
          ? `Terminal: ${sessions.find((s) => s.id === l.sessionId)?.name ?? ''}`
          : `Editor: ${docState.docs.find((d) => d.id === l.docId)?.title ?? ''}`;
      if (navLiveRef.current) navLiveRef.current.textContent = label;
    },
    [sessions, docState.docs],
  );
  const { goBack, goForward, canBack, canForward } = useNavHistory(
    { sessionId: activeId, docId: docState.activeId },
    applyNav,
    isAlive,
  );

  // A non-input modal/overlay (confirm, menu, palette, settings, new-session, web-prompt,
  // icon-picker) must swallow the nav inputs — the keydown form-field guard only catches
  // focused inputs, not these (spec §4, AC10).
  const isAnyModalOpen =
    !!palette ||
    settingsOpen ||
    !!menu ||
    !!confirm ||
    !!newSession ||
    webPromptOpen ||
    iconPickerSessionId !== null;
  const navBack = useCallback(() => {
    if (!isAnyModalOpen) goBack();
  }, [isAnyModalOpen, goBack]);
  const navForward = useCallback(() => {
    if (!isAnyModalOpen) goForward();
  }, [isAnyModalOpen, goForward]);
  useEffect(() => {
    navBackRef.current = navBack;
    navForwardRef.current = navForward;
  }, [navBack, navForward]);

  // Mouse thumb buttons X1/X2 → Back/Forward. A window-level CAPTURE listener mirrors the
  // keydown handler so xterm/Monaco stopPropagation can't blackhole it; mousedown is
  // preventDefault'd to suppress Chromium's own (no-op here) history nav. On Windows the
  // DOM thumb-button path is gated off — the host app-command is the authoritative source
  // there, so one physical press navigates exactly once (spec §3.3).
  useEffect(() => {
    if (isWindows) return;
    const guestFocused = () => document.activeElement?.tagName.toLowerCase() === 'webview';
    const isThumb = (b: number) => b === 3 || b === 4;
    const onDown = (e: MouseEvent) => {
      if (isThumb(e.button)) e.preventDefault();
    };
    const onAux = (e: MouseEvent) => {
      if (!isThumb(e.button)) return;
      e.preventDefault();
      if (guestFocused()) return;
      if (e.button === 3) navBack();
      else navForward();
    };
    window.addEventListener('mousedown', onDown, true);
    window.addEventListener('auxclick', onAux, true);
    return () => {
      window.removeEventListener('mousedown', onDown, true);
      window.removeEventListener('auxclick', onAux, true);
    };
  }, [navBack, navForward]);

  // Windows thumb-button fallback: the host forwards the per-window app-command as an
  // `appCommand` message (the authoritative source on Windows; see the DOM gate above).
  useEffect(() => {
    return subscribe((msg) => {
      if (msg.type !== 'appCommand') return;
      if (msg.command === 'back') navBack();
      else navForward();
    });
  }, [navBack, navForward]);

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
    // Show each command's bound key combo for discoverability, resolved through the same
    // (rebindable) registry the global handler uses. Absent for commands with no binding.
    const comboFor = (actionId: string): string | undefined => {
      const action = SHORTCUT_ACTIONS.find((a) => a.id === actionId);
      return action ? formatCombo(effectiveCombo(action, settings.shortcuts)) : undefined;
    };
    const cmds: PaletteEntry[] = [
      {
        id: 'cmd:new',
        title: 'New session',
        group: 'Commands',
        icon: <IconPlus size={14} />,
        combo: comboFor('newSession'),
        run: () => openNewSession(),
      },
      {
        id: 'cmd:newWindow',
        title: 'New window',
        group: 'Commands',
        icon: <IconPlus size={14} />,
        combo: comboFor('newWindow'),
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
        combo: comboFor('openBoard'),
        run: () => openView('openBoard'),
      },
      {
        id: 'cmd:arch',
        title: 'Open architecture canvas',
        group: 'Commands',
        icon: <IconGraph size={14} />,
        combo: comboFor('openArchitecture'),
        run: () => openView('openArchitecture'),
      },
      {
        id: 'cmd:review',
        title: 'Review all changes',
        group: 'Commands',
        icon: <IconReview size={14} />,
        combo: comboFor('openReview'),
        run: openReviewTab,
      },
      {
        id: 'cmd:gitHistory',
        title: 'View commit history',
        group: 'Commands',
        icon: <IconBranch size={14} />,
        combo: comboFor('openGitHistory'),
        run: openGitHistoryTab,
      },
      {
        id: 'cmd:findInFiles',
        title: 'Find in files',
        group: 'Commands',
        icon: <IconSearch size={14} />,
        combo: comboFor('openGlobalSearch'),
        run: openGlobalSearch,
      },
      {
        id: 'cmd:toggleSidebar',
        title: paletteCommandTitle('sessions', !sidebarCollapsed),
        group: 'Commands',
        icon: <IconSidebar size={14} />,
        combo: comboFor('toggleSidebar'),
        run: toggleSidebar,
      },
      {
        id: 'cmd:toggleExplorer',
        title: paletteCommandTitle('explorer', !explorerCollapsed),
        group: 'Commands',
        icon: <IconDoc size={14} />,
        combo: comboFor('toggleExplorer'),
        run: toggleExplorer,
      },
      {
        id: 'cmd:back',
        title: 'Go back',
        group: 'Commands',
        icon: <IconCommand size={14} />,
        combo: comboFor('navBack'),
        run: goBack,
      },
      {
        id: 'cmd:forward',
        title: 'Go forward',
        group: 'Commands',
        icon: <IconCommand size={14} />,
        combo: comboFor('navForward'),
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
      if (activeDoc.kind === 'file' && isHtmlFile(activeDoc.path)) {
        cmds.push({
          id: 'cmd:openInBrowser',
          title: 'Open active file in browser',
          group: 'Commands',
          icon: <IconExternal size={14} />,
          run: () => post({ type: 'openExternalPath', path: activeDoc.path }),
        });
      }
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
        combo: comboFor('openSettings'),
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
            onPinDoc={(id) => dispatchDocs({ type: 'pinDoc', id })}
            dock={dockHandlers('center')}
            splitId={splitId}
            onCloseSplit={() => setSplitId(null)}
            onOpenFile={openFile}
            onOpenFileAt={openTerminalFileLink}
            onRevealFolder={(path) => post({ type: 'revealInExplorer', path })}
            onOpenCommitReview={(sha, sid) => openReviewForCommit(sha, sid)}
            changesRoot={active ? gitRootForSession(active) : undefined}
            changes={projectData?.changes ?? []}
            onReviewRequestDiff={requestReviewDiff}
            onJumpToHunk={jumpToHunk}
            onCloseReview={closeReviewTab}
            onSetReviewSource={setReviewSource}
            onNewSession={openNewSession}
            showGitIndicator={settings.showGitIndicator}
            onOpenGitHistory={openGitHistoryTab}
            onOpenReview={openReviewTab}
            onOpenCommitFile={openCommitFile}
            onReviewCommit={(sha, subject) => openReviewForCommit(sha, undefined, subject)}
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
            onSessionDragEnd={(sessionId, screenX, screenY) =>
              post({ type: 'session:dragEnd', sessionId, screenX, screenY })
            }
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
          onOpenFile={(p, mode) => openFile(p, undefined, mode)}
          onOpenMatch={openMatch}
          paneRef={rightPaneRef}
          onOpenDiff={(rel) => active && openDiff(joinPath(gitRootForSession(active), rel))}
          onGitAction={onGitAction}
          setMenu={setMenu}
          revealPath={(path) => post({ type: 'revealInExplorer', path })}
          openExternalApp={(path) => post({ type: 'openExternalPath', path })}
          openWithChooser={(path) => post({ type: 'openWith', path })}
          copyToClipboard={copyToClipboard}
          onDeleteFile={onDeleteFile}
          onFileRenamed={onFileRenamed}
          onChangeContextMenu={onChangeContextMenu}
          onRefreshChanges={refreshChanges}
          recordFsOp={recordFsOp}
          onContextPath={(p) =>
            active && post({ type: 'repo:context', sessionId: active.id, path: p })
          }
        />
      </PanelFrame>
    );
  };

  return (
    <div className="shell">
      <AnimatedBg />
      <div ref={navLiveRef} className="sr-only" aria-live="polite" role="status" />
      <TopBar
        isDev={!!state?.about?.isDev}
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
