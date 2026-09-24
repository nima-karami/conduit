import * as monaco from 'monaco-editor';
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
import { repoForPath } from '../src/active-repo';
import { visibleSessionIds } from '../src/attention';
import { canonicalPath } from '../src/canonical-path';
import { acceptRepoChanges, changesModel } from '../src/changes-view-model';
import { sessionExitAction, shouldConfirmClose } from '../src/close-decision';
import {
  type DeleteOutcome,
  permanentConfirmMessage,
  trashConfirmMessage,
} from '../src/delete-confirm';
import { folderKey } from '../src/folder-key';
import { langFromPath } from '../src/lang';
import { centerFacingEdge, parseLayout, type Region, serializeLayout } from '../src/layout';
import { isHtmlDocPath } from '../src/media-kind';
import type { ApplyResult } from '../src/nav-history';
import { type NewSessionPrefill, projectForNewSession } from '../src/new-session-seed';
import { resolveOwningSession } from '../src/owning-session';
import { sessionPaletteFields } from '../src/palette-state';
import { PLANS_DIR } from '../src/plan-path';
import type {
  ChangeDTO,
  DiffTabScope,
  FileContentDTO,
  FileDiffDTO,
  HostToWebview,
  PersistedDoc,
  RepoChanges,
} from '../src/protocol';
import {
  acceptSearchResults,
  type FolderCorpus,
  foldersToRequest,
  pruneCorpus,
  quickOpenFileRows,
} from '../src/quick-open-folders';
import { quitConfirmCopy } from '../src/quit-guard';
import { historyRepoFor, repoBaseName, repoLabel, repoSetKey } from '../src/repo-display';
import { gitOf } from '../src/repo-git';
import { isUnderRoot } from '../src/repo-rel';
import { normalizeRoot } from '../src/review-marks';
import { resolveSessionIcon } from '../src/session-icon';
import { sessionNameFromPath } from '../src/session-name';
import {
  folderForPath,
  foldersLeft,
  presentFolders,
  sessionSections,
} from '../src/session-sections';
import type { ChangesViewMode, RightPaneTab } from '../src/settings';
import { canRelaunch, relaunchableSessionIds, staleSessionIds } from '../src/stale-sessions';
import { lastSessionTarget, plainShellTarget } from '../src/start-routes';
import { formatDuration } from '../src/timed-messages';
import type { AgentDefinition, Session } from '../src/types';
import {
  fsDndCopy,
  fsDndMove,
  fsMutate,
  gitAction,
  logToHost,
  lspInvoke,
  post,
  subscribe,
} from './bridge';
import { closeAllIds, closeOthersIds } from './bulk-close';
import { type CenterView, centerViewForAction, nextCenterView } from './center-view';
import { goToChangeInActiveDoc } from './change-nav-registry';
import { buildBulkMenuItems } from './changes-actions';
import { type ClosedTab, popClosedTab, pushClosedTab, toClosedTab } from './closed-tabs';
import { AnimatedBg } from './components/animated-bg';
import { ArchitectureView } from './components/architecture-view';
import { BoardView } from './components/board-view';
import { BranchChip } from './components/branch-chip';
import { CenterPane } from './components/center-pane';
import { CommandPalette, type PaletteEntry } from './components/command-palette';
import { ConfirmDialog, type ConfirmState } from './components/confirm-dialog';
import { ContextMenu, type MenuItem, type MenuState } from './components/context-menu';
import { ErrorBoundary } from './components/error-boundary';
import { IconPickerModal } from './components/icon-picker-modal';
import { NewSessionModal } from './components/new-session-modal';
import { type DockHandlers, PanelFrame } from './components/panel-frame';
import { ProjectPicker } from './components/project-picker';
import { RightPane, type RightPaneHandle } from './components/right-pane';
import { SettingsModal } from './components/settings-modal';
import { Sidebar } from './components/sidebar';
import { TimedMessageDialog } from './components/timed-message-dialog';
import { Toasts } from './components/toasts';
import { TopBar } from './components/top-bar';
import type { UpdateStatus } from './components/update-card';
import { WebPromptModal } from './components/web-prompt-modal';
import { decideShortcut } from './decide-shortcut';
import { createDiffReadQueue, type DiffReadQueue, diffReadTargets } from './diff-read-queue';
import { diffTabKey } from './diff-tab-scope';
import { clearDirty, getDirtySnapshot, subscribeDirty } from './dirty-store';
import { reorderDock } from './dock-reorder';
import type { DocKind, OpenDoc, OpenMode } from './docs';
import {
  backgroundOpenOutcome,
  commitDiffPath,
  docsReducer,
  GIT_HISTORY_DOC_PATH,
  initialDocs,
  REVIEW_DOC_ID,
  REVIEW_DOC_PATH,
  type ReviewSource,
  toPersistedDocs,
} from './docs';
import {
  type CursorPos,
  coalescesEntries,
  findOpenDoc,
  type NavEntry,
  navAnnouncement,
  navEntryFor,
} from './editor-nav';
import { shouldReplaceContent } from './file-freshness';
import { buildRowChangeMap } from './file-tree';
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
import type { GitActionIntent } from './git-intent';
import { bumpHtmlReload, clearHtmlView, getHtmlView, toggleHtmlView } from './html-view-store';
import { type HunkActionHost, setHunkActionHost } from './hunk-actions';
import {
  IconBoard,
  IconBranch,
  IconCheck,
  IconClock,
  IconClose,
  IconCommand,
  IconCompare,
  IconCopy,
  IconDoc,
  IconDuplicate,
  IconExternal,
  IconFolder,
  IconGraph,
  IconPencil,
  IconPlus,
  IconRefresh,
  IconReview,
  IconSearch,
  IconSettings,
  IconSidebar,
  IconSparkle,
  IconTrash,
  SessionGlyph,
} from './icons';
import { registerLspHoverProvider } from './lsp-nav';
import { restartableLanguages, useLspLanguages, useLspStatuses, useLspTrust } from './lsp-status';
import { initLspClient, type LspDocInput, reconcileLspDocs, requestTrust } from './lsp-sync';
import { formatMention } from './mention';
import { setMentionSink } from './mention-bus';
import { registerConduitEditorOpener } from './monaco-opener';
import {
  lastCursor,
  liveCursor,
  requestNavFocus,
  revealInNavEditor,
  setCursorJumpSink,
} from './nav-editors';
import { buildPanelToggleItems, type HideablePanel, paletteCommandTitle } from './panel-visibility';
import { probePathExists } from './path-probe';
import { planExternalChanges } from './plan-store';
import { clearReveal, fileUri, peekReveal, setDefinitionOpener, setReveal } from './project-index';
import { pushRecentDoc, type RecentDoc, recentPaletteId, recentSubtitle } from './recent-docs';
import { resolveModuleOnDemand } from './resolve-module';
import { subscribeNoteTarget } from './review-note-target';
import { loadNotesFor } from './review-notes-store';
import {
  diffKey,
  REVIEW_SCOPES,
  type ReviewScope,
  scopeDiffArgs,
  scopeFromDiffArgs,
} from './review-scope';
import {
  getSaveEntry,
  onFileSaved,
  revertDocByPath,
  saveActiveDoc,
  saveAllDirtyDocs,
} from './save-registry';
import { selectionInActiveDoc } from './selection-registry';
import { selectionSourceFor } from './selection-source';
import { useSettings } from './settings';
import { comboLabel, effectiveCombo, isWindows, matchCombo, SHORTCUT_ACTIONS } from './shortcuts';
import { closeTabSelection } from './tab-close-selection';
import {
  requestTerminalFocus,
  selectionInTerminal,
  shouldFocusActiveTerminal,
} from './terminal-bus';
import { THEMES } from './themes';
import { cancelTimedMessage, renewTimedMessage, subscribeTimerEvents } from './timer-store';
import { pushToast } from './toast-store';
import { registerTsNavigationProviders, setUnresolvedResolver } from './ts-nav';
import { applyProjectFiles, setCompilerOptionsRoot } from './ts-project';
import { isEditorEntry, isTerminalEntry, isTypingEntry } from './typing-guard';
import { useBackgroundOpenFeedback } from './use-background-open-feedback';
import { canNavigate, type NavHistoryDeps, useNavHistory } from './use-nav-history';
import { useReviewModeLayout } from './use-review-mode-layout';
import { useSnooze } from './use-snooze';
import { markClosing } from './view-state-store';

type StateMsg = Extract<HostToWebview, { type: 'state' }>;
type ProjectMsg = Extract<HostToWebview, { type: 'project' }>;
type SettingsTab = 'general' | 'appearance' | 'shortcuts' | 'skills' | 'about';
const baseName = (p: string) => p.split(/[\\/]/).filter(Boolean).pop() || p;

/** `record: false` for an open that is not a navigation (a Back reopen, a rename). */
interface FileOpenNav {
  reveal?: CursorPos;
  record?: boolean;
}

const joinPath = (base: string, rel: string) =>
  `${base.replace(/[\\/]+$/, '')}/${rel}`.replace(/\\/g, '/');

/** Quiet period after a watched root reports a change before the index tops itself up. Short
 *  enough that a file an agent just wrote is navigable by the time the user looks for it,
 *  long enough that a multi-file write lands as one top-up. */
const INCREMENTAL_INDEX_DEBOUNCE_MS = 500;

const isCodeFile = (p: string) => /\.(ts|tsx|js|jsx|mts|cts|mjs|cjs)$/i.test(p);

/**
 * The text to seed global search with, or undefined to keep the previous query (VS Code's
 * behaviour when there is no selection). Read synchronously at the keypress — opening the
 * pane moves focus and collapses the selection.
 */
function searchSeedFromSelection(
  docs: readonly OpenDoc[],
  activeId: string | null,
  sessionId: string,
): string | undefined {
  const sel = window.getSelection();
  const anchor = sel?.anchorNode ?? null;
  const activeEl = document.activeElement;
  const explorerEl = document.querySelector('.panel--explorer');
  // The anchor counts, not just focus: a drag-select over a `.filerow` can leave focus on
  // <body>, and that selection must not reach the search box (see selection-source.ts).
  const explorerHasFocus =
    !!explorerEl &&
    ((!!activeEl && explorerEl.contains(activeEl)) || (!!anchor && explorerEl.contains(anchor)));
  const source = selectionSourceFor({ activeEl, domAnchor: anchor, explorerHasFocus });
  const text =
    source === 'terminal'
      ? selectionInTerminal(sessionId)
      : source === 'editor'
        ? selectionInActiveDoc(docs, activeId)
        : source === 'dom'
          ? (sel?.toString() ?? '')
          : '';
  const trimmed = text.trim();
  return trimmed === '' ? undefined : trimmed;
}

/**
 * The session whose project IS `root` — the owner of everything under its `.conduit/`.
 * Matched on `normalizeRoot`, the folded form the host broadcasts plan roots in and
 * `webview/plan-store.ts` keys on. Several sessions can share one project; the active one
 * wins so the plan opens where the user already is. Null when no open session owns it,
 * which the caller must NOT paper over with the active session: a plan tab's `sessionId` is
 * the terminal Send pastes into, so a wrong one hands the human's edits to another agent.
 */
function sessionOwningRoot(
  sessions: readonly Session[],
  root: string,
  activeId: string | null,
): string | null {
  const want = normalizeRoot(root);
  const owners = sessions.filter((s) => normalizeRoot(s.home) === want).map((s) => s.id);
  if (owners.length === 0) return null;
  if (activeId !== null && owners.includes(activeId)) return activeId;
  return owners[0] ?? null;
}

