import { execFile, spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  type IpcMainEvent,
  ipcMain,
  Menu,
  Notification,
  powerMonitor,
  screen,
  session,
  shell,
  type WebContents,
  webContents,
} from 'electron';
import { hcClient, startCore } from '../server/hc-cli';
import { CURRENT_SHIM_GENERATION, prepareRuntime } from '../server/runtime-dir/prepare';
import { activeCwd, sessionGitRoot } from '../src/active-cwd';
import { repoForPath, requestGitRoot, resolveRequestRepoRoot } from '../src/active-repo';
import { isAppIndexUrl } from '../src/app-navigation';
import { asyncSingleFlight } from '../src/async-singleflight';
import { atomicWriteFile, atomicWriteFileSync } from '../src/atomic-write';
import { fingerprint } from '../src/board-watch';
import { changelogSection } from '../src/changelog';
import {
  createCloseGuard,
  createQuitGrant,
  GRANT_TTL_MS,
  type GuardReason,
  openWindowIds,
} from '../src/close-guard';
import { type CommitValidation, isCommitHex, parseBatchCheck } from '../src/commit-token';
import { SHIM_LEAF } from '../src/conduit-mcp/install-entries';
import { coerceInstallRequest } from '../src/conduit-mcp/install-types';
import { readBlob } from '../src/config';
import type { TruncatedBy } from '../src/content-search';
import { searchContentFs } from '../src/content-search-fs';
import { HC_PINNED_VERSION } from '../src/contracts/hc';
import type {
  WindowPresence as C2WindowPresence,
  DataStores,
  ServerEvents,
  ServerMethods,
  SessionMutation,
} from '../src/contracts/server-protocol';
import { coreStartEnv, SERVER_EXHAUSTED_FILE } from '../src/contracts/session-identity';
import { decideCrashRecovery } from '../src/crash-recovery';
import { ExpiringCache } from '../src/expiring-cache';
import { indexToSearchHits, walkFilesAsync } from '../src/file-search';
import {
  parseWriteOptions,
  readDiffReply,
  readDir,
  readFile,
  UNMERGED,
  type Unmerged,
  writeFile,
} from '../src/file-service';
import { folderKey } from '../src/folder-key';
import { locateFolder } from '../src/folder-locate';
import { type DndOpts, fsCopy, fsMove } from '../src/fs-dnd';
import { fsImport, type ImportConflictPolicy } from '../src/fs-import';
import {
  createDir,
  createFile,
  type FsMutationRequest,
  type MutationResult,
  remove,
  removePermanent,
  rename as renamePath,
} from '../src/fs-mutations';
import { executeGitAction, type GitActionRequest, type GitActionResult } from '../src/git-actions';
import { GIT_TIMEOUT, runGit } from '../src/git-exec';
import {
  assignLanes,
  getBlame,
  getCommitDiff,
  getHistory,
  getRangeDiff,
  searchHistory,
} from '../src/git-history';
import { isDirty, listBranches, listRefs, switchBranch } from '../src/git-info';
import { resolveLfsImage } from '../src/git-lfs';
import { gitIgnoredNames, gitListedFiles, LISTING_MAX_BUFFER } from '../src/git-listing';
import { createAsyncMemo } from '../src/git-memo';
import { fullyQualifiedRef, type RefEndpoint, rangeKey } from '../src/git-range';
import { decideSwitch, isKnownRef } from '../src/git-switch';
import { type HeadBlobShow, readHeadBlob } from '../src/head-blob';
import { IgnoreCache } from '../src/ignore-cache';
import { importClosure } from '../src/import-graph';
import { staleIndexRoots } from '../src/index-resync';
import {
  type IndexMode,
  indexQueueSlot,
  planIndexPass,
  type RootIndexState,
  takeChunks,
  wantsFullIndex,
} from '../src/index-streams';
import { instanceNames } from '../src/instance-names';
import { type HostPlatform, resolveServerBinary, type SearchContext } from '../src/lsp-binary';
import { compileRootMarkers, compileWatchGlobs, LANGUAGE_SERVERS } from '../src/lsp-registry';
import { resolveServerRoot } from '../src/lsp-root';
import {
  type CachedResolution,
  dropResolutionsForRoot,
  hostFsShim,
  rememberResolution,
  resolveCacheKey,
  resolveModuleWithClosure,
  touchResolution,
} from '../src/module-resolver-fs';
import { openWithCommand } from '../src/open-with';
import {
  nodeOutgoingPathDeps,
  outgoingFoldersFor,
  validateOutgoingPaths,
} from '../src/outgoing-paths';
import { resolveOwningSession } from '../src/owning-session';
import { isInsideAnyRoot, isInsideRoot, realPathLeaf } from '../src/path-guard';
import { hostRealPathLeaf } from '../src/path-link-confine';
import type { IndexedFile } from '../src/path-resolve';
import { parseDocs, serializeDocs } from '../src/persistence';
import { buildQueueEntry } from '../src/pipeline';
import { applyPlanCommentPatch, commentsFingerprint } from '../src/plan-comments';
import { buildPreviewUrl, isPreviewUrl } from '../src/preview-url';
import { createProjectFileIndex, repoSetOf } from '../src/project-file-index';
import type {
  AboutInfo,
  DiffBase,
  HostToWebview,
  PersistedDoc,
  RepoDTO,
  ServerUiState,
  SessionOpReason,
  WebviewToHost,
} from '../src/protocol';
import { summarizeQueue } from '../src/queue-summary';
import { busySessions, runningSessions } from '../src/quit-guard';
import { resolveRangePreset } from '../src/range-preset';
import { createGrantStore, hostCanonical } from '../src/read-grants';
import { releaseNotesAckVersion, releaseNotesDecision } from '../src/release-notes-decision';
import { createRepoFileIndex } from '../src/repo-file-index';
import {
  filterExistingRepos,
  restoreRepos,
  serializeRepos,
  upsertAttachedRepo,
  upsertRepo,
} from '../src/repo-history';
import { repoRelPath } from '../src/repo-rel';
import { detectRepos, scanSessionRepos } from '../src/repo-scan';
import { createRepoScanScheduler } from '../src/repo-scan-scheduler';
import { revealActionFor } from '../src/reveal-action';
import {
  contentHash,
  isMark,
  marksFor,
  normalizeRoot,
  parseMarksFile,
  serializeMarksFile,
  setMark as setReviewMark,
} from '../src/review-marks';
import { applyNotePatch, notesFingerprint, type ReviewNotesData } from '../src/review-notes';
import { isIndexScope, searchRootAllowed } from '../src/search-scope';
import { presentRoots, sessionContains } from '../src/session-folders';
import { createSessionResourceDemand } from '../src/session-resource-demand';
import {
  type AppSettings,
  coerceSettings,
  restoreSettings,
  serializeSettings,
} from '../src/settings';
import { mirrorServerKeys, serverPatchOf, uiOnly } from '../src/settings-mirror';
import { expandShortNames, hasShortComponent, hostShortNameDeps } from '../src/short-names';
import { defaultSidebarUi, parseSidebarUi, type SidebarUiState } from '../src/sidebar-state';
import type { SkillDestination, SkillInfo, SkillInstallResult } from '../src/skills';
import { INDEX_FILE_CAP, isOversizedForIndex, selectIndexCandidates } from '../src/source-index';
import { groundForTheme } from '../src/theme-ground';
import { loadTsconfigChain } from '../src/tsconfig-discovery';
import { type TsconfigDTO, toTsconfigDTO } from '../src/tsconfig-map';
import type { BriefRequest, Session } from '../src/types';
import { createGuestOpenGate, hardenWebviewPrefs, isHttpUrl } from '../src/webview-guard';
import { createWindowPresence } from '../src/window-presence';
import {
  assignOwner,
  buildWinList,
  clampBoundsToDisplays,
  type OwnerMap,
  parseWindowLayout,
  planLayoutRestore,
  removeOwner,
  serializeWindowLayout,
  sessionsForWindow as sessionsOwnedBy,
  tearOutBounds,
  type WindowLayout,
  windowAtPoint,
} from '../src/window-registry';
import { currentWindowsPty } from '../src/windows-pty-info';
import { parseTrustStore, serializeTrustStore } from '../src/workspace-trust';
import { AppSessionStore, type SessionDiff } from './app-session-store';
import { extractOpenTarget, gitRootOf } from './arg-utils';
import { BoardWatcher } from './board-watcher';
import {
  acceptProposal,
  appendPipelineQueueEntry,
  listSpecs,
  type ProposalKind,
  planWriteRefusal,
  readArchitectureForProject,
  readArchitectureProposal,
  readBoardForProject,
  readBoardProposal,
  readPipelineForProject,
  readPipelineQueueForProject,
  readPlan,
  readPlanComments,
  readReviewNotesForProject,
  readSpec,
  rejectProposal,
  removeReviewNotesArtifactFile,
  writeArchitectureArtifactFile,
  writeBoardArtifactFile,
  writePipelineArtifactFile,
  writePlanCommentsFile,
  writePlanFile,
  writeReviewNotesArtifactFile,
  writeSpec,
} from './conduit-fs';
import { createDragOutHost } from './drag-out-host';
import { execFileBounded } from './exec-bounded';
import { createFolderPicker } from './folder-picker';
import { type HcCliDeps, supervisorEnv } from './hc-cli';
import { createHcEvents } from './hc-events';
import { Logger } from './logger';
import { LspManager } from './lsp-manager';
import { startLanguageServer } from './lsp-server';
import { watchServerRoot } from './lsp-watcher';
import { NotesWatcher } from './notes-watcher';
import { OpenFileWatcher } from './open-file-watcher';
import { createOsFileClipboard, spawnPowerShell } from './os-file-clipboard';
import { createPathLinkResolver } from './path-link-resolver';
import { PlanWatcher } from './plan-watcher';
import {
  PREVIEW_PARTITION,
  previewStat,
  previewTargetForPath,
  registerPreviewProtocol,
  registerPreviewScheme,
  rootTokenFor,
} from './preview-protocol';
import { defaultTreeKillDeps } from './process-tree';
import { ProjectWatcher } from './project-watcher';
import { ProposalWatcher } from './proposal-watcher';
import { stopAgentsBeforeQuit } from './quit-stop';
import { createRepoTrackerHost } from './repo-tracker-host';
import { collectRuntimeGarbage } from './runtime-gc';
import { runtimeLayout } from './runtime-layout';
import {
  createServerCalls,
  installDownResult,
  installDownStatus,
  serverDownReply,
  waitForServerSnapshot,
} from './server-calls';
import { type AppLog, ServerCallError, ServerClient } from './server-client';
import { createPendingAppCreateMatcher, createServerEventRouter } from './server-events';
import { createServerLifecycle } from './server-lifecycle';
import { SessionFolderRuntime } from './session-folder-runtime';
import { installSkill, listSkills } from './skills-service';
import { createTerminalHost } from './terminal-host';
import { createTerminalLinkFactory } from './terminal-link';
import { checkForUpdate, initUpdater, quitAndInstall } from './updater';
import { closeWindowSessions, reconcileSessionOwners } from './window-session-close';

function readAboutInfo(): AboutInfo {
  try {
    // package.json lives one directory above __dirname (out/main.js → root).
    const pkgPath = path.join(__dirname, '..', 'package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as {
      version?: string;
      author?: string | { name?: string };
      build?: { publish?: { owner?: string; repo?: string } };
    };
    const version = typeof pkg.version === 'string' ? pkg.version : '0.0.0';
    const rawAuthor = pkg.author;
    const author =
      typeof rawAuthor === 'string'
        ? rawAuthor
        : typeof rawAuthor === 'object' && rawAuthor?.name
          ? rawAuthor.name
          : 'Nima Karami';
    // The repo URL comes from the SAME publish config electron-updater fetches releases from,
    // so the About link and the update channel cannot point at different repositories. It was
    // a second hardcoded string, and it had the owner slug wrong — the link 404'd.
    const owner = pkg.build?.publish?.owner ?? 'nima-karami';
    const repo = pkg.build?.publish?.repo ?? 'conduit';
    return {
      version,
      author,
      repoUrl: `https://github.com/${owner}/${repo}`,
      electronVersion: process.versions.electron ?? '',
      nodeVersion: process.versions.node ?? '',
      chromeVersion: process.versions.chrome ?? '',
      isDev: !app.isPackaged,
      e2e: process.env.CONDUIT_E2E === '1',
    };
  } catch {
    return {
      version: '0.0.0',
      author: 'Nima Karami',
      repoUrl: 'https://github.com/nima-karami/conduit',
      electronVersion: process.versions.electron ?? '',
      nodeVersion: process.versions.node ?? '',
      chromeVersion: process.versions.chrome ?? '',
      isDev: !app.isPackaged,
      e2e: process.env.CONDUIT_E2E === '1',
    };
  }
}

const aboutInfo: AboutInfo = readAboutInfo();

// Allow WebGL even when the GPU is blocklisted/unavailable, so the shader
// background (and xterm's WebGL renderer) work via software rendering as a
// fallback. Must run before app 'ready'.
app.commandLine.appendSwitch('ignore-gpu-blocklist');
app.commandLine.appendSwitch('enable-unsafe-swiftshader');
// Deliberately NOT app.disableDomainBlockingFor3DAPIs(): it is app-global, so it would also lift
// Chromium's 3D guard for web-tab guests, letting a page crash the GPU in a loop until Chromium
// kills the whole app. After a repeat reset terminals stay on DOM instead (webview/terminal-gpu.ts).

// Also before app 'ready' — Electron throws if a scheme is privileged afterwards.
registerPreviewScheme();

// Dev build runs side-by-side with an installed Conduit: a separate userData dir also gives
// it its own single-instance lock (the lock lives under userData), so the two don't clobber
// each other. Skipped when --user-data-dir is set (E2E) so per-scenario isolation holds.
if (!app.isPackaged && !app.commandLine.hasSwitch('user-data-dir')) {
  app.setPath('userData', path.join(app.getPath('appData'), 'Conduit (dev)'));
}

// Multi-window registry (Slice A). One engine, many views: every BrowserWindow is a
// view onto the subset of sessions it owns. `sessionOwner` maps a sessionId to its
// owning window id; `windows` holds the live windows. The first window created at
// launch is the `primaryWindowId` (restore + cold-launch OS-open ownership target).
const windows = new Map<number, BrowserWindow>();
const sessionOwner: OwnerMap = new Map();
// Each window's sidebar UI (Space selection, folds, pins), persisted with its layout entry; a
// window without one starts at defaults (sidebar-agent-tree spec §3).
const sidebarUiByWindow = new Map<number, SidebarUiState>();
let primaryWindowId = -1;
// Stable 1-based display ordinal per window id, assigned in creation order. Used as the
// fallback `win:list` title ("Window 2") for a window that owns no named session yet, so
// the move picker stays stable even as windows open/close (multi-window Slice B).
const windowOrdinal = new Map<number, number>();
let nextWindowOrdinal = 1;
// Most-recently-focused window id, tracked on each window's `focus` event. Used to
// route launch targets when no window currently holds OS focus.
let lastFocusedWindowId = -1;
// The window holding focus by its own focus/blur events: getFocusedWindow() is null for a hidden
// window, which still gets 'focus' (e2e drives it), and presence must report that change.
let focusedWindowId: number | null = null;
// Set true at the top of `before-quit` (Slice C). The per-window close guard reads it to
// distinguish "the app is quitting" (preserve owned sessions so they restore next launch)
// from "deliberately closing one window among several" (dispose its sessions, as Slice A).
let isQuitting = false;

// Set by the app-ready closure; debounced snapshot of the multi-window layout to windows.json
// (Slice C). Module-level so the createWindow factory can wire it to each window's resize/move
// without threading it through the factory signature.
let schedulePersistLayout: (() => void) | null = null;

// Set by the app-ready closure. The module-level createWindow factory needs the logger, but the
// Logger can only be built once restored settings exist — which happens inside that closure.
let hostLog: Logger | null = null;

// Per-window reload budget for renderer-crash recovery, keyed by the window itself so a closed
// window’s history is collected with it. See docs/specs/archive/2026-08-20-renderer-crash-recovery.md.
const crashReloads = new WeakMap<BrowserWindow, number[]>();

const windowFor = (sessionId: string): BrowserWindow | undefined =>
  windows.get(sessionOwner.get(sessionId) ?? -1);

const focusedWindow = (): BrowserWindow | undefined =>
  BrowserWindow.getFocusedWindow() ??
  windows.get(lastFocusedWindowId) ??
  windows.values().next().value;

// Set by the app-ready closure; invoked on window focus so the git indicator self-heals
// against an external `git checkout` made while the app was unfocused (Slice A refresh), and the
// active session's folders are health-checked (mf-model spec §2.6).
let onWindowFocus: (() => void) | null = null;
let onWindowPresenceChanged: (() => void) | null = null;

// Set by the app-ready closure; broadcasts the `win:list` picker payload (needs the engine
// to count owned sessions). Called on window create/close/focus + after a session move
// (multi-window Slice B).
let broadcastWinList: (() => void) | null = null;

const userData = () => app.getPath('userData');
const reposFile = () => path.join(userData(), 'repos.json');
// Per-file "I've reviewed this" marks (spec 2026-08-27-review-supercharge §2 Lane B). Lives in
// userData beside sessions.json — never in the reviewed repo, where it would read as a change.
const reviewMarksFile = () => path.join(userData(), 'review-marks.json');
const settingsFile = () => path.join(userData(), 'settings.json');
// Persisted multi-window layout (geometry + per-window owned sessions) for restore-across-
// restart (Slice C). Gated on the `restoreSessions` setting.
const windowsLayoutFile = () => path.join(userData(), 'windows.json');
// Persisted editor tabs (editor-tabs-persist), a SIBLING of sessions.json so a corrupt tab
// blob can never break session restore (spec §3.2 D3). Restore is gated on `restoreSessions`.
const docsFile = () => path.join(userData(), 'docs.json');

/** Write `data` to `filePath`, surfacing disk/permission errors that empty callbacks would swallow. */
function persistFile(filePath: string, data: string, label: string): void {
  // Atomic (temp + rename) so an interrupted write never truncates the live file — see
  // src/atomic-write.ts (update-durability fix).
  atomicWriteFile(filePath, data, (err) => {
    if (err) console.error(`[persist] failed to write ${label}:`, err);
  });
}

function git(args: string[], cwd: string): Promise<string> {
  return runGit(args, { cwd, timeoutMs: GIT_TIMEOUT.diff, maxBuffer: 8 * 1024 * 1024 }).then(
    (r) => r.stdout,
  );
}

// content-search cancellation: the async walk runs on the main process, so a newer query
// for the same root must abort the in-flight one. Each request claims a monotonic
// generation; `isCancelled` for a walk is "some later request took over this root".
let contentSearchSeq = 0;
const STR_SEARCH_REFUSED = 'Search refused: not a folder or repo of this session.';
const contentSearchGen = new Map<string, number>();

/** The watcher already debounces 300 ms; this rides on top so a burst costs one refresh. */
const FILE_INDEX_SIGNAL_MS = 250;

const repoFileIndex = createRepoFileIndex({
  listRepo: async (root) => {
    const listing = await gitListedFiles(root);
    if (listing.kind === 'listed') return listing.rels;
    return listing.kind === 'not-repo' ? 'not-repo' : null;
  },
  walkLoose: (root, prune, cap) => walkFilesAsync(root, cap, prune),
});

// Set by the app-ready closure, which owns the repo tracker; until then a non-git root has no
// registered repos and its index is the loose walk alone.
let trackedReposUnder: ((rootKey: string) => Array<{ key: string; root: string }>) | null = null;

/** Async existence + kind; null on a miss (ENOENT, EPERM — the caller only asks "is it there"). */
const statKindAsync = (absPath: string): Promise<'file' | 'dir' | null> =>
  fs.promises.stat(absPath).then(
    (st) => (st.isDirectory() ? 'dir' : 'file'),
    () => null,
  );

// Path-token and cwd-report path rules take the platform injected (src/path-token-normalize.ts).
const PATH_LINK_OPTS = {
  platform: process.platform === 'win32' ? ('win32' as const) : ('posix' as const),
  caseSensitive: process.platform === 'linux',
};

// path-links v1: cached briefly so files created after the cache was built still become
// linkable without a manual refresh.
const projectFileIndexMeta = createProjectFileIndex({
  listGit: (root) => gitListedFiles(root),
  walk: (root, cap) => walkFilesAsync(root, cap),
  repoIndex: repoFileIndex,
  reposUnder: (rootKey) => trackedReposUnder?.(rootKey) ?? [],
  onTruncated: (root) =>
    hostLog?.warn('index', 'git-listing-truncated', { root, maxBytes: LISTING_MAX_BUFFER }),
});

/** Files per `projectFiles` chunk — small enough that building one can't cost the renderer
 *  a frame, large enough that a 5000-file project is ~25 messages, not 5000. */
const INDEX_CHUNK_SIZE = 200;

/** What the source index has already streamed per root and window, so a `fsChanged` top-up
 *  sends each window only the files it lacks (spec contract 5; streams: src/index-streams.ts).
 *  A root is kept only while some window streams it. */
const projectIndexState = new Map<string, RootIndexState>();

const isLiveWindow = (windowId: number) => {
  const w = windows.get(windowId);
  return !!w && !w.isDestroyed() && !w.webContents.isDestroyed();
};

/** Window ids, not IPC events, so a closed window's sender is never kept alive or posted to. */
function sendToWindow(windowId: number, msg: HostToWebview) {
  if (isLiveWindow(windowId)) windows.get(windowId)?.webContents.send('to-webview', msg);
}

type E2eHoldPoint = 'index' | 'closure' | 'scan' | 'topup';
/** Smoke-only (installed under CONDUIT_E2E): parks an index build between reading the repo set
 *  and recording the root's state ('index'), a full build on each read of its seeds' import
 *  closure ('closure'), a repo scan before it runs ('scan'), or a renderer's top-up request
 *  before it is queued ('topup'), so a scenario can order a build against a registration or a
 *  window close by hand. 'topup' exists because reading a tree on Windows fires
 *  directory change events, and the top-up they cause re-syncs on its own and hides the race. */
let e2eHold: ((at: E2eHoldPoint) => Promise<void>) | null = null;

/** On-demand module resolutions, keyed by root so a whole project's entries can be dropped in
 *  one pass — see docs/specs/archive/2026-08-21-goto-definition-flows.md §1. A failure is cached too:
 *  a specifier that resolves nowhere would otherwise pay a full walk on every retry. */
const moduleResolveCache = new Map<string, CachedResolution>();

/** In-flight index work per root: the run to chain behind, and the slots (indexQueueSlot)
 *  already waiting behind it. */
const indexRuns = new Map<string, { tail: Promise<void>; queued: Set<string> }>();

/**
 * Run at most ONE index per root at a time, with at most one top-up per slot (indexQueueSlot)
 * queued behind it.
 *
 * Overlapping runs share `projectIndexState`: a `fsChanged` top-up that starts while the full
 * index is still streaming reads a half-filled "already sent" set and re-streams everything the
 * full run has not reached yet. That is not theoretical — it turned the cap fixture's 5000-file
 * index into 8502 files across 52 chunks. Coalescing the queued top-up also means a burst of
 * watcher events costs one extra pass, not one per event.
 */
function queueProjectIndex(
  root: string,
  seeds: string[],
  windowId: number | null,
  log: Logger,
  mode: IndexMode,
): Promise<void> {
  const run = indexRuns.get(root) ?? { tail: Promise.resolve(), queued: new Set<string>() };
  indexRuns.set(root, run);
  const slot = indexQueueSlot(projectIndexState.get(root), windowId, mode);
  if (slot !== null && run.queued.has(slot)) return run.tail;
  if (slot !== null) run.queued.add(slot);
  run.tail = run.tail.then(async () => {
    if (slot !== null) run.queued.delete(slot);
    try {
      await indexProjectSources(root, seeds, windowId, log, mode);
    } catch (e) {
      log.warn('index', 'project-index-failed', { root, mode, error: String(e) });
    }
  });
  return run.tail;
}

/** Size in bytes, or 0 for anything that can't be stat'ed (a file deleted between the listing
 *  and now) — the read that follows will fail honestly rather than being pre-judged here. */
