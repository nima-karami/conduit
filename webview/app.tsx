import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { centerFacingEdge, parseLayout, type Region, serializeLayout } from '../src/layout';
import type { NavLoc } from '../src/nav-history';
import type { FileContentDTO, FileDiffDTO, HostToWebview, SearchHit } from '../src/protocol';
import type { AgentDefinition, Session } from '../src/types';
import { fsMutate, gitAction, logToHost, post, subscribe } from './bridge';
import { closeAllIds, closeOthersIds } from './bulk-close';
import { type CenterView, centerViewForAction, nextCenterView } from './center-view';
import { AnimatedBg } from './components/animated-bg';
import { ArchitectureView } from './components/architecture-view';
import { BoardView } from './components/board-view';
import { CenterPane } from './components/center-pane';
import { CommandPalette, type PaletteEntry } from './components/command-palette';
import { ConfirmDialog, type ConfirmState } from './components/confirm-dialog';
import { ContextMenu, type MenuState } from './components/context-menu';
import { ErrorBoundary } from './components/error-boundary';
import { NewSessionModal } from './components/new-session-modal';
import { type DockHandlers, PanelFrame } from './components/panel-frame';
import { type GitActionIntent, RightPane, type RightPaneHandle } from './components/right-pane';
import { SettingsModal } from './components/settings-modal';
import { Sidebar } from './components/sidebar';
import { Toasts } from './components/toasts';
import { TopBar } from './components/top-bar';
import { clearDirty, getDirtySnapshot, subscribeDirty } from './dirty-store';
import { reorderDock } from './dock-reorder';
import type { OpenDoc } from './docs';
import { docsReducer, initialDocs } from './docs';
import { shouldReplaceContent } from './file-freshness';
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
  IconSearch,
  IconSettings,
  IconSidebar,
  IconSparkle,
  IconTerminal,
  IconTrash,
} from './icons';
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
  const [docState, dispatchDocs] = useReducer(docsReducer, initialDocs);
  const [files, setFiles] = useState<Map<string, FileContentDTO>>(new Map());
  const [diffs, setDiffs] = useState<Map<string, FileDiffDTO>>(new Map());
  const [palette, setPalette] = useState<{ initialQuery: string } | null>(null);
  const [settingsTab, setSettingsTab] = useState<SettingsTab>('general');
  const [recents, setRecents] = useState<{ kind: 'file' | 'diff'; path: string }[]>([]);
  const [search, setSearch] = useState<{ root: string; results: SearchHit[] }>({
    root: '',
    results: [],
  });
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [renamingId, setRenamingId] = useState<string | undefined>(undefined);
  const [confirm, setConfirm] = useState<ConfirmState | null>(null);
  const [centerView, setCenterView] = useState<CenterView>('editor');
  const [splitId, setSplitId] = useState<string | null>(null);
  const dragRegionRef = useRef<Region | null>(null);
  const [overRegion, setOverRegion] = useState<Region | null>(null);
  const { hydrate, settings, update } = useSettings();

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
      } else if (msg.type === 'project') setProject(msg);
      else if (msg.type === 'fileContent') {
        // K3 dirty-buffer protection: a fresh disk read must NOT replace the map
        // entry for a path whose Monaco buffer is dirty. CodeViewer's seed effect
        // is keyed on `doc.content`, so replacing it would re-seed the model from
        // disk and destroy the user's unsaved edits. A clean path picks up the
        // fresh content (the point of the branch). See file-freshness.ts.
        const path = msg.doc.path;
        if (shouldReplaceContent(path, getDirtySnapshot().has(path))) {
          setFiles((m) => new Map(m).set(path, msg.doc));
        }
      } else if (msg.type === 'fileDiff') setDiffs((m) => new Map(m).set(msg.doc.path, msg.doc));
      else if (msg.type === 'searchResults') setSearch({ root: msg.root, results: msg.results });
      else if (msg.type === 'projectFiles') {
        indexModels(msg.files);
        // Once-guarded inside: kicks the TS-worker warm-up early so the user's first
        // go-to-definition isn't paying a fresh cold start (wishlist E1).
        warmWorkerFromMonaco();
      } else if (msg.type === 'error') {
        // A host-side failure (e.g. a failed `.conduit/` save) must be VISIBLE, not
        // silently dropped — that's the whole point of propagating it (ADR §5). Log it
        // to the host and surface a dismissable alert so the user never "thinks it
        // saved and didn't."
        logToHost(`host error: ${msg.message}`);
        setConfirm({
          title: 'Something went wrong',
          message: msg.message,
          confirmLabel: 'Dismiss',
          onConfirm: () => {},
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
        if (!existing) return m; // not in map — nothing to update
        // Preserve the full FileContentDTO shape; only update content.
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

  // Latest docs snapshot in a ref so the global Mod+S handler (bound once) can route to
  // the ACTIVE doc's registered save without re-binding the listener on every doc change.
  const docStateRef = useRef(docState);
  docStateRef.current = docState;

  // Global shortcuts — data-driven from the (rebindable, persisted) bindings.
  const actionMap = useMemo<Record<string, () => void>>(
    () => ({
      openSearch: () => setPalette({ initialQuery: '' }),
      openCommands: () => setPalette({ initialQuery: '>' }),
      // View-switch actions route through centerViewForAction so the action→view
      // mapping has a single, unit-tested source of truth (no inline drift).
      openBoard: () => openView('openBoard'),
      openArchitecture: () => openView('openArchitecture'),
      openEditor: () => openView('openEditor'),
      openGlobalSearch,
      toggleSidebar,
      toggleExplorer,
      newSession: () => openNewSession(),
      openSettings: () => {
        setSettingsTab('general');
        setSettingsOpen(true);
      },
      // Global save (K2): route Mod+S — pressed ANYWHERE, including the terminal or
      // sidebar — to the active doc's registered save. Self-guarded (no active doc /
      // clean / in-flight → no-op), so it never fights Monaco's own focused binding.
      save: () => saveActiveDoc(docStateRef.current.docs, docStateRef.current.activeId),
    }),
    [openView, toggleSidebar, toggleExplorer, openGlobalSearch, openNewSession],
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

  // Ask the host for git changes + file tree whenever the active project changes.
  useEffect(() => {
    if (active?.projectPath) post({ type: 'requestProject', path: active.projectPath });
  }, [active?.projectPath]);

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

  const projectData = project && active && project.path === active.projectPath ? project : null;

  const pushRecent = useCallback(
    (kind: 'file' | 'diff', path: string) =>
      setRecents((prev) =>
        [{ kind, path }, ...prev.filter((r) => !(r.kind === kind && r.path === path))].slice(0, 10),
      ),
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
        // Clean — close immediately.
        forceCloseDoc(id);
        return;
      }
      const fileName = baseName(doc.path);
      setConfirm({
        title: `Unsaved changes in ${fileName}`,
        message: `"${fileName}" has unsaved changes. Save before closing, or discard them?`,
        confirmLabel: 'Save',
        // Secondary = Discard: clear dirty + close without writing.
        secondaryLabel: 'Discard',
        onSecondary: () => {
          clearDirty(doc.path);
          dispatchDocs({ type: 'close', id });
        },
        // Primary = Save: invoke save, close on success only.
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
    (path: string) => {
      // K3: always request a fresh read from disk. If we already have a cached
      // copy it stays displayed until the host replies (no flicker). We never
      // short-circuit because the file may have changed on disk since the last
      // read (e.g. agent or external editor wrote it).
      // Exception: if the buffer is dirty we still dispatch the readFile request
      // (to keep the map fresh for the markdown rendered view), but CodeViewer
      // does NOT re-seed the Monaco model — it is keyed on path, not content.
      post({ type: 'readFile', path });
      dispatchDocs({ type: 'open', kind: 'file', path });
      pushRecent('file', path);
      // Index the project's source files once so go-to-definition resolves cross-file.
      if (
        isCodeFile(path) &&
        active?.projectPath &&
        !indexedRoots.current.has(active.projectPath)
      ) {
        indexedRoots.current.add(active.projectPath);
        post({ type: 'indexProject', root: active.projectPath });
      }
    },
    [active, pushRecent],
  );
  const openDiff = useCallback(
    (path: string) => {
      post({ type: 'readDiff', path }); // always refresh a diff
      dispatchDocs({ type: 'open', kind: 'diff', path });
      pushRecent('diff', path);
    },
    [pushRecent],
  );

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

  // Close a set of sessions, reusing the single-close path (`kill` per id). The
  // host's PtyHost kills each pty and `SessionManager.remove` drops it, so each
  // session is torn down properly — bulk close never bypasses that. Confirm once
  // (not per-session) if the setting is on and any of the targets is running,
  // mirroring single-close: same `confirmCloseRunning` gate, no extra always-on
  // prompt. `post` is a no-op-safe bridge call (guards `window.agentDeck`).
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
    const allPaths = docState.docs.map((d) => d.path);
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
    if (!active?.projectPath) return;
    const abs = joinPath(active.projectPath, rel);
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
        // Bulk git actions (separator-divided)
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

  // Run a git action (stage/unstage/discard/stash) for the active project, then
  // re-fetch the change list so the UI reflects the new state. Failures toast.
  const runGit = useCallback(
    async (op: GitActionIntent['op'], path?: string) => {
      const root = active?.projectPath;
      if (!root) return;
      // 'discardAll' is a renderer-only intent; map it to a real bulk discard below.
      const hostOp = op as Exclude<GitActionIntent['op'], 'discardAll'>;
      const res = await gitAction({ root, op: hostOp, path });
      if (!res.ok) pushToast({ message: `Git: ${res.error}`, variant: 'error' });
      // Always refresh — even on failure the on-disk state may have partially changed.
      post({ type: 'requestProject', path: root });
    },
    [active?.projectPath],
  );

  // Discard every change: unstage all, then restore tracked files, then delete
  // untracked. Sequenced so staged-and-modified files end up clean. Refresh once.
  const discardAll = useCallback(async () => {
    const root = active?.projectPath;
    if (!root) return;
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
  }, [active?.projectPath, projectData?.changes]);

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
      dispatchDocs({ type: 'activate', id: exists ? l.docId : null });
    },
    [docState.docs],
  );
  const { goBack, goForward, canBack, canForward } = useNavHistory(
    { sessionId: activeId, docId: docState.activeId },
    applyNav,
  );

  // Omni-search set (R4.13): sessions (by title) + agents (by name) + files (by path)
  // of the active project. Routing: a session activates it; an agent opens the
  // new-session flow with that agent preselected; a file opens it. The group order here
  // (Sessions, Agents, Files) mirrors the pure ranker in src/omni-search.ts (which the
  // unit tests pin); the palette's own fuzzy filter narrows these as the user types.
  // Files come from the host's project index (`searchFiles`), the same source L5's
  // Search panel uses for its file list. File *content* search stays in L5's Search
  // panel — this bar is name/title matching only (see src/omni-search.ts header note).
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
            run: () => openFile(h.abs),
          }))
        : [];
    return [...sessionEntries, ...agentEntries, ...fileEntries];
  }, [sessions, agents, active, search, openFile]);

  // Recently opened documents (shown when the query is empty).
  const recentItems: PaletteEntry[] = useMemo(
    () =>
      recents.map((r) => ({
        id: `recent:${r.kind}:${r.path}`,
        title: baseName(r.path),
        subtitle: r.kind === 'diff' ? 'diff' : undefined,
        group: 'Recent',
        icon: <IconDoc size={14} />,
        run: () => (r.kind === 'file' ? openFile(r.path) : openDiff(r.path)),
      })),
    [recents, openDiff, openFile],
  );

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
        id: 'cmd:editor',
        title: 'Open editor',
        group: 'Commands',
        icon: <IconDoc size={14} />,
        run: () => openView('openEditor'),
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
              .filter((d) => d.id !== activeDoc.id)
              .forEach((d) => {
                closeDoc(d.id);
              }),
        },
      );
      // Revert File — only visible when the active doc is dirty.
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
    // Save All — always visible (idempotent when nothing is dirty).
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
    openGlobalSearch,
    sidebarCollapsed,
    explorerCollapsed,
    toggleSidebar,
    toggleExplorer,
    closeDoc,
    dirtySet,
    openNewSession,
  ]);

  // ---- Dockable layout: render the three regions in the persisted order ----
  const order = parseLayout(settings.layout);
  // Hidden side panels drop out of the rendered order; the center column is flex,
  // so it reflows to fill the freed space.
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
            docs={docState.docs}
            activeDocId={docState.activeId}
            files={files}
            diffs={diffs}
            onSelectDoc={(id) => dispatchDocs({ type: 'activate', id })}
            onCloseDoc={closeDoc}
            onRelaunch={(id) => post({ type: 'relaunch', id })}
            onTabContextMenu={onTabContextMenu}
            onReorderDoc={(dragId, targetId) => dispatchDocs({ type: 'reorder', dragId, targetId })}
            dock={dockHandlers('center')}
            splitId={splitId}
            onCloseSplit={() => setSplitId(null)}
            onOpenFile={openFile}
          />
        </ErrorBoundary>
      );
    }
    if (region === 'sessions') {
      return (
        <PanelFrame
          key="sessions"
          region="sessions"
          title="Sessions"
          widthVar="--left-w"
          edge={centerFacingEdge(visibleOrder, 'sessions')}
          onWidthCommit={(w) => commitWidth('sessions', w)}
          dock={dockHandlers('sessions')}
          onPanelContextMenu={onPanelTogglesMenu}
        >
          <Sidebar
            sessions={sessions}
            agents={agents}
            activeId={activeId}
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
          />
        </PanelFrame>
      );
    }
    return (
      <PanelFrame
        key="explorer"
        region="explorer"
        title="Explorer"
        widthVar="--right-w"
        edge={centerFacingEdge(visibleOrder, 'explorer')}
        onWidthCommit={(w) => commitWidth('explorer', w)}
        dock={dockHandlers('explorer')}
        onPanelContextMenu={onPanelTogglesMenu}
      >
        <RightPane
          projectPath={active?.projectPath}
          changes={projectData?.changes ?? []}
          onOpenFile={openFile}
          onOpenMatch={openMatch}
          paneRef={rightPaneRef}
          onOpenDiff={(rel) => active?.projectPath && openDiff(joinPath(active.projectPath, rel))}
          onGitAction={onGitAction}
          setMenu={setMenu}
          revealPath={(path) => post({ type: 'revealInExplorer', path })}
          copyToClipboard={copyToClipboard}
          onDeleteFile={onDeleteFile}
          onFileRenamed={onFileRenamed}
          onChangeContextMenu={onChangeContextMenu}
        />
      </PanelFrame>
    );
  };

  return (
    <div className="shell">
      <AnimatedBg />
      <TopBar
        project={activeProject ?? 'Conduit'}
        session={active?.name ?? 'No session'}
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
        />
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
      {confirm && <ConfirmDialog state={confirm} onClose={() => setConfirm(null)} />}
      <Toasts />
    </div>
  );
}