export function App() {
  const [state, setState] = useState<StateMsg | null>(null);
  const [activeId, setActiveId] = useState<string | undefined>();
  const [project, setProject] = useState<ProjectMsg | null>(null);
  const [repoChanges, setRepoChanges] = useState<RepoChanges[] | undefined>();
  // The new-session flow. `null` = closed; the prefill shape is the public contract other
  // callers pass (mf-new-session spec §3.1).
  const [newSession, setNewSession] = useState<NewSessionPrefill | null>(null);
  const openNewSession = useCallback((home?: string) => setNewSession(home ? { home } : {}), []);

  const [settingsOpen, setSettingsOpen] = useState(false);
  const [webPromptOpen, setWebPromptOpen] = useState(false);
  const [docState, dispatchDocs] = useReducer(docsReducer, initialDocs);
  // Latest docs for effects that must read them without re-firing on every docs change (the
  // closeSession view-state eviction sweep is keyed on the session set, not on docs).
  const docsRef = useRef(docState.docs);
  docsRef.current = docState.docs;
  const [files, setFiles] = useState<Map<string, FileContentDTO>>(new Map());
  const [diffs, setDiffs] = useState<Map<string, FileDiffDTO>>(new Map());
  // Every re-read of an open diff tab goes through here (spec 2026-09-22-scoped-diff-tabs §3).
  const diffReadQueueRef = useRef<DiffReadQueue>(
    createDiffReadQueue((t) =>
      post({ type: 'readDiff', path: t.path, ...scopeDiffArgs(t.diffScope ?? 'all') }),
    ),
  );
  const rereadOpenDiffs = useCallback((match: (doc: OpenDoc) => boolean) => {
    for (const t of diffReadTargets(docsRef.current, match)) diffReadQueueRef.current.request(t);
  }, []);
  useEffect(() => {
    for (const t of diffReadTargets(docState.docs, (d) => !diffs.has(diffTabKey(d))))
      diffReadQueueRef.current.ensure(t);
  }, [docState.docs, diffs]);
  const [palette, setPalette] = useState<{ initialQuery: string } | null>(null);
  const [settingsTab, setSettingsTab] = useState<SettingsTab>('general');
  const [recentsBySession, setRecentsBySession] = useState<Record<string, RecentDoc[]>>({});
  const [corpus, setCorpus] = useState<FolderCorpus>({});
  const [menu, setMenu] = useState<MenuState | null>(null);
  useEffect(() => {
    const open = menu;
    return () => open?.onClosed?.();
  }, [menu]);
  // Multi-window Slice B: the other open windows for the "Move to window…" picker. Updated
  // from the host's `win:list` broadcast; this window's own id comes from `state.windowId`.
  const [winList, setWinList] = useState<{ id: number; title: string; sessionCount: number }[]>([]);
  const [renamingId, setRenamingId] = useState<string | undefined>(undefined);
  const [confirm, setConfirm] = useState<ConfirmState | null>(null);
  const [updateStatus, setUpdateStatus] = useState<UpdateStatus | null>(null);
  const [updateDismissed, setUpdateDismissed] = useState(false);
  // D3: session icon-picker modal state. `null` = closed; non-null = picker open for session.id.
  const [iconPickerSessionId, setIconPickerSessionId] = useState<string | null>(null);
  const [movePicker, setMovePicker] = useState<{
    sessionId: string;
    at: { x: number; y: number };
  } | null>(null);
  const closeMovePicker = useCallback(() => setMovePicker(null), []);
  const [timedMessageFor, setTimedMessageFor] = useState<string | null>(null);

  /** The palette acts on the ACTIVE session; the chip, the card menu and the stale card name one. */
  const openTimedMessages = useCallback(
    (sessionId?: string) => {
      const target = sessionId ?? activeId;
      if (!target) {
        pushToast({ message: 'Open a session first.', variant: 'error' });
        return;
      }
      setTimedMessageFor(target);
    },
    [activeId],
  );

  const [centerView, setCenterView] = useState<CenterView>('editor');
  const centerViewRef = useRef(centerView);
  centerViewRef.current = centerView;
  const [splitId, setSplitId] = useState<string | null>(null);
  const dragRegionRef = useRef<Region | null>(null);
  const [overRegion, setOverRegion] = useState<Region | null>(null);
  // W2: holds the cancel-reply callback when a host `confirmQuit` dialog is open.
  // Called by the ConfirmDialog onClose wrapper so reply(false) fires on Cancel/Esc.
  const quitCancelRef = useRef<(() => void) | null>(null);
  // Holds the resolver of an open hunk-discard confirm. Called with `false` by the ConfirmDialog
  // onClose wrapper so Cancel and Esc both settle the promise the caller is awaiting.
  const hunkConfirmRef = useRef<((ok: boolean) => void) | null>(null);
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
  // Set once useReviewModeLayout runs, far below (needs rightPaneRef/reviewMode); reached via a
  // ref so this declaration doesn't have to move past everything that already closes over it.
  const userToggledExplorerRef = useRef<() => void>(() => {});
  const toggleExplorer = useCallback(() => {
    userToggledExplorerRef.current();
    update({ explorerCollapsed: !settings.explorerCollapsed });
  }, [settings.explorerCollapsed, update]);
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
      else if (msg.type === 'project') {
        setProject(msg);
        setRepoChanges((prev) =>
          acceptRepoChanges(prev, msg.repoChanges, activeRef.current?.repos),
        );
      } else if (msg.type === 'fileContent') {
        // K3 dirty-buffer protection: a fresh disk read must NOT replace the map entry
        // for a path whose Monaco buffer is dirty — CodeViewer's seed effect is keyed on
        // `doc.content`, so re-seeding would destroy the user's unsaved edits. A clean
        // path picks up the fresh content. See file-freshness.ts.
        const path = msg.doc.path;
        if (shouldReplaceContent(path, getDirtySnapshot().has(path))) {
          setFiles((m) => new Map(m).set(path, msg.doc));
        }
      } else if (msg.type === 'fileDiff') {
        const key = diffKey(msg.doc.path, scopeFromDiffArgs(msg));
        setDiffs((m) => new Map(m).set(key, msg.doc));
        diffReadQueueRef.current.settle(key);
      } else if (msg.type === 'searchResults') {
        setCorpus((c) => acceptSearchResults(c, msg, presentFolders(activeRef.current)));
      } else if (msg.type === 'projectFiles') {
        // Content to the language worker as extraLibs — NOT a Monaco model per project file
        // (that loop was what made opening a file janky). See webview/ts-project.ts.
        applyProjectFiles(msg);
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
        // The guest re-fetches from disk, so the nonce — not doc.content — is the signal:
        // readFile truncates at MAX_BYTES (src/file-service.ts:17), so two versions of a
        // large file sharing their first 2 MB, or a byte-identical rewrite, would produce
        // no change to compare.
        const changed = docStateRef.current.docs.find(
          (d) => d.kind === 'file' && d.path === msg.path && isHtmlDocPath(d.path),
        );
        if (changed) bumpHtmlReload(changed.id);
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
          home: '',
          roots: [],
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

  // `ready` is the handshake the host answers with the whole startup burst (state, win:list,
  // restoreDocs, review:marks), so it must not be posted before this subscription exists. It used
  // to fire at module scope in index.tsx, covered only by message-bus.ts's buffer — which holds
  // messages while NOBODY is subscribed, and `review-marks-store.ts` subscribes at import time.
  // The burst was then delivered to that store alone and the initial `state` was lost.
  // Mount-only deps: a re-post makes the host re-send its one-shot restoreDocs.
  useEffect(() => {
    post({ type: 'ready' });
  }, []);

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

  const hostSessions: Session[] = useMemo(() => state?.sessions ?? [], [state]);
  // Snooze is applied here, above everything that reads a session's attention state, so the
  // rail and the topbar's aggregate chip can never disagree about who is waiting (D16).
  const { sessions, snooze } = useSnooze(hostSessions);
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
    const targets = relaunchableSessionIds(sessions);
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
    const targets = relaunchableSessionIds(sessions);
    for (const id of targets) {
      post({ type: 'relaunch', id });
    }
  }, [sessions]);

  // Imperative bridge to the Explorer's RightPane so Mod+Shift+F can switch it to the
  // Search tab and focus the query input (L5).
  const rightPaneRef = useRef<RightPaneHandle | null>(null);
  // Open global search: ensure the Explorer panel is visible, then focus the Search tab.
  // `update` persists the un-collapse; the focus call is deferred a frame inside openSearch.
  const openGlobalSearch = useCallback(
    (seed?: string) => {
      if (settings.explorerCollapsed) update({ explorerCollapsed: false });
      requestAnimationFrame(() => rightPaneRef.current?.openSearch(seed));
    },
    [settings.explorerCollapsed, update],
  );

  // Declared ahead of every producer so each can record; the deps are assigned once `applyNav`
  // exists (the closeDocRef precedent).
  const navDepsRef = useRef<NavHistoryDeps>({
    currentEntry: () => null,
    isLive: () => false,
    isOnScreen: () => false,
    apply: async () => 'dead',
  });
  const { state: navState, recordNav, recordJump, goBack, goForward } = useNavHistory(navDepsRef);

  // Switch the center pane from an action id, via the single tested mapping.
  const openView = useCallback((actionId: string) => {
    const view = centerViewForAction(actionId);
    if (view) setCenterView(view);
  }, []);

  // R5.5: open the Review-changes view as a singleton editor tab (not a center-view
  // overlay). Ensure the center is on the editor so the tab area is visible, then
  // open/activate the review doc. Opening it again just re-activates the one tab.
  // `openReviewTab` stays argument-less: it is wired straight to onClick in several places,
  // where an extra parameter would be handed a MouseEvent.
  const openReviewScoped = useCallback(
    (scope: ReviewScope) => {
      const sessionId = activeIdRef.current ?? '';
      recordNav({ sessionId, doc: { kind: 'review', path: REVIEW_DOC_PATH } });
      setCenterView('editor');
      dispatchDocs({
        type: 'openReview',
        sessionId,
        source: { kind: 'working', ...(scope === 'all' ? {} : { scope }) },
      });
    },
    [recordNav],
  );
  const openReviewTab = useCallback(() => openReviewScoped('all'), [openReviewScoped]);

  // Open/activate the singleton Review tab scoped to a COMMIT (source = that commit). Switches
  // the active session first when a target is given (like openFile), so a later terminal
  // commit-link can route to the clicked terminal's session. See
  // docs/specs/2026-06-29-review-commit-source.md §3.1.
  // `repoRoot` scopes the review to a SPECIFIC repo — passed for a terminal commit click so the
  // review reads the commit from that terminal's cwd repo, not the pinned active repo (feat-link-cwd).
  const openReviewForCommit = useCallback(
    (sha: string, targetSessionId?: string, subject?: string, repoRoot?: string) => {
      const sessionId = targetSessionId ?? activeIdRef.current ?? '';
      recordNav({ sessionId, doc: { kind: 'review', path: REVIEW_DOC_PATH } });
      setCenterView('editor');
      if (targetSessionId && targetSessionId !== activeIdRef.current) {
        setActiveId(targetSessionId);
        dispatchDocs({ type: 'switchSession', sessionId: targetSessionId });
      }
      dispatchDocs({
        type: 'openReview',
        sessionId,
        source: {
          kind: 'commit',
          sha,
          ...(subject ? { subject } : {}),
          ...(repoRoot ? { repoRoot } : {}),
        },
      });
    },
    [recordNav],
  );

  // Retarget the open Review tab from its breadcrumb selector (working ⇄ a commit ⇄ a compare).
  const setReviewSource = useCallback(
    (s: ReviewSource) => {
      if (s.kind === 'working') return openReviewScoped(s.scope ?? 'all');
      if (s.kind === 'commit') return openReviewForCommit(s.sha, undefined, s.subject);
      // range: a two-ref comparison rides the singleton review doc like any other source.
      const sessionId = activeIdRef.current ?? '';
      recordNav({ sessionId, doc: { kind: 'review', path: REVIEW_DOC_PATH } });
      setCenterView('editor');
      dispatchDocs({ type: 'openReview', sessionId, source: s });
    },
    [openReviewScoped, openReviewForCommit, recordNav],
  );

  // git-history Slice A: open the commit-graph as a singleton center-pane doc for the
  // active session, mirroring openReviewTab. Re-opening just re-activates the one tab (and
  // transfers ownership to the now-active session). Without `repoRoot` it shows the active repo
  // (docs/specs/2026-09-23-mf-changes.md §2.5).
  const openGitHistoryTab = useCallback(
    (repoRoot?: string) => {
      const sessionId = activeIdRef.current ?? '';
      recordNav({ sessionId, doc: { kind: 'git-history', path: GIT_HISTORY_DOC_PATH } });
      setCenterView('editor');
      const session = sessionsRef.current.find((s) => s.id === sessionId);
      dispatchDocs({
        type: 'open',
        kind: 'git-history',
        path: GIT_HISTORY_DOC_PATH,
        sessionId,
        repoRoot: repoRoot ?? historyRepoFor(undefined, session),
      });
    },
    [recordNav],
  );
  const retargetGitHistory = useCallback((repoRoot: string) => {
    dispatchDocs({
      type: 'open',
      kind: 'git-history',
      path: GIT_HISTORY_DOC_PATH,
      sessionId: activeIdRef.current ?? '',
      repoRoot,
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
  // Latest session list in a ref for the same reason: the plan toast is subscribed once for the
  // window's life and has to resolve a plan's owning session at CLICK time, not at subscribe time.
  const sessionsRef = useRef(sessions);
  sessionsRef.current = sessions;

  const backgroundFeedback = useBackgroundOpenFeedback();
  const reportBackground = backgroundFeedback.report;
  // Read BEFORE the dispatch: the outcome is what the open is about to do (spec
  // 2026-09-22-middle-click-new-tab §3). The session is named only when it isn't the active one.
  const reportBackgroundOpen = useCallback(
    (kind: DocKind, path: string, targetSessionId: string, diffScope?: DiffTabScope) => {
      const r = backgroundOpenOutcome(docStateRef.current, kind, path, targetSessionId, diffScope);
      const sessionName =
        r.ownerSessionId === activeIdRef.current
          ? null
          : (sessionsRef.current.find((s) => s.id === r.ownerSessionId)?.name ?? null);
      reportBackground({ id: r.id, title: r.title, outcome: r.outcome, sessionName });
    },
    [reportBackground],
  );

  // Open one of a commit's files as a `commit-diff` tab — from the commit detail rendered
  // inline in the history view (single-click = preview, double-click = pin, middle = background).
  const openCommitFile = useCallback(
    (sha: string, file: string, mode: OpenMode, repoRoot?: string) => {
      const sessionId = activeIdRef.current ?? '';
      if (mode === 'background') {
        reportBackgroundOpen('commit-diff', commitDiffPath(sha, file), sessionId);
      } else {
        recordNav({ sessionId, doc: { kind: 'commit-diff', path: commitDiffPath(sha, file) } });
        setCenterView('editor');
      }
      dispatchDocs({ type: 'openCommitFile', sha, file, sessionId, mode, repoRoot });
    },
    [recordNav, reportBackgroundOpen],
  );

  // A tab click / Ctrl+Tab / Mod+digit is an R1 producer; the Terminal stop never records
  // (docs/specs/2026-09-22-editor-nav-history.md §2.2).
  const activateDocByUser = useCallback(
    (id: string | null, sessionId: string) => {
      const doc = id === null ? undefined : docStateRef.current.docs.find((d) => d.id === id);
      if (doc && id !== docStateRef.current.activeId) recordNav(navEntryFor(doc));
      dispatchDocs({ type: 'activate', id, sessionId });
    },
    [recordNav],
  );

  const openGlobalSearchSeeded = useCallback(() => {
    openGlobalSearch(
      searchSeedFromSelection(
        docStateRef.current.docs,
        docStateRef.current.activeId,
        activeIdRef.current ?? '',
      ),
    );
  }, [openGlobalSearch]);

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
  const openShellRef = useRef<() => void>(() => {});
  const reopenLastRef = useRef<() => void>(() => {});
  openShellRef.current = () => {
    const target = plainShellTarget(state?.repos ?? [], agents, settings.defaultAgentId);
    if (target) post({ type: 'openRepo', path: target.path, agentId: target.agentId });
  };
  reopenLastRef.current = () => {
    const target = lastSessionTarget(state?.repos ?? [], agents, Date.now());
    if (target) post({ type: 'openRepo', path: target.path, agentId: target.agentId });
  };
  // Reopen-closed-tab (Mod+Shift+T): a bounded LIFO of recently-closed reopenable docs and
  // the reopen action. Both are refs so closeDoc/actionMap don't re-bind on every close;
  // reopenClosedTab depends on openFile/openDiff/openWeb declared further below.
  const closedTabsRef = useRef<ClosedTab[]>([]);
  const reopenClosedTabRef = useRef<() => void>(() => {});
  // Polite live region announcing the landed location after a Back/Forward traversal — a
  // same-type editor→editor jump isn't conveyed by focus alone (spec §10).
  const navLiveRef = useRef<HTMLDivElement>(null);

  // §10: arm, auto-arm, cancel, fire, miss and waiting are announced ONCE each; the countdown
  // never is — a per-second live region would be a screen-reader firehose.
  useEffect(() => {
    const announce = (text: string) => {
      if (navLiveRef.current) navLiveRef.current.textContent = text;
    };
    const nameOf = (id: string) => sessions.find((s) => s.id === id)?.name ?? 'the session';
    const timeFmt = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });

    return subscribeTimerEvents((e) => {
      if (e.kind === 'error') {
        pushToast({ message: e.message, variant: 'error' });
        return;
      }
      if (e.kind === 'armed') {
        announce(
          `Timed message armed — ${e.schedule.message}, ${formatDuration(e.schedule.nextAt - Date.now())} from now`,
        );
        return;
      }
      if (e.kind === 'autoArmed') {
        const when = timeFmt.format(new Date(e.schedule.nextAt));
        pushToast({
          message: `Armed: ${e.schedule.message} at ${when}`,
          variant: 'info',
          action: { label: 'Undo', run: () => cancelTimedMessage(e.schedule.id) },
        });
        // The one thing here that happens without the user asking, so it says it was automatic
        // and that Undo exists (§10).
        announce(`Automatically armed — ${e.schedule.message} at ${when}. Undo available.`);
        return;
      }
      if (e.kind === 'cancelled') {
        announce(`Timed message cancelled — ${e.schedule.message}`);
        return;
      }
      if (e.kind === 'waiting') {
        announce(`Timed message waiting — ${nameOf(e.schedule.sessionId)} isn't running`);
        return;
      }
      // A fire. `e.schedule` is the PRE-fire record (the host broadcasts timer:fired before
      // timer:state), so its nextAt is the time this was scheduled for.
      const name = nameOf(e.fire.sessionId);
      const text = e.schedule?.message ?? 'the message';
      const lateBy = e.schedule ? formatDuration(e.fire.at - e.schedule.nextAt) : '';
      if (e.fire.reason === 'expired') {
        pushToast({
          message: `Timed message missed — "${text}" was due too long ago to send`,
          variant: 'error',
          action: { label: 'Renew', run: () => renewTimedMessage(e.fire.id) },
        });
        announce('Timed message missed');
        return;
      }
      if (!e.fire.delivered) {
        pushToast({
          message: `Couldn't send "${text}" to ${name} — the session ended mid-send`,
          variant: 'error',
        });
        announce(`Timed message not sent to ${name}`);
        return;
      }
      const suffix = e.fire.late ? ` — ${lateBy} late (waited for the session)` : '';
      pushToast({ message: `Sent "${text}" to ${name}${suffix}`, variant: 'info' });
      announce(`Sent ${text} to ${name}${e.fire.late ? `, ${lateBy} late` : ''}`);
    });
  }, [sessions]);

  // Global shortcuts — data-driven from the (rebindable, persisted) bindings.
  const actionMap = useMemo<Record<string, () => void>>(() => {
    const currentSessionId = () => activeIdRef.current ?? '';
    const currentSessionDocs = () =>
      docStateRef.current.docs.filter((d) => d.sessionId === currentSessionId());
    const activate = (id: string | null) => activateDocByUser(id, currentSessionId());
    // Tab cycle stops: the Terminal (null) first, then each open doc; +1 next, -1 prev.
    const cycleTab = (dir: number) => {
      const stops: (string | null)[] = [null, ...currentSessionDocs().map((d) => d.id)];
      const cur = stops.indexOf(docStateRef.current.activeId);
      activate(stops[(cur + dir + stops.length) % stops.length]);
    };
    return {
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
      openGitHistory: () => openGitHistoryTab(),
      openEditor: () => openView('openEditor'),
      openGlobalSearch: openGlobalSearchSeeded,
      toggleSidebar,
      toggleExplorer,
      newSession: () => openNewSession(),
      // The empty state's other two routes, reachable from anywhere. Refs keep actionMap
      // off the state broadcast (same reason as doUndoRef); both no-op when the route has
      // no honest target, which is also when the empty state hides the row.
      openShell: () => openShellRef.current(),
      reopenLastSession: () => reopenLastRef.current(),
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
      // Editor-scoped keys, but bound here too: Monaco marks the keys it binds
      // defaultPrevented, so this fires only for a combo monaco cannot express — which is
      // what keeps a rebind to such a combo from silently doing nothing.
      nextChange: () =>
        goToChangeInActiveDoc(docStateRef.current.docs, docStateRef.current.activeId, 'next'),
      prevChange: () =>
        goToChangeInActiveDoc(docStateRef.current.docs, docStateRef.current.activeId, 'prev'),
      toggleHtmlView: () => {
        const d = docStateRef.current.docs.find((x) => x.id === docStateRef.current.activeId);
        if (d?.kind === 'file' && isHtmlDocPath(d.path))
          toggleHtmlView(d.id, settings.htmlDefaultView);
      },
      // File-explorer undo/redo. When Monaco is focused it consumes Ctrl+Z/Ctrl+Shift+Z
      // first (marking the event defaultPrevented), so decideShortcut skips these — they
      // fire here only elsewhere (explorer, terminal). Invoked via stable refs to avoid
      // ordering issues (doUndo/doRedo are declared after this useMemo).
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
      // Built-in navigation (VS Code parity). Ctrl+Tab / Ctrl+PageUp cycle back, the
      // PageDown pair forward; navGoToTab is dispatched specially (it needs the pressed
      // digit). Cmd+Tab/Cmd+` are OS-reserved on macOS, hence the literal Ctrl combos.
      navNextTab: () => cycleTab(1),
      navPrevTab: () => cycleTab(-1),
      navPrevTabPage: () => cycleTab(-1),
      navNextTabPage: () => cycleTab(1),
      // Toggle (spec §2): in the terminal, hand focus back to the app so app shortcuts
      // work again (Monaco if one is mounted, else blur to the root); otherwise focus the
      // session's terminal. This is the escape hatch out of a focused terminal.
      navFocusTerminal: () => {
        const active = document.activeElement as HTMLElement | null;
        if (isTerminalEntry(active)) {
          const editorEl = document.querySelector<HTMLElement>(
            '.monaco-editor .native-edit-context, .monaco-editor textarea',
          );
          if (editorEl) editorEl.focus();
          else active?.blur();
        } else {
          const sessionId = currentSessionId();
          activate(null);
          requestAnimationFrame(() => requestTerminalFocus(sessionId));
        }
      },
    };
  }, [
    openView,
    toggleSidebar,
    toggleExplorer,
    openGlobalSearchSeeded,
    openNewSession,
    openReviewTab,
    openGitHistoryTab,
    settings.htmlDefaultView,
    activateDocByUser,
  ]);
  const bindingsRef = useRef(settings.shortcuts);
  bindingsRef.current = settings.shortcuts;
  // Two window handlers give app shortcuts terminal/editor-fallback precedence (spec §1).
  // CAPTURE runs before xterm consumes the key: while the terminal is focused it fires only
  // decideShortcut's reserved set and lets every other key reach the shell — capture is
  // required because xterm would otherwise swallow Ctrl+` itself. BUBBLE owns
  // everything else: it runs after Monaco has handled (and marked defaultPrevented) any key
  // it binds, so the editor wins its own keys and app shortcuts fire for the rest.
  useEffect(() => {
    const onKeyCapture = (e: KeyboardEvent) => {
      if (!isTerminalEntry(e.target as Element | null)) return;
      for (const action of SHORTCUT_ACTIONS) {
        const combo = effectiveCombo(action, bindingsRef.current);
        if (!matchCombo(e, combo)) continue;
        const ctx = {
          inTerminal: true,
          inEditor: false,
          inFormField: false,
          defaultPrevented: e.defaultPrevented,
          combo,
        };
        if (!decideShortcut(ctx, action.id)) continue;
        if (!actionMap[action.id]) continue;
        e.preventDefault();
        e.stopPropagation();
        actionMap[action.id]();
        return;
      }
    };
    const onKeyBubble = (e: KeyboardEvent) => {
      const target = e.target as Element | null;
      if (isTerminalEntry(target)) return;
      if (e.defaultPrevented) return;
      const inEditor = isEditorEntry(target);
      const inFormField = !inEditor && isTypingEntry(target);
      for (const action of SHORTCUT_ACTIONS) {
        const combo = effectiveCombo(action, bindingsRef.current);
        if (!matchCombo(e, combo)) continue;
        const ctx = {
          inTerminal: false,
          inEditor,
          inFormField,
          defaultPrevented: e.defaultPrevented,
          combo,
        };
        if (!decideShortcut(ctx, action.id)) continue;
        // navGoToTab is one action but needs the pressed digit; read it at dispatch. A
        // digit past the open-doc count is a no-op that lets the key through.
        if (action.id === 'navGoToTab') {
          const sessionId = activeIdRef.current ?? '';
          const doc = docStateRef.current.docs.filter((d) => d.sessionId === sessionId)[
            Number(e.key) - 1
          ];
          if (!doc) continue;
          e.preventDefault();
          e.stopPropagation();
          activateDocByUser(doc.id, sessionId);
          return;
        }
        if (!actionMap[action.id]) continue;
        e.preventDefault();
        e.stopPropagation();
        actionMap[action.id]();
        return;
      }
    };
    window.addEventListener('keydown', onKeyCapture, true);
    window.addEventListener('keydown', onKeyBubble, false);
    return () => {
      window.removeEventListener('keydown', onKeyCapture, true);
      window.removeEventListener('keydown', onKeyBubble, false);
    };
  }, [actionMap, activateDocByUser]);

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

  // Tell the host which sessions this window has on screen: it exempts them from
  // "needs you" and treats seeing one as acknowledgment. Sent even when empty, so a
  // closed/killed session stops being reported as visible. No-op in the browser
  // preview (the mock ignores it).
  useEffect(() => {
    post({ type: 'visible', ids: visibleSessionIds(activeId, splitId) });
  }, [activeId, splitId]);

  const active = sessions.find((s) => s.id === activeId);
  // Keep the notes store loaded for the active repo even when Review was never opened, so the
  // editor's note glyphs work on their own — they read the same store.
  useEffect(() => {
    const root = active ? gitRootForSession(active) : undefined;
    if (root) loadNotesFor(root);
  }, [active]);

  // A glyph click in the editor opens Review; ReviewView itself lands on the note.
  useEffect(() => subscribeNoteTarget(openReviewTab), [openReviewTab]);
  const activeProject = active ? active.home.split(/[\\/]/).filter(Boolean).pop() : undefined;

  // Editor tabs are scoped to their session: only the active session's docs are shown,
  // so you never see another session's editors. Switching sessions restores that
  // session's remembered view (its last active doc, or the Terminal).
  const visibleDocs = useMemo(
    () => docState.docs.filter((d) => d.sessionId === activeId),
    [docState.docs, activeId],
  );
  const activeDoc = visibleDocs.find((d) => d.id === docState.activeId) ?? null;
  const reviewMode = activeDoc?.kind === 'review' && centerView === 'editor';
  const reviewDocOpen = docState.docs.some((d) => d.kind === 'review');
  const [paneTab, setPaneTab] = useState<RightPaneTab>(settings.rightPaneTab);
  // A frame late on purpose: the pane may be mounting in this very render (auto-open, or the
  // header toggle opening it), and the ref is null until it has.
  const showChangesInPane = useCallback(() => {
    requestAnimationFrame(() => rightPaneRef.current?.showChanges());
  }, []);
  const setExplorerCollapsedSetting = useCallback(
    (v: boolean) => update({ explorerCollapsed: v }),
    [update],
  );
  const { userToggledExplorer } = useReviewModeLayout({
    reviewMode,
    reviewDocOpen,
    explorerCollapsed: settings.explorerCollapsed,
    setExplorerCollapsed: setExplorerCollapsedSetting,
    showChanges: showChangesInPane,
  });
  userToggledExplorerRef.current = userToggledExplorer;
  useEffect(() => {
    dispatchDocs({ type: 'switchSession', sessionId: activeId ?? '' });
  }, [activeId]);
  // Switching sessions must land keyboard focus in the newly-active session's terminal so the
  // user can type immediately: the terminals stay mounted (only CSS `display` flips), so
  // TerminalPane's one-time init focus never re-fires. Route through the focus bus (the pane owns
  // its xterm) after a frame — mirrors the Ctrl+` path — so the pane is display:flex and the
  // switchSession dispatch above has resolved this session's view before we read/focus it.
  useEffect(() => {
    if (!activeId) return;
    const raf = requestAnimationFrame(() => {
      if (shouldFocusActiveTerminal(docStateRef.current.activeId, document.activeElement)) {
        requestTerminalFocus(activeId);
      }
    });
    return () => cancelAnimationFrame(raf);
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

  // Language-server doc sync is keyed on the open TABS, not on mounted editors — only the active
  // tab has a CodeViewer (plan 2026-09-22-language-server-go "Sync is keyed on the tab list").
  const lspLanguages = useLspLanguages();
  const lspStatuses = useLspStatuses();
  const lspTrust = useLspTrust();
  useEffect(() => initLspClient(), []);
  useEffect(() => {
    const hover = registerLspHoverProvider(lspLanguages.map((l) => l.languageId));
    return () => hover.dispose();
  }, [lspLanguages]);
  useEffect(() => {
    const served = new Set(lspLanguages.map((l) => l.languageId));
    const inputs: LspDocInput[] = [];
    const seen = new Set<string>();
    for (const d of docState.docs) {
      if (d.kind !== 'file' || seen.has(d.path)) continue;
      seen.add(d.path);
      const languageId = langFromPath(d.path);
      if (!served.has(languageId)) continue;
      const model = monaco.editor.getModel(fileUri(d.path));
      const text =
        model && dirtySet.has(d.path)
          ? model.getValue()
          : (files.get(d.path)?.content ?? model?.getValue());
      if (text !== undefined) inputs.push({ path: d.path, languageId, text });
    }
    reconcileLspDocs(inputs);
  }, [docState.docs, files, lspLanguages, dirtySet]);

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
  // activeCwd(active) prefers the live cd-tracked dir (cwd) over home.
  // Depend on home + cwd (not the whole session object) so a rename or
  // icon change does NOT retrigger a potentially-expensive project reload.
  // biome-ignore lint/correctness/useExhaustiveDependencies: intentional fine-grained dep
  useEffect(() => {
    if (active)
      post({
        type: 'requestProject',
        path: activeCwd(active),
        changesRoot: active.activeRepoRoot,
        sessionId: active.id,
      });
  }, [
    active?.id,
    active?.home,
    active?.cwd,
    active?.activeRepoRoot,
    repoSetKey(active?.repos ?? []),
    active?.repos === undefined,
  ]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: a new session starts with no reply
  useEffect(() => {
    setRepoChanges(undefined);
  }, [active?.id]);

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
  // biome-ignore lint/correctness/useExhaustiveDependencies: intentional fine-grained dep (cwd + home only)
  const refreshChanges = useCallback(() => {
    if (active)
      post({
        type: 'requestProject',
        path: activeCwd(active),
        changesRoot: active.activeRepoRoot,
        sessionId: active.id,
      });
  }, [
    active?.id,
    active?.home,
    active?.cwd,
    active?.activeRepoRoot,
    repoSetKey(active?.repos ?? []),
    active?.repos === undefined,
  ]);

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
      post({
        type: 'requestProject',
        path: activeCwd(cur),
        changesRoot: cur.activeRepoRoot,
        sessionId: cur.id,
      });
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
  // biome-ignore lint/correctness/useExhaustiveDependencies: intentional fine-grained dep (cwd + home gate, not full active obj)
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
  }, [active?.home, active?.cwd, refreshChanges]);

  // Live working-tree monitoring: the host watches the active project and pushes `fsChanged`
  // (debounced, noise-filtered) when anything changes on disk. Re-read the change list right
  // away so the Changes tab + git decorations stay current WITHOUT needing a window refocus.
  // (Open editor tabs are reconciled separately via `fileChanged`; the file tree re-reads
  // itself on `fsChanged` in FilesView.)
  useEffect(() => {
    return subscribe((msg) => {
      if (msg.type !== 'fsChanged') return;
      refreshChanges();
      rereadOpenDiffs((d) => msg.folders.some((f) => isUnderRoot(f, d.path)));
    });
  }, [refreshChanges, rereadOpenDiffs]);
  // fsChanged only covers the active project, so a session's diff tabs catch up when it
  // becomes active.
  useEffect(() => {
    if (activeId) rereadOpenDiffs((d) => d.sessionId === activeId);
  }, [activeId, rereadOpenDiffs]);

  // Quick open covers every present folder (spec §2.10): on palette open, ask for each folder
  // not cached yet, once per palette session; a folder that leaves the session is dropped.
  const presentKeys = presentFolders(active).map(folderKey).join('\n');
  const requestedCorpus = useRef(new Set<string>());
  // biome-ignore lint/correctness/useExhaustiveDependencies: active is read via presentKeys, as everywhere else in this file
  useEffect(() => {
    if (!palette) {
      requestedCorpus.current.clear();
      return;
    }
    for (const root of foldersToRequest(presentFolders(active), corpus)) {
      const k = folderKey(root);
      if (requestedCorpus.current.has(k)) continue;
      requestedCorpus.current.add(k);
      post({ type: 'searchFiles', root, query: '' });
    }
  }, [palette, presentKeys, corpus]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: active is read via presentKeys, as everywhere else in this file
  useEffect(() => {
    setCorpus((c) => pruneCorpus(c, presentFolders(active)));
  }, [presentKeys]);

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
  // biome-ignore lint/correctness/useExhaustiveDependencies: active is read via its fine-grained fields, as everywhere else in this file
  const sections = useMemo(
    () => sessionSections(active),
    [active?.home, active?.roots, active?.missingRoots, active?.homeMissing],
  );
  const hintProjectId = projectForNewSession(active, state?.projects ?? []);
  const hintProjectName = state?.projects.find((p) => p.id === hintProjectId)?.name;
  const openAsSessionHint = hintProjectName !== undefined ? `in ${hintProjectName}` : undefined;
  // biome-ignore lint/correctness/useExhaustiveDependencies: active is read via its fine-grained fields, as everywhere else in this file
  const rowChanges = useMemo(
    () =>
      buildRowChangeMap({
        repoChanges,
        changes: projectData?.changes ?? [],
        changesRoot: active ? gitRootForSession(active) : undefined,
      }),
    [repoChanges, projectData?.changes, active?.activeRepoRoot, active?.cwd, active?.home],
  );

  // Hunk-level stage/unstage/discard reach app-level capabilities through a module store rather
  // than props — the editor's change peek is four prop hops away, and the ops must be awaited.
  // See webview/hunk-actions.ts and spec 2026-08-27-review-supercharge §2 Lane E.
  // biome-ignore lint/correctness/useExhaustiveDependencies: active is read via its fine-grained fields, as everywhere else in this file
  useEffect(() => {
    const fallbackRoot = active ? gitRootForSession(active) : '';
    const perRepo = repoChanges ?? [
      { root: fallbackRoot, changes: fallbackRoot ? (projectData?.changes ?? []) : [] },
    ];
    const absKeys = (keep: (c: ChangeDTO) => boolean) =>
      new Set(
        perRepo.flatMap((r) =>
          r.changes.filter(keep).map((c) => folderKey(joinPath(r.root, c.path))),
        ),
      );
    const host: HunkActionHost = {
      rootFor: (abs) => repoForPath(active?.repos ?? [], abs) ?? fallbackRoot,
      stagedPaths: absKeys((c) => c.staged),
      conflictedPaths: absKeys((c) => c.conflicted === true),
      confirmDiscard: (state) =>
        new Promise<boolean>((resolve) => {
          // A second discard opened while one was still asking: settle the displaced caller
          // rather than leaving it awaiting a promise nothing will ever resolve.
          hunkConfirmRef.current?.(false);
          hunkConfirmRef.current = resolve;
          setConfirm({
            ...state,
            onConfirm: () => {
              hunkConfirmRef.current = null;
              resolve(true);
            },
          });
        }),
      refreshChanges,
      invalidateDiff: (absPath) => {
        setDiffs((m) => {
          // Lane D keys the cache per scope, so an op has to drop every scope's view of the
          // file — the card that refetches may be showing any one of them.
          const keys = REVIEW_SCOPES.map((s) => diffKey(absPath, s)).filter((k) => m.has(k));
          if (keys.length === 0) return m;
          const next = new Map(m);
          for (const k of keys) next.delete(k);
          return next;
        });
        const target = canonicalPath(absPath);
        rereadOpenDiffs((d) => d.path === target);
      },
    };
    return setHunkActionHost(host);
  }, [
    active?.home,
    active?.cwd,
    active?.activeRepoRoot,
    active?.repos,
    projectData?.changes,
    repoChanges,
    refreshChanges,
    rereadOpenDiffs,
  ]);

  const pushRecent = useCallback(
    (kind: 'file' | 'diff', path: string, sessionId: string, diffScope?: DiffTabScope) =>
      setRecentsBySession((prev) => ({
        ...prev,
        [sessionId]: pushRecentDoc(prev[sessionId] ?? [], {
          kind,
          path,
          ...(diffScope ? { diffScope } : {}),
        }),
      })),
    [],
  );

  // Immediately close a doc tab (no dirty check). Also drops any dirty- and view-state entry.
  const forceCloseDoc = useCallback(
    (id: string) => {
      const doc = docState.docs.find((d) => d.id === id);
      if (doc) {
        // A diff tab shares its path with the file tab; only the file owns the dirty flag.
        if (doc.kind === 'file') {
          clearDirty(doc.path);
          clearReveal(doc.path);
        }
        const closed = toClosedTab(doc);
        if (closed) closedTabsRef.current = pushClosedTab(closedTabsRef.current, closed);
      }
      markClosing(id);
      clearHtmlView(id);
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
  /** Index a project's sources once per window. Fires when a session becomes active rather
   *  than on the first code-file open, so the language worker is already loaded by the time
   *  the user asks it anything — waiting for the first F12 to start indexing is what made
   *  that first F12 feel broken. `seeds` orders the reply so their imports stream first; there
   *  are none on the session-open path (nothing is on screen yet), only when a file is opened
   *  in a root that hasn't been indexed. */
  const indexProjectOnce = useCallback((root: string, seeds: string[] = []) => {
    const key = folderKey(root);
    if (indexedRoots.current.has(key)) return;
    indexedRoots.current.add(key);
    post({ type: 'indexProject', root, seeds });
  }, []);
  // Every present folder, home first (spec §2.11): an added or located folder is new here and
  // gets indexed through the same effect.
  const lastPresent = useRef<{ id: string | undefined; folders: string[] }>({
    id: undefined,
    folders: [],
  });
  // biome-ignore lint/correctness/useExhaustiveDependencies: active is read via presentKeys, as everywhere else in this file
  useEffect(() => {
    const folders = presentFolders(active);
    const now = { id: active?.id, folders };
    // A folder that left while unwatched may have changed; re-adding it (Undo) must re-index it.
    for (const k of foldersLeft(lastPresent.current, now)) indexedRoots.current.delete(k);
    lastPresent.current = now;
    if (folders.length === 0) return;
    // Deliberately behind the session's own startup (PTY spawn, git interrogation, first
    // paint): indexing reads every source file in the project, and racing it against those
    // makes opening a session feel slower to buy latency nobody is waiting on yet.
    const t = setTimeout(() => {
      for (const f of folders) indexProjectOnce(f);
    }, 1500);
    return () => clearTimeout(t);
  }, [presentKeys, indexProjectOnce]);
  useEffect(() => setCompilerOptionsRoot(active?.home), [active?.home]);
  // A file created after the index ran was unreachable forever — `indexedRoots` is a once-guard
  // and nothing invalidated it (spec contract 5, row 35). The watcher reports only FOLDERS, so
  // the host does the diffing: it knows which paths it already streamed. Debounced on top of the
  // watcher's own 300 ms so a `git checkout` or an agent's edit burst costs one top-up, not one
  // per file.
  useEffect(() => {
    const timers = new Map<string, ReturnType<typeof setTimeout>>();
    const stop = subscribe((msg) => {
      if (msg.type !== 'fsChanged') return;
      for (const root of msg.folders) {
        const key = folderKey(root);
        if (!indexedRoots.current.has(key)) continue;
        clearTimeout(timers.get(key));
        timers.set(
          key,
          setTimeout(() => {
            timers.delete(key);
            post({ type: 'indexProject', root, incremental: true });
          }, INCREMENTAL_INDEX_DEBOUNCE_MS),
        );
      }
    });
    return () => {
      stop();
      for (const t of timers.values()) clearTimeout(t);
    };
  }, []);
  const openFile = useCallback(
    (rawPath: string, targetSessionId?: string, mode: OpenMode = 'preview', nav?: FileOpenNav) => {
      // Every route into a file tab funnels through here — tree click, terminal link, quick
      // open, go to definition — and `docs.ts` keys tabs by the path STRING, so they all have
      // to spell it the same way (spec 2026-08-21 contract 4).
      const path = canonicalPath(rawPath);
      const background = mode === 'background';
      // If a target session is provided and differs from the active one, switch first.
      const effectiveSessionId = targetSessionId ?? activeIdRef.current ?? '';
      // Record BEFORE staging the reveal: setReveal moves a mounted editor's cursor
      // synchronously, which would corrupt the "from" side (nav-history plan, Settled decisions).
      // A background open is not a navigation.
      if (!background && nav?.record !== false) {
        recordNav({
          sessionId: effectiveSessionId,
          doc: { kind: 'file', path },
          ...(nav?.reveal ? { pos: nav.reveal } : {}),
        });
      }
      // Only the active doc is mounted, and a mounted viewer jumps on setReveal, so a background
      // open leaves the active doc's position alone (spec 2026-09-22-middle-click-new-tab §3).
      if (nav?.reveal && !(background && `file:${path}` === docStateRef.current.activeId)) {
        setReveal(path, nav.reveal);
      }
      if (background) {
        reportBackgroundOpen('file', path, effectiveSessionId);
      } else if (targetSessionId && targetSessionId !== activeIdRef.current) {
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
      if (!background) rightPaneRef.current?.revealInTree(path);
      // Usually already running (indexing starts when a session becomes active). This covers
      // the case where a file is opened in a project that hasn't been indexed yet, and seeds
      // the priority wave with the file the user is actually looking at.
      const effectiveSession = sessions.find((s) => s.id === effectiveSessionId) ?? active;
      if (effectiveSession?.home) {
        const owner =
          folderForPath(presentFolders(effectiveSession), path) ?? effectiveSession.home;
        indexProjectOnce(owner, isCodeFile(path) ? [path] : []);
      }
    },
    [active, sessions, pushRecent, indexProjectOnce, recordNav, reportBackgroundOpen],
  );
  const openDiff = useCallback(
    (
      rawPath: string,
      targetSessionId?: string,
      opts?: { sideBySide?: boolean; diffScope?: DiffTabScope; mode?: OpenMode },
    ) => {
      // Review writes the same scoped cache key, so the path has to be spelled the same.
      const path = canonicalPath(rawPath);
      const diffScope = opts?.diffScope;
      const background = opts?.mode === 'background';
      const effectiveSessionId = targetSessionId ?? activeIdRef.current ?? '';
      if (background) {
        reportBackgroundOpen('diff', path, effectiveSessionId, diffScope);
      } else {
        recordNav({
          sessionId: effectiveSessionId,
          doc: { kind: 'diff', path, ...(diffScope ? { diffScope } : {}) },
        });
      }
      if (!background && targetSessionId && targetSessionId !== activeIdRef.current) {
        setActiveId(targetSessionId);
        dispatchDocs({ type: 'switchSession', sessionId: targetSessionId });
      }
      diffReadQueueRef.current.request({ path, diffScope });
      dispatchDocs({
        type: 'open',
        kind: 'diff',
        path,
        sessionId: effectiveSessionId,
        sideBySide: opts?.sideBySide,
        diffScope,
        ...(background ? { mode: 'background' as const } : {}),
      });
      pushRecent('diff', path, effectiveSessionId, diffScope);
    },
    [pushRecent, recordNav, reportBackgroundOpen],
  );
  const onOpenReviewDiff = useCallback(
    (path: string, scope: ReviewScope, mode?: OpenMode) =>
      openDiff(path, undefined, {
        sideBySide: true,
        diffScope: scope === 'all' ? undefined : scope,
        mode,
      }),
    [openDiff],
  );
  // Open an http(s) URL as a web tab owned by the active session — or, for a guest's middle-click,
  // by the session owning that web tab. No host read — the <webview> guest fetches the page
  // itself (path = URL); ownership mirrors files.
  const openWeb = useCallback(
    (url: string, targetSessionId?: string, mode?: OpenMode) => {
      const sessionId = targetSessionId ?? activeIdRef.current ?? '';
      if (mode === 'background') {
        reportBackgroundOpen('web', url, sessionId);
        dispatchDocs({ type: 'open', kind: 'web', path: url, sessionId, mode });
        return;
      }
      recordNav({ sessionId, doc: { kind: 'web', path: url } });
      dispatchDocs({ type: 'open', kind: 'web', path: url, sessionId });
    },
    [recordNav, reportBackgroundOpen],
  );

  // Reopen the last closed tab (Mod+Shift+T). Files/diffs restore under their original
  // session as permanent tabs; a web tab reopens under the active session (openWeb owns no
  // session param). A no-op when the stack is empty.
  const reopenClosedTab = useCallback(() => {
    const { tab, rest } = popClosedTab(closedTabsRef.current);
    closedTabsRef.current = rest;
    if (!tab) return;
    if (tab.kind === 'file') openFile(tab.path, tab.sessionId, 'permanent');
    else if (tab.kind === 'diff') openDiff(tab.path, tab.sessionId, { diffScope: tab.diffScope });
    else openWeb(tab.path);
  }, [openFile, openDiff, openWeb]);
  reopenClosedTabRef.current = reopenClosedTab;

  // Open a content-search hit at its line/column (L5). openFile stages the reveal, which
  // CodeViewer consumes on mount via takeReveal() (the same seam cross-file go-to-definition
  // uses). Switch the center pane to the editor so a freshly-opened doc isn't hidden behind a
  // Board/Canvas.
  const openMatch = useCallback(
    (abs: string, line: number, column: number, mode: OpenMode = 'preview') => {
      if (mode !== 'background') setCenterView('editor');
      openFile(abs, undefined, mode, { reveal: { line, column } });
    },
    [openFile],
  );

  // R3 Review: open a changed file in the editor revealed at a hunk's WORK line, through the
  // same reveal seam as search-jump / go-to-definition.
  const jumpToHunk = useCallback(
    (abs: string, line: number, mode: OpenMode = 'preview') => {
      if (mode !== 'background') setCenterView('editor');
      openFile(abs, undefined, mode, { reveal: { line, column: 1 } });
    },
    [openFile],
  );

  // Stable so ReviewView's fetch effect runs once, not on every diff arrival: an inline
  // arrow here changes identity each app render → re-requests every diff → O(N^2) reads.
  const requestReviewDiff = useCallback(
    // Through the queue too: replies carry no request id, so a read the queue didn't post would
    // settle one it did.
    (abs: string, scope: ReviewScope) =>
      diffReadQueueRef.current.request(
        scope === 'all' ? { path: abs } : { path: abs, diffScope: scope },
      ),
    [],
  );

  // D11: open a terminal path link at an optional position. Resolves the owning session
  // so the file opens in the session that owns the path, then stages a reveal if a line
  // (and optionally col) was given. Switches the center pane to the editor.
  const openTerminalFileLink = useCallback(
    (
      path: string,
      line?: number,
      col?: number,
      originSessionId?: string,
      mode: OpenMode = 'preview',
    ) => {
      const owningId = resolveOwningSession({
        path,
        sessions,
        openDocs: docState.docs,
        activeId: activeId ?? null,
        originSessionId,
      });
      if (mode !== 'background') setCenterView('editor');
      openFile(
        path,
        owningId ?? undefined,
        mode,
        line === undefined ? undefined : { reveal: { line, column: col ?? 1 } },
      );
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

  // An agent's write to a plan in ANY open project, including one this window never opened —
  // the toast is its only cue (plan-store `fireExternal`). `durationMs: 0` because it is an
  // invitation, not a status line; the ref keeps the subscription to one for the window's life.
  useEffect(
    () =>
      planExternalChanges().subscribe((root, slug) => {
        pushToast({
          message: `Agent updated plan ${slug}`,
          variant: 'info',
          durationMs: 0,
          action: {
            label: 'Open',
            run: () => {
              // The plan's OWN project, never the active one. A plan tab's sessionId is the
              // terminal Send pastes into (spec §2 "Session binding"), so binding it to
              // whatever was on screen sends the human's edits to an unrelated agent.
              const owner = sessionOwningRoot(
                sessionsRef.current,
                root,
                activeIdRef.current ?? null,
              );
              if (owner === null) {
                pushToast({
                  message: `No open session owns ${root}, so ${slug} has no agent to send to. Open that project first.`,
                  variant: 'error',
                });
                return;
              }
              openFileRef.current(`${root}/${PLANS_DIR}/${slug}.md`, owner, 'permanent');
            },
          },
        });
      }),
    [],
  );

  useEffect(() => {
    setDefinitionOpener((abs, pos) =>
      openFileRef.current(abs, undefined, 'preview', { reveal: pos }),
    );
    // A CodeViewer outside a doc tab has no history identity, so its jumps are not entries.
    setCursorJumpSink((path, from, to) => {
      const key = canonicalPath(path);
      const doc = docStateRef.current.docs.find((d) => d.kind === 'file' && d.path === key);
      if (doc) recordJump(navEntryFor(doc, from), navEntryFor(doc, to));
    });
    // `activeIdRef`, not `activeId`: adding the id to the dependency array would re-run this
    // effect on every session switch, re-registering the Monaco-GLOBAL opener and providers.
    setUnresolvedResolver((fromFile, specifier) =>
      resolveModuleOnDemand(activeIdRef.current ?? null, fromFile, specifier),
    );
    // Monaco-global, not per editor: the opener is what makes every built-in navigation
    // command able to leave the current file, and the providers add the two commands
    // monaco's TS mode never registered.
    const disposables = [registerConduitEditorOpener(), ...registerTsNavigationProviders()];
    return () => {
      setUnresolvedResolver(null);
      setCursorJumpSink(null);
      for (const d of disposables) d.dispose();
    };
  }, [recordJump]);

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

  // Close every stale session (dead restored records) in one action. Reuses the shared
  // close path so persistence updates; stale sessions are never running, so closeSessions
  // never prompts. No-op when nothing is stale.
  const closeAllStale = useCallback(() => {
    closeSessions(
      staleSessionIds(sessions),
      'Close all stale sessions',
      'Close all stale sessions?',
    );
  }, [sessions, closeSessions]);

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
    if (canRelaunch(s)) {
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
          label: 'Timed message…',
          icon: <IconClock size={14} />,
          onClick: () => openTimedMessages(s.id),
        },
        {
          label: 'Duplicate session',
          icon: <IconDuplicate size={14} />,
          onClick: () => post({ type: 'duplicate', id: s.id }),
        },
        {
          label: 'Move to project…',
          icon: <IconFolder size={14} />,
          // Beside the row it was picked from (12e); a bare call has only the right-click point.
          onClick: (a) =>
            setMovePicker({
              sessionId: s.id,
              at: a ? { x: a.rect.right, y: a.rect.top } : { x: e.clientX, y: e.clientY },
            }),
        },
        ...moveMenuItems(s.id),
        {
          label: 'Copy home path',
          icon: <IconCopy size={14} />,
          separatorBefore: true,
          onClick: () => copyToClipboard(s.home),
        },
        {
          label: 'Copy name',
          icon: <IconCopy size={14} />,
          onClick: () => copyToClipboard(s.name),
        },
        {
          label: 'Reveal in Explorer',
          icon: <IconExternal size={14} />,
          onClick: () => post({ type: 'revealInExplorer', path: s.home }),
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
        ...(doc.kind === 'file' && isHtmlDocPath(doc.path)
          ? [
              {
                label:
                  getHtmlView(doc.id, settings.htmlDefaultView) === 'preview'
                    ? 'View source'
                    : 'View rendered',
                icon: <IconDoc size={14} />,
                onClick: () => toggleHtmlView(doc.id, settings.htmlDefaultView),
              },
              {
                label: 'Open externally',
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
          label: 'Timed message…',
          icon: <IconClock size={14} />,
          onClick: () => openTimedMessages(s.id),
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
          onClick: () => post({ type: 'revealInExplorer', path: s.home }),
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
      const ref = formatMention(active.home, req.path, req.startLine, req.endLine);
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

  // Move files/folders to the recycle bin (L2). One confirm up front; the loop is sequential and
  // never aborts on a failure, and whatever couldn't be trashed is offered ONE permanent-delete
  // confirm afterwards. See the selection-aware-context-menus spec §4.3 (and §3.2: a delete
  // records no undo entry — the Recycle Bin is the recovery path).
  const onDeleteFiles = useCallback(
    (
      nodes: { path: string; kind: 'dir' | 'file' }[],
      afterDeleted: (outcome: DeleteOutcome) => void,
    ) => {
      if (nodes.length === 0) return;
      const runPass = async (op: 'remove' | 'removePermanent', batch: typeof nodes) => {
        const deleted: string[] = [];
        const failed: { path: string; error: string }[] = [];
        for (const node of batch) {
          const res = await fsMutate({ op, path: node.path });
          if (res.ok) {
            if (node.kind === 'file') dropDocsFor(node.path);
            deleted.push(node.path);
          } else {
            failed.push({ path: node.path, error: res.error });
          }
        }
        afterDeleted({ deleted, failed: failed.map((f) => f.path) });
        return failed;
      };
      const permanently = (stuck: typeof nodes) => {
        setConfirm({
          title: 'Delete permanently',
          message: permanentConfirmMessage(stuck.map((n) => n.path)),
          confirmLabel: 'Delete permanently',
          danger: true,
          focusCancel: stuck.length > 1,
          onConfirm: () => {
            void runPass('removePermanent', stuck).then((failed) => {
              for (const f of failed) pushToast({ message: f.error, variant: 'error' });
            });
          },
        });
      };
      setConfirm({
        title: 'Move to Recycle Bin',
        message: trashConfirmMessage(nodes.map((n) => n.path)),
        confirmLabel: 'Move to Recycle Bin',
        danger: true,
        focusCancel: nodes.length > 1,
        onConfirm: () => {
          void runPass('remove', nodes).then((failed) => {
            if (failed.length > 0) {
              permanently(nodes.filter((n) => failed.some((f) => f.path === n.path)));
            }
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
      // A rename re-targets a tab the user already had open for real → keep it permanent. Not a
      // navigation (spec A6: renames aren't tracked), so it records nothing.
      openFile(toPath, undefined, 'permanent', { record: false });
    },
    [dropDocsFor, openFile],
  );

  // The row / repo-head menus reuse the kebab's bulk items; the icons are this menu's own.
  const withBulkIcons = (items: MenuItem[]): MenuItem[] =>
    items.map((it) => ({
      ...it,
      icon: it.danger ? <IconTrash size={14} /> : <IconBranch size={14} />,
    }));

  // No repoRoot = the active repo's list, the one `project.changes` carries.
  const changesOfRepo = useCallback(
    (repoRoot: string | undefined): ChangeDTO[] =>
      repoRoot === undefined
        ? (projectData?.changes ?? [])
        : (repoChanges?.find((r) => folderKey(r.root) === folderKey(repoRoot))?.changes ?? []),
    [projectData?.changes, repoChanges],
  );

  const repoBulkItems = (repoRoot: string): MenuItem[] => {
    const changes = changesOfRepo(repoRoot);
    return withBulkIcons(
      buildBulkMenuItems(
        changes.filter((c) => c.staged),
        changes.filter((c) => !c.staged),
        (intent) => void onGitAction(intent),
        () => {},
        { kind: 'repo', repoRoot },
      ),
    );
  };

  const pathMenuItems = (abs: string): MenuItem[] => [
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
  ];

  const onChangeContextMenu = (e: React.MouseEvent, rel: string, repoRoot: string) => {
    e.preventDefault();
    if (!active) return;
    const abs = joinPath(repoRoot, rel);
    const [firstBulk, ...restBulk] = repoBulkItems(repoRoot);
    setMenu({
      x: e.clientX,
      y: e.clientY,
      items: [
        { label: 'Open diff', icon: <IconBranch size={14} />, onClick: () => openDiff(abs) },
        { label: 'Open file', icon: <IconDoc size={14} />, onClick: () => openFile(abs) },
        ...pathMenuItems(abs),
        ...(firstBulk ? [{ ...firstBulk, separatorBefore: true }] : []),
        ...restBulk,
      ],
    });
  };

  const onRepoHeadContextMenu = (e: React.MouseEvent | React.KeyboardEvent, repoRoot: string) => {
    e.preventDefault();
    if (!active) return;
    const keyboard = !('clientX' in e);
    const at = keyboard
      ? (e.currentTarget as Element).getBoundingClientRect()
      : { left: e.clientX, bottom: e.clientY };
    setMenu({
      x: at.left,
      y: at.bottom,
      keyboard,
      items: [...repoBulkItems(repoRoot), ...pathMenuItems(repoRoot)],
    });
  };

  // Run a git action (stage/unstage/discard/stash) in one repo — `repoRoot`, else the active
  // one — then re-fetch the change list so the UI reflects the new state. Failures toast.
  // biome-ignore lint/correctness/useExhaustiveDependencies: active read via its fine-grained fields
  const runGit = useCallback(
    async (op: GitActionIntent['op'], path?: string, repoRoot?: string) => {
      if (!active) return;
      const root = repoRoot ?? gitRootForSession(active);
      // 'discardAll' is a renderer-only intent; map it to a real bulk discard below.
      const hostOp = op as Exclude<GitActionIntent['op'], 'discardAll'>;
      const res = await gitAction({ root, op: hostOp, path });
      if (!res.ok) pushToast({ message: `Git: ${res.error}`, variant: 'error' });
      // Always refresh — even on failure the on-disk state may have partially changed.
      refreshChanges();
      rereadOpenDiffs((d) => isUnderRoot(root, d.path));
    },
    [active?.home, active?.cwd, active?.activeRepoRoot, refreshChanges, rereadOpenDiffs],
  );

  // One repo after another so a failure names its repo and the rest still run; one refresh.
  const runGitFanOut = useCallback(
    async (op: 'stageAll' | 'unstageAll', roots: string[]) => {
      for (const root of roots) {
        const res = await gitAction({ root, op });
        if (!res.ok)
          pushToast({ message: `Git (${repoBaseName(root)}): ${res.error}`, variant: 'error' });
        rereadOpenDiffs((d) => isUnderRoot(root, d.path));
      }
      refreshChanges();
    },
    [refreshChanges, rereadOpenDiffs],
  );

  // Discard every change: unstage all, then restore tracked files, then delete
  // untracked. Sequenced so staged-and-modified files end up clean. Refresh once.
  // biome-ignore lint/correctness/useExhaustiveDependencies: active read via its fine-grained fields
  const discardAll = useCallback(
    async (repoRoot?: string) => {
      if (!active) return;
      const root = repoRoot ?? gitRootForSession(active);
      const list = changesOfRepo(repoRoot);
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
      rereadOpenDiffs((d) => isUnderRoot(root, d.path));
    },
    [
      active?.home,
      active?.cwd,
      active?.activeRepoRoot,
      changesOfRepo,
      refreshChanges,
      rereadOpenDiffs,
    ],
  );

  // Entry point from the Changes tab. Destructive ops get a 2-way confirm first;
  // everything else runs immediately.
  const onGitAction = useCallback(
    async (intent: GitActionIntent): Promise<void> => {
      const { op, path, repoRoot, repoRoots } = intent;
      if (repoRoots && (op === 'stageAll' || op === 'unstageAll'))
        return runGitFanOut(op, repoRoots);
      if (op === 'discardUntracked' && path) {
        setConfirm({
          title: 'Delete untracked file',
          message: `Delete untracked file ${baseName(path)}? This cannot be undone.`,
          confirmLabel: 'Delete',
          danger: true,
          onConfirm: () => void runGit('discardUntracked', path, repoRoot),
        });
        return;
      }
      if (op === 'discardTracked' && path) {
        setConfirm({
          title: 'Discard changes',
          message: `Discard changes to ${baseName(path)}? This cannot be undone.`,
          confirmLabel: 'Discard',
          danger: true,
          onConfirm: () => void runGit('discardTracked', path, repoRoot),
        });
        return;
      }
      if (op === 'discardAll') {
        const n = changesOfRepo(repoRoot).length;
        const repos = active?.repos ?? [];
        const repo =
          repoRoot === undefined
            ? undefined
            : repos.find((r) => folderKey(r.root) === folderKey(repoRoot));
        const where = repo && repos.length >= 2 ? ` in ${repoLabel(repo, repos)}` : '';
        setConfirm({
          title: 'Discard all changes',
          message: `Discard all ${n} change${n === 1 ? '' : 's'}${where}? Untracked files are deleted too. This cannot be undone.`,
          confirmLabel: 'Discard all',
          danger: true,
          onConfirm: () => void discardAll(repoRoot),
        });
        return;
      }
      return runGit(op, path, repoRoot);
    },
    [runGit, runGitFanOut, discardAll, changesOfRepo, active?.repos],
  );

  const changesViewModel = useMemo(
    () => changesModel({ session: active, repoChanges, view: settings.changesView }),
    [active, repoChanges, settings.changesView],
  );
  const reviewCombo = comboLabel('openReview', settings.shortcuts);
  const reviewTitle = reviewCombo ? `Review changes (${reviewCombo})` : 'Review changes';

  // biome-ignore lint/correctness/useExhaustiveDependencies: active read via its fine-grained fields
  const onRepoContext = useCallback(
    (root: string) => {
      if (active) post({ type: 'repo:context', sessionId: active.id, path: root });
    },
    [active?.id],
  );
  // biome-ignore lint/correctness/useExhaustiveDependencies: active read via its fine-grained fields
  const onPickActiveRepo = useCallback(
    (root: string | null) => {
      if (!active) return;
      post(
        root === null
          ? { type: 'repo:unpin', sessionId: active.id }
          : { type: 'repo:pin', sessionId: active.id, repoRoot: root },
      );
    },
    [active?.id],
  );
  // The All view has no pin control, so a pin left behind would silently freeze the active
  // repo (spec §13 D15).
  const onSetChangesView = useCallback(
    (view: ChangesViewMode) => {
      update({ changesView: view });
      if (view === 'all' && active?.repoPinned) post({ type: 'repo:unpin', sessionId: active.id });
    },
    [update, active?.id, active?.repoPinned],
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

  // Navigation history (docs/specs/2026-09-22-editor-nav-history.md §2.3–§2.4). Reads refs, not
  // state: an apply awaits the existence probe, and whatever it reads after that must be current.
  const currentNavEntry = useCallback((): NavEntry | null => {
    const { docs, activeId: docId } = docStateRef.current;
    const doc = docId === null ? undefined : docs.find((d) => d.id === docId);
    if (!doc) return null;
    if (doc.kind !== 'file') return navEntryFor(doc);
    // While a landing's tab is still mounting there is no live editor. Its cursor is then the staged
    // reveal it will consume, else the position its view state restores; an unknown cursor would
    // coalesce with (and so hide) every stop in the file — a burst of Backs skipped them.
    return navEntryFor(doc, liveCursor(doc.path) ?? peekReveal(doc.path) ?? lastCursor(doc.path));
  }, []);

  const isNavLive = useCallback(
    (e: NavEntry): boolean =>
      findOpenDoc(docStateRef.current.docs, e.doc) !== undefined ||
      (e.doc.kind === 'file' && sessionsRef.current.some((s) => s.id === e.sessionId)),
    [],
  );

  // A Terminal tab or the Board/Canvas shows no entry, so Back from there lands on the current one.
  const isNavOnScreen = useCallback(
    (e: NavEntry): boolean => {
      if (centerViewRef.current !== 'editor') return false;
      const live = currentNavEntry();
      return live !== null && coalescesEntries(live, e);
    },
    [currentNavEntry],
  );

  // `applyNav` keeps its name for the docs.test.ts activate-before-switchSession comment; the
  // activate dispatch and setActiveId stay in the same tick for the same reason.
  const applyNav = useCallback(async (e: NavEntry): Promise<ApplyResult> => {
    const announce = (title: string, pos = e.pos) => {
      if (navLiveRef.current) navLiveRef.current.textContent = navAnnouncement(title, pos);
    };
    const doc = findOpenDoc(docStateRef.current.docs, e.doc);
    if (doc) {
      const wasActive =
        doc.id === docStateRef.current.activeId && doc.sessionId === activeIdRef.current;
      dispatchDocs({ type: 'activate', id: doc.id, sessionId: doc.sessionId });
      if (doc.sessionId !== activeIdRef.current) setActiveId(doc.sessionId);
      setCenterView('editor');
      // An active doc whose editor is still mounting (the previous landing of a burst) has nothing
      // to reveal into yet, so it takes the staged path too; that replaces the earlier landing's
      // pending reveal instead of letting the mount consume the stale one.
      if (doc.kind === 'file' && !(e.pos && wasActive && revealInNavEditor(doc.path, e.pos))) {
        if (e.pos) setReveal(doc.path, e.pos);
        requestNavFocus(doc.path);
      }
      // An entry left without a record (a session switch) has no pos; its view state restores the
      // cursor it was left at, which is what the editor will show.
      announce(doc.title, e.pos ?? (doc.kind === 'file' ? lastCursor(doc.path) : undefined));
      return 'applied';
    }
    if (e.doc.kind !== 'file') return 'dead';
    if (!(await probePathExists(e.doc.path))) return 'dead';
    if (!sessionsRef.current.some((s) => s.id === e.sessionId)) return 'dead';
    setCenterView('editor');
    openFileRef.current(e.doc.path, e.sessionId, 'preview', { reveal: e.pos, record: false });
    requestNavFocus(e.doc.path);
    announce(baseName(e.doc.path));
    return 'applied';
  }, []);
  navDepsRef.current = {
    currentEntry: currentNavEntry,
    isLive: isNavLive,
    isOnScreen: isNavOnScreen,
    apply: applyNav,
  };

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
    iconPickerSessionId !== null ||
    movePicker !== null;
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
      subtitle: baseName(s.home),
      group: 'Sessions',
      icon: <SessionGlyph icon={resolveSessionIcon(s, agents)} size={14} />,
      ...sessionPaletteFields(s, activeId),
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
    const owningFor = (abs: string) =>
      resolveOwningSession({
        path: abs,
        sessions,
        openDocs: docState.docs,
        activeId: activeId ?? null,
      }) ?? undefined;
    const fileEntries: PaletteEntry[] = quickOpenFileRows(corpus, sections).map(({ hit, tag }) => ({
      id: `file:${hit.abs}`,
      title: hit.rel,
      group: 'Files',
      icon: <IconDoc size={14} />,
      ...(tag ? { badge: tag.label, badgeTone: tag.tone, badgeTitle: tag.title } : {}),
      run: () => openFile(hit.abs, owningFor(hit.abs)),
      runBackground: () => openFile(hit.abs, owningFor(hit.abs), 'background'),
    }));
    return [...sessionEntries, ...agentEntries, ...fileEntries];
  }, [sessions, agents, activeId, corpus, sections, openFile, docState.docs]);

  // Recently opened documents for the active session (shown when the query is empty).
  const recentItems: PaletteEntry[] = useMemo(() => {
    const activeRecents = (activeId ? recentsBySession[activeId] : undefined) ?? [];
    return activeRecents.map((r) => ({
      id: recentPaletteId(r),
      title: baseName(r.path),
      subtitle: recentSubtitle(r),
      group: 'Recent',
      icon: <IconDoc size={14} />,
      run: () =>
        r.kind === 'file'
          ? openFile(r.path)
          : openDiff(r.path, undefined, { diffScope: r.diffScope }),
      runBackground: () =>
        r.kind === 'file'
          ? openFile(r.path, undefined, 'background')
          : openDiff(r.path, undefined, { diffScope: r.diffScope, mode: 'background' }),
    }));
  }, [recentsBySession, activeId, openDiff, openFile]);

  // Command set (accessed via the `>` prefix).
  const commandItems: PaletteEntry[] = useMemo(() => {
    // Show each command's bound key combo for discoverability, resolved through the same
    // (rebindable) registry the global handler uses. Absent for commands with no binding.
    const comboFor = (actionId: string): string | undefined =>
      comboLabel(actionId, settings.shortcuts);
    const cmds: PaletteEntry[] = [
      {
        id: 'cmd:new',
        title: 'New session',
        keywords: ['create', 'start', 'launch'],
        group: 'Commands',
        icon: <IconPlus size={14} />,
        combo: comboFor('newSession'),
        run: () => openNewSession(),
      },
      {
        id: 'cmd:newWindow',
        title: 'New window',
        keywords: ['spawn'],
        group: 'Commands',
        icon: <IconPlus size={14} />,
        combo: comboFor('newWindow'),
        run: () => post({ type: 'win:new' }),
      },
      {
        id: 'cmd:editor',
        title: 'Open editor',
        keywords: ['code editor'],
        group: 'Commands',
        icon: <IconDoc size={14} />,
        run: () => openView('openEditor'),
      },
      {
        id: 'cmd:web',
        title: 'Open web page…',
        keywords: ['browser', 'url', 'website'],
        group: 'Commands',
        icon: <IconExternal size={14} />,
        run: () => setWebPromptOpen(true),
      },
      {
        id: 'cmd:board',
        title: 'Open feature board',
        keywords: ['kanban', 'tasks', 'backlog'],
        group: 'Commands',
        icon: <IconBoard size={14} />,
        combo: comboFor('openBoard'),
        run: () => openView('openBoard'),
      },
      {
        id: 'cmd:arch',
        title: 'Open architecture canvas',
        keywords: ['diagram', 'components'],
        group: 'Commands',
        icon: <IconGraph size={14} />,
        combo: comboFor('openArchitecture'),
        run: () => openView('openArchitecture'),
      },
      {
        id: 'cmd:review',
        title: 'Review all changes',
        keywords: ['diff', 'changes', 'pull request', 'pr'],
        group: 'Commands',
        icon: <IconReview size={14} />,
        combo: comboFor('openReview'),
        run: openReviewTab,
      },
      {
        id: 'cmd:gitHistory',
        title: 'View commit history',
        keywords: ['log', 'commits', 'git log'],
        group: 'Commands',
        icon: <IconBranch size={14} />,
        combo: comboFor('openGitHistory'),
        run: () => openGitHistoryTab(),
      },
      {
        id: 'cmd:timedMessage',
        title: 'Send timed message…',
        keywords: [
          'interval',
          'schedule',
          'scheduled',
          'timer',
          'delay',
          'repeat',
          'reminder',
          'remind',
          'continue',
          'usage limit',
          'auto-resume',
          'auto resume',
        ],
        group: 'Commands',
        icon: <IconClock size={14} />,
        // No default key: SHORTCUT_ACTIONS requires a defaultCombo, so a binding-less command is
        // palette-only — and this is a considered action, not a hot path (§5).
        run: () => openTimedMessages(),
      },
      {
        id: 'cmd:findInFiles',
        title: 'Find in files',
        keywords: ['search', 'grep'],
        group: 'Commands',
        icon: <IconSearch size={14} />,
        combo: comboFor('openGlobalSearch'),
        run: openGlobalSearchSeeded,
      },
      {
        id: 'cmd:toggleSidebar',
        title: paletteCommandTitle('sessions', !sidebarCollapsed),
        keywords: ['rail', 'sessions panel'],
        group: 'Commands',
        icon: <IconSidebar size={14} />,
        combo: comboFor('toggleSidebar'),
        run: toggleSidebar,
      },
      {
        id: 'cmd:toggleExplorer',
        title: paletteCommandTitle('explorer', !explorerCollapsed),
        keywords: ['file tree', 'files panel'],
        group: 'Commands',
        icon: <IconDoc size={14} />,
        combo: comboFor('toggleExplorer'),
        run: toggleExplorer,
      },
      {
        id: 'cmd:back',
        title: 'Go back',
        keywords: ['navigate back', 'history back'],
        group: 'Commands',
        icon: <IconCommand size={14} />,
        combo: comboFor('navBack'),
        run: goBack,
      },
      {
        id: 'cmd:forward',
        title: 'Go forward',
        keywords: ['navigate forward', 'history forward'],
        group: 'Commands',
        icon: <IconCommand size={14} />,
        combo: comboFor('navForward'),
        run: goForward,
      },
      {
        id: 'cmd:reduceMotion',
        title: settings.reduceMotion ? 'Reduce motion: off' : 'Reduce motion: on',
        keywords: ['animation', 'accessibility'],
        group: 'Commands',
        icon: <IconSparkle size={14} />,
        run: () => update({ reduceMotion: !settings.reduceMotion }),
      },
      {
        id: 'cmd:cycleTheme',
        title: 'Cycle theme',
        keywords: ['appearance', 'dark mode', 'light mode', 'color scheme'],
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
          keywords: ['finder', 'file manager', 'show in folder'],
          group: 'Commands',
          icon: <IconExternal size={14} />,
          run: () => post({ type: 'revealInExplorer', path: active.home }),
        },
        {
          id: 'cmd:close',
          title: 'Close active session',
          keywords: ['kill session', 'end session'],
          group: 'Commands',
          icon: <IconTrash size={14} />,
          run: () => requestKill(active.id),
        },
        {
          id: 'cmd:moveSessionNewWindow',
          title: 'Move session to new window',
          keywords: ['detach', 'pop out'],
          group: 'Commands',
          icon: <IconExternal size={14} />,
          run: () => post({ type: 'session:move', sessionId: active.id, target: { kind: 'new' } }),
        },
      );
      if (canRelaunch(active))
        cmds.push({
          id: 'cmd:relaunch',
          title: 'Relaunch active session',
          keywords: ['restart', 'reload session'],
          group: 'Commands',
          icon: <IconSparkle size={14} />,
          run: () => post({ type: 'relaunch', id: active.id }),
        });
    }
    const activeDoc = docState.docs.find((d) => d.id === docState.activeId);
    if (activeDoc) {
      if (activeDoc.kind === 'file' && isHtmlDocPath(activeDoc.path)) {
        cmds.push(
          {
            id: 'cmd:toggleHtmlView',
            title: 'Toggle rendered view',
            keywords: ['html', 'preview', 'source', 'render'],
            group: 'Commands',
            icon: <IconDoc size={14} />,
            combo: comboFor('toggleHtmlView'),
            run: () => toggleHtmlView(activeDoc.id, settings.htmlDefaultView),
          },
          {
            id: 'cmd:reloadHtmlPreview',
            title: 'Reload preview',
            keywords: ['html', 'refresh', 'reload'],
            group: 'Commands',
            icon: <IconRefresh size={14} />,
            run: () => bumpHtmlReload(activeDoc.id),
          },
          {
            id: 'cmd:openInBrowser',
            // `shell.openPath` hands the file to the OS default app for .html, which is often
            // an editor — "in browser" was a promise this cannot keep.
            title: 'Open externally',
            keywords: ['browser', 'preview', 'default app'],
            group: 'Commands',
            icon: <IconExternal size={14} />,
            run: () => post({ type: 'openExternalPath', path: activeDoc.path }),
          },
        );
      }
      cmds.push(
        {
          id: 'cmd:revealFile',
          title: 'Reveal active file in Explorer',
          keywords: ['show file'],
          group: 'Commands',
          icon: <IconExternal size={14} />,
          run: () => post({ type: 'revealInExplorer', path: activeDoc.path }),
        },
        {
          id: 'cmd:copyFile',
          title: 'Copy active file path',
          keywords: ['copy path'],
          group: 'Commands',
          icon: <IconCopy size={14} />,
          run: () => copyToClipboard(activeDoc.path),
        },
        {
          id: 'cmd:closeOthers',
          title: 'Close other tabs',
          keywords: ['close others'],
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
      if (activeDoc.kind === 'file') {
        // Unconditional: whether the file HAS changes is known only to the editor's marker
        // hook, which lands after this list is memoised — gating on it here made the rows
        // disappear. The registry is resolved at run() time, and an unchanged file gets the
        // editor's own "No changes" announcement.
        cmds.push(
          {
            id: 'cmd:nextChange',
            title: 'Go to next change',
            keywords: ['next diff'],
            group: 'Commands',
            icon: <IconCompare size={14} />,
            combo: comboFor('nextChange'),
            run: () =>
              goToChangeInActiveDoc(docStateRef.current.docs, docStateRef.current.activeId, 'next'),
          },
          {
            id: 'cmd:prevChange',
            title: 'Go to previous change',
            keywords: ['previous diff'],
            group: 'Commands',
            icon: <IconCompare size={14} />,
            combo: comboFor('prevChange'),
            run: () =>
              goToChangeInActiveDoc(docStateRef.current.docs, docStateRef.current.activeId, 'prev'),
          },
        );
      }
      if (dirtySet.has(activeDoc.path)) {
        cmds.push({
          id: 'cmd:revertFile',
          title: 'Revert File',
          keywords: ['discard changes', 'undo file'],
          group: 'Commands',
          icon: <IconDoc size={14} />,
          run: () => revertDocByPath(activeDoc.path),
        });
      }
    }
    if (relaunchableSessionIds(sessions).length > 0) {
      cmds.push({
        id: 'cmd:relaunchAllStale',
        title: 'Relaunch all stale sessions',
        keywords: ['restart all', 'reconnect'],
        group: 'Commands',
        icon: <IconSparkle size={14} />,
        run: relaunchAllStale,
      });
    }
    if (staleSessionIds(sessions).length > 0) {
      cmds.push({
        id: 'cmd:closeAllStale',
        title: 'Close all stale sessions',
        keywords: ['clear stale'],
        group: 'Commands',
        icon: <IconTrash size={14} />,
        run: closeAllStale,
      });
    }
    cmds.push({
      id: 'cmd:saveAll',
      title: 'Save All',
      keywords: ['save everything'],
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
    // The recovery the crash message names (spec 2026-09-22-language-server-go §2.2).
    for (const l of restartableLanguages(lspStatuses, lspLanguages)) {
      cmds.push({
        id: `cmd:restartLsp:${l.languageId}`,
        title: `Restart ${l.displayName} language server`,
        keywords: [l.binary, l.languageId, 'lsp', 'language server'],
        group: 'Commands',
        icon: <IconRefresh size={14} />,
        run: () => void lspInvoke({ type: 'lsp:restart', languageId: l.languageId }),
      });
    }
    // Workspace Trust (docs/specs/2026-09-23-workspace-trust.md). "Trust" only asks the host to
    // raise its prompt — the host picks the folder and owns the decision.
    const trustLanguage = lspLanguages[0];
    const trustTarget = activeFilePath ?? active?.home;
    if (trustLanguage && trustTarget) {
      cmds.push({
        id: 'cmd:trustCurrentFolder',
        title: 'Workspace Trust: Trust Current Folder',
        keywords: ['restricted mode', 'trust', 'language server'],
        group: 'Commands',
        run: () => requestTrust(trustTarget, trustLanguage.languageId),
      });
    }
    cmds.push({
      id: 'cmd:manageTrust',
      title: 'Manage Workspace Trust',
      keywords: ['restricted mode', 'trusted folders'],
      group: 'Commands',
      // After the palette closes on this run, reopen it narrowed to the trusted folders.
      run: () => setTimeout(() => setPalette({ initialQuery: '>Workspace Trust: Remove' }), 0),
    });
    for (const folder of lspTrust.trusted) {
      cmds.push({
        id: `cmd:untrust:${folder}`,
        title: `Workspace Trust: Remove ${folder}`,
        keywords: ['untrust', 'revoke', 'restricted mode'],
        group: 'Commands',
        run: () => void lspInvoke({ type: 'lsp:trustRevoke', path: folder }),
      });
    }
    const settingsCmds: PaletteEntry[] = [
      {
        id: 'set:general',
        title: 'Open Settings: General',
        keywords: ['preferences', 'options'],
        group: 'Settings',
        icon: <IconSettings size={14} />,
        combo: comboFor('openSettings'),
        run: () => openSettingsAt('general'),
      },
      {
        id: 'set:appearance',
        title: 'Open Settings: Appearance',
        keywords: ['theme', 'colors'],
        group: 'Settings',
        icon: <IconSettings size={14} />,
        run: () => openSettingsAt('appearance'),
      },
      {
        id: 'set:shortcuts',
        title: 'Open Settings: Shortcuts',
        keywords: ['keybindings', 'hotkeys'],
        group: 'Settings',
        icon: <IconSettings size={14} />,
        run: () => openSettingsAt('shortcuts'),
      },
      {
        id: 'set:skills',
        title: 'Install Conduit skills…',
        keywords: ['claude skills', 'plugins'],
        group: 'Settings',
        icon: <IconSettings size={14} />,
        run: () => openSettingsAt('skills'),
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
      icon: <SessionGlyph icon={resolveSessionIcon(s, agents)} size={14} />,
      ...sessionPaletteFields(s, activeId),
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
    agents,
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
    openGlobalSearchSeeded,
    sidebarCollapsed,
    explorerCollapsed,
    toggleSidebar,
    toggleExplorer,
    closeDoc,
    dirtySet,
    openNewSession,
    relaunchAllStale,
    closeAllStale,
    openTimedMessages,
    lspStatuses,
    lspLanguages,
    lspTrust,
    activeFilePath,
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
            repos={state?.repos ?? []}
            activeId={activeId}
            docs={visibleDocs}
            activeDocId={docState.activeId}
            files={files}
            diffs={diffs}
            onSelectDoc={(id) => activateDocByUser(id, activeIdRef.current ?? '')}
            onCloseDoc={closeDoc}
            onRelaunch={(id) => post({ type: 'relaunch', id })}
            onOpenTimedMessages={openTimedMessages}
            onTabContextMenu={onTabContextMenu}
            onTerminalTabContextMenu={onTerminalTabContextMenu}
            onReorderDoc={(dragId, targetId) => dispatchDocs({ type: 'reorder', dragId, targetId })}
            onPinDoc={(id) => dispatchDocs({ type: 'pinDoc', id })}
            dock={dockHandlers('center')}
            splitId={splitId}
            onCloseSplit={() => setSplitId(null)}
            onOpenFile={(p, mode) => openFile(p, undefined, mode)}
            onOpenFileAt={openTerminalFileLink}
            onOpenWeb={openWeb}
            flashTabId={backgroundFeedback.flashTabId}
            onRevealFolder={(path) => post({ type: 'revealInExplorer', path })}
            onOpenCommitReview={(sha, sid, repoRoot) =>
              openReviewForCommit(sha, sid, undefined, repoRoot)
            }
            changesRoot={active ? gitRootForSession(active) : undefined}
            changes={projectData?.changes ?? []}
            onReviewRequestDiff={requestReviewDiff}
            onJumpToHunk={jumpToHunk}
            onOpenReviewDiff={onOpenReviewDiff}
            onReviewGitAction={onGitAction}
            onCloseReview={closeReviewTab}
            onSetReviewSource={setReviewSource}
            onNewSession={() => openNewSession()}
            onOpenCommitFile={openCommitFile}
            onRetargetHistory={retargetGitHistory}
            onReviewCommit={(sha, subject, repoRoot, sessionId) =>
              openReviewForCommit(sha, sessionId, subject, repoRoot)
            }
            onDocTitle={(id, title) => dispatchDocs({ type: 'setTitle', id, title })}
            paneTab={paneTab}
            explorerCollapsed={settings.explorerCollapsed}
            onTogglePanel={toggleExplorer}
            onShowChanges={showChangesInPane}
            onClearSideBySide={(id) => dispatchDocs({ type: 'clearSideBySide', id })}
            onRetryDiff={(doc) =>
              diffReadQueueRef.current.request({ path: doc.path, diffScope: doc.diffScope })
            }
            onOpenFullDiff={(doc) => openDiff(doc.path, doc.sessionId)}
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
            projects={state?.projects ?? []}
            windowCount={Math.max(1, winList.length)}
            onNewInProject={(projectId) => setNewSession({ projectId })}
            onOpenBoard={(id) => {
              setActiveId(id);
              setCenterView('board');
            }}
            onConfirm={setConfirm}
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
            onCloseAllStale={closeAllStale}
            onRename={(id, name) => post({ type: 'rename', id, name })}
            onRelaunch={(id) => post({ type: 'relaunch', id })}
            onOpenSettings={() => openSettingsAt('general')}
            onContextMenu={onSessionContextMenu}
            onSnooze={snooze}
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
          reviewFallbackRoot={active ? activeCwd(active) : undefined}
          sessionId={active?.id}
          sections={sections}
          rowChanges={rowChanges}
          osDropSeam={state?.about?.e2e === true}
          openAsSessionHint={openAsSessionHint}
          changes={projectData?.changes ?? []}
          changesModel={changesViewModel}
          reviewTitle={reviewTitle}
          onReview={openReviewTab}
          onRefresh={refreshChanges}
          onSetView={onSetChangesView}
          onAction={onGitAction}
          onRepoHeadContextMenu={onRepoHeadContextMenu}
          onRepoContext={onRepoContext}
          onPickActiveRepo={onPickActiveRepo}
          renderChip={(repo) =>
            active ? (
              <BranchChip
                sessionId={active.id}
                repo={repo}
                git={gitOf(active, repo.root)}
                onViewHistory={openGitHistoryTab}
                onSwitched={refreshChanges}
                onActivate={() => onRepoContext(repo.root)}
              />
            ) : null
          }
          moveGrip={{ onDragStart: edock.onDragStart, onDragEnd: edock.onDragEnd }}
          onOpenFile={(p, mode) => openFile(p, undefined, mode)}
          onOpenMatch={openMatch}
          paneRef={rightPaneRef}
          onOpenDiff={(repoRoot, rel, diffScope, mode) =>
            openDiff(joinPath(repoRoot, rel), undefined, { diffScope, mode })
          }
          setMenu={setMenu}
          revealPath={(path) => post({ type: 'revealInExplorer', path })}
          openExternalApp={(path) => post({ type: 'openExternalPath', path })}
          openWithChooser={(path) => post({ type: 'openWith', path })}
          openAsSession={openNewSession}
          copyToClipboard={copyToClipboard}
          onDeleteFiles={onDeleteFiles}
          onFileRenamed={onFileRenamed}
          onChangeContextMenu={onChangeContextMenu}
          onReviewScope={openReviewScoped}
          reviewMode={reviewMode}
          onTabShown={setPaneTab}
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
      <div
        ref={backgroundFeedback.statusRef}
        className="sr-only bg-open-status"
        aria-live="polite"
        role="status"
      />
      <TopBar
        isDev={!!state?.about?.isDev}
        onOpenSearch={() => setPalette({ initialQuery: '' })}
        onBack={goBack}
        onForward={goForward}
        canBack={canNavigate(navState, navDepsRef.current, -1)}
        canForward={canNavigate(navState, navDepsRef.current, 1)}
        centerView={centerView}
        onSelectView={setCenterView}
        sessions={sessions}
        onFocusAttention={setActiveId}
        onContextMenu={onPanelTogglesMenu}
      />
      <div className="workbench">{visibleOrder.map(renderRegion)}</div>
      {newSession && (
        <NewSessionModal
          prefill={newSession}
          ctx={{
            active,
            sessions,
            projects: state?.projects ?? [],
            repos: state?.repos ?? [],
            agents,
            launchers: state?.launchers ?? [],
            defaultAgentId: settings.defaultAgentId,
          }}
          onClose={() => setNewSession(null)}
          onStarted={(_id, dropped) => {
            // The knownIds effect activates the new session; nothing else to do here.
            setNewSession(null);
            for (const d of dropped) {
              pushToast({
                message: `Skipped ${sessionNameFromPath(d.path)}: not a valid folder`,
                variant: 'error',
              });
            }
          }}
        />
      )}
      {settingsOpen && (
        <SettingsModal
          agents={agents}
          initialTab={settingsTab}
          about={state?.about}
          projectPath={active?.home || null}
          onClose={() => setSettingsOpen(false)}
          onCheckUpdate={() => post({ type: 'updateCheck' })}
          onRelaunch={() => post({ type: 'updateRelaunch' })}
          updateStatus={updateStatus}
          onSetChangesView={onSetChangesView}
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
          projectPath={active?.home}
          sessions={sessions}
          onStartSessionForCard={(card) =>
            setNewSession({
              ...(active ? { home: active.home } : {}),
              roots: active?.roots ?? [],
              projectId: active?.projectId ?? null,
              cardId: card.id,
              cardTitle: card.title,
            })
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
          projectPath={active?.home}
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
            // A hunk discard was awaiting an answer; Cancel and Esc both arrive here.
            const hunkReply = hunkConfirmRef.current;
            hunkConfirmRef.current = null;
            hunkReply?.(false);
            setConfirm(null);
          }}
        />
      )}
      {movePicker && (
        <ProjectPicker
          session={sessions.find((x) => x.id === movePicker.sessionId)}
          projects={state?.projects ?? []}
          at={movePicker.at}
          onClose={closeMovePicker}
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
      {timedMessageFor &&
        (() => {
          const target = sessions.find((s) => s.id === timedMessageFor);
          return target ? (
            <TimedMessageDialog
              session={target}
              onClose={() => setTimedMessageFor(null)}
              requestConfirm={setConfirm}
            />
          ) : null;
        })()}
      <Toasts />
    </div>
  );
}