function fileSizeBytes(absPath: string): number {
  try {
    return fs.statSync(absPath).size;
  } catch {
    return 0;
  }
}

/** Read `<root>/tsconfig.json` and its `extends` chain — now including the PACKAGE form that
 *  `@tsconfig/*` presets use, which the old relative-only walk dropped (spec row 22). Returns
 *  undefined when there's nothing readable. */
function readProjectTsconfig(root: string, log: Logger): TsconfigDTO | undefined {
  const dir = root.replace(/\\/g, '/');
  const chain = loadTsconfigChain(`${dir}/tsconfig.json`, hostFsShim);
  if (!chain) {
    log.info('index', 'tsconfig-unreadable', { root: dir });
    return undefined;
  }
  // Options resolve against the OUTERMOST config's directory: that's where a `baseUrl` in
  // an inherited config is anchored for the project actually being indexed.
  return toTsconfigDTO(chain.options, dir);
}

/**
 * Stream the project's source files to the renderer for cross-file navigation.
 *
 * Ordering is the feature: the seeds' import closure goes out in chunk 0 (with the
 * tsconfig), so the first go-to-definition of a session resolves against files that are
 * already loaded, and the rest of the tree streams behind it. The candidate set comes from
 * the gitignore-aware `git ls-files` index — NOT the bounded `walkFiles` search walk, whose
 * any-file-type cap used to truncate deep source directories out of the index entirely.
 */
async function indexProjectSources(
  root: string,
  seeds: string[],
  windowId: number | null,
  log: Logger,
  requested: IndexMode,
): Promise<void> {
  // A host-started re-sync for a root every window has since stopped indexing.
  if (windowId === null && !projectIndexState.has(root)) return;
  // A re-index means the tree was re-read; a resolution cached against the old one may name a
  // file that has since moved.
  dropResolutionsForRoot(moduleResolveCache, root);

  const meta = await projectFileIndexMeta(root, {
    fresh: !wantsFullIndex(projectIndexState.get(root), windowId, requested),
  });
  await e2eHold?.('index');

  const selected = selectIndexCandidates(
    meta.files.map((f) => ({ rel: f.rel, abs: f.abs.replace(/\\/g, '/') })),
  );
  const withinCap = selected.slice(0, INDEX_FILE_CAP);
  const capped = selected.length - withinCap.length;

  // Oversized files leave the SELECTION rather than being read and dropped later: counted in
  // `total` they would stall the progress counter short of its own target forever, and read
  // at all they cost 2 MB+ of I/O for content the worker must not have (a truncated file makes
  // it confidently deny every symbol past the cut). See spec contract 5, row 17.
  let skipped = 0;
  const hits: IndexedFile[] = [];
  for (const h of withinCap) {
    if (isOversizedForIndex(fileSizeBytes(h.abs))) skipped += 1;
    else hits.push(h);
  }
  const hitPaths = hits.map((h) => h.abs);

  // Read once, reuse for the closure walk and every window's chunks.
  const cache = new Map<string, { content: string; language: string } | null>();
  const readCached = async (abs: string) => {
    const hit = cache.get(abs);
    if (hit !== undefined) return hit;
    const dto = await readFile(abs);
    const value = dto.binary || dto.error ? null : { content: dto.content, language: dto.language };
    cache.set(abs, value);
    return value;
  };

  const closure = wantsFullIndex(projectIndexState.get(root), windowId, requested)
    ? await importClosure(
        seeds.map((s) => s.replace(/\\/g, '/')),
        new Set(hitPaths),
        async (p) => {
          await e2eHold?.('closure');
          const v = await readCached(p);
          return v?.content ?? null;
        },
      )
    : [];

  // Everything from here to the state write is synchronous, after the pass's last await: the
  // requester may have closed, or a prune dropped this root, during any read above, so neither
  // may be stored now (search-scope review r3 SF-A, r4 SF-A).
  const requester = windowId !== null && isLiveWindow(windowId) ? windowId : null;
  const prior = projectIndexState.get(root);
  if (requester === null && !prior) return;
  const state: RootIndexState = prior ?? { repoSet: meta.repoSet, streams: new Map() };
  const full = wantsFullIndex(state, requester, requested);
  // A prune during the reads can turn this pass full for a requester that held a stream; it
  // still streams everything, only without the seeds' imports first.
  const priority = full ? closure : [];
  const priorityCount = priority.length;
  const prioritySet = new Set(priority);
  const fullOrder = full ? [...priority, ...hitPaths.filter((p) => !prioritySet.has(p))] : [];

  const plans = planIndexPass(state, {
    requester,
    mode: requested,
    repoSet: meta.repoSet,
    selected: hitPaths,
    fullOrder,
  });
  projectIndexState.set(root, state);
  // A repo registered while the listing above was built found no state here to re-sync, so
  // this run catches it (search-scope review r2 SF1).
  if (
    meta.repoSet !== null &&
    meta.repoSet !== repoSetOf(trackedReposUnder?.(folderKey(root)) ?? [])
  )
    void queueProjectIndex(root, [], null, log, 'resync');
  if (!plans.length) {
    log.info('index', 'project-index-unchanged', { root });
    return;
  }

  const tsconfig = full ? readProjectTsconfig(root, log) : undefined;
  for (const plan of plans) {
    const stream = state.streams.get(plan.windowId);
    if (!stream) continue;
    const total = plan.paths.length;
    for (const chunk of takeChunks(plan, stream, INDEX_CHUNK_SIZE)) {
      const files: { path: string; content: string; language: string }[] = [];
      for (const abs of chunk.paths) {
        const dto = await readCached(abs);
        if (dto) files.push({ path: abs, content: dto.content, language: dto.language });
      }
      sendToWindow(plan.windowId, {
        type: 'projectFiles',
        root,
        files,
        seq: chunk.seq,
        total,
        done: chunk.done,
        skipped,
        capped,
        ...(plan.full ? {} : { supplemental: true as const }),
        ...(chunk.removed.length ? { removed: chunk.removed } : {}),
        ...(chunk.tsconfig && tsconfig ? { tsconfig } : {}),
      });
    }
    log.info('index', plan.full ? 'project-indexed' : 'project-index-topup', {
      root,
      windowId: plan.windowId,
      total,
      ...(plan.removed.length ? { removed: plan.removed.length } : {}),
      ...(plan.full ? { priority: priorityCount } : {}),
      skipped,
      capped,
    });
  }
}

// terminal-commit-link: a commit oid is immutable, so collapse repeat validations across
// re-paints with a short TTL cache keyed by `${root}\0${token}` (mirrors FILE_INDEX_TTL_MS).
const COMMIT_VALIDATE_TTL_MS = 5000;
const commitValidateCache = new ExpiringCache<string, { commit: string | null; at: number }>({
  ttlMs: COMMIT_VALIDATE_TTL_MS,
  maxEntries: 2048,
});

/** Run `git cat-file --batch-check`, feeding the (already shape-validated) tokens on stdin. */
function gitBatchCheck(tokens: string[], root: string): Promise<string> {
  return runGit(['cat-file', '--batch-check'], {
    cwd: root,
    timeoutMs: GIT_TIMEOUT.metadata,
    maxBuffer: 4 * 1024 * 1024,
    stdin: `${tokens.join('\n')}\n`,
  }).then((r) => r.stdout);
}

/**
 * Validate terminal commit-hash candidates against `root`: each that names a real commit object
 * resolves to its full 40-char sha, else null. The renderer string is re-asserted as `[0-9a-f]
 * {7,40}` before reaching git (never trusted into execFile — mirrors `git:switch`). Batched into
 * one `cat-file` process for the uncached tokens (spec §3.2).
 */
async function validateCommits(root: string, tokens: string[]): Promise<CommitValidation[]> {
  const now = Date.now();
  const resolved = new Map<string, string | null>();
  const need: string[] = [];
  for (const t of tokens) {
    if (!isCommitHex(t)) {
      resolved.set(t, null);
      continue;
    }
    const hit = commitValidateCache.get(`${root}\0${t}`);
    if (hit && now - hit.at < COMMIT_VALIDATE_TTL_MS) resolved.set(t, hit.commit);
    else if (!need.includes(t)) need.push(t);
  }
  if (need.length > 0) {
    const parsed = parseBatchCheck(await gitBatchCheck(need, root), need);
    for (const r of parsed) {
      resolved.set(r.token, r.commit);
      commitValidateCache.set(`${root}\0${r.token}`, { commit: r.commit, at: now });
    }
  }
  return tokens.map((token) => ({ token, commit: resolved.get(token) ?? null }));
}

/** True iff the EXACT fully-qualified ref exists. `show-ref --verify` matches a single ref by its
 *  full path (no globbing, no rev-walk), so it is O(1) and complete — independent of any display
 *  cap. `--quiet` suppresses output; the exit code is the answer. `fqRef` is already a safe
 *  `refs/...` string (built by {@link fullyQualifiedRef}); the leading `--` guard keeps an
 *  option-like value from being misread even so. */
function refExists(cwd: string, fqRef: string): Promise<boolean> {
  return runGit(['show-ref', '--verify', '--quiet', '--', fqRef], {
    cwd,
    timeoutMs: GIT_TIMEOUT.metadata,
  }).then((r) => r.ok);
}

/**
 * Validate both endpoints of a Review comparison against the host's OWN repo — the SPECIFIC
 * picked ref by exact existence (branch/remote/tag via {@link fullyQualifiedRef} + `show-ref`),
 * a commit via cat-file (validateCommits). Keyed on the ref NAMESPACE, not on a display-capped
 * list, so a tag outside the newest-N window still resolves and a mislabeled endpoint maps to a
 * path that simply won't exist (spec 2026-06-30 §3 design-review correction). Returns a short
 * error reason for the first invalid endpoint, or null when both are usable. The renderer's ref
 * strings are never trusted into git unchecked.
 */
async function firstInvalidEndpoint(cwd: string, endpoints: RefEndpoint[]): Promise<string | null> {
  for (const ep of endpoints) {
    if (ep.kind === 'branch' || ep.kind === 'tag') {
      const fq = fullyQualifiedRef(ep);
      if (!fq || !(await refExists(cwd, fq))) return 'Unknown ref';
    } else if (ep.kind === 'commit') {
      const [v] = await validateCommits(cwd, [ep.sha]);
      if (!v || v.commit === null) return 'Unknown commit';
    }
  }
  return null;
}

/** Memo + last-known-good store backing the two fixes above (src/ignore-cache.ts). */
const ignoreCache = new IgnoreCache();

/**
 * The ignored subset of `names`, preferring a fresh memo hit (no git process at all) and
 * falling back to this directory's last known set when git fails to answer.
 */
async function ignoredEntriesCached(dir: string, names: string[]): Promise<Set<string>> {
  if (names.length === 0) return new Set();
  const now = Date.now();
  const memo = ignoreCache.getFresh(dir, names, now);
  if (memo) return memo;
  const fresh = await gitIgnoredNames(dir, names);
  if (fresh === null) return ignoreCache.getLast(dir) ?? new Set();
  ignoreCache.set(dir, names, fresh, Date.now());
  return fresh;
}

/** Text blobs keep readDiff's original ceiling; only the image side, which reads raw bytes,
 *  needs the larger one. One show path, two caps — never one loosened cap for both. */
const TEXT_BLOB_MAX_BUFFER = 8 * 1024 * 1024;
const IMAGE_BLOB_MAX_BUFFER = 32 * 1024 * 1024;

/**
 * A directory's repo top level, and a root's HEAD sha. Memoised because one `fsChanged` wakes
 * EVERY open editor at once: without this, N editors meant N `rev-parse --show-toplevel` plus
 * N `rev-parse HEAD` before the first blob was read. See spec 2026-08-27-review-supercharge
 * §2 Lane A ("N shows, not 2N spawns"). The toplevel of a directory is effectively immutable
 * for a session; HEAD is not, hence the much shorter TTL — long enough to collapse one burst.
 */
const repoRootMemo = createAsyncMemo<string>({ ttlMs: 30_000, max: 200 });
const headShaMemo = createAsyncMemo<string | null>({ ttlMs: 1_000, max: 50 });

function repoTopLevel(dir: string): Promise<string> {
  return repoRootMemo.get(dir, async () => {
    const r = await runGit(['rev-parse', '--show-toplevel'], {
      cwd: dir,
      timeoutMs: GIT_TIMEOUT.metadata,
    });
    return r.ok ? r.stdout.trim() : '';
  });
}

/** Cache KEY only: with a 1 s TTL this can lag the blob's real HEAD by a commit, which costs
 *  one stale cache hit that the next fsChanged corrects — never a wrong baseline, because the
 *  blob itself is always read fresh. */
function headShaFor(root: string): Promise<string | null> {
  return headShaMemo.get(root, async () => {
    const r = await runGit(['rev-parse', 'HEAD'], { cwd: root, timeoutMs: GIT_TIMEOUT.metadata });
    return r.ok ? r.stdout.trim() || null : null;
  });
}

/**
 * THE `git show` blob path for this process — readDiff's text and image sides (at either
 * baseline) and the editor's change decorations all come through here, so there is one cap,
 * one timeout and one set of outcome flags rather than a second implementation per caller.
 */
async function gitShowBlob(
  root: string,
  rel: string,
  ref: DiffBase,
  maxBuffer = TEXT_BLOB_MAX_BUFFER,
): Promise<HeadBlobShow> {
  const res = await runGit(['show', ref === 'index' ? `:${rel}` : `HEAD:${rel}`], {
    cwd: root,
    timeoutMs: GIT_TIMEOUT.diff,
    maxBuffer,
  });
  return {
    ok: res.ok,
    bytes: res.stdoutBuffer,
    code: res.code,
    failed: res.notFound || res.timedOut || res.aborted || res.truncated,
  };
}

/**
 * Is this path unmerged (a conflict, so no stage-0 blob)? Spawned ONLY after an index read
 * already failed: a failed `git show :<rel>` is equally a staged deletion or an untracked
 * file, and only those cases pay for the extra call.
 */
async function indexUnmerged(root: string, rel: string): Promise<boolean> {
  const res = await runGit(['--literal-pathspecs', 'ls-files', '--unmerged', '--', rel], {
    cwd: root,
    timeoutMs: GIT_TIMEOUT.metadata,
  });
  return res.ok && res.stdout.trim() !== '';
}

async function gitShow(absPath: string, ref: DiffBase = 'head'): Promise<string | Unmerged> {
  const root = await repoTopLevel(path.dirname(absPath));
  const rel = root ? repoRelPath(root, absPath) : null;
  if (!rel) return '';
  const res = await gitShowBlob(root, rel, ref);
  if (res.ok) return res.bytes.toString('utf8');
  return ref === 'index' && (await indexUnmerged(root, rel)) ? UNMERGED : '';
}

/**
 * Binary-safe blob read. Resolves `null` when the ref has no blob for the path (new/untracked
 * file) or the read fails — the caller treats that as "added".
 */
async function gitShowBuffer(
  absPath: string,
  ref: DiffBase = 'head',
): Promise<Buffer | null | Unmerged> {
  const root = await repoTopLevel(path.dirname(absPath));
  const rel = root ? repoRelPath(root, absPath) : null;
  if (!rel) return null;
  const res = await gitShowBlob(root, rel, ref, IMAGE_BLOB_MAX_BUFFER);
  if (res.ok) {
    return resolveLfsImage(res.bytes, {
      gitBin: 'git',
      cwd: root,
      timeoutMs: GIT_TIMEOUT.metadata,
      maxBytes: IMAGE_BLOB_MAX_BUFFER,
    });
  }
  return ref === 'index' && (await indexUnmerged(root, rel)) ? UNMERGED : null;
}

// Three explicit routes replace the old single-window `send` (multi-window Slice A):
//  - broadcast: path-tagged artifact/watcher pushes the renderer keys by path and
//    ignores when not current (board/project/architecture/proposal/spec/file+fs
//    changes/updater/watcher errors).
//  - reply(e, msg): direct request→response inside `handle`, back to the requester.
//  - sendToOwner: session-scoped streams (term:data/exit, restored replay, activate).
function broadcast(msg: HostToWebview) {
  for (const w of windows.values()) w.webContents.send('to-webview', msg);
}

type OpenFileInEditor = Extract<HostToWebview, { type: 'openFileInEditor' }>;

function reply(e: IpcMainEvent, msg: HostToWebview) {
  // An async handler (.then/.catch) may resolve after the sender's window closed; sending
  // to a destroyed webContents throws. Guard it (multi-window Slice A).
  if (!e.sender.isDestroyed()) e.sender.send('to-webview', msg);
}

function sendToOwner(sessionId: string, msg: HostToWebview) {
  windowFor(sessionId)?.webContents.send('to-webview', msg);
}

// Schemes we are willing to hand to the OS. Never pass file:/data:/javascript:
// (or arbitrary strings) to shell.openExternal — that is a local-exec hazard.
const EXTERNAL_SCHEMES = new Set(['http:', 'https:', 'mailto:', 'tel:', 'sms:', 'facetime:']);

/** Open a URL in the user's real browser / OS handler, after validating its scheme. */
function openExternalUrl(url: string): void {
  try {
    const scheme = new URL(url).protocol.toLowerCase();
    if (EXTERNAL_SCHEMES.has(scheme)) void shell.openExternal(url);
  } catch {
    // Malformed URL — ignore (never navigate, never exec).
  }
}

/**
 * Build, register, and wire one Conduit window (multi-window Slice A). The engine
 * (sessions/pty/etc.) stays process-global; this only creates a VIEW. `onClose` is the
 * engine-scoped quit-guard the whenReady closure supplies (it needs the session model);
 * `onClosed` lets the closure drop per-window confirm flags. Returns the new window.
 */
// Taskbar/alt-tab icon: the dev-badged variant for dev builds, the normal icon when packaged.
// .ico on Windows (multi-res, for taskbar/alt-tab crispness), .png elsewhere.
function appIconPath(): string {
  const ext = process.platform === 'win32' ? 'ico' : 'png';
  const name = app.isPackaged ? 'icon' : 'icon-dev';
  return path.join(__dirname, '..', 'assets', `${name}.${ext}`);
}

function createWindow(opts: {
  primary?: boolean;
  onClose: (w: BrowserWindow, ev: Electron.Event) => void;
  onClosed: (windowId: number) => void;
  /** Main-frame, cross-document navigation began: the renderer is about to be replaced. */
  onNavigationStart: (windowId: number) => void;
  onGone: (windowId: number) => void;
  onUnresponsive: (windowId: number) => void;
  onSessionEnd: () => void;
}): BrowserWindow {
  const w = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 900,
    minHeight: 560,
    // Chromium paints this before the renderer's first frame, so a fixed dark value flashed
    // dark at every Aero user on launch. Read from disk rather than the closure's live
    // `settings`: this runs at window-create time, and restoreSettings() already tolerates a
    // missing or corrupt file.
    backgroundColor: groundForTheme(restoreSettings(readBlob(settingsFile())).theme),
    title: app.isPackaged ? 'Conduit' : 'Conduit (dev)',
    // The smoke suite (CONDUIT_E2E=1) launches windows hidden so runs don't pop
    // up windows or steal focus. Playwright drives the renderer over CDP either way;
    // backgroundThrottling:false below keeps a hidden window rendering normally.
    show: process.env.CONDUIT_E2E !== '1',
    // App icon: .ico on Windows for taskbar/alt-tab, .png otherwise; dev-badged in dev.
    icon: appIconPath(),
    // Hide the native title bar (keep the frame so resizing stays native); the
    // renderer draws its own draggable top bar. On Windows it also draws min/max/close
    // (.winctl); on macOS the native traffic lights stay (titleBarStyle:'hidden' keeps
    // them) and the renderer omits .winctl.
    titleBarStyle: 'hidden',
    // macOS only: nudge the native traffic lights to sit vertically centered in the
    // default top bar. Offset is from the window's true top-left corner, so it
    // includes --win-pad (12px) + the topbar's 1px border on top of half the 57px
    // bar height (--density-topbar-h at default density) — tuned visually against
    // real hardware, not computed from that alone. Compact density (~47px bar),
    // fullscreen (lights hidden), and the neon theme (--win-pad: 0, bar sits 12px
    // higher) are all knowingly imperfect here — see
    // docs/specs/archive/2026-08-08-mac-topbar-layout.md Edge cases. No-op off-darwin.
    ...(process.platform === 'darwin' ? { trafficLightPosition: { x: 28, y: 33 } } : {}),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      // Enables the in-app web view (<webview> tag). Each guest is locked down at
      // attach time by 'will-attach-webview' below (no preload, no node, sandboxed,
      // http(s)-only) so this doesn't widen the app's own trust boundary.
      webviewTag: true,
      // Don't throttle the renderer's compositor/timers while the window is
      // minimized or hidden. Otherwise the animated background's paint state goes
      // stale and Chromium shows a brief flash when the window is restored after a
      // long minimize (wishlist focus-restore-flash). Keeping it warm trades a little
      // background GPU for a clean restore.
      backgroundThrottling: false,
    },
  });

  windows.set(w.id, w);
  windowOrdinal.set(w.id, nextWindowOrdinal++);
  if (opts.primary) primaryWindowId = w.id;
  lastFocusedWindowId = w.id;

  const emitMax = () => w.webContents.send('win:maximized', w.isMaximized());
  w.on('maximize', emitMax);
  w.on('unmaximize', emitMax);
  // Re-snapshot the layout (debounced) when geometry changes, so a resized/moved window's
  // bounds survive a restart even without a session change (Slice C).
  w.on('resize', () => schedulePersistLayout?.());
  w.on('move', () => schedulePersistLayout?.());
  // Stop taskbar flash when the window regains focus (T1A). Track most-recently-focused
  // for launch-target routing when no window currently holds OS focus.
  w.on('blur', () => {
    if (focusedWindowId === w.id) focusedWindowId = null;
    onWindowPresenceChanged?.();
  });
  w.on('focus', () => {
    focusedWindowId = w.id;
    lastFocusedWindowId = w.id;
    w.flashFrame(false);
    onWindowFocus?.();
    // The focused window changes the picker's "current" framing; cheap to re-broadcast.
    broadcastWinList?.();
  });

  // Windows surfaces the mouse thumb buttons as the per-window `app-command` event, not as
  // DOM button 3/4. Forward them to THIS window's renderer (app-command is per-window, so
  // never broadcast) to drive the existing Back/Forward. preventDefault stops Chromium's
  // own (no-op here) history nav. See docs/specs/archive/2026-06-30-mouse-nav-buttons.md §3.2.
  w.on('app-command', (e, command) => {
    if (command !== 'browser-backward' && command !== 'browser-forward') return;
    e.preventDefault();
    w.webContents.send('to-webview', {
      type: 'appCommand',
      command: command === 'browser-backward' ? 'back' : 'forward',
    } satisfies HostToWebview);
  });

  // Links must never navigate the app window away (that strands the user in a
  // chrome-less full-screen page with no back button — wishlist E4). Route
  // external URLs to the real browser; deny any in-window/new-window navigation.
  w.webContents.setWindowOpenHandler(({ url }) => {
    openExternalUrl(url);
    return { action: 'deny' };
  });
  const indexHtml = path.join(__dirname, 'index.html');
  const indexUrl = pathToFileURL(indexHtml).href;
  w.webContents.on('will-navigate', (event, url) => {
    if (isAppIndexUrl(url, indexUrl)) return;
    event.preventDefault();
    if (url.startsWith('file:')) hostLog?.warn('nav', 'blocked file navigation', { url });
    else openExternalUrl(url);
  });

  // In-app web view (<webview>) guests are untrusted remote pages. Lock each one down
  // at attach time: strip any preload, force no-node + contextIsolation + sandbox, and
  // refuse to attach a non-http(s) src (file:/data:/etc). See src/webview-guard.ts.
  w.webContents.on('will-attach-webview', (event, webPreferences, params) => {
    const { allow } = hardenWebviewPrefs(
      webPreferences as unknown as Record<string, unknown>,
      params.src,
    );
    if (!allow) event.preventDefault();
  });

  // A dead renderer leaves a permanently black window while the main process — sessions and
  // their PTY children — is untouched, so quitting to escape it would kill live shells. Reload
  // in place instead: the renderer boots like a fresh start and term:start takes the attach path.
  // See docs/specs/archive/2026-08-20-renderer-crash-recovery.md.
  w.webContents.on('render-process-gone', (_ev, details) => {
    opts.onGone(w.id);
    const decision = decideCrashRecovery(details.reason, crashReloads.get(w) ?? [], Date.now());
    crashReloads.set(w, decision.reloads);
    hostLog?.error('window', `render process gone (${details.reason})`, {
      windowId: w.id,
      reason: details.reason,
      exitCode: details.exitCode,
      action: decision.action,
      reloadsInWindow: decision.reloads.length,
    });
    if (decision.action !== 'reload') return;
    if (w.isDestroyed() || w.webContents.isDestroyed()) return;
    w.webContents.reload();
  });

  // Not did-start-loading: that also fires for subframe loads. A same-document navigation keeps
  // the renderer and its asks (plan 2026-10-30-conduit-mcp-tool-policy, spec staleness r1 #8).
  w.webContents.on('did-start-navigation', (e) => {
    if (e.isMainFrame && !e.isSameDocument) opts.onNavigationStart(w.id);
  });

  w.on('close', (ev) => opts.onClose(w, ev));
  w.on('unresponsive', () => opts.onUnresponsive(w.id));
  // OS shutdown/logoff is not guarded (dirty-quit-guard D8), but the state snapshot still lands.
  w.on('session-end', () => opts.onSessionEnd());
  w.on('closed', () => {
    if (focusedWindowId === w.id) focusedWindowId = null;
    windows.delete(w.id);
    windowOrdinal.delete(w.id);
    opts.onClosed(w.id);
  });

  void w.loadFile(indexHtml);
  return w;
}

app.whenReady().then(() => {
  // Single-instance: a second launch (e.g. the "Open in Conduit" context menu while the
  // app is already running) must route its folder into THIS instance, not open a duplicate.
  // The loser instance quits immediately; the primary handles `second-instance` below.
  if (!app.requestSingleInstanceLock()) {
    app.quit();
    return;
  }

  // Cold launch ("app was closed → Open with Conduit") parses the open target right after
  // createWindow(), long before the renderer has loaded and subscribed to 'to-webview'.
  // webContents.send before the page attaches its listener is dropped (no host-side buffering),
  // so a one-shot openFileInEditor would silently vanish. We hold such opens until the renderer
  // signals readiness (its first 'ready' → postState) and flush them then. A warm
  // second-instance (renderer already ready) sends immediately.
  let rendererReady = false;
  const pendingOsOpens: OpenFileInEditor[] = [];
  const sendOpenFileInEditor = (msg: OpenFileInEditor) => {
    if (rendererReady) sendToOwner(msg.sessionId, msg);
    else pendingOsOpens.push(msg);
  };
  const flushPendingOsOpens = () => {
    rendererReady = true;
    for (const msg of pendingOsOpens.splice(0)) sendToOwner(msg.sessionId, msg);
  };

  if (process.env.CONDUIT_E2E === '1') {
    const holding = new Set<E2eHoldPoint>();
    const parked: Record<E2eHoldPoint, Array<() => void>> = {
      index: [],
      closure: [],
      scan: [],
      topup: [],
    };
    e2eHold = (at) =>
      holding.has(at)
        ? new Promise<void>((resolve) => parked[at].push(resolve))
        : Promise.resolve();
    (global as Record<string, unknown>).__conduitHold = {
      hold: (at: E2eHoldPoint) => {
        holding.add(at);
      },
      heldCount: (at: E2eHoldPoint) => parked[at].length,
      release: (at: E2eHoldPoint) => {
        holding.delete(at);
        for (const resolve of parked[at].splice(0)) resolve();
      },
      /** The TS index's per-root state, so a scenario can see a leak no window would show. */
      indexState: () =>
        [...projectIndexState].map(([root, s]) => ({ root, windows: [...s.streams.keys()] })),
    };
  }

  // Smoke-only seam: the renderer is always loaded by the time a scenario runs, so the harness
  // can't reproduce true cold-launch timing on its own. Expose the readiness gate + queue depth
  // so a scenario can flip readiness off, fire a `second-instance` open, assert it was buffered
  // (not dropped), then flush and assert the doc opens. Gated on CONDUIT_E2E so it never exists
  // in a shipped build.
  if (process.env.CONDUIT_E2E === '1') {
    (global as Record<string, unknown>).__osOpenColdHook = {
      setRendererReady: (v: boolean) => {
        rendererReady = v;
      },
      pendingCount: () => pendingOsOpens.length,
      flush: () => flushPendingOsOpens(),
    };
  }
  const folderPicker = createFolderPicker({
    showOpenDialog: (w, o) => (w ? dialog.showOpenDialog(w, o) : dialog.showOpenDialog(o)),
    e2e: process.env.CONDUIT_E2E === '1',
    installHook: (h) => {
      (global as Record<string, unknown>).__pickDirHook = h;
    },
  });

  const hostPlatform: HostPlatform =
    process.platform === 'win32' ? 'win32' : process.platform === 'darwin' ? 'darwin' : 'linux';

  const outgoingPathDeps = nodeOutgoingPathDeps(process.platform);
  const dragOutHost = createDragOutHost({
    platform: hostPlatform,
    e2e: process.env.CONDUIT_E2E === '1',
    systemRoot: process.env.SystemRoot,
    appWindowIdFor: (cid) => [...windows.values()].find((w) => w.webContents.id === cid)?.id,
    sessionFolders: (sid, wid) => {
      const s = store.get(sid);
      return s && sessionOwner.get(sid) === wid ? outgoingFoldersFor(s) : undefined;
    },
    validate: (p, f) => validateOutgoingPaths(p, f, outgoingPathDeps),
    clipboard: createOsFileClipboard({
      runPowerShell: spawnPowerShell,
      writeBuffer: (f, d) => clipboard.writeBuffer(f, d),
    }),
    installProbes: (p) => {
      (global as Record<string, unknown>).__conduitClipboardLog = p.clipboard;
      (global as Record<string, unknown>).__conduitDownloadLog = p.download;
    },
    log: (lvl, msg, d) => log[lvl]('fs', msg, d),
    windowFolders: (wid) => {
      const each = sessionsOwnedBy(sessionOwner, wid, store.list()).map(outgoingFoldersFor);
      return {
        present: each.flatMap((f) => f.present),
        missing: each.flatMap((f) => f.missing),
      };
    },
    isDirectory: (p) => {
      try {
        return fs.statSync(p).isDirectory();
      } catch {
        return false;
      }
    },
    realpath: realPathLeaf,
    now: Date.now,
  });
  // The app windows' session: web tabs and previews download through their own partitions.
  session.defaultSession.on('will-download', (ev, item, wc) => {
    if (!dragOutHost.allowDownload(item.getURL(), wc.id)) ev.preventDefault();
  });
  // Smoke-only: Playwright cannot perform the OS drop that makes Chromium ask for the bytes, so
  // a scenario spends the grant through the same decision will-download uses.
  if (process.env.CONDUIT_E2E === '1') {
    (global as Record<string, unknown>).__conduitAllowDownload = (url: string, cid: number) =>
      dragOutHost.allowDownload(url, cid);
  }

  // The server's sessions with the app's repo overlay (D39): every session read in the app.
  const store = new AppSessionStore();
  // Server-owned lists, from the snapshot and `data.changed`.
  let stores: DataStores = { agents: [], launchers: [], projects: [] };
  const pathLinks = createPathLinkResolver({
    getSession: (id) => store.get(id),
    // sessionGitRoot's semantics through the memoised toplevel: a git spawn per resolve was the
    // largest share of a warm resolve (plan 2026-10-16-terminal-path-links Slice 6 profile).
    gitRoot: async (s) => {
      const cwd = activeCwd(s).replace(/\\/g, '/');
      return (await repoTopLevel(cwd)) || cwd;
    },
    fileIndex: async (root) => {
      const meta = await projectFileIndexMeta(root);
      return { files: meta.files, coveredRoots: meta.covered };
    },
    stat: statKindAsync,
    topLevel: repoTopLevel,
    homeDir: os.homedir().replace(/\\/g, '/'),
    // `log` is created further down this function; resolves only run after it exists.
    realPathLeaf: hostRealPathLeaf(PATH_LINK_OPTS.platform),
    log: {
      warn: (scope, msg, data) => log.warn(scope, msg, data),
      debug: (scope, msg, data) => log.debug(scope, msg, data),
    },
    ...PATH_LINK_OPTS,
  });

  // ── Git: the host-wide repo tracker ───────────────────────────────────────
  // One refresh per dirty repo, fanned out to every session containing it; GitInfo rides the
  // `state` broadcast via Session.repoGit. See docs/plans/2026-10-16-multi-repo-tracking.plan.md.
  const gitDemand = createSessionResourceDemand(
    (ids) => {
      for (const id of ids) if (deferredRepoScans.has(id)) scheduleRepoScan(id);
      for (const w of windows.values()) {
        const shown = ids
          .filter((id) => gitDemand.isVisibleInWindow(w.id, id))
          .flatMap((id) => {
            const s = store.get(id);
            return s ? [s.home, ...presentRoots(s)] : [];
          });
        const stale = shown.filter((root) => pendingFsByWindow.get(w.id)?.has(root));
        for (const root of stale) pendingFsByWindow.get(w.id)?.delete(root);
        if (stale.length)
          w.webContents.send('to-webview', {
            type: 'fsChanged',
            root: stale[0],
            folders: [...new Set(stale)],
          });
      }
      for (const [windowId, request] of deferredProjectRequests) {
        if (!request.sessionId || !ids.includes(request.sessionId)) continue;
        deferredProjectRequests.delete(windowId);
        request.run();
      }
      for (const [key, request] of deferredIndexes) {
        if (
          !ids.some((id) => {
            const s = store.get(id);
            return s && sessionContains(s, request.root);
          })
        )
          continue;
        deferredIndexes.delete(key);
        request.run();
      }
      repoTrackerHost.tracker.visibilityChanged();
    },
    (ids) => {
      for (const id of ids) {
        repoScanner.forget(id);
        deferredRepoScans.add(id);
      }
    },
  );
  const deferredRepoScans = new Set<string>();
  const pendingFsByWindow = new Map<number, Set<string>>();
  const deferredProjectRequests = new Map<number, { sessionId: string; run: () => void }>();
  const deferredIndexes = new Map<string, { root: string; windowId: number; run: () => void }>();

  const repoTrackerHost = createRepoTrackerHost({
    mgr: store,
    demand: gitDemand,
    owns: (windowId, sessionId) => sessionOwner.get(sessionId) === windowId,
    windows: () =>
      [...windows.values()].map((w) => ({
        id: w.id,
        send: (msg: HostToWebview) => w.webContents.send('to-webview', msg),
      })),
    // `log` is created further down this function; the tracker only logs from later runs.
    log: {
      debug: (scope, msg, data) => log.debug(scope, msg, data),
      warn: (scope, msg, data) => log.warn(scope, msg, data),
    },
  });

  // Quick-open's corpus refresh (fileIndexChanged), trailing: a build or a checkout dirties a
  // repo many times a second, and every window re-requests on each signal.
  let fileIndexSignal: ReturnType<typeof setTimeout> | null = null;
  const signalFileIndexChanged = () => {
    if (fileIndexSignal) return;
    fileIndexSignal = setTimeout(() => {
      fileIndexSignal = null;
      for (const w of windows.values())
        w.webContents.send('to-webview', { type: 'fileIndexChanged' } satisfies HostToWebview);
    }, FILE_INDEX_SIGNAL_MS);
  };
  repoTrackerHost.tracker.onDirty((key) => {
    if (key === null) repoFileIndex.invalidateLoose();
    else repoFileIndex.invalidateRepo(key);
    signalFileIndexChanged();
  });
  trackedReposUnder = (rootKey) => repoTrackerHost.tracker.reposUnder(rootKey);

  const pruneFileIndexes = () => {
    const sessions = store.list();
    repoFileIndex.retain(
      new Set(sessions.flatMap((s) => [s.home, ...s.roots]).map(folderKey)),
      new Set(sessions.flatMap((s) => s.repos ?? []).map((r) => folderKey(r.root))),
    );
    for (const root of projectIndexState.keys())
      if (!sessions.some((s) => sessionContains(s, root))) projectIndexState.delete(root);
  };
  /** A session gained or lost repos, or went away. `log` is read only when this runs, after the
   *  closure has created it. */
  const afterReposChanged = () => {
    folders.reposChanged();
    pruneFileIndexes();
    const currentRepoSet = (root: string) =>
      repoSetOf(repoTrackerHost.tracker.reposUnder(folderKey(root)));
    for (const root of staleIndexRoots(projectIndexState, currentRepoSet))
      void queueProjectIndex(root, [], null, log, 'resync');
    signalFileIndexChanged();
  };

  // Multi-repo: debounced sub-repo scan per session (re-detect on open + project changes).
  const detectShared = asyncSingleFlight(detectRepos, folderKey);
  const enclosingShared = asyncSingleFlight(repoTopLevel, folderKey);
  const repoScanner = createRepoScanScheduler({
    scan: async (sessionId) => {
      await e2eHold?.('scan');
      const s = store.get(sessionId);
      return s ? scanSessionRepos(s, { detect: detectShared, enclosing: enclosingShared }) : [];
    },
    apply: (sessionId, repos) => {
      if (!store.setRepos(sessionId, repos)) return;
      repoTrackerHost.tracker.setSessionRepos(sessionId, repos);
      afterReposChanged();
    },
    onError: (sessionId, e) => log.error('repo', `scan failed for ${sessionId}: ${String(e)}`),
  });
  const scheduleRepoScan = (sessionId: string, force = false) => {
    if (!force && store.get(sessionId)?.repos !== undefined && !gitDemand.isVisible(sessionId)) {
      deferredRepoScans.add(sessionId);
      return;
    }
    deferredRepoScans.delete(sessionId);
    repoScanner.schedule(sessionId);
  };

  // A renderer-chosen root runs git only when it is a detected repo or the terminal's own git
  // root (docs/specs/archive/2026-09-23-mf-changes.md §3 D22; docs/specs/archive/2026-09-23-mf-review.md D11).
  const requestRepoRoot = (session: Session, root: unknown): Promise<string | null> =>
    resolveRequestRepoRoot(session, root, () =>
      sessionGitRoot(session, git).catch((err) => {
        log.error('git', `request root check failed: ${String(err)}`);
        return '';
      }),
    );

  // Sessions mid-move between windows (multi-window Slice B). When ownership is reassigned,
  // the SOURCE window's TerminalPane unmounts and fires `term:dispose` — which would KILL the
  // live PTY we are trying to hand to the target window. A session in this set has its next
  // `term:dispose` swallowed (the flag is one-shot, cleared on consume) so the PTY survives the
  // hand-off. The target's fresh pane keeps the SAME sessionId, so no remount kills it.
  const movingSessions = new Set<string>();

  // User settings (theme/fonts/layout/behaviour), persisted to settings.json.
  const settingsFileExistedAtLoad = fs.existsSync(settingsFile());
  let settings: AppSettings = restoreSettings(readBlob(settingsFile()));
  const releaseNotesOffers = new Map<number, string>();

  // Diagnostics logger (Slice A): the host's sole disk writer. Constructed here — before
  // window creation — so startup seams are captured. Level comes from settings and is
  // updated live on a settings change. `off` (via logLevel) or logging=false silences it.
  const log = new Logger(settings.logging ? settings.logLevel : 'off');
  hostLog = log;
  log.info('app', 'ready', { version: aboutInfo.version, e2e: process.env.CONDUIT_E2E === '1' });
  // The only record of a GPU-process restart, which blanks WebGL terminals (webview/terminal-gpu.ts)
  // and is the leading suspect for the unexplained green flash.
  app.on('child-process-gone', (_e, details) => {
    log.warn('process', 'child process gone', {
      type: details.type,
      reason: details.reason,
      exitCode: details.exitCode,
      name: details.name,
      serviceName: details.serviceName,
    });
  });

  // The latest renderer-wide server state, so a window that loads after the snapshot still gets it.
  let lastTimers: Extract<HostToWebview, { type: 'timer:state' }> | null = null;
  let lastMcp: Extract<HostToWebview, { type: 'mcp:state' }> | null = null;
  let serverUiState: ServerUiState = { state: 'connecting' };

  // Fail-closed per-window readiness and visible set for the MCP policy gate; separate from
  // activity/gitDemand, which fail open (spec 2026-10-30-conduit-mcp-tool-policy §2.3).
  const presence = createWindowPresence();

  // The overlay's own mutators (repo scans, pins, cwd follow) re-post; server lists post themselves.
  store.onChange(() => postState());

  // Latest editor-tab payload the renderer sent (editor-tabs-persist). Seeded from disk so the
  // before-quit sync flush re-writes the last good blob even if no `persistDocs` arrived this
  // run; replaced on every `persistDocs`. Written like sessions.json (always persisted; only the
  // RESTORE send is gated on restoreSessions). See spec §3.2 + [[conduit-update-durability]].
  // KNOWN LIMITATION (MVP): one global payload + one docs.json. Each window's renderer sends only
  // its own session docs, so with MULTIPLE windows the last `persistDocs` wins and only one
  // window's tabs restore. Not a data-safety issue — sessions.json is untouched and restore drops
  // docs whose session this window doesn't own. Per-window keying is a deliberate follow-up.
  let lastDocs: PersistedDoc[] = parseDocs(readBlob(docsFile()));

  // Recently-opened repositories (with the terminal last used in each).
  let repos = restoreRepos(readBlob(reposFile()));

  // Held in memory and pushed to windows directly: two windows share one main process, so a
  // change never needs an FS round trip to reach the other one (spec §2 Lane B).
  let reviewMarks = parseMarksFile(readBlob(reviewMarksFile()));
  // Only flush what this run actually changed. readBlob swallows EVERY read error, not just a
  // missing file, so a lock / AV / EACCES at launch yields an EMPTY in-memory set — and an
  // unconditional quit flush would then overwrite an intact file with nothing. Same failure class
  // as the 0.11.1 durability incident; sessions.json carries the same shape of gate.
  let reviewMarksDirty = false;

  /** Every repo in the file — the snapshot a freshly loaded window needs to open its load gate. */
  const allMarkRepos = () =>
    Object.keys(reviewMarks.repos).map((root) => ({ root, marks: marksFor(reviewMarks, root) }));

  // A recent-folder entry whose directory was deleted/renamed shouldn't show in the list
  // (clicking it would just fail). Checked at display time only — repos.json is left intact,
  // so a remounted drive or recreated folder reappears on its own. A statSync throw
  // (permission/IO/missing) counts as "not a directory" → hidden, never crashes the broadcast.
  const isExistingDir = (p: string): boolean => {
    try {
      return fs.statSync(p).isDirectory();
    } catch {
      return false;
    }
  };

  // History (most recent first), missing folders hidden, plus a Home entry if absent.
  const reposForState = (): RepoDTO[] => {
    const home = os.homedir();
    const existing = filterExistingRepos(repos, isExistingDir);
    const sorted = [...existing].sort((a, b) => b.lastOpened - a.lastOpened);
    if (!sorted.some((r) => r.path === home)) {
      sorted.push({ path: home, name: 'Home', lastOpened: 0 });
    }
    return sorted;
  };

  // Per-window state (multi-window Slice A): each window receives only the sessions it owns;
  // shared fields (agents/repos/settings/about) are identical per window. Status, busy and
  // needs-attention come in-band from the server (sessions.changed).
  let sessionsLoaded = false;
  const postState = () => {
    const all = store.list();
    const repos = reposForState();
    for (const [windowId, w] of windows) {
      w.webContents.send('to-webview', {
        type: 'state',
        agents: stores.agents,
        sessions: sessionsOwnedBy(sessionOwner, windowId, all),
        sessionsLoaded,
        projects: stores.projects,
        repos,
        launchers: stores.launchers,
        settings,
        about: aboutInfo,
        windowId,
      } satisfies HostToWebview);
    }
    flushPendingActivations();
  };

  // MCP opens with focus: activated once the session is in its owner's state, never before.
  const pendingActivate = new Set<string>();
  const flushPendingActivations = () => {
    for (const id of pendingActivate) {
      if (!store.get(id)) continue;
      pendingActivate.delete(id);
      windowFor(id)?.webContents.send('to-webview', {
        type: 'activateSession',
        sessionId: id,
      } satisfies HostToWebview);
    }
  };

  // win:list (multi-window Slice B): the open windows + owned-session counts for the
  // "Move to window…" picker. Broadcast to every window; each renderer filters out its own
  // id (from state.windowId). Titles fall back to a stable per-window ordinal.
  broadcastWinList = () => {
    const list = buildWinList(
      [...windows.keys()],
      sessionOwner,
      store.list(),
      (id) => windowOrdinal.get(id) ?? 0,
    );
    broadcast({ type: 'win:list', windows: list });
  };

  // Snapshot the current multi-window layout to windows.json (Slice C). Gated on the same
  // `restoreSessions` setting that controls session restore — no new persisted setting (spec
  // §defaults). The empty-snapshot guard preserves the last good layout when the registry has
  // already emptied (the close-last-window timing where `closed` fired before this runs); the
  // populated final state is captured by the non-debounced call in `before-quit`.
  // The current multi-window layout (bounds + owned session ids). Shared by the debounced
  // async persist and the synchronous quit-flush so the snapshot shape lives in one place.
  const buildLayoutSnapshot = (): WindowLayout[] => {
    const all = store.list();
    return [...windows.values()].map((w) => {
      const sidebarUi = sidebarUiByWindow.get(w.id);
      return {
        bounds: w.getBounds(),
        sessionIds: sessionsOwnedBy(sessionOwner, w.id, all).map((s) => s.id),
        ...(sidebarUi ? { sidebarUi } : {}),
      };
    });
  };

  const persistLayout = () => {
    // A quit has already written the final snapshot synchronously (flushStateSync).
    if (!settings.restoreSessions || isQuitting) return;
    const snapshot = buildLayoutSnapshot();
    if (snapshot.length === 0) return;
    log.debug('window', 'layout-persist', { windows: snapshot.length });
    persistFile(windowsLayoutFile(), serializeWindowLayout(snapshot), 'windows.json');
  };

  // Durable, SYNCHRONOUS flush of the app's own files on quit: an auto-update REPLACES the app by
  // force-killing the running exe, cutting off any in-flight async write, and an interrupted write
  // truncated these files once (update-durability fix). Sessions, projects, launchers and timers
  // are the server's files and outlive the app.
  const flushStateSync = () => {
    const write = (file: string, data: string, label: string) => {
      try {
        atomicWriteFileSync(file, data);
      } catch (e) {
        log.error('persist', `sync flush failed for ${label}: ${String(e)}`);
      }
    };
    write(settingsFile(), serializeSettings(settings), 'settings.json');
    // Editor tabs are low-stakes, but the same force-kill-on-update hazard applies (spec §3.2).
    write(docsFile(), serializeDocs(lastDocs), 'docs.json');
    // Gated on an actual change this run — see reviewMarksDirty.
    if (reviewMarksDirty)
      write(reviewMarksFile(), serializeMarksFile(reviewMarks), 'review-marks.json');
    if (settings.restoreSessions) {
      const snapshot = buildLayoutSnapshot();
      if (snapshot.length > 0)
        write(windowsLayoutFile(), serializeWindowLayout(snapshot), 'windows.json');
    }
  };

  const LAYOUT_PERSIST_MS = 500;
  let layoutPersistTimer: ReturnType<typeof setTimeout> | null = null;
  schedulePersistLayout = () => {
    if (layoutPersistTimer) return;
    layoutPersistTimer = setTimeout(() => {
      layoutPersistTimer = null;
      persistLayout();
    }, LAYOUT_PERSIST_MS);
  };

  // Reassign a live session's owner window (multi-window Slice B/C). The program keeps running in
  // hc; the target's pane mounts and its term:start attaches a fresh observer. The `movingSessions`
  // guard keeps the source pane's unmount (term:dispose) from detaching the target's link.
  const moveSessionToWindow = (sessionId: string, targetId: number): void => {
    movingSessions.add(sessionId);
    assignOwner(sessionOwner, sessionId, targetId);
    // The server rebinds an ask to the new owner from presence (W5).
    schedulePresence();
    postState(); // source drops the session; target gains it
    broadcastWinList?.(); // counts changed
    schedulePersistLayout?.(); // ownership changed → re-snapshot the layout (Slice C)
    const target = windows.get(targetId);
    if (target) {
      target.webContents.send('to-webview', { type: 'activateSession', sessionId });
      // Follow the moved session: surface + focus the target so the user lands on it.
      if (process.env.CONDUIT_E2E !== '1') target.show();
      target.focus();
    }
  };

  // Open a folder in the chosen terminal (C2 sessions.create) and remember it in history. `cardId`
  // (N2) stamps the session with the board card it was started for; `ownerWindowId` is the window
  // the new session belongs to (multi-window Slice A).
  async function openRepo(
    home: string,
    agentId: string,
    ownerWindowId: number,
    opts: { roots?: string[]; projectId?: string; cardId?: string; brief?: BriefRequest } = {},
  ): Promise<ServerMethods['sessions.create']['result']> {
    const pending = pendingCreates.begin(ownerWindowId);
    try {
      const r = await callServer('sessions.create', {
        agentId,
        home,
        ...(opts.roots ? { roots: opts.roots } : {}),
        ...(opts.projectId ? { projectId: opts.projectId } : {}),
        ...(opts.cardId ? { cardId: opts.cardId } : {}),
        ...(opts.brief ? { brief: opts.brief } : {}),
      });
      assignOwner(sessionOwner, r.sessionId, ownerWindowId);
      pendingCreates.resolve(pending, r.sessionId);
      rememberOpen(
        agentId,
        home,
        opts.roots ?? [],
        (r.droppedRoots ?? []).map((d) => d.path),
      );
      postState();
      schedulePresence();
      return r;
    } catch (error) {
      pendingCreates.cancel(pending);
      throw error;
    }
  }

  /** Recents for a person's open; the server counts the launcher use. */
  function rememberOpen(agentId: string, p: string, roots: string[], dropped: string[]) {
    const now = Date.now();
    const missing = new Set(dropped);
    const attached = roots.filter((r) => !missing.has(r));
    // Reverse, then home last: the home ends up first and attached folders keep their order (D14).
    for (const r of [...attached].reverse()) {
      repos = upsertAttachedRepo(repos, { path: r, name: path.basename(r) || r, lastOpened: now });
    }
    repos = upsertRepo(repos, {
      path: p,
      name: path.basename(p) || p,
      lastAgentId: agentId,
      lastOpened: now,
    });
    persistFile(reposFile(), serializeRepos(repos), 'repos.json');
  }

  // Read-grant store (K2): the set of exact files the host has served via readFile this
  // session. A write to one of these is allowed even when it falls outside every write
  // root (go-to-definition target, out-of-root recent). Bounded (default cap 500),
  // app-lifetime retention — it only ever holds files the user actually opened, so the
  // memory is negligible. See src/read-grants.ts for the security model.
  const readGrants = createGrantStore({ canonical: hostCanonical });

  const boardWatcher = new BoardWatcher();

  // Per-repo review notes, held in memory and pushed to windows directly (spec
  // 2026-08-27-review-supercharge §2 Lane F). The ARTIFACT is the durable copy; there is no quit
  // flush, because every mutation writes through.
  const reviewNotes = new Map<string, ReviewNotesData>();
  const notesWatcher = new NotesWatcher();
  // Per-root write chain. Two quick patches otherwise race on writeAtomic's rename: if the EARLIER
  // one lands last, the file holds stale notes while `recordWrite` already holds the NEWER
  // fingerprint — so the watcher reads the app's own stale write as an external edit and
  // broadcasts it back over correct in-memory state, taking the user's newest note off screen.
  // Mirrors the pipeline-queue chain in conduit-fs.ts.
  const notesWriteChains = new Map<string, Promise<void>>();

  // One watch per OPENED project root (reconciled against the session list in sendProject,
  // dropped with the project's last session), because a plan can be edited by an agent in any
  // open project, not just the one on screen. See docs/plans/2026-09-19-interactive-plan.plan.md.
  const planWatcher = new PlanWatcher((root, slug, file, markdown, comments) => {
    if (file === 'plan') {
      broadcast({ type: 'plan:doc', root, slug, markdown: markdown ?? null, origin: 'external' });
    } else {
      broadcast({ type: 'plan:comments', root, slug, comments, origin: 'external' });
    }
  });

  const folders = new SessionFolderRuntime({
    store,
    scheduleRepoScan,
    reconcilePlans: (homes) => planWatcher.reconcile(homes.map(normalizeRoot)),
    broadcastFsChanged: (fire) => {
      for (const w of windows.values()) {
        const needed = store
          .list()
          .some(
            (s) =>
              gitDemand.isVisibleInWindow(w.id, s.id) &&
              fire.folders.some((root) => sessionContains(s, root)),
          );
        if (needed) w.webContents.send('to-webview', { type: 'fsChanged', ...fire });
        else {
          const pending = pendingFsByWindow.get(w.id) ?? new Set<string>();
          for (const root of fire.folders)
            if (
              store.list().some((s) => sessionOwner.get(s.id) === w.id && sessionContains(s, root))
            )
              pending.add(root);
          pendingFsByWindow.set(w.id, pending);
        }
      }
    },
    // Folder-scoped, not per package: `fsChanged` carries no changed path, and
    // `shouldIgnoreWatchPath` drops every `node_modules` event before the debounce — so an
    // npm install emits nothing at all and no finer signal exists to key on. A resolution
    // costs one bounded walk and is only ever recomputed after a navigation misses.
    dropResolutionsForRoot: (root) => dropResolutionsForRoot(moduleResolveCache, root),
    createWatcher: (onFire, onSuspect) =>
      new ProjectWatcher(onFire, {
        log: (m) => console.log('[watch]', m),
        onSuspect,
        onPath: (k) => repoTrackerHost.onWatchedPath(k),
        onLost: (f) => repoTrackerHost.lostFolders(f),
        onLive: (r) => repoTrackerHost.setLiveRoots(r),
      }),
    // Dropped while the service is down, like any C2 notification (D29).
    suspect: (sessionId, folder) =>
      serverClient()?.notify('folders.suspect', { sessionId, path: folder }),
    visibleSessionIds: () => gitDemand.visibleIds(),
    isWindowSuspended: (windowId) => gitDemand.isSuspended(windowId),
    log: (level, msg, data) => log[level]('folders', msg, data),
  });
  folders.onFoldersChanged(() => pruneFileIndexes());
  onWindowFocus = () => {
    repoTrackerHost.windowFocused();
    // The server rechecks the focused window's visible session's folders on a focus change (W4).
    schedulePresence();
  };
  const replyOp = (
    dispatch: Dispatch,
    m: { type: string; requestId?: number },
    r: Omit<Extract<HostToWebview, { type: 'session:opResult' }>, 'type' | 'requestId'>,
  ) => {
    if (typeof m.requestId === 'number') {
      dispatch({
        type: 'session:opResult',
        requestId: m.requestId,
        ok: r.ok,
        ...(r.ok ? {} : { reason: r.reason }),
      });
    } else if (!r.ok) {
      log.info('session', `${m.type} refused`, { reason: r.reason });
    }
  };
  const mutateSession = (sessionId: string, mutation: SessionMutation) =>
    callServer('sessions.mutate', { sessionId, mutation });
  /** The C2 reply's reason is optional on the wire; a refusal without one is an unknown session. */
  const opResultOf = (
    r: ServerMethods['sessions.mutate']['result'],
  ): { ok: true } | { ok: false; reason: SessionOpReason } =>
    r.ok ? { ok: true } : { ok: false, reason: r.reason ?? 'unknown-session' };

  type OpenRepoError = NonNullable<Extract<HostToWebview, { type: 'openRepo:result' }>['error']>;
  const OPEN_REPO_ERRORS: ReadonlySet<string> = new Set<OpenRepoError>([
    'home-missing',
    'invalid-path',
    'unknown-agent',
    'brief-unreadable',
    'brief-too-large',
    'brief-invalid',
    'brief-io',
  ]);
  /** sessions.create refuses as an RPC error whose message is today's openRepo:result error. */
  const isOpenRepoError = (m: string): m is OpenRepoError => OPEN_REPO_ERRORS.has(m);
  const openRepoErrorOf = (err: unknown): OpenRepoError | undefined =>
    err instanceof ServerCallError && isOpenRepoError(err.message) ? err.message : undefined;

  async function openRepoRequest(
    m: Extract<WebviewToHost, { type: 'openRepo' }>,
    ownerWindowId: number,
    dispatch: Dispatch,
  ) {
    const requestId = typeof m.requestId === 'number' ? m.requestId : undefined;
    const answer = (
      r: Omit<Extract<HostToWebview, { type: 'openRepo:result' }>, 'type' | 'requestId'>,
    ) => {
      if (requestId !== undefined) dispatch({ type: 'openRepo:result', requestId, ...r });
      else if (r.error) log.info('session', 'openRepo refused', { error: r.error });
    };
    if (typeof m.path !== 'string' || m.path === '') {
      answer({ droppedRoots: [], error: 'invalid-path' });
      return;
    }
    try {
      const r = await openRepo(m.path, m.agentId, ownerWindowId, {
        ...(Array.isArray(m.roots) ? { roots: m.roots } : {}),
        ...(typeof m.projectId === 'string' ? { projectId: m.projectId } : {}),
        ...(m.cardId ? { cardId: m.cardId } : {}),
        ...(m.brief !== undefined ? { brief: m.brief } : {}),
      });
      answer({ sessionId: r.sessionId, droppedRoots: r.droppedRoots ?? [] });
    } catch (err) {
      const error = openRepoErrorOf(err);
      if (!error) throw err;
      answer({ droppedRoots: [], error });
    }
  }

  // The renderer keys read-only off `EACCES`/`EPERM` in this text, so the errno has to survive.
  const planErrorText = (err: unknown): string => {
    const message = err instanceof Error ? err.message : String(err);
    const code = err instanceof Error && 'code' in err ? String(err.code) : '';
    return code ? `${code}: ${message}` : message;
  };

  const persistNotes = (root: string, projectRoot: string, data: ReviewNotesData): void => {
    const run = async (): Promise<void> => {
      if (data.notes.length === 0) await removeReviewNotesArtifactFile(projectRoot);
      else await writeReviewNotesArtifactFile(projectRoot, data);
      // Recorded ONLY on success: a rejected write left the file unchanged, so priming the echo
      // guard would suppress a later genuine external edit.
      notesWatcher.recordWrite(notesFingerprint(data));
    };
    const prior = notesWriteChains.get(root) ?? Promise.resolve();
    const result = prior.then(run, run);
    // A failed write must not wedge the chain for every later save.
    notesWriteChains.set(
      root,
      result.catch(() => {}),
    );
    result.catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      log.error('notes', `write to .conduit/review-notes.json failed: ${message}`);
      broadcast({ type: 'error', message: `Could not save notes: ${message}` });
    });
  };

  // Watcher-originated pushes are path-tagged; the renderer keys them by path and ignores
  // a non-current one, so broadcasting to every window is safe + simplest (multi-window).
  const openFileWatcher = new OpenFileWatcher((p) => broadcast({ type: 'fileChanged', path: p }));

  const proposalWatcher = new ProposalWatcher();

  // Auto-update lifecycle (no-op in dev; active only in packaged builds). Update events are
  // shared notifications — broadcast to every window.
  const stopUpdater = initUpdater(broadcast, (event, data) => log.info('updater', event, data));

  // ── Quit / close / update-relaunch guard (dirty-quit-guard spec §2) ──────────────
  // A window whose close the guard already proceeded: its re-fired close event passes through.
  const windowConfirmed = new Set<number>();
  const windowClosing = new Set<number>();

  const liveWindow = (id: number): BrowserWindow | undefined => {
    const w = windows.get(id);
    return w && !w.isDestroyed() ? w : undefined;
  };
  // A window still ending its sessions has answered its close too: a sibling's queued close must
  // see itself as the last window and quit, keeping its sessions (S4).
  const openWindows = () =>
    openWindowIds(
      windows.keys(),
      (id) => !!liveWindow(id),
      new Set([...windowConfirmed, ...windowClosing]),
      BrowserWindow.getFocusedWindow()?.id,
    );
  const openWindowCount = () => openWindows().length;
  // The open confirmQuit per window, so only a live app-quit answer can arm stopAgentsOnQuit.
  const quitAsks = new Map<number, { requestId: number; reason: GuardReason }>();
  // F4: a plain quit leaves agents running; only the stop choice in the quit dialog arms this (the
  // palette's quitAndStop reason stops them without it).
  let stopAgentsOnQuit = false;
  let stopFailureRequestId = 0;
  const stopFailureAsks = new Map<
    number,
    {
      windowId: number;
      settle(choice: 'retry' | 'leave' | 'cancel'): void;
    }
  >();

  const closeGuard = createCloseGuard({
    windowIds: openWindows,
    prepare: (id) => {
      const w = liveWindow(id);
      if (!w) return;
      if (w.isMinimized()) w.restore();
      if (process.env.CONDUIT_E2E !== '1') w.show();
      w.focus();
    },
    focus: (id) => liveWindow(id)?.focus(),
    counts: (id) => {
      const sessions = sessionsOwnedBy(sessionOwner, id, store.list());
      return { running: runningSessions(sessions).length, busy: busySessions(sessions).length };
    },
    ask: (id, ask) => {
      quitAsks.set(id, { requestId: ask.requestId, reason: ask.reason });
      liveWindow(id)?.webContents.send('to-webview', { type: 'confirmQuit', ...ask });
    },
    abort: (id, requestId) => {
      quitAsks.delete(id);
      liveWindow(id)?.webContents.send('to-webview', { type: 'quitAborted', requestId });
    },
    confirmUnresponsive: (id, signal) => {
      const w = liveWindow(id);
      if (!w) return Promise.resolve(true);
      return dialog
        .showMessageBox(w, {
          type: 'warning',
          buttons: ['Wait', 'Close anyway'],
          defaultId: 0,
          cancelId: 0,
          message: "Conduit isn't responding.",
          detail: "Unsaved changes in this window can't be saved.",
          signal,
        })
        .then(
          (r) => r.response === 1,
          () => false,
        );
    },
    proceedApp: (reason) => {
      const stopAgents = stopAgentsOnQuit || reason === 'quitAndStop';
      const finish = () => {
        quitAsks.clear();
        stopAgentsOnQuit = false;
        quitGrant.issue();
        if (reason === 'update') quitAndInstall();
        else setImmediate(() => app.quit());
      };
      if (!stopAgents) {
        finish();
        return;
      }
      void stopAgentsBeforeQuit({
        stop: () => lifecycle?.stopAll() ?? Promise.resolve({ ok: false }),
        failure: async (failureReason) => {
          const w = focusedWindow() ?? liveWindow(primaryWindowId);
          if (!w) return 'cancel';
          const requestId = ++stopFailureRequestId;
          return new Promise<'retry' | 'leave' | 'cancel'>((resolve) => {
            const closed = () => settle('cancel');
            const settle = (choice: 'retry' | 'leave' | 'cancel') => {
              stopFailureAsks.delete(requestId);
              w.removeListener('closed', closed);
              resolve(choice);
            };
            stopFailureAsks.set(requestId, { windowId: w.id, settle });
            w.once('closed', closed);
            w.webContents.send('to-webview', {
              type: 'confirmStopAgentsFailed',
              requestId,
              reason: failureReason,
            } satisfies HostToWebview);
          });
        },
        finish,
        cancel: () => {
          stopAgentsOnQuit = false;
          quitAsks.clear();
          closeGuard.unlockAnswered();
        },
      });
    },
    proceedWindow: (id) => {
      const w = liveWindow(id);
      if (!w) return;
      // Its sibling vanished mid-guard, so this close is now a quit and its sessions are kept for
      // restore (dirty-quit-guard plan, critic nit).
      if (openWindowCount() === 1 && process.platform !== 'darwin') {
        quitGrant.issue();
        setImmediate(() => app.quit());
        return;
      }
      stopAgentsOnQuit = false;
      const ask = quitAsks.get(id);
      quitAsks.delete(id);
      windowClosing.add(id);
      void closeWindowSessions({
        sessionIds: sessionsOwnedBy(sessionOwner, id, store.list()).map((s) => s.id),
        remove: (sessionId) => callServer('sessions.remove', { sessionId }).then(() => {}),
        close: () => {
          windowClosing.delete(id);
          windowConfirmed.add(id);
          if (!w.isDestroyed()) w.close();
        },
        failed: (message) => {
          windowClosing.delete(id);
          log.warn('window', 'session removal on close failed', { windowId: id, message });
          if (!liveWindow(id)) return;
          if (ask)
            w.webContents.send('to-webview', {
              type: 'quitAborted',
              requestId: ask.requestId,
            } satisfies HostToWebview);
          w.webContents.send('to-webview', {
            type: 'error',
            message: `Couldn't close the window: ${message}`,
          } satisfies HostToWebview);
        },
      });
    },
    resumeWindowClose: (id) => {
      const w = liveWindow(id);
      if (w) closeDecision(w);
    },
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
    log: (message) => log.warn('window', message),
  });

  const quitGrant = createQuitGrant({
    ttlMs: GRANT_TTL_MS,
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
    onExpire: () => closeGuard.unlockAnswered(),
  });

  // Closing the last window is a quit (its sessions are kept for restore); closing any other window
  // ends only that window's sessions. darwin keeps the app alive with no windows.
  const closeDecision = (w: BrowserWindow) => {
    if (windowClosing.has(w.id)) return;
    if (openWindowCount() === 1 && process.platform !== 'darwin') app.quit();
    else closeGuard.requestWindowClose(w.id);
  };

  // These artifact helpers take an explicit `dispatch` (multi-window Slice A): a request
  // handler passes a sender-scoped reply; the armed watcher passes `broadcast` so later
  // changes reach every window (path-tagged → non-current windows ignore them).
  type Dispatch = (msg: HostToWebview) => void;

  /** Read the current proposal for a kind and push it (or `null`) via `dispatch`. */
  function sendProposal(dispatch: Dispatch, p: string, kind: ProposalKind) {
    if (kind === 'board') {
      dispatch({ type: 'proposal', path: p, kind, proposed: readBoardProposal(p) });
    } else {
      dispatch({ type: 'proposal', path: p, kind, proposed: readArchitectureProposal(p) });
    }
  }

  /** Re-push the canonical artifact for a kind (after an accept rewrote it). */
  function sendCanonical(dispatch: Dispatch, p: string, kind: ProposalKind) {
    if (kind === 'board') {
      dispatch({ type: 'board', path: p, board: readBoardForProject(p) });
    } else {
      dispatch({ type: 'architecture', path: p, doc: readArchitectureForProject(p) });
    }
  }

  // Arm a single live proposal watch for a project (idempotent enough: watch() replaces any
  // prior watch). Fired on board OR canvas open; whichever kind changed is broadcast.
  function armProposalWatch(p: string) {
    proposalWatcher.watch(p, (kind) => sendProposal(broadcast, p, kind));
  }

  // Arms the watcher, rescans repos and checks folder health; nothing is replied: change lists
  // arrive as repoDelta and the tree through readDir (engine review r1 SF3).
  function requestProject(
    windowId: number,
    p: string,
    sessionId: string | undefined,
    auto: boolean,
  ) {
    deferredProjectRequests.delete(windowId);
    if (auto && sessionId && !gitDemand.isVisible(sessionId)) {
      deferredProjectRequests.set(windowId, {
        sessionId,
        run: () => requestProject(windowId, p, sessionId, true),
      });
      return;
    }
    folders.requestProject(p, sessionId, windowId, !auto);
  }

  // ── Conduit server (C2) and hc observer (C5) ──────────────────────────────
  // The server owns sessions, PTYs (in hc), projects, launchers, timers and MCP; the app is a
  // client of it. See docs/plans/2026-11-02-three-process-w7-app-client.plan.md.
  const e2e = process.env.CONDUIT_E2E === '1';
  const appLog: AppLog = (level, msg, data) => log[level]('server', msg, data);
  const names = instanceNames(
    userData(),
    process.platform === 'win32' ? 'win32' : 'posix',
    os.tmpdir(),
  );
  // M22: isolated XDG for our core; every app hc call goes through this env (our HC_SESSION).
  const hcEnv = coreStartEnv(process.env, names, true);
  const hc = hcClient(names, hcEnv, (m) => log.warn('hc', m));
  // Before the lifecycle: the start rule and its F6/F9 waits read this one subscription.
  const hcEvents = createHcEvents(hc, { 'conduit.instance': names.instance }, appLog);
  let lifecycle: ReturnType<typeof createServerLifecycle> | null = null;
  const serverClient = () => lifecycle?.client() ?? null;
  const serverCalls = createServerCalls(() => lifecycle);
  const callServer = serverCalls.call;
  let resolveFirstSnapshot = () => {};
  /** OS opens wait for it: they need the server's agents. */
  const firstSnapshot = new Promise<void>((resolve) => {
    resolveFirstSnapshot = resolve;
  });

  const terminals = createTerminalHost({
    client: serverClient,
    links: createTerminalLinkFactory({ hc, hcSession: names.hcSession, hcEvents, log: appLog }),
    store,
    sendToOwner,
    log: appLog,
  });
  hc.onConnection((state) => {
    if (state === 'reconnected') terminals.hcReconnected();
  });

  /** timers.renew/sendNow/sendOnce refuse as an RPC error whose message is the toast. */
  const timerCall = async <M extends 'timers.renew' | 'timers.sendNow' | 'timers.sendOnce'>(
    dispatch: Dispatch,
    m: M,
    p: ServerMethods[M]['params'],
  ) => {
    try {
      await callServer(m, p);
    } catch (err) {
      if (!(err instanceof ServerCallError) || err.kind !== 'refused') throw err;
      dispatch({ type: 'timer:error', message: err.message });
    }
  };

  const removeSession = (id: string): Promise<void> =>
    callServer('sessions.remove', { sessionId: id }).then(
      () => {},
      (err: unknown) => log.warn('session', 'remove failed', { sessionId: id, err: String(err) }),
    );

  // ── Presence (C2 ui.presence): visible, ready, focus and owners, coalesced per tick ──
  let presenceQueued = false;
  const pushPresence = () => {
    const focusedId = focusedWindowId;
    const windowsNow: C2WindowPresence[] = [...windows.keys()].map((windowId) => ({
      windowId,
      focused: focusedId === windowId,
      ready: presence.isReady(windowId),
      visibleSessionIds: store
        .list()
        .filter((s) => presence.isOnScreen(windowId, s.id))
        .map((s) => s.id),
      ownedSessionIds: [...sessionOwner].filter(([, w]) => w === windowId).map(([id]) => id),
    }));
    serverClient()
      ?.call('ui.presence', { windows: windowsNow })
      .catch((err: unknown) => log.warn('server', 'ui.presence failed', { err: String(err) }));
  };
  const schedulePresence = () => {
    if (presenceQueued) return;
    presenceQueued = true;
    setImmediate(() => {
      presenceQueued = false;
      pushPresence();
    });
  };

  onWindowPresenceChanged = schedulePresence;

  /** Created with no app, restored without a layout, or its window is gone. */
  const fallbackWindow = (): number =>
    focusedWindow()?.id ?? (windows.has(primaryWindowId) ? primaryWindowId : -1);

  const applyPlacement = (e: ServerEvents['sessions.opened'], appWindowId?: number) => {
    const openerWindow =
      e.openerSessionId !== undefined ? sessionOwner.get(e.openerSessionId) : undefined;
    const windowId =
      appWindowId !== undefined && windows.has(appWindowId)
        ? appWindowId
        : openerWindow !== undefined && windows.has(openerWindow)
          ? openerWindow
          : fallbackWindow();
    assignOwner(sessionOwner, e.sessionId, windowId);
    if (!e.focus)
      windows.get(windowId)?.webContents.send('to-webview', {
        type: 'suppressAutoSwitch',
        sessionId: e.sessionId,
      } satisfies HostToWebview);
    // An app open focuses through its own openRepo:result; an MCP open is activated here.
    else if (e.openerSessionId !== undefined) pendingActivate.add(e.sessionId);
    if (store.get(e.sessionId)) {
      postState();
      broadcastWinList?.();
      schedulePersistLayout?.();
    }
    schedulePresence();
  };

  const pendingCreates = createPendingAppCreateMatcher(applyPlacement);
  const place = (e: ServerEvents['sessions.opened']) => {
    if (e.openerSessionId === undefined) pendingCreates.opened(e);
    else applyPlacement(e);
  };

  /** Each session's last home, for the plan watch a removed session may have held alone. */
  const homes = new Map<string, string>();
  const forgetSession = (id: string) => {
    const planRoot = homes.get(id);
    homes.delete(id);
    // The project is closed once its last session goes; the plans watch would otherwise hold an
    // fs.watch handle (and a poll interval) on a folder nothing is showing any more.
    if (planRoot) {
      const key = normalizeRoot(planRoot);
      if (!store.list().some((s) => normalizeRoot(s.home) === key)) planWatcher.unwatch(key);
    }
    gitDemand.forget(id);
    for (const [windowId, request] of deferredProjectRequests)
      if (request.sessionId === id) deferredProjectRequests.delete(windowId);
    repoScanner.forget(id);
    repoTrackerHost.tracker.dropSession(id);
    removeOwner(sessionOwner, id);
    pendingActivate.delete(id);
  };

  /** The app's side of every server list: owners, cwd auto-follow, folder runtime, indexes. */
  const sessionsApplied = (diffs: SessionDiff[]) => {
    let membership = reconcileSessionOwners(
      sessionOwner,
      store.list().map((s) => s.id),
      (id) => !!liveWindow(id),
      fallbackWindow(),
      (id) => pendingCreates.isHeld(id),
    );
    for (const d of diffs) {
      if (d.kind === 'turnEnded') {
        if (!gitDemand.isVisible(d.sessionId))
          repoTrackerHost.tracker.sessionTurnEnded(d.sessionId);
        continue;
      }
      if (d.kind === 'removed') {
        forgetSession(d.sessionId);
        membership = true;
        continue;
      }
      const s = store.get(d.sessionId);
      if (!s) continue;
      homes.set(s.id, s.home);
      if (d.kind === 'added') {
        membership = true;
        if (!sessionOwner.has(s.id) && !pendingCreates.isHeld(s.id))
          assignOwner(sessionOwner, s.id, fallbackWindow());
      }
      // Multi-repo: a cd inside a detected sub-repo auto-follows (the store ignores it while pinned).
      if (d.cwdChanged && s.cwd) store.setAutoRepo(s.id, repoForPath(s.repos ?? [], s.cwd));
    }
    folders.applied(diffs);
    if (!membership) return;
    afterReposChanged();
    if (deferredIndexes.size || pendingFsByWindow.size) {
      const sessions = store.list();
      const owned = (root: string) => sessions.some((s) => sessionContains(s, root));
      for (const [key, request] of deferredIndexes)
        if (!owned(request.root)) deferredIndexes.delete(key);
      for (const [windowId, roots] of pendingFsByWindow) {
        for (const root of roots) if (!owned(root)) roots.delete(root);
        if (roots.size === 0) pendingFsByWindow.delete(windowId);
      }
    }
    broadcastWinList?.();
    schedulePersistLayout?.();
    schedulePresence();
  };

  const attentionBody = (name: string, kind: ServerEvents['attention.edge']['kind']) =>
    kind === 'run-end' ? `${name} finished` : `${name} is waiting`;

  const notifyAttention = (sessionId: string, kind: ServerEvents['attention.edge']['kind']) => {
    const session = store.get(sessionId);
    if (!session) return;
    windowFor(sessionId)?.flashFrame(true);
    if (!Notification.isSupported()) return;
    const notif = new Notification({ title: 'Conduit', body: attentionBody(session.name, kind) });
    notif.on('click', () => {
      const w = windowFor(sessionId);
      if (w) {
        w.show();
        w.focus();
        sendToOwner(sessionId, { type: 'activateSession', sessionId });
      }
    });
    notif.show();
  };

  const router = createServerEventRouter({
    store,
    terminals,
    broadcastState: () => postState(),
    broadcast: (m) => {
      if (m.type === 'timer:state') lastTimers = m;
      if (m.type === 'mcp:state') lastMcp = m;
      broadcast(m);
    },
    sendToWindow: (id, m) => {
      const w = windows.get(id);
      if (w && !w.isDestroyed() && !w.webContents.isDestroyed())
        w.webContents.send('to-webview', m);
    },
    ownerWindowOf: (id) => {
      const w = sessionOwner.get(id);
      return w !== undefined && windows.has(w) ? w : undefined;
    },
    raiseWindow: (id) => {
      const w = windows.get(id);
      if (!w || w.isDestroyed()) return;
      if (!e2e) w.show();
      w.focus();
    },
    openFileInEditor: sendOpenFileInEditor,
    sessionsApplied,
    onServerSettings: (s) => {
      const next = mirrorServerKeys(settings, s);
      if (JSON.stringify(next) === JSON.stringify(settings)) return;
      settings = next;
      persistFile(settingsFile(), serializeSettings(settings), 'settings.json');
      postState();
    },
    onStores: (s) => {
      stores = { ...stores, ...s };
      postState();
    },
    onRuntime: (h) => {
      log.info('server', 'runtime', { ...h });
      // Runtime health is per connection; a late event after a drop has no server behind it.
      if (serverUiState.state !== 'connected') return;
      serverUiState = { ...serverUiState, runtime: h };
      broadcast({ type: 'server:state', state: serverUiState });
    },
    osAttention: () => settings.osAttention,
    anyWindowFocused: () => BrowserWindow.getFocusedWindow() !== null,
    notifyAttention,
    flash: (sessionId) => {
      const w = windowFor(sessionId);
      if (w && !w.isFocused()) w.flashFrame(true);
    },
    place,
    log: appLog,
  });

  /** HcCliDeps.execFile: a non-zero exit is a result, never a throw. */
  const execHc: HcCliDeps['execFile'] = (file, args, o) =>
    new Promise((resolve) => {
      execFile(
        file,
        args,
        { env: o.env, cwd: o.cwd, timeout: o.timeoutMs, windowsHide: true },
        (err, stdout, stderr) => {
          const code = err ? (typeof err.code === 'number' ? err.code : 1) : 0;
          resolve({
            code,
            stdout: String(stdout),
            stderr: String(stderr) || (err ? err.message : ''),
          });
        },
      );
    });

  async function startServer(): Promise<void> {
    const appVersion = aboutInfo.version;
    // W9: a packaged app runs its server from copies outside the install dir (D2).
    const prepared = app.isPackaged
      ? await prepareRuntime({
          resourcesDir: process.resourcesPath,
          userData: userData(),
          appVersion,
          hcVersion: HC_PINNED_VERSION,
          shimVersion: CURRENT_SHIM_GENERATION,
        })
      : undefined;
    const layout = runtimeLayout({
      packaged: app.isPackaged,
      userData: userData(),
      appVersion,
      appPath: app.getAppPath(),
      env: process.env,
    });
    // D23: under the single-instance lock, before the start rule.
    try {
      const gc = await collectRuntimeGarbage(
        names.runtimeRoot,
        { appVersion, hcVersion: layout.hcVersion },
        {
          readdir: (d) => fs.promises.readdir(d),
          rename: (a, b) => fs.promises.rename(a, b),
          rmrf: (d) => fs.promises.rm(d, { recursive: true, force: true }),
        },
      );
      if (gc.removed.length || gc.inUse.length) log.info('runtime', 'gc', { ...gc });
    } catch (err) {
      log.warn('runtime', 'gc failed', { err: String(err) });
    }
    // E2e hooks reach the server as argv: hc may refresh the env on Windows (M10).
    const serverArgs = e2e ? ['--e2e'] : [];
    if (prepared)
      serverArgs.push(
        '--shim-dir',
        prepared.shimDir,
        '--previous-exe',
        process.execPath,
        '--previous-shim',
        path.join(process.resourcesPath, 'conduit-mcp', SHIM_LEAF),
      );
    const marker = path.join(userData(), SERVER_EXHAUSTED_FILE);
    lifecycle = createServerLifecycle({
      names,
      layout,
      userData: userData(),
      appVersion,
      serverArgs,
      client: () => new ServerClient({ endpoint: names.serverEndpoint, appVersion, log: appLog }),
      hc,
      hcEvents,
      cli: {
        hcExe: layout.hcExe,
        env: hcEnv,
        coreCwd: layout.coreCwd,
        execFile: execHc,
        startCore: () => startCore(layout.hcExe, names, hcEnv),
        connect: () => hcClient(names, hcEnv, (m) => log.warn('hc', m)),
      },
      markerExists: () =>
        fs.promises.access(marker).then(
          () => true,
          () => false,
        ),
      deleteMarker: () => fs.promises.rm(marker, { force: true }),
      spawnDetachedSupervisor: (args) => {
        if (!args) throw new Error('Missing supervisor argv');
        const child = spawn(layout.nodeExe, args, {
          detached: true,
          stdio: 'ignore',
          windowsHide: true,
          env: supervisorEnv(hcEnv, names),
          cwd: path.dirname(layout.superviseJs),
        });
        child.on('error', (err) =>
          log.error('server', 'supervisor spawn failed', { err: String(err) }),
        );
        child.unref();
      },
      now: Date.now,
      log: appLog,
    });
    lifecycle.onState((s) => {
      log.info('server', `state ${s.state}`, { ...s });
      serverCalls.stateChanged(s);
      serverUiState = s.state === 'connected' ? { state: 'connected' } : s;
      broadcast({ type: 'server:state', state: serverUiState });
    });
    lifecycle.onConnected((c) => {
      serverCalls.connected(c);
      c.call('server.setLogging', { logging: settings.logging, logLevel: settings.logLevel }).catch(
        (err: unknown) => log.warn('server', 'setLogging failed', { err: String(err) }),
      );
      c.subscribe(router).then(
        () => {
          resolveFirstSnapshot();
          if (sessionsLoaded) return;
          sessionsLoaded = true;
          postState();
        },
        (err: unknown) => log.warn('server', 'subscribe failed', { err: String(err) }),
      );
      pushPresence();
      terminals.serverConnected();
    });
    await lifecycle.start();
  }

  powerMonitor.on('resume', () => serverClient()?.notify('system.resumed', {}));
  powerMonitor.on('unlock-screen', () => serverClient()?.notify('system.resumed', {}));

  async function handle(m: WebviewToHost, e: IpcMainEvent) {
    const senderWin = BrowserWindow.fromWebContents(e.sender);
    const senderId = senderWin?.id;
    // A message in flight after its window closed has no sender window — ignore it
    // (multi-window Slice A: ownership can't be resolved).
    if (!senderWin || senderId === undefined) return;
    // Sender-scoped reply for request→response handlers; an arrow so the closures below
    // capture this turn's event.
    const replyHere: Dispatch = (msg) => reply(e, msg);
    try {
      switch (m.type) {
        case 'ready':
          presence.markReady(senderId);
          schedulePresence();
          postState();
          replyHere({ type: 'server:state', state: serverUiState });
          // A just-loaded window may have missed the create/focus win:list broadcasts (it
          // wasn't subscribed yet); send the current picker list now (Slice B).
          broadcastWinList?.();
          // Renderer has subscribed; release any OS file-opens buffered during cold launch.
          flushPendingOsOpens();
          // One-shot tab restore (editor-tabs-persist): the renderer applies it once, after its
          // sessions land, and drops docs whose session this window doesn't own. Gated on the
          // same setting as session restore — off ⇒ no message ⇒ no tabs (spec §3.3 D5).
          if (settings.restoreSessions && lastDocs.length > 0) {
            replyHere({ type: 'restoreDocs', docs: lastDocs });
          }
          // Reviewed marks, to the window that just loaded (like restoreDocs above). An EMPTY
          // list is a real answer: it is what opens the renderer's mark controls (§4).
          replyHere({ type: 'review:marks', repos: allMarkRepos() });
          // Once per loaded document: a reload re-hydrates; no state broadcast ever carries it.
          replyHere({
            type: 'window:sidebarInit',
            sidebarUi: sidebarUiByWindow.get(senderId) ?? defaultSidebarUi(),
          });
          // Before the first snapshot these arrive with it, as broadcasts.
          if (lastTimers) replyHere(lastTimers);
          if (lastMcp) replyHere(lastMcp);
          break;
        case 'log': {
          // Back-compatible: a bare {type:'log', message} defaults to info / scope 'renderer'.
          const level = m.level && m.level !== 'off' ? m.level : 'info';
          log[level](m.scope ?? 'renderer', m.message, m.data);
          break;
        }
        case 'revealLogs':
          void shell.openPath(userData());
          break;
        case 'getReleaseNotes': {
          const version = app.getVersion();
          const changelogPath = app.isPackaged
            ? path.join(process.resourcesPath, 'CHANGELOG.md')
            : path.join(app.getAppPath(), 'CHANGELOG.md');
          let notes: string | null = null;
          try {
            notes = changelogSection(fs.readFileSync(changelogPath, 'utf8'), version);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
          }
          const decision = releaseNotesDecision(
            version,
            settings.lastSeenVersion,
            notes,
            settingsFileExistedAtLoad,
          );
          if (decision.persistVersion && settings.lastSeenVersion !== decision.persistVersion) {
            settings = { ...settings, lastSeenVersion: decision.persistVersion };
            persistFile(settingsFile(), serializeSettings(settings), 'settings.json');
          }
          if (decision.showToast) releaseNotesOffers.set(senderId, version);
          else releaseNotesOffers.delete(senderId);
          replyHere({ type: 'releaseNotes', version, notes, showToast: decision.showToast });
          break;
        }
        case 'releaseNotesShown': {
          const version = releaseNotesAckVersion(releaseNotesOffers.get(senderId), m.version);
          if (!version) break;
          releaseNotesOffers.delete(senderId);
          if (settings.lastSeenVersion !== version) {
            settings = { ...settings, lastSeenVersion: version };
            persistFile(settingsFile(), serializeSettings(settings), 'settings.json');
          }
          break;
        }
        case 'window:sidebar':
          // Sender-scoped: a window only ever writes its own entry, validated like a restore. A
          // sender outside the registry (closing, or a guest) would leave an entry no close drops.
          if (!windows.has(senderId)) break;
          sidebarUiByWindow.set(senderId, parseSidebarUi(m.sidebarUi));
          schedulePersistLayout?.();
          break;
        case 'openRepo':
          await openRepoRequest(m, senderId, replyHere);
          break;
        case 'session:addRoot':
          replyOp(replyHere, m, await mutateSession(m.sessionId, { op: 'addRoot', path: m.path }));
          break;
        case 'session:removeRoot':
          replyOp(
            replyHere,
            m,
            await mutateSession(m.sessionId, { op: 'removeRoot', path: m.path }),
          );
          break;
        case 'session:setHome':
          replyOp(replyHere, m, await mutateSession(m.sessionId, { op: 'setHome', path: m.path }));
          break;
        case 'session:locateFolder': {
          const { requestId } = m;
          if (typeof requestId !== 'number') {
            log.warn('folder', 'session:locateFolder without a requestId');
            break;
          }
          const outcome = await locateFolder(m.sessionId, m.path, {
            get: (id) => store.get(id),
            pick: (d) => folderPicker.pick(senderWin, 'Locate folder', d),
            isDir: (p) =>
              fs.promises.stat(p).then(
                (st) => st.isDirectory(),
                () => false,
              ),
            dirname: path.dirname,
            ops: {
              // Locate replaces a missing home; it doesn't keep it as a root (session-ops keepOldHome).
              setHome: (sessionId, p) =>
                mutateSession(sessionId, { op: 'setHome', path: p, keepOldHome: false }).then(
                  opResultOf,
                ),
              replaceRoot: (sessionId, from, to) =>
                mutateSession(sessionId, { op: 'replaceRoot', from, to }).then(opResultOf),
            },
          });
          replyHere({ type: 'session:locateResult', requestId, ...outcome });
          break;
        }
        case 'session:addDirsToAgent':
        case 'session:restart': {
          const { requestId, sessionId } = m;
          if (typeof requestId !== 'number') {
            log.warn('agentScope', `${m.type} without a requestId`);
            break;
          }
          // Only the window showing the session may act on it (review N1).
          if (typeof sessionId !== 'string' || sessionOwner.get(sessionId) !== senderId) {
            replyHere({
              type: 'agentScope:result',
              requestId,
              sessionId: typeof sessionId === 'string' ? sessionId : '',
              ok: false,
              reason: 'noSession',
            });
            break;
          }
          const r = await callServer(
            m.type === 'session:addDirsToAgent' ? 'sessions.addDirs' : 'sessions.restart',
            { sessionId },
          );
          replyHere({ type: 'agentScope:result', requestId, ...r });
          break;
        }
        case 'session:dismissAgentScope':
          if (typeof m.sessionId === 'string' && sessionOwner.get(m.sessionId) === senderId)
            await callServer('sessions.dismissScope', { sessionId: m.sessionId });
          break;
        case 'session:setProject':
          replyOp(
            replyHere,
            m,
            await mutateSession(m.sessionId, { op: 'setProject', projectId: m.projectId }),
          );
          break;
        case 'project:create': {
          if (typeof m.requestId !== 'number' || typeof m.name !== 'string') {
            log.warn('project', 'project:create: bad payload');
            break;
          }
          try {
            const created = await callServer('projects.create', { name: m.name });
            replyHere({ type: 'project:created', requestId: m.requestId, id: created.id });
          } catch (err) {
            const reason = err instanceof ServerCallError ? err.message : '';
            if (reason !== 'invalid-name' && reason !== 'store-unavailable') throw err;
            replyHere({ type: 'project:opResult', requestId: m.requestId, ok: false, reason });
          }
          break;
        }
        case 'project:rename':
          await callServer('projects.rename', { id: m.id, name: m.name }).catch((err: unknown) =>
            log.info('project', 'project:rename refused', { id: m.id, err: String(err) }),
          );
          break;
        case 'project:delete':
          await callServer('projects.delete', { id: m.id }).catch((err: unknown) =>
            log.warn('project', 'project:delete failed', { id: m.id, err: String(err) }),
          );
          break;
        case 'project:reorder':
          await callServer('projects.reorder', { ids: m.ids }).catch((err: unknown) =>
            log.warn('project', 'project:reorder failed', { err: String(err) }),
          );
          break;
        case 'launchers:rescan':
          await callServer('launchers.rescan', {});
          break;
        case 'launcher:addCustom': {
          if (typeof m.requestId !== 'number') {
            log.warn('launcher', 'launcher:addCustom without a requestId');
            break;
          }
          // The data.changed carrying the launcher precedes this reply on the one pipe.
          const r = await callServer('launchers.addCustom', {
            commandLine: m.commandLine,
            ...(m.label !== undefined ? { label: m.label } : {}),
          });
          replyHere({ type: 'launcher:added', requestId: m.requestId, ...r });
          break;
        }
        case 'launcher:removeCustom':
          await callServer('launchers.removeCustom', { id: m.id });
          break;
        case 'folder:pick':
          if (typeof m.requestId !== 'number') {
            log.warn('folder', 'folder:pick without a requestId');
            break;
          }
          replyHere({
            type: 'folder:picked',
            requestId: m.requestId,
            path: await folderPicker.pick(senderWin, 'Add a folder'),
          });
          break;
        case 'file:pick':
          if (typeof m.requestId !== 'number') {
            log.warn('brief', 'file:pick without a requestId');
            break;
          }
          replyHere({
            type: 'file:picked',
            requestId: m.requestId,
            path: await folderPicker.pickFile(senderWin, m.title),
          });
          break;
        case 'brief:probe':
          if (typeof m.requestId !== 'number') {
            log.warn('brief', 'brief:probe without a requestId');
            break;
          }
          replyHere({
            type: 'brief:probed',
            requestId: m.requestId,
            ...(await callServer('briefs.probe', { path: m.path })),
          });
          break;
        case 'brief:agentPreview':
          if (typeof m.requestId !== 'number') {
            log.warn('brief', 'brief:agentPreview without a requestId');
            break;
          }
          replyHere({
            type: 'brief:agentPreviewed',
            requestId: m.requestId,
            ...(await callServer('briefs.agentPreview', { agentId: m.agentId })),
          });
          break;
        case 'folder:probe':
          if (typeof m.requestId !== 'number') {
            log.warn('folder', 'folder:probe without a requestId');
            break;
          }
          replyHere({
            type: 'folder:probeResult',
            requestId: m.requestId,
            ...(await callServer('sessions.probeFolders', { paths: m.paths })),
          });
          break;
        case 'fs:copyToOsClipboard':
          await dragOutHost.copyToOsClipboard(m, {
            senderContentsId: e.sender.id,
            reply: replyHere,
          });
          break;
        case 'fs:armDragDownload':
          dragOutHost.armDragDownload(m, e.sender.id);
          break;
        case 'launch:preview': {
          if (typeof m.requestId !== 'number') {
            log.warn('launcher', 'launch:preview without a requestId');
            break;
          }
          const { type: _type, requestId, ...params } = m;
          replyHere({
            type: 'launch:previewResult',
            requestId,
            ...(await callServer('launchers.preview', params)),
          });
          break;
        }
        case 'requestProject':
          requestProject(senderId, m.path, m.sessionId, m.auto === true);
          break;
        case 'readDir': {
          const entries = await readDir(m.path);
          const ignored = await ignoredEntriesCached(
            m.path,
            entries.map((e) => e.name),
          );
          if (ignored.size > 0) for (const e of entries) if (ignored.has(e.name)) e.ignored = true;
          replyHere({ type: 'dirEntries', path: m.path, entries });
          break;
        }
        case 'readFile': {
          const doc = await readFile(m.path);
          // Record a write-grant for a file the host itself chose to serve (K2). Only on
          // a successful, non-binary, non-error read — never grant a path that failed to
          // read, and never a directory (readFile only ever serves files). This lets the
          // editor save a go-to-definition target / out-of-root recent that lives outside
          // every write root, while validateWrite still governs arbitrary paths.
          if (!doc.error && !doc.binary) readGrants.add(m.path);
          replyHere({ type: 'fileContent', doc });
          break;
        }
        case 'md:image': {
          // Local images embedded in a rendered markdown doc (webview/md-links.ts resolveMdImage
          // resolved the src to this absolute path). Unlike `readFile`/`resolvePathToken` (which a
          // USER triggers by clicking), md:image is CONTENT-triggered — merely opening a markdown
          // doc auto-fetches its `<img src>`s — so a hostile doc could otherwise probe/surface
          // arbitrary on-disk images via `/abs/path` or `../..` escapes. Confine it to the open
          // workspace roots; anything outside fails closed to the viewer's broken-image affordance.
          if (!isInsideAnyRoot(m.path, writeRoots())) {
            replyHere({ type: 'md:imageResult', requestId: m.requestId, error: 'Image not found' });
            break;
          }
          const doc = await readFile(m.path);
          if (doc.image) {
            replyHere({
              type: 'md:imageResult',
              requestId: m.requestId,
              dataUrl: doc.image.dataUrl,
            });
          } else {
            replyHere({
              type: 'md:imageResult',
              requestId: m.requestId,
              error: doc.error ?? 'Not an image',
            });
          }
          break;
        }
        case 'html:canPreview': {
          // Content-triggered, root-confined read like `md:image` above — the same verdict the
          // protocol handler applies, asked up front so a refusal has something to render.
          const target = previewTargetForPath(m.path, writeRoots(), previewStat, realPathLeaf);
          if (!target.ok) {
            replyHere({
              type: 'html:canPreviewResult',
              requestId: m.requestId,
              result: { ok: false, reason: target.reason, detail: target.detail },
            });
            break;
          }
          const url = buildPreviewUrl(
            rootTokenFor(target.root),
            path.relative(target.root, target.path).split(path.sep),
          );
          // A name the parser refuses (`:` is legal off Windows) would only be blocked by the guard.
          replyHere({
            type: 'html:canPreviewResult',
            requestId: m.requestId,
            result: isPreviewUrl(url) ? { ok: true, url } : { ok: false, reason: 'unsupported' },
          });
          break;
        }
        case 'html:setNetworkAllowed': {
          if (m.allowed) allowedGuests.add(m.guestId);
          else allowedGuests.delete(m.guestId);
          break;
        }
        case 'watchFiles': {
          // Watch exactly the files the renderer reports open. These paths were all served
          // via readFile, so they're files the host already chose to expose — watching is
          // read-only and adds no new trust surface.
          openFileWatcher.setPaths(m.paths);
          break;
        }
        case 'persistDocs': {
          // Renderer is the source of truth for open tabs (CLAUDE.md exception). Hold the latest
          // payload for the before-quit sync flush and atomic-write it now (already debounced
          // renderer-side). See spec §3.3.
          lastDocs = m.docs;
          persistFile(docsFile(), serializeDocs(lastDocs), 'docs.json');
          break;
        }
        case 'readDiff': {
          const scope = {
            ...(m.base ? { base: m.base } : {}),
            ...(m.side ? { side: m.side } : {}),
          };
          const doc = await readDiffReply(m.path, gitShow, gitShowBuffer, scope);
          if (doc.error !== undefined)
            log.warn('diff', 'readDiff failed', { path: m.path, ...scope, error: doc.error });
          replyHere({ type: 'fileDiff', doc, ...scope });
          break;
        }
        case 'git:history': {
          const session = store.get(m.sessionId);
          if (!session) break;
          const cwd = await requestRepoRoot(session, m.repoRoot);
          const echoRoot = m.repoRoot !== undefined ? { repoRoot: m.repoRoot } : {};
          if (cwd === null) {
            replyHere({
              type: 'git:historyResult',
              sessionId: m.sessionId,
              commits: [],
              layout: assignLanes([]),
              hasMore: false,
              state: 'error',
              ...(m.requestId !== undefined ? { requestId: m.requestId } : {}),
              ...echoRoot,
            });
            break;
          }
          const query = m.query?.trim();
          // A non-empty query searches FULL history (all refs) so a match beyond the loaded
          // window surfaces directly; otherwise the normal paged tip read. See searchHistory.
          const { commits, hasMore, state } = query
            ? await searchHistory(cwd, query, {
                limit: m.limit,
                log: (msg) => log.error('git', msg),
              })
            : await getHistory(cwd, {
                limit: m.limit,
                before: m.before,
                log: (msg) => log.error('git', msg),
              });
          const layout = assignLanes(commits);
          replyHere({
            type: 'git:historyResult',
            sessionId: m.sessionId,
            commits,
            layout,
            hasMore,
            state,
            ...(m.requestId !== undefined ? { requestId: m.requestId } : {}),
            ...(query ? { query } : {}),
            ...echoRoot,
          });
          break;
        }
        case 'git:commitDiff': {
          const session = store.get(m.sessionId);
          // A silent break here stranded the Review pane on "Loading commit changes…" forever —
          // see docs/specs/archive/2026-08-20-commit-review-memory-bounds.md §4.
          if (!session) {
            replyHere({
              type: 'git:commitDiffResult',
              sessionId: m.sessionId,
              sha: m.sha,
              files: [],
              error: 'session not found',
              requestId: m.requestId,
              ...(m.root ? { root: m.root } : {}),
            });
            break;
          }
          // A terminal-originated commit review passes `root` (the terminal's cwd repo, from
          // validateCommitsResult) so the diff is read from the SAME repo that validated the
          // hash; History passes the repo it shows.
          const cwd = await requestRepoRoot(session, m.root);
          if (cwd === null) {
            replyHere({
              type: 'git:commitDiffResult',
              sessionId: m.sessionId,
              sha: m.sha,
              files: [],
              error: 'unknown repo',
              root: m.root,
              requestId: m.requestId,
            });
            break;
          }
          const { files, truncated, error } = await getCommitDiff(cwd, m.sha, {
            log: (msg) => log.error('git', msg),
            timeoutMs: GIT_TIMEOUT.diff,
          });
          replyHere({
            type: 'git:commitDiffResult',
            sessionId: m.sessionId,
            sha: m.sha,
            files,
            ...(truncated ? { truncated } : {}),
            ...(m.root ? { root: m.root } : {}),
            ...(error ? { error } : {}),
            requestId: m.requestId,
          });
          break;
        }
        case 'git:blame': {
          const session = store.get(m.sessionId);
          if (!session) break;
          // Resolve the repo from the FILE's own directory, not the session's pinned repo: in a
          // multi-repo workspace the open file often lives in a different repo than the pin, and
          // blaming against the pin would reject every such file as "outside the repository".
          const cwd = path.dirname(m.path);
          const root = (await git(['rev-parse', '--show-toplevel'], cwd)).trim();
          if (!root) {
            replyHere({
              type: 'git:blameResult',
              sessionId: m.sessionId,
              path: m.path,
              lines: [],
              error: 'Not a git repository.',
            });
            break;
          }
          // Reject a path escaping the repo root — the renderer's path is never trusted into git.
          const rel = path.relative(root, m.path).split(path.sep).join('/');
          if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
            replyHere({
              type: 'git:blameResult',
              sessionId: m.sessionId,
              path: m.path,
              lines: [],
              error: 'File is outside the repository.',
            });
            break;
          }
          // Only a tracked file can be blamed; an untracked/new file is a silent no-op.
          const tracked =
            (
              await git(['--literal-pathspecs', 'ls-files', '--error-unmatch', '--', rel], root)
            ).trim() !== '';
          if (!tracked) {
            replyHere({ type: 'git:blameResult', sessionId: m.sessionId, path: m.path, lines: [] });
            break;
          }
          const lines = await getBlame(root, rel, { log: (msg) => log.error('git', msg) });
          replyHere({ type: 'git:blameResult', sessionId: m.sessionId, path: m.path, lines, root });
          break;
        }
        case 'git:headBlob': {
          const res = await readHeadBlob(m.path, {
            repoRoot: repoTopLevel,
            headSha: headShaFor,
            showBlob: (root, rel) => gitShowBlob(root, rel, 'head'),
          });
          // An untracked file is a normal outcome (whole-file added), not a failure.
          if (res.reason && res.reason !== 'untracked')
            log.debug('git', 'headBlob', { path: m.path, reason: res.reason });
          replyHere({
            type: 'git:headBlobResult',
            requestId: m.requestId,
            path: m.path,
            headSha: res.headSha,
            text: res.text,
            ...(res.reason ? { reason: res.reason } : {}),
          });
          break;
        }
        case 'git:rangeDiff': {
          const session = store.get(m.sessionId);
          if (!session) break;
          const key = rangeKey(m.base, m.head);
          const echoRoot = m.repoRoot !== undefined ? { repoRoot: m.repoRoot } : {};
          const fail = (error: string) =>
            replyHere({
              type: 'git:rangeDiffResult',
              sessionId: m.sessionId,
              key,
              files: [],
              error,
              requestId: m.requestId,
              ...echoRoot,
            });
          const cwd = await requestRepoRoot(session, m.repoRoot);
          if (cwd === null) {
            fail('unknown repo');
            break;
          }
          const error = await firstInvalidEndpoint(cwd, [m.base, m.head]);
          if (error) {
            fail(error);
            break;
          }
          const { files, truncated } = await getRangeDiff(cwd, m.base, m.head, {
            log: (msg) => log.error('git', msg),
          });
          replyHere({
            type: 'git:rangeDiffResult',
            sessionId: m.sessionId,
            key,
            files,
            ...(truncated ? { truncated } : {}),
            requestId: m.requestId,
            ...echoRoot,
          });
          break;
        }
        case 'review:setMark': {
          const root = normalizeRoot(m.root);
          // The renderer is the only sender today, but the file this writes outlives every window:
          // a malformed mark would be persisted and handed back to every future launch.
          if (!root || !isMark(m.mark)) break;
          reviewMarks = setReviewMark(reviewMarks, root, m.mark, m.on);
          reviewMarksDirty = true;
          persistFile(reviewMarksFile(), serializeMarksFile(reviewMarks), 'review-marks.json');
          // Every window, not just the sender: both may be showing the same repo (§4).
          broadcast({
            type: 'review:marks',
            repos: [{ root, marks: marksFor(reviewMarks, root) }],
          });
          break;
        }
        case 'review:loadNotes': {
          const root = normalizeRoot(m.root);
          if (!root) break;
          const data = reviewNotes.get(root) ?? readReviewNotesForProject(m.root);
          reviewNotes.set(root, data);
          replyHere({ type: 'review:notes', root, notes: data.notes });
          // One repo at a time, like the board watcher: re-pointing is what a source switch does.
          notesWatcher.watch(m.root, (external) => {
            reviewNotes.set(root, external);
            broadcast({ type: 'review:notes', root, notes: external.notes });
          });
          break;
        }
        case 'review:setNotes': {
          const root = normalizeRoot(m.root);
          if (!root) break;
          const current = reviewNotes.get(root) ?? readReviewNotesForProject(m.root);
          // `applyNotePatch` validates the payload itself (a malformed note is a no-op): this file
          // outlives every window, so nothing unchecked may be persisted into it.
          const next: ReviewNotesData = {
            version: 1,
            notes: applyNotePatch(current.notes, m.patch),
          };
          reviewNotes.set(root, next);
          // Every window, not just the sender: both may be showing the same repo (§4). Sent even
          // when nothing changed — that is what corrects a sender whose optimistic patch the
          // authoritative `applyNotePatch` refused (a body over the bound, an add at the cap).
          broadcast({ type: 'review:notes', root, notes: next.notes });
          // A refused or idempotent patch has nothing to persist; writing anyway would churn the
          // artifact in the user's repo and hand the watcher a pointless event.
          if (notesFingerprint(next) !== notesFingerprint(current)) {
            persistNotes(root, m.root, next);
          }
          break;
        }
        case 'plan:load': {
          const root = normalizeRoot(m.root);
          if (!root) break;
          try {
            const doc = await readPlan(root, m.slug);
            broadcast({
              type: 'plan:doc',
              root,
              slug: m.slug,
              markdown: doc.markdown ?? null,
              origin: 'load',
            });
            broadcast({
              type: 'plan:comments',
              root,
              slug: m.slug,
              comments: doc.comments,
              origin: 'load',
            });
          } catch (err) {
            broadcast({
              type: 'plan:error',
              root,
              slug: m.slug,
              op: 'load',
              message: planErrorText(err),
            });
          }
          break;
        }
        case 'plan:write': {
          const root = normalizeRoot(m.root);
          if (!root) break;
          // Before the fingerprint, not inside the write: a slug the write would reject anyway
          // must not leave a `lastWritten` entry keyed on it, and markdown the loader would
          // refuse must not reach the disk (electron/conduit-fs.ts planWriteRefusal).
          const refusal = planWriteRefusal(m.slug, m.markdown);
          if (refusal) {
            broadcast({ type: 'plan:error', root, slug: m.slug, op: 'write', message: refusal });
            break;
          }
          // Recorded BEFORE the write, unlike the notes path: the fs event can land before the
          // promise settles, and an unrecorded write comes back to the editor as an external
          // edit mid-keystroke (plan §"Settled decisions").
          planWatcher.recordWrite(root, m.slug, 'plan', contentHash(m.markdown));
          try {
            await writePlanFile(root, m.slug, m.markdown);
            broadcast({
              type: 'plan:doc',
              root,
              slug: m.slug,
              markdown: m.markdown,
              origin: 'write-ack',
            });
          } catch (err) {
            broadcast({
              type: 'plan:error',
              root,
              slug: m.slug,
              op: 'write',
              message: planErrorText(err),
            });
          }
          break;
        }
        case 'plan:setComments': {
          const root = normalizeRoot(m.root);
          if (!root) break;
          try {
            // Disk, not an in-memory copy: an agent may have replied in the sidecar since the
            // renderer last saw it, and the patch has to merge into that. The sidecar alone —
            // the markdown is not part of this write, and an unreadable plan must not block a
            // comment on it.
            const current = await readPlanComments(root, m.slug);
            const next = applyPlanCommentPatch(current, m.patch);
            // Sent even when nothing changed — that is what corrects a sender whose optimistic
            // patch `applyPlanCommentPatch` refused (text over the bound, an add at the cap).
            broadcast({
              type: 'plan:comments',
              root,
              slug: m.slug,
              comments: next,
              origin: 'ack',
            });
            const fingerprint = commentsFingerprint(next);
            if (fingerprint !== commentsFingerprint(current)) {
              planWatcher.recordWrite(root, m.slug, 'comments', fingerprint);
              await writePlanCommentsFile(root, m.slug, next);
            }
          } catch (err) {
            broadcast({
              type: 'plan:error',
              root,
              slug: m.slug,
              op: 'comments',
              message: planErrorText(err),
            });
          }
          break;
        }
        case 'git:resolveRange': {
          const session = store.get(m.sessionId);
          if (!session) break;
          const echoRoot = m.repoRoot !== undefined ? { repoRoot: m.repoRoot } : {};
          const cwd = await requestRepoRoot(session, m.repoRoot);
          if (cwd === null) {
            replyHere({
              type: 'git:resolveRangeResult',
              sessionId: m.sessionId,
              preset: m.preset,
              requestId: m.requestId,
              error: 'unknown repo',
              ...echoRoot,
            });
            break;
          }
          const revParse = async (ref: string): Promise<string | null> => {
            // Never let an option-like token reach the arg array (mirrors git:switch / refExists).
            if (!ref || ref.startsWith('-')) return null;
            const r = await runGit(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], {
              cwd,
              timeoutMs: GIT_TIMEOUT.metadata,
            });
            return r.ok ? r.stdout.trim() || null : null;
          };
          const res = await resolveRangePreset(m.preset, {
            revParse,
            upstreamRef: async () => {
              const r = await runGit(['rev-parse', '--abbrev-ref', '@{upstream}'], {
                cwd,
                timeoutMs: GIT_TIMEOUT.metadata,
              });
              return r.ok ? r.stdout.trim() || null : null;
            },
            mergeBase: async (a, b) => {
              const r = await runGit(['merge-base', a, b], {
                cwd,
                timeoutMs: GIT_TIMEOUT.metadata,
              });
              return r.ok ? r.stdout.trim() || null : null;
            },
          });
          replyHere({
            type: 'git:resolveRangeResult',
            sessionId: m.sessionId,
            preset: m.preset,
            requestId: m.requestId,
            ...res,
            ...echoRoot,
          });
          break;
        }
        case 'git:refs': {
          const session = store.get(m.sessionId);
          if (!session) break;
          const cwd = await requestRepoRoot(session, m.repoRoot);
          const echoRoot = m.repoRoot !== undefined ? { repoRoot: m.repoRoot } : {};
          if (cwd === null) {
            replyHere({
              type: 'git:refsResult',
              sessionId: m.sessionId,
              branches: [],
              current: null,
              remotes: [],
              tags: [],
              error: 'unknown repo',
              ...echoRoot,
            });
            break;
          }
          const { branches, current, remotes, tags } = await listRefs(cwd);
          log.debug('git', 'refs', {
            sessionId: m.sessionId,
            count: branches.length,
            remotes: remotes.length,
            tags: tags.length,
            current,
          });
          replyHere({
            type: 'git:refsResult',
            sessionId: m.sessionId,
            branches,
            current,
            remotes,
            tags,
            ...echoRoot,
          });
          break;
        }
        case 'git:switch': {
          const session = store.get(m.sessionId);
          if (!session) break;
          const cwd = requestGitRoot(session, m.repoRoot);
          const echoRoot = m.repoRoot !== undefined ? { repoRoot: m.repoRoot } : {};
          if (cwd === null) {
            replyHere({
              type: 'git:switchResult',
              sessionId: m.sessionId,
              ok: false,
              reason: 'failed',
              message: 'unknown repo',
              ...echoRoot,
            });
            break;
          }
          const ref = m.target.ref;
          // Re-enumerate and validate the ref against the host's own set — the renderer's
          // ref is never trusted into execFile.
          const { branches } = await listBranches(cwd);
          if (!isKnownRef(ref, branches)) {
            log.info('git', 'switch', { sessionId: m.sessionId, ref, ok: false, reason: 'failed' });
            replyHere({
              type: 'git:switchResult',
              sessionId: m.sessionId,
              ok: false,
              reason: 'failed',
              message: 'Unknown branch.',
              ...echoRoot,
            });
            break;
          }
          const busy = !!store.get(m.sessionId)?.busy;
          const dirty = busy ? false : await isDirty(cwd);
          const gate = decideSwitch({ busy, dirty });
          if (!gate.ok) {
            log.info('git', 'switch', {
              sessionId: m.sessionId,
              ref,
              ok: false,
              reason: gate.reason,
            });
            replyHere({
              type: 'git:switchResult',
              sessionId: m.sessionId,
              ok: false,
              reason: gate.reason,
              ...echoRoot,
            });
            break;
          }
          const result = await switchBranch(cwd, ref);
          log.info('git', 'switch', { sessionId: m.sessionId, ref, ok: result.ok });
          if (result.ok) {
            replyHere({ type: 'git:switchResult', sessionId: m.sessionId, ok: true, ...echoRoot });
          } else {
            replyHere({
              type: 'git:switchResult',
              sessionId: m.sessionId,
              ok: false,
              reason: 'failed',
              message: result.message,
              ...echoRoot,
            });
          }
          break;
        }
        case 'repo:pin':
          // Validate against the detected set before pinning (the renderer's root is untrusted).
          if (store.get(m.sessionId)?.repos?.some((r) => r.root === m.repoRoot)) {
            store.pinRepo(m.sessionId, m.repoRoot);
          }
          break;
        case 'repo:unpin':
          store.unpinRepo(m.sessionId);
          break;
        case 'repo:context': {
          const s = store.get(m.sessionId);
          if (s) {
            store.setAutoRepo(m.sessionId, repoForPath(s.repos ?? [], m.path));
          }
          break;
        }
        case 'rename':
          log.info('session', 'rename', { sessionId: m.id });
          await mutateSession(m.id, { op: 'rename', name: m.name });
          break;
        case 'setSessionIcon':
          await mutateSession(m.id, { op: 'setIconOverride', icon: m.icon });
          break;
        case 'relaunch':
          await callServer('sessions.relaunch', { sessionIds: [m.id] });
          break;
        case 'kill':
          await removeSession(m.id);
          break;
        case 'visible':
          presence.setVisible(senderId, m.ids);
          // What this window has on screen: the server's attention exemptions and ask gate read it.
          schedulePresence();
          {
            // gitDemand's set decides which windows get a session's repo deltas.
            const ownIds = repoTrackerHost.ownedIds(senderId, m.ids);
            gitDemand.setVisible(senderId, ownIds);
            // Unconditional, even for an unchanged set: a reloaded renderer re-posts the same
            // ids and has to re-hydrate from the cache.
            repoTrackerHost.windowShown(senderId, ownIds);
          }
          folders.visibilityChanged();
          for (const id of m.ids) if (deferredRepoScans.has(id)) scheduleRepoScan(id);
          break;
        case 'changes:subscribe':
          repoTrackerHost.setLinesDemand(senderId, m.sessionIds);
          break;
        case 'repo:refresh':
          repoTrackerHost.refresh(m.sessionId, m.root);
          break;
        case 'duplicate': {
          log.info('session', 'duplicate', { sessionId: m.id });
          const dup = await callServer('sessions.duplicate', { sessionId: m.id });
          // Owner = the source session's owner (same window), falling back to the sender.
          assignOwner(sessionOwner, dup.sessionId, sessionOwner.get(m.id) ?? senderId);
          postState();
          schedulePresence();
          break;
        }
        case 'reorderSessions':
          await callServer('sessions.reorder', { order: m.order });
          break;
        case 'updateSettings': {
          // Coerce before persisting: drops unknown keys, clamps ranges, whitelists enum strings,
          // and runs the legacy codeBg→surfaceColor migration. Server keys are not this message's.
          const before = { logging: settings.logging, logLevel: settings.logLevel };
          settings = uiOnly(
            coerceSettings(m.settings as unknown as Record<string, unknown>),
            settings,
          );
          persistFile(settingsFile(), serializeSettings(settings), 'settings.json');
          // Push the new diagnostics level to the live logger (no restart). Log AFTER the
          // level update so a just-enabled level captures its own enabling.
          log.setLevel(settings.logging ? settings.logLevel : 'off');
          log.info('settings', 'save', {
            logging: settings.logging,
            logLevel: settings.logLevel,
          });
          if (before.logging !== settings.logging || before.logLevel !== settings.logLevel)
            serverClient()
              ?.call('server.setLogging', {
                logging: settings.logging,
                logLevel: settings.logLevel,
              })
              .catch((err: unknown) =>
                log.warn('server', 'setLogging failed', { err: String(err) }),
              );
          // Broadcast the settings the host actually kept: every OTHER window learns of the
          // change only from a broadcast, which for an idle session can be never otherwise.
          postState();
          break;
        }
        case 'updateServerSettings':
          try {
            const r = await callServer('serverSettings.patch', { patch: serverPatchOf(m.patch) });
            settings = mirrorServerKeys(settings, r.settings);
            persistFile(settingsFile(), serializeSettings(settings), 'settings.json');
            replyHere({
              type: 'serverSettings:result',
              requestId: m.requestId,
              ok: true,
              settings: r.settings,
            });
          } catch (err) {
            log.warn('settings', 'server settings patch failed', { err: String(err) });
            replyHere({
              type: 'serverSettings:result',
              requestId: m.requestId,
              ok: false,
              settings,
            });
          }
          // On a failure this re-broadcasts the mirror, reverting the window's optimistic edit.
          postState();
          break;
        case 'revealInExplorer':
          log.info('shell', 'reveal', { path: m.path });
          if (revealActionFor(m.path) === 'openPath') {
            void shell.openPath(m.path);
          } else {
            shell.showItemInFolder(m.path);
          }
          break;
        case 'openExternalPath':
          // Open the file with its OS-default associated app. Path only (never a URL),
          // so there's no scheme-injection hazard beyond opening a file the user
          // right-clicked — which they could already do via Reveal.
          log.info('shell', 'open-external-path', { path: m.path });
          void shell.openPath(m.path);
          break;
        case 'openWith': {
          log.info('shell', 'open-with', { path: m.path });
          // Native OS "Open with…" application chooser. Windows has a CLI primitive
          // (OpenAs_RunDLL); elsewhere fall back to the default-app open so the menu
          // item is never dead. Detached + unref so the chooser UI outlives this turn.
          const cmd = openWithCommand(process.platform, m.path);
          if (cmd) {
            spawn(cmd.command, cmd.args, { detached: true, windowsHide: false }).unref();
          } else {
            void shell.openPath(m.path);
          }
          break;
        }
        case 'indexProject': {
          if (m.incremental) await e2eHold?.('topup');
          const owners = store.list().filter((s) => sessionContains(s, m.root));
          if (owners.length && !owners.some((s) => gitDemand.isVisible(s.id))) {
            const key = `${senderId}\0${folderKey(m.root)}`;
            deferredIndexes.set(key, {
              root: m.root,
              windowId: senderId,
              run: () =>
                void queueProjectIndex(
                  m.root,
                  m.seeds ?? [],
                  senderId,
                  log,
                  m.incremental ? 'incremental' : 'full',
                ),
            });
            break;
          }
          await queueProjectIndex(
            m.root,
            m.seeds ?? [],
            senderId,
            log,
            m.incremental ? 'incremental' : 'full',
          );
          break;
        }
        case 'resolveModule': {
          const root = store.get(m.sessionId)?.home;
          if (!root) {
            replyHere({
              type: 'resolveModuleResult',
              requestId: m.requestId,
              ok: false,
              reason: 'no session',
            });
            break;
          }
          const key = resolveCacheKey(root, m.fromFile, m.specifier);
          let value = touchResolution(moduleResolveCache, key);
          const fresh = value === undefined;
          const startedAt = Date.now();
          if (value === undefined) {
            const r = await resolveModuleWithClosure(m.fromFile, m.specifier, root);
            value = r.ok ? r.value : { failed: r.reason };
            rememberResolution(moduleResolveCache, key, value);
          }
          if ('failed' in value) {
            if (fresh)
              log.info('index', 'resolve-miss', { specifier: m.specifier, reason: value.failed });
            replyHere({
              type: 'resolveModuleResult',
              requestId: m.requestId,
              ok: false,
              reason: value.failed,
            });
            break;
          }
          // These files are outside the index's own selection, so this window's "already sent"
          // set has to learn about them or the next `fsChanged` top-up re-streams them and
          // inflates the progress counters the status line reports. Only this window gets them.
          const stream = projectIndexState.get(root)?.streams.get(senderId);
          if (stream)
            for (const f of value.files) {
              stream.sent.add(f.path);
              stream.resolved.add(f.path);
            }
          if (fresh) {
            log.info('index', 'resolve-hit', {
              specifier: m.specifier,
              entry: value.entry,
              files: value.files.length,
              // The walk + closure read, which is the cost the cache exists to avoid paying
              // twice — and the number a slow navigation gets blamed on.
              ms: Date.now() - startedAt,
            });
          }
          replyHere({
            type: 'resolveModuleResult',
            requestId: m.requestId,
            ok: true,
            entry: value.entry,
            files: value.files,
          });
          break;
        }
        case 'requestBoard': {
          // The board + its has-spec indicators (G3) + pipeline-queue summary (N3), sent
          // as one consistent batch. Always re-tagged with the request's path (m.path) so
          // a stale watcher reply for a previous project can't land in the renderer.
          // `dispatch` is the requester's reply for the immediate push and `broadcast` for
          // the armed watcher's later changes (multi-window Slice A).
          const sendBoardBundle =
            (dispatch: Dispatch) => (board: ReturnType<typeof readBoardForProject>) => {
              dispatch({ type: 'board', path: m.path, board });
              dispatch({ type: 'specsList', path: m.path, cardIds: listSpecs(m.path) });
              dispatch({
                type: 'pipelineQueue',
                path: m.path,
                summary: summarizeQueue(readPipelineQueueForProject(m.path).entries),
              });
            };
          // Per-project board at `<root>/.conduit/board.json` (empty if absent/none).
          sendBoardBundle(replyHere)(readBoardForProject(m.path));
          // Live watch so an external agent's edits update the open board without reopening.
          boardWatcher.watch(m.path, sendBoardBundle(broadcast));
          // Surface any pending board proposal (N1) + watch for it appearing/clearing live.
          sendProposal(replyHere, m.path, 'board');
          armProposalWatch(m.path);
          break;
        }
        case 'updateBoard':
          // Surface a failed save (don't swallow, unlike the legacy root-board write) so a
          // committed artifact is never silently mistaken for saved (ADR §5). Record the
          // self-write fingerprint ONLY on success: if the write rejects, the file on disk
          // is unchanged, so the watcher's echo guard must not be primed with a payload
          // that never landed (which would suppress a later genuine external edit).
          writeBoardArtifactFile(m.path, m.board)
            .then(() => {
              boardWatcher.recordWrite(fingerprint(m.board));
              log.info('artifact', 'board write', { path: m.path });
            })
            .catch((err: unknown) => {
              const message = err instanceof Error ? err.message : String(err);
              console.error('Failed to write .conduit/board.json:', message);
              replyHere({ type: 'error', message: `Could not save board: ${message}` });
            });
          break;
        case 'requestSpec': {
          // A card's spec at `<root>/.conduit/specs/<id>.md` (G3). Absent = empty content,
          // `exists: false` — the renderer seeds a heading from the card title it holds.
          const content = readSpec(m.path, m.cardId);
          replyHere({
            type: 'spec',
            path: m.path,
            cardId: m.cardId,
            content: content ?? '',
            exists: content !== null,
          });
          break;
        }
        case 'saveSpec':
          // Surface a failed save (don't swallow) so a committed artifact is never silently
          // mistaken for saved (ADR §5). On success, re-emit the spec list so the indicator
          // appears on a newly-specced card without a board reload.
          writeSpec(m.path, m.cardId, m.content)
            .then(() => {
              log.info('artifact', 'spec write', { path: m.path, cardId: m.cardId });
              // Shared path-tagged indicator update — broadcast (non-current windows ignore).
              broadcast({ type: 'specsList', path: m.path, cardIds: listSpecs(m.path) });
            })
            .catch((err: unknown) => {
              const message = err instanceof Error ? err.message : String(err);
              console.error('Failed to write .conduit/specs:', message);
              replyHere({ type: 'error', message: `Could not save spec: ${message}` });
            });
          break;
        case 'requestArchitecture':
          // Read from `.conduit/architecture.json`, migrating the legacy bare
          // `<root>/architecture.json` forward when `.conduit/` doesn't have it yet.
          replyHere({
            type: 'architecture',
            path: m.path,
            doc: readArchitectureForProject(m.path),
          });
          // Surface any pending architecture proposal (N1) + watch for changes live.
          sendProposal(replyHere, m.path, 'architecture');
          armProposalWatch(m.path);
          break;
        case 'updateArchitecture':
          // Write the committed `.conduit/` envelope atomically. Unlike the legacy
          // swallowing write, surface a failed save to the renderer (ADR §5) so a
          // committed artifact is never silently mistaken for saved.
          writeArchitectureArtifactFile(m.path, m.doc).catch((err: unknown) => {
            const message = err instanceof Error ? err.message : String(err);
            console.error('Failed to write .conduit/architecture.json:', message);
            replyHere({ type: 'error', message: `Could not save architecture: ${message}` });
          });
          break;
        case 'requestProposal':
          // Surface the current proposal state for a kind (N1). `null` when none pending.
          sendProposal(replyHere, m.path, m.kind);
          break;
        case 'acceptProposal': {
          // Apply the proposed whole document to the canonical file, delete the proposal,
          // then push BOTH the now-empty proposal state (clears the banner) and the fresh
          // canonical doc (so the view reflects the applied change without a reload). The
          // canonical write records a self-write fingerprint so the board watcher doesn't
          // re-emit our own apply as an external edit. Post-write pushes are path-tagged
          // shared updates → broadcast; only the error goes back to the requester.
          const kind = m.kind;
          acceptProposal(m.path, kind)
            .then(() => {
              if (kind === 'board')
                boardWatcher.recordWrite(fingerprint(readBoardForProject(m.path)));
              sendCanonical(broadcast, m.path, kind);
              if (kind === 'board')
                broadcast({ type: 'specsList', path: m.path, cardIds: listSpecs(m.path) });
              sendProposal(broadcast, m.path, kind);
            })
            .catch((err: unknown) => {
              const message = err instanceof Error ? err.message : String(err);
              console.error('Failed to accept proposal:', message);
              replyHere({ type: 'error', message: `Could not accept proposal: ${message}` });
            });
          break;
        }
        case 'rejectProposal': {
          // Delete the proposal; the canonical doc is untouched. Re-push the (now-null)
          // proposal state so the banner clears even without a live watch event.
          const kind = m.kind;
          rejectProposal(m.path, kind)
            .then(() => sendProposal(broadcast, m.path, kind))
            .catch((err: unknown) => {
              const message = err instanceof Error ? err.message : String(err);
              console.error('Failed to reject proposal:', message);
              replyHere({ type: 'error', message: `Could not reject proposal: ${message}` });
            });
          break;
        }
        case 'requestPipeline':
          // Per-project skill-per-transition config at `<root>/.conduit/pipeline.json`
          // (empty if absent/none). The board encodes the pipeline, not just the status (G4).
          replyHere({ type: 'pipeline', path: m.path, config: readPipelineForProject(m.path) });
          break;
        case 'updatePipeline':
          // Human-owned config; surface a failed save (ADR §5), never swallow it.
          writePipelineArtifactFile(m.path, m.config).catch((err: unknown) => {
            const message = err instanceof Error ? err.message : String(err);
            console.error('Failed to write .conduit/pipeline.json:', message);
            replyHere({ type: 'error', message: `Could not save pipeline: ${message}` });
          });
          break;
        case 'queueTransition': {
          // SURFACE, not execute: record the transition to `.conduit/pipeline-queue.json`
          // for an external agent (or the user) to act on. Conduit cannot run a Claude Code
          // skill itself — this is the consumable hook only. Best-effort: the card has
          // already moved, so a failed append is surfaced but never blocks anything.
          const qPath = m.path;
          appendPipelineQueueEntry(
            qPath,
            buildQueueEntry({ id: m.cardId, title: m.cardTitle }, m.from, m.to, m.skill),
          )
            .then(() => {
              // Re-emit the updated queue summary so the header badge increments live
              // (path-tagged shared update → broadcast).
              broadcast({
                type: 'pipelineQueue',
                path: qPath,
                summary: summarizeQueue(readPipelineQueueForProject(qPath).entries),
              });
            })
            .catch((err: unknown) => {
              const message = err instanceof Error ? err.message : String(err);
              console.error('Failed to record pipeline transition:', message);
              replyHere({ type: 'error', message: `Could not record transition: ${message}` });
            });
          break;
        }
        case 'searchFiles': {
          // Quick-open corpus (Mod+P): back it with the shared project index (git ls-files —
          // gitignore-respecting, uncapped) so files past walkFiles' BFS cap surface and
          // ignored trees (vendor/, target/, .venv/, …) don't. A non-git root gets its repos'
          // listings plus loose files the same way (projectFileIndexMeta).
          const session = store.get(m.sessionId);
          if (!session || !searchRootAllowed(session, m.root) || !isIndexScope(m.scope)) {
            log.warn('search', 'files-refused', { sessionId: m.sessionId, root: m.root });
            break;
          }
          const { files } = await projectFileIndexMeta(m.root, {
            scope: m.scope,
            fresh: m.fresh === true,
          });
          replyHere({
            type: 'searchResults',
            root: m.root,
            results: indexToSearchHits(files, m.root),
          });
          break;
        }
        case 'contentSearch': {
          // Project-wide find-in-files (L5), driven from the shared file index: a git root's
          // listing, a non-git root's repo listings plus loose files, or the capped walk
          // (scope 'everything', or git did not answer). The index's own walk is reused rather
          // than walked again inside the time budget. Result caps, the time budget and the
          // binary/large-file skips still apply. `requestId` is echoed back so a newer query
          // supersedes this (stale) reply in the renderer. Wrapped so a throw (e.g. a vanished
          // root) surfaces as an inline error.
          const session = store.get(m.sessionId);
          if (!session || !searchRootAllowed(session, m.root) || !isIndexScope(m.scope)) {
            log.warn('search', 'content-refused', { sessionId: m.sessionId, root: m.root });
            replyHere({
              type: 'contentSearchResults',
              requestId: m.requestId,
              root: m.root,
              results: [],
              truncated: false,
              error: STR_SEARCH_REFUSED,
            });
            break;
          }
          let res: {
            results: Awaited<ReturnType<typeof searchContentFs>>['files'];
            truncated: boolean;
            truncatedBy?: TruncatedBy;
            error?: string;
          };
          const gen = ++contentSearchSeq;
          contentSearchGen.set(m.root, gen);
          const isCancelled = () => contentSearchGen.get(m.root) !== gen;
          try {
            const { files: indexed, capped } = await projectFileIndexMeta(m.root, {
              scope: m.scope,
            });
            const candidates = indexed.map((f) => ({ rel: f.rel, abs: f.abs.replace(/\\/g, '/') }));
            const r = await searchContentFs(m.root, m.query, isCancelled, candidates);
            // A walk that hit its cap never offered the rest of the tree.
            const truncatedBy = r.truncatedBy ?? (capped ? 'limit' : undefined);
            res = {
              results: r.files,
              truncated: r.truncated || capped,
              ...(truncatedBy ? { truncatedBy } : {}),
              error: r.error,
            };
            log.debug('search', 'content', {
              root: m.root,
              matches: r.files.length,
              truncated: res.truncated,
              truncatedBy,
            });
          } catch (e: unknown) {
            res = {
              results: [],
              truncated: false,
              error: e instanceof Error ? e.message : String(e),
            };
          }
          replyHere({
            type: 'contentSearchResults',
            requestId: m.requestId,
            root: m.root,
            results: res.results,
            truncated: res.truncated,
            ...(res.truncatedBy ? { truncatedBy: res.truncatedBy } : {}),
            error: res.error,
          });
          break;
        }
        case 'term:start':
          log.info('pty', 'start', { sessionId: m.sessionId, windowId: senderId });
          await terminals.start(m);
          break;
        case 'timer:set': {
          // The server re-sanitizes and recomputes; a rejection is a toast, never a silent drop (§3).
          const res = await callServer('timers.set', { schedule: m.schedule });
          if (res.error) replyHere({ type: 'timer:error', ...res.error });
          break;
        }
        case 'timer:offer':
          await callServer('timers.offer', { sessionId: m.sessionId, action: m.action });
          break;
        case 'timer:cancel':
          await callServer('timers.cancel', { id: m.id });
          break;
        case 'timer:renew':
          await timerCall(replyHere, 'timers.renew', { id: m.id });
          break;
        case 'timer:sendNow':
          await timerCall(replyHere, 'timers.sendNow', { id: m.id });
          break;
        case 'timer:sendOnce':
          await timerCall(replyHere, 'timers.sendOnce', {
            sessionId: m.sessionId,
            message: m.message,
          });
          break;
        case 'timer:test': {
          // Smoke-only seam: the server refuses it unless started with --e2e (§7).
          const { type: _type, ...params } = m;
          if (e2e) await callServer('timers.test', params);
          break;
        }
        case 'mcp:compose':
        case 'mcp:thread:get':
        case 'mcp:markRead':
        case 'mcp:allowMore':
        case 'mcp:pause':
        case 'mcp:attachment:get':
        case 'mcp:retry':
        case 'mcp:setToolPolicy':
        case 'mcp:askAnswer':
        case 'mcp:uiResult': {
          const r = await callServer('mcp.fromRenderer', { windowId: senderId, message: m });
          if (r.reply) replyHere(r.reply);
          break;
        }
        case 'term:input':
          terminals.input(m.sessionId, m.data);
          break;
        case 'term:resize':
          log.debug('pty', 'resize', { sessionId: m.sessionId, cols: m.cols, rows: m.rows });
          terminals.resize(m.sessionId, m);
          break;
        case 'term:facts':
          terminals.facts(m.sessionId, m.facts);
          break;
        case 'term:dispose':
          // Slice B: the source window's pane unmounting mid-move must not detach the target's
          // fresh link (same sessionId). Swallowed once.
          if (movingSessions.delete(m.sessionId)) {
            log.debug('pty', 'dispose-skipped-moving', { sessionId: m.sessionId });
            break;
          }
          log.debug('pty', 'dispose', { sessionId: m.sessionId });
          terminals.dispose(m.sessionId);
          break;
        case 'pathExists': {
          // D11: cheap existence check for terminal path-link validation. Intentionally
          // no workspace-containment guard — this is read-only (no write surface), and
          // the renderer can already open any path via readFile, which is also unguarded
          // by workspace roots. Only `exists` and `isDir` are returned; no file content.
          // Async and UNC-budgeted (plan 2026-10-16-terminal-path-links T4.1): a click on a share
          // must not block the main thread. The reply is correlated by the echoed path.
          const kind = await pathLinks.probe(m.path);
          replyHere({
            type: 'pathExistsResult',
            path: m.path,
            exists: kind !== null,
            isDir: kind === 'dir',
          });
          break;
        }
        case 'resolvePathToken': {
          // Roots off the LIVE cwd (sessionGitRoot), never the pinned active repo, and tries
          // every other session root too (plan 2026-10-16-terminal-path-links Contracts).
          const requestId = typeof m.requestId === 'number' ? m.requestId : -1;
          try {
            const reply = await pathLinks.resolve(m.sessionId, m.tokens);
            replyHere({
              type: 'resolvePathTokenResult',
              sessionId: m.sessionId,
              requestId,
              ...reply,
            });
          } catch (err) {
            // Exactly one reply per request: the pane settles every pending token of the batch.
            log.warn('links', 'resolve-failed', { error: String(err) });
            replyHere({
              type: 'resolvePathTokenResult',
              sessionId: m.sessionId,
              requestId,
              cwd: '',
              rootsSig: '',
              roots: [],
              results: [],
            });
          }
          break;
        }
        case 'validateCommits': {
          // terminal-commit-link: confirm candidate hashes are real commits in the repo the
          // terminal's LIVE cwd sits in (sessionGitRoot) — NOT the UI-pinned active repo, which
          // would false-negative (or, with a colliding short-sha, link the wrong repo's commit)
          // when the pin differs from cwd. `root` rides the reply so a click can scope Review to
          // this same repo. Unknown session / failure → empty results (renderer renders plain).
          const session = store.get(m.sessionId);
          let results: CommitValidation[] = [];
          let root: string | undefined;
          if (session) {
            try {
              root = await sessionGitRoot(session, git);
              results = await validateCommits(root, m.tokens);
            } catch {
              results = [];
              root = undefined;
            }
          }
          replyHere({ type: 'validateCommitsResult', sessionId: m.sessionId, results, root });
          break;
        }
        case 'win:new':
          // Multi-window Slice A: open an additional empty window (no sessions). Its
          // ready→postState shows it with zero owned sessions → empty-state CTA.
          spawnWindow();
          break;
        case 'session:move': {
          // Multi-window Slice B: reassign a live session's owner window via the shared
          // moveSessionToWindow helper (no PTY restart; the engine is process-global and
          // untouched). `kind:'new'` spawns a fresh window as the target.
          if (!store.get(m.sessionId)) break;
          let targetId: number;
          if (m.target.kind === 'new') {
            targetId = spawnWindow().id;
          } else {
            const tw = windows.get(m.target.windowId);
            // Reject a move to a window that is gone/closing (spec edge case): keep ownership
            // unchanged and surface an error to the SENDER window.
            if (!tw || tw.webContents.isDestroyed()) {
              replyHere({ type: 'error', message: 'That window is no longer available.' });
              break;
            }
            targetId = m.target.windowId;
          }
          moveSessionToWindow(m.sessionId, targetId);
          log.info('session', 'move', { sessionId: m.sessionId, targetId });
          break;
        }
        case 'session:dragEnd': {
          // Multi-window Slice C: a session tab's drag ended at global SCREEN coords. HTML5 DnD
          // doesn't cross BrowserWindow bounds, so we hit-test the drop point here.
          if (!store.get(m.sessionId)) break;
          const point = { x: m.screenX, y: m.screenY };
          // Drop back over the SOURCE window → no-op (an in-strip reorder, if any, already
          // applied client-side). windowAtPoint excludes the source, so without this guard a
          // drop home would fall through to tear-out. windowAtPoint over a one-element list
          // containing only the source returns its id iff the point is inside it.
          if (windowAtPoint(point, [{ id: senderId, bounds: senderWin.getBounds() }], -1) != null) {
            break;
          }
          const wins = [...windows.entries()].map(([id, w]) => ({ id, bounds: w.getBounds() }));
          const targetId = windowAtPoint(point, wins, senderId);
          if (targetId != null) {
            moveSessionToWindow(m.sessionId, targetId);
            log.info('window', 'drag-move', { sessionId: m.sessionId, targetId });
            break;
          }
          // No window under the point → tear out a NEW window at the drop point.
          const display = screen.getDisplayNearestPoint(point).workArea;
          const newWin = spawnWindow();
          newWin.setBounds(tearOutBounds(point, { width: 1440, height: 900 }, display));
          moveSessionToWindow(m.sessionId, newWin.id);
          log.info('window', 'drag-move', { sessionId: m.sessionId, targetId: 'tear-out' });
          break;
        }
        case 'updateCheck':
          checkForUpdate();
          break;
        case 'updateRelaunch':
          closeGuard.requestAppQuit('update', senderId);
          break;
        case 'server:retry':
          await lifecycle?.retry();
          break;
        case 'server:restartService':
          await lifecycle?.restartService();
          break;
        case 'server:stopAllAndContinue':
          await lifecycle?.stopAllAndContinue();
          break;
        case 'server:restartAgentsToUpdate':
          await lifecycle?.stopAllAndContinue();
          break;
        case 'stopAgentsFailureDecision': {
          const ask = stopFailureAsks.get(m.requestId);
          if (ask?.windowId === senderId) ask.settle(m.choice);
          break;
        }
        case 'app:quitAndStopAgents':
          closeGuard.requestAppQuit('quitAndStop', senderId);
          break;
        case 'session:retryLaunch':
          await terminals.retryLaunch(m.sessionId);
          break;
        case 'session:discardLaunch':
          await callServer('sessions.discardLaunch', { sessionId: m.sessionId });
          break;
        case 'quitAck':
          closeGuard.onAck(senderId, m.requestId);
          break;
        case 'quitDialogShown':
          closeGuard.onShown(senderId, m.requestId);
          break;
        case 'quitDecision': {
          const ask = quitAsks.get(senderId);
          if (ask?.requestId === m.requestId) {
            if (ask.reason !== 'windowClose' || !m.proceed) quitAsks.delete(senderId);
            if (!m.proceed) stopAgentsOnQuit = false;
            else if (m.stopAgents && ask.reason !== 'windowClose') stopAgentsOnQuit = true;
          }
          closeGuard.onDecision(senderId, m.requestId, m.proceed);
          break;
        }
      }
    } catch (err: unknown) {
      const refusal = serverDownReply(m, err);
      if (refusal) {
        replyHere(refusal);
        return;
      }
      const message = err instanceof Error ? err.message : String(err);
      log.error('ipc', `handler failed: ${m.type}`, { message });
      replyHere({ type: 'error', message });
    }
  }

  ipcMain.on('to-host', (e, m: WebviewToHost) => void handle(m, e));

  // The legitimate set of folders the editor may write into: every open session's
  // project folder plus the recently-opened repo history. These are exactly the
  // roots the file explorer / editor opened files from, so confining writes to them
  // lets the editor save what it opened while rejecting anything outside the tree.
  const writeRoots = (): string[] => {
    const set = new Set<string>();
    for (const s of store.list()) {
      if (s.home) set.add(s.home);
      for (const r of s.roots) set.add(r);
    }
    for (const r of repos) if (r.path) set.add(r.path);
    return [...set];
  };

  // Language servers (ADR 0006). Built after writeRoots: a server's root must sit inside one.
  // Peek targets are read for the reply only — never a grant, never a fileContent (spec §3.2).
  const LSP_TARGET_MAX_BYTES = 2 * 1024 * 1024;
  const lspSearch: SearchContext = {
    env: process.env,
    platform: hostPlatform,
    homedir: os.homedir(),
    tmpdir: os.tmpdir(),
    isFile: (p) =>
      fs.promises.stat(p).then(
        (st) => st.isFile(),
        () => false,
      ),
    realpath: (p) => fs.promises.realpath(p),
    execFile: (file, args, o) =>
      execFileBounded(file, args, o, {
        spawn: (f, a, so) => spawn(f, a, so),
        tree: defaultTreeKillDeps(),
      }),
  };
  // Workspace Trust lives in userData, never a repo (docs/specs/archive/2026-09-23-workspace-trust.md).
  const trustFile = path.join(userData(), 'workspace-trust.json');
  let trustRaw = '';
  try {
    trustRaw = fs.readFileSync(trustFile, 'utf8');
  } catch (e: unknown) {
    // Missing on first run; unreadable (EACCES, EISDIR) is treated like corrupt JSON — an empty
    // store, so every folder stays Restricted rather than the app failing to start.
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
      log.warn('lsp', 'workspace-trust.json unreadable; starting with nothing trusted', {
        error: String(e),
      });
    }
  }
  let trustStore = parseTrustStore(trustRaw, hostPlatform);
  const lspManager = new LspManager({
    trustStore: {
      get: () => trustStore,
      set: (s) => {
        trustStore = s;
        persistFile(trustFile, serializeTrustStore(s), 'workspace-trust.json');
      },
    },
    broadcastTrust: (state) => broadcast({ type: 'lsp:trust', ...state }),
    homeDir: os.homedir(),
    registry: LANGUAGE_SERVERS,
    platform: hostPlatform,
    workspaceRoots: writeRoots,
    resolveBinary: (spec) => resolveServerBinary(spec, lspSearch),
    resolveRoot: (p, spec) =>
      resolveServerRoot(
        p,
        writeRoots(),
        spec,
        {
          exists: (f) =>
            fs.promises.access(f).then(
              () => true,
              () => false,
            ),
          realpath: (f) => fs.promises.realpath(f),
          list: (d) => fs.promises.readdir(d).catch(() => []),
        },
        hostPlatform,
      ),
    startServer: ({ spec, resolved, root }) =>
      startLanguageServer({
        spec,
        binary: resolved.binary,
        toolDir: resolved.toolDir,
        root,
        hostEnv: process.env,
        platform: hostPlatform,
        spawn: (file, args, o) => spawn(file, [...args], o),
        tree: defaultTreeKillDeps(),
        log,
      }),
    watchRoot: (root, spec, onChanges, onMarker, onGone) =>
      watchServerRoot(
        root,
        {
          matches: compileWatchGlobs(spec.watchGlobs, spec.watchIgnoreDirs),
          isMarker: compileRootMarkers(spec),
        },
        onChanges,
        onMarker,
        onGone,
        { log: (m) => log.warn('lsp', m) },
      ),
    readTarget: async (p) => {
      try {
        const st = await fs.promises.stat(p);
        if (!st.isFile() || st.size > LSP_TARGET_MAX_BYTES) return null;
        return await fs.promises.readFile(p, 'utf8');
      } catch {
        return null;
      }
    },
    broadcastStatus: (status) => broadcast({ type: 'lsp:status', status }),
    log,
  });
  // A reload keeps the webContents id; the preload's per-load epoch handles that. This only
  // releases a window that is gone for good.
  const lspTracked = new Set<number>();
  ipcMain.handle('lsp', (e, raw: unknown) => {
    const sender = e.sender;
    if (!lspTracked.has(sender.id)) {
      const id = sender.id;
      lspTracked.add(id);
      sender.once('destroyed', () => {
        lspTracked.delete(id);
        lspManager.dropWebContents(id);
      });
    }
    return lspManager.handle(sender.id, raw);
  });

  // HTML preview transport (ADR 0005). The allow-set is keyed on the GUEST because one
  // process-global preview session serves every window; the host owns it because the host
  // is the enforcement point.
  const allowedGuests = new Set<number>();

  const sendToGuestHost = (guest: WebContents, msg: HostToWebview) => {
    const target = guest.hostWebContents;
    if (target && !target.isDestroyed()) target.send('to-webview', msg);
  };

  const notifyBlocked = (guestId: number | undefined, host: string) => {
    if (guestId === undefined) return;
    const guest = webContents.fromId(guestId);
    if (guest) sendToGuestHost(guest, { type: 'html:networkBlocked', guestId, host });
  };

  registerPreviewProtocol(
    session.fromPartition(PREVIEW_PARTITION),
    // A callback, not a snapshot: roots change as sessions open and close.
    writeRoots,
    (guestId) => guestId !== undefined && allowedGuests.has(guestId),
    notifyBlocked,
  );

  // Write-file IPC (I2 + K2). A trust boundary: the renderer can ask to write any path,
  // so the host validates containment (src/path-guard) before touching disk. A write is
  // ALSO allowed when its canonical real path is a recorded read-grant — a file the host
  // itself served via readFile (go-to-definition / out-of-root recent), which can live
  // outside every write root. Grants hold exact files only (see src/read-grants.ts);
  // validateWrite is never weakened. Returns a typed result; on rejection or failure the
  // renderer keeps the buffer dirty and surfaces the reason (banner + toast).
  ipcMain.handle('writeFile', async (_e, p: string, content: string, rawOpts?: unknown) => {
    const opts = parseWriteOptions(rawOpts);
    if (opts === null) return { ok: false as const, error: 'Invalid write options.' };
    try {
      return await writeFile(p, content, writeRoots(), readGrants, opts);
    } catch (e: unknown) {
      return { ok: false as const, error: e instanceof Error ? e.message : String(e) };
    }
  });

  // Git-action IPC (L1). Request/response (like writeFile) so a stage/unstage/discard/
  // stash result or error propagates back to the renderer, which then re-fetches the
  // change list. A trust boundary: validate `root` is a KNOWN workspace root before
  // touching git/disk, so the untrusted renderer can't drive git in an arbitrary
  // directory. Per-path containment within that root is enforced by planGitAction.
  ipcMain.handle('git-action', async (_e, req: GitActionRequest): Promise<GitActionResult> => {
    try {
      if (!req?.root || !writeRoots().some((r) => isInsideRoot(req.root, r))) {
        return { ok: false, error: 'Unknown or untrusted repository root.' };
      }
      log.info('git', `action ${req.op}`, { root: req.root });
      return await executeGitAction(req);
    } catch (e: unknown) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  });

  // File-tree mutation IPC (L2). Request/response (like writeFile / git-action) so a
  // create/rename/delete result or error propagates back to the renderer, which then
  // re-reads the affected directory. A trust boundary: src/fs-mutations validates that
  // EVERY path stays inside a known workspace root before touching disk, so the
  // untrusted renderer can't create/rename/delete anywhere outside the tree. Delete
  // goes to the OS recycle bin via shell.trashItem (injected); a trash failure is
  // surfaced, never silently turned into a permanent delete.
  ipcMain.handle('fs-mutate', async (_e, req: FsMutationRequest): Promise<MutationResult> => {
    try {
      const roots = writeRoots();
      log.info('fs', `mutate ${req.op}`, {
        path: req.op === 'rename' ? req.to : req.path,
        ...(req.op === 'rename' ? { from: req.from } : {}),
      });
      switch (req.op) {
        case 'createFile':
          return await createFile(req.path, roots);
        case 'createDir':
          return await createDir(req.path, roots);
        case 'rename':
          return await renamePath(req.from, req.to, roots);
        case 'remove':
          return await remove(req.path, roots, (p) => shell.trashItem(p));
        case 'removePermanent':
          return await removePermanent(req.path, roots);
        default:
          return { ok: false, error: 'Unknown mutation.' };
      }
    } catch (e: unknown) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  });

  // Drag-and-drop move/copy IPC (D5). Both `from` and `to` are path-guard validated
  // so the renderer cannot move/copy files outside any workspace root.
  // Destination existence is checked before touching disk — no silent overwrite.
  ipcMain.handle('fs-move', async (_e, from: string, to: string, opts?: DndOpts) => {
    try {
      return await fsMove(from, to, writeRoots(), opts);
    } catch (e: unknown) {
      return { ok: false as const, error: e instanceof Error ? e.message : String(e) };
    }
  });
  ipcMain.handle('fs-copy', async (_e, from: string, to: string, opts?: DndOpts) => {
    try {
      return await fsCopy(from, to, writeRoots(), opts);
    } catch (e: unknown) {
      return { ok: false as const, error: e instanceof Error ? e.message : String(e) };
    }
  });
  // OS drag-and-drop import: copy external files/folders into a target dir inside a root.
  // Only the TARGET is path-guarded; the sources are arbitrary OS paths the user dragged in.
  ipcMain.handle(
    'fs-import',
    async (
      _e,
      sources: string[],
      targetDir: string,
      opts?: { onConflict?: ImportConflictPolicy },
    ) => {
      try {
        return await fsImport(sources, targetDir, writeRoots(), opts);
      } catch (e: unknown) {
        return { ok: false as const, error: e instanceof Error ? e.message : String(e) };
      }
    },
  );

  // Skill installer (spec 2026-07-06): list the app's bundled skills + copy one into the open
  // project's or the user-global `.claude/skills`. The renderer passes the project root (it owns
  // that state); `null` means no project open, so only global installs are possible.
  ipcMain.handle('skills-list', (_e, projectRoot: string | null): SkillInfo[] =>
    listSkills(projectRoot),
  );
  ipcMain.handle(
    'skills-install',
    (_e, id: string, dest: SkillDestination, projectRoot: string | null): SkillInstallResult =>
      installSkill(id, dest, projectRoot),
  );

  // MCP install (spec 2026-10-27-conduit-mcp-install §3.6): nothing is written without a click.
  ipcMain.handle('mcpInstall:status', (_e, p: unknown) =>
    callServer('mcp.installStatus', { projectPath: typeof p === 'string' ? p : null }).catch(
      installDownStatus,
    ),
  );
  ipcMain.handle('mcpInstall:act', async (_e, v: unknown) => {
    const req = coerceInstallRequest(v);
    if (!req) throw new Error('invalid mcpInstall request');
    const r = await callServer('mcp.installAct', { request: req }).catch((err: unknown) =>
      installDownResult(req, err),
    );
    if (r.ok && r.permissionErrorCode) {
      log.warn('mcp-install', 'permission rule not written', {
        cli: req.cli,
        code: r.permissionErrorCode,
      });
    }
    return r;
  });

  // Diagnostics bundle (Slice B): assemble a version/OS header + the already-redacted
  // recent log tail into a file under the logs dir, then reveal it. The header carries only
  // explicit version facts — never a process.env dump. Best-effort; returns null on failure.
  ipcMain.handle('copyDiagnostics', () => {
    const bundle = log.buildDiagnostics({
      appVersion: app.getVersion(),
      electron: process.versions.electron ?? '',
      chrome: process.versions.chrome ?? '',
      node: process.versions.node ?? '',
      platform: process.platform,
      osRelease: os.release(),
    });
    if (bundle) {
      log.info('app', 'diagnostics-bundle', { path: bundle });
      shell.showItemInFolder(bundle);
    }
    return bundle;
  });

  // Recent log tail for Settings→About (Slice B). Bounded host-side; disk content is already
  // redacted. `off` lets the renderer show a "logging is off" note instead of an empty block.
  ipcMain.handle('readLogTail', (_e, n: number) => {
    if (log.isOff()) return { off: true, tail: '' };
    return { off: false, tail: log.readTail(typeof n === 'number' ? n : 100) };
  });

  // Custom window controls (native title bar is hidden). Multi-window Slice A: act on the
  // window that hosts the clicking renderer (e.sender), not a global window.
  ipcMain.on('win:minimize', (e) => BrowserWindow.fromWebContents(e.sender)?.minimize());
  ipcMain.on('win:toggleMaximize', (e) => {
    const w = BrowserWindow.fromWebContents(e.sender);
    if (w?.isMaximized()) w.unmaximize();
    else w?.maximize();
  });
  ipcMain.on('win:close', (e) => BrowserWindow.fromWebContents(e.sender)?.close());
  ipcMain.handle(
    'win:isMaximized',
    (e) => BrowserWindow.fromWebContents(e.sender)?.isMaximized() ?? false,
  );

  // Renderer asks the host to open a link in the real browser (non-destructive).
  ipcMain.on('open-external', (_e, url: string) => openExternalUrl(url));

  // The persisted settings, delivered SYNCHRONOUSLY at preload time. Asynchronous delivery (the
  // `state` broadcast, which the renderer only gets after its `ready`) is a round-trip too late:
  // the renderer had already mounted on DEFAULT_SETTINGS and painted whole frames of the wrong
  // theme/fonts/pane widths before the real ones arrived. Registered above window creation, so
  // no preload can ever outrun it.
  ipcMain.on('settings:initial', (e) => {
    e.returnValue = settings;
  });
  ipcMain.on('pty:windowsPty', (e) => {
    e.returnValue = currentWindowsPty();
  });

  // before-quit fires again for every app.quit() inside one quit (window-all-closed re-quits);
  // teardown runs once. See dirty-quit-guard plan, Slice 1 run notes.
  let tornDown = false;
  app.on('before-quit', (ev) => {
    if (tornDown) return;
    if (!quitGrant.consume()) {
      // Snapshot first: if the process dies while the guard waits, state is already on disk (B2).
      flushStateSync();
      ev.preventDefault();
      closeGuard.requestAppQuit('quit');
      return;
    }
    tornDown = true;
    // Flag the quit BEFORE the cleanup below so the per-window close events fired during
    // teardown take the quit branch (preserve sessions for restore), not the per-window
    // dispose branch (Slice C).
    isQuitting = true;
    log.info('app', 'quit');
    // Capture the final state SYNCHRONOUSLY + atomically while windows + ownership are intact.
    // Synchronous so it completes before the auto-update installer can force-kill the process
    // (async writes would be truncated → data loss). Agents keep running in hc (F4).
    flushStateSync();
    terminals.closeAll();
    lifecycle?.dispose();
    hcEvents.close();
    hc.close();
    if (layoutPersistTimer) clearTimeout(layoutPersistTimer);
    boardWatcher.stop();
    notesWatcher.stop();
    planWatcher.stop();
    folders.stop();
    proposalWatcher.stop();
    openFileWatcher.stop();
    stopUpdater();
    // Close every git-dir watch and cancel pending refreshes so
    // no fs.watch handle or timer keeps the main process alive past quit.
    gitDemand.stop();
    deferredProjectRequests.clear();
    deferredIndexes.clear();
    pendingFsByWindow.clear();
    repoTrackerHost.stop();
    lspManager.killAllSync();
  });

  // Every close of a window (custom ✕, Alt+F4, taskbar) goes through the guard; the close re-fires
  // once the guard proceeds, and during a quit the teardown's closes pass straight through.
  const onWindowClose = (w: BrowserWindow, ev: Electron.Event) => {
    log.info('window', 'close', { windowId: w.id });
    if (isQuitting || windowConfirmed.has(w.id)) return;
    ev.preventDefault();
    closeDecision(w);
  };

  // Factory for an additional/empty window (New Window + the primary). Wires the engine-scoped
  // close guard + cleanup of the per-window confirm flag on 'closed'.
  function spawnWindow(opts?: { primary?: boolean }): BrowserWindow {
    const w = createWindow({
      primary: opts?.primary,
      onClose: onWindowClose,
      onNavigationStart: (windowId) => {
        presence.startLoading(windowId);
        schedulePresence();
      },
      onGone: (windowId) => {
        closeGuard.onWindowGone(windowId);
        // A crashed renderer that is not reloaded fires no navigation, so reset here too.
        presence.startLoading(windowId);
        schedulePresence();
      },
      onUnresponsive: (windowId) => closeGuard.onUnresponsive(windowId),
      onSessionEnd: flushStateSync,
      onClosed: (windowId) => {
        releaseNotesOffers.delete(windowId);
        closeGuard.onWindowGone(windowId);
        presence.drop(windowId);
        sidebarUiByWindow.delete(windowId);
        // Its visible-session set dies with it, or sessions it was showing would stay
        // exempt from attention forever.
        schedulePresence();
        windowConfirmed.delete(windowId);
        gitDemand.dropWindow(windowId);
        repoTrackerHost.dropWindow(windowId);
        deferredProjectRequests.delete(windowId);
        pendingFsByWindow.delete(windowId);
        for (const [key, request] of deferredIndexes)
          if (request.windowId === windowId) deferredIndexes.delete(key);
        for (const [root, state] of projectIndexState) {
          state.streams.delete(windowId);
          if (!state.streams.size) projectIndexState.delete(root);
        }
        folders.windowClosed(windowId);
        log.info('window', 'closed', { windowId });
        // A closed window drops out of the move picker (Slice B).
        broadcastWinList?.();
      },
    });
    // The webContents is destroyed with the window, so the id is captured now. `closed` drops it
    // even for a window that never spoke LSP, which the channel's `destroyed` hook never sees.
    const wcId = w.webContents.id;
    w.once('closed', () => lspManager.dropWebContents(wcId));
    w.on('minimize', () => {
      gitDemand.setSuspended(w.id, true);
      lspManager.setWindowMinimized(wcId, true);
    });
    w.on('restore', () => {
      gitDemand.setSuspended(w.id, false);
      repoTrackerHost.windowRestored(w.id);
      lspManager.setWindowMinimized(wcId, false);
    });
    log.info('window', 'create', { windowId: w.id });
    closeGuard.onWindowCreated(w.id);
    broadcastWinList?.();
    schedulePersistLayout?.(); // a new window changes the layout (Slice C)
    return w;
  }

  Menu.setApplicationMenu(null);

  // Restore the multi-window LAYOUT (Slice C, overrides Slice A D-4): the windows at their saved
  // bounds, each owning its saved sessions. The server's list arrives once connected; a session
  // the layout doesn't name goes to the focused window then (sessionsApplied). The first planned
  // window is the primary (the cold-launch OS-open + second-instance fallback target).
  const savedLayout = settings.restoreSessions
    ? parseWindowLayout(readBlob(windowsLayoutFile()))
    : [];
  const restorePlan = planLayoutRestore(
    savedLayout,
    savedLayout.flatMap((w) => w.sessionIds),
  );
  const workAreas = screen.getAllDisplays().map((d) => d.workArea);
  for (let i = 0; i < restorePlan.length; i++) {
    const planned = restorePlan[i];
    const w = spawnWindow({ primary: i === 0 });
    w.setBounds(clampBoundsToDisplays(planned.bounds, workAreas));
    if (planned.sidebarUi) sidebarUiByWindow.set(w.id, planned.sidebarUi);
    for (const id of planned.sessionIds) assignOwner(sessionOwner, id, w.id);
  }
  // planLayoutRestore always yields ≥1 window, but guard against an empty plan defensively.
  if (windows.size === 0) spawnWindow({ primary: true });
  log.info('window', 'layout-restore', { windows: windows.size });
  postState();

  app.on('activate', () => {
    if (windows.size === 0) spawnWindow({ primary: true });
  });

  // Harden every guest <webview>'s own webContents once (app-level, not per window): gate every
  // window-open (no guest ever gets a real window) and block non-http(s) navigation.
  //
  // Preview guests (ADR 0005) branch INSIDE this listener rather than registering a second
  // one: a second setWindowOpenHandler silently replaces this handler for every guest, and a
  // second will-navigate listener cannot re-allow what this one already preventDefault'ed.
  app.on('web-contents-created', (_e, contents) => {
    if (contents.getType() !== 'webview') return;
    const guestId = contents.id;
    // Keyed on the URL rather than on `contents.session === previewSession`: session identity
    // holds, but only as an undocumented implementation detail.
    const isPreviewGuest = () => isPreviewUrl(contents.getURL());

    // A preview guest's external open is denied and surfaced, never handed to openExternalUrl:
    // that passes the FULL url — query string included — to shell.openExternal, and
    // HandlerDetails carries no user-gesture flag, so `window.open('https://x/?d=' + page)`
    // would exfiltrate silently. The renderer's Allow affordance lands in Slice 3.
    const gateExternal = (url: string) => notifyBlocked(guestId, new URL(url).hostname);

    const openGate = createGuestOpenGate();
    contents.on('input-event', (_ev, input) => openGate.noteInput(input, Date.now()));

    contents.setWindowOpenHandler(({ url, disposition }) => {
      if (isPreviewGuest()) {
        if (isPreviewUrl(url)) {
          void contents.loadURL(url).catch((err: unknown) => {
            log.warn('preview', 'popup load failed', { url, error: String(err) });
          });
        } else if (isHttpUrl(url)) {
          gateExternal(url);
        }
        return { action: 'deny' };
      }
      const route = openGate.route(url, disposition, Date.now());
      if (route === 'in-app-background' || route === 'in-app-foreground') {
        const background = route === 'in-app-background';
        sendToGuestHost(contents, { type: 'web:openTab', guestId, url, background });
      } else if (route === 'external') {
        openExternalUrl(url);
      }
      return { action: 'deny' };
    });
    contents.on('will-navigate', (navEvent, url) => {
      if (isPreviewGuest()) {
        if (isPreviewUrl(url)) return;
        navEvent.preventDefault();
        if (isHttpUrl(url)) gateExternal(url);
        return;
      }
      if (!isHttpUrl(url)) navEvent.preventDefault();
    });
    // Focus inside a guest page means the host renderer never sees these keydowns, and
    // <webview> exposes no DOM equivalent of before-input-event.
    contents.on('before-input-event', (_ev, input) => {
      if (input.type !== 'keyDown' || !isPreviewGuest()) return;
      const key =
        input.key === 'Escape'
          ? 'Escape'
          : (input.control || input.meta) && input.key.toLowerCase() === 'f'
            ? 'Find'
            : null;
      if (key) sendToGuestHost(contents, { type: 'html:guestKey', guestId, key });
    });
    contents.on('destroyed', () => allowedGuests.delete(guestId));
  });

  // The OS integrations launch `Conduit.exe "<path>"`. "Open in Conduit" passes a folder;
  // "Open with Conduit" / a default-editor association passes a file. Classify the launch
  // target and route accordingly; a new session runs the server's first agent, a shell. Used for
  // both a second launch and this first launch.
  const classifyPath = (p: string): 'dir' | 'file' | 'none' => {
    try {
      const st = fs.statSync(p);
      if (st.isDirectory()) return 'dir';
      if (st.isFile()) return 'file';
      return 'none';
    } catch {
      return 'none';
    }
  };

  // Open a lone file launched from the OS: root its session at the file's git repo (else its
  // parent dir), reuse an existing session whose home is the nearest ancestor of the
  // file (else create one at the root), then tell the renderer to open the doc. The host has
  // no view of which docs are open in the renderer, so the nearest-ancestor (Rule 2) reuse is
  // all that applies here; the renderer's own resolveOwningSession Rule 1 still de-dupes an
  // already-open file when the doc actually opens.
  const openFileFromOS = async (
    filePath: string,
    ownerWindowId: number,
  ): Promise<string | undefined> => {
    const root = gitRootOf(filePath, (p) => fs.existsSync(p)) ?? path.dirname(filePath);
    const existing = resolveOwningSession({
      path: filePath,
      sessions: store.list().map((s) => ({ id: s.id, home: s.home, roots: s.roots })),
      openDocs: [],
      activeId: null,
    });
    const send = (sessionId: string) =>
      sendOpenFileInEditor({ type: 'openFileInEditor', path: filePath, sessionId, source: 'os' });
    const sessionId = existing ?? (await openFromOS(root, ownerWindowId));
    if (sessionId) send(sessionId);
    return sessionId;
  };

  /** A new session for an OS open, once the server's agents are known. */
  const openFromOS = async (home: string, ownerWindowId: number): Promise<string | undefined> => {
    try {
      await serverCalls.whenConnected();
      if (!lifecycle) throw new ServerCallError('disconnected', 'Background service unavailable');
      await waitForServerSnapshot(firstSnapshot, lifecycle);
    } catch (err) {
      log.warn('app', 'os-open unavailable', { home, err: String(err) });
      dialog.showErrorBox('Conduit', 'No terminals available.');
      return undefined;
    }
    const agentId = stores.agents[0]?.id;
    if (!agentId) {
      dialog.showErrorBox('Conduit', 'No terminals available.');
      return undefined;
    }
    try {
      return (await openRepo(home, agentId, ownerWindowId)).sessionId;
    } catch (err) {
      log.warn('app', 'os-open failed', { home, err: String(err) });
      return undefined;
    }
  };

  // OS opens are owned by the given window (multi-window Slice A): the focused window for a
  // warm second-instance, the primary window at cold launch.
  /** Resolves with the session the open landed in, once it has. */
  const openArg = async (
    argv: readonly string[],
    ownerWindowId: number,
  ): Promise<string | undefined> => {
    // argv[0] is the executable (the absolute path to Conduit.exe on a packaged build); skip
    // it explicitly, else classifyPath would return the exe itself as the file to open.
    const target = extractOpenTarget(argv, classifyPath, [process.execPath, argv[0] ?? '']);
    if (!target) return undefined;
    log.info('app', 'os-open', { kind: target.kind, path: target.path });
    const p = hasShortComponent(target.path)
      ? await expandShortNames(target.path, hostShortNameDeps)
      : target.path;
    return target.kind === 'dir' ? openFromOS(p, ownerWindowId) : openFileFromOS(p, ownerWindowId);
  };

  app.on('second-instance', (_event, argv) => {
    log.info('app', 'second-instance');
    const target = focusedWindow();
    void openArg(argv, target?.id ?? primaryWindowId);
    if (target) {
      if (target.isMinimized()) target.restore();
      target.focus();
    }
  });

  // First launch opened via the context menu while the app was closed → primary window.
  const coldOpen = openArg(process.argv, primaryWindowId);
  // Smoke-only: the open waits for the server, so it lands after the first state; a scenario
  // waits for it before acting, else its session appears mid-scenario and takes the selection.
  if (process.env.CONDUIT_E2E === '1') (global as Record<string, unknown>).__coldOpen = coldOpen;

  startServer().catch((err: unknown) =>
    log.error('server', 'start failed', { err: err instanceof Error ? err.message : String(err) }),
  );
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
