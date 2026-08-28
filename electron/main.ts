import { execFile, spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  app,
  BrowserWindow,
  dialog,
  type IpcMainEvent,
  ipcMain,
  Menu,
  Notification,
  screen,
  shell,
} from 'electron';
import { activeCwd, gitRootForSession, sessionGitRoot } from '../src/active-cwd';
import { repoForPath } from '../src/active-repo';
import { AgentRegistry } from '../src/agent-registry';
import { atomicWriteFile, atomicWriteFileSync } from '../src/atomic-write';
import { fingerprint } from '../src/board-watch';
import { type CommitValidation, isCommitHex, parseBatchCheck } from '../src/commit-token';
import { loadAgents, readBlob } from '../src/config';
import { searchContentFs } from '../src/content-search-fs';
import { decideCrashRecovery } from '../src/crash-recovery';
import { cwdReportingAugmentation } from '../src/cwd-reporting';
import { indexToSearchHits, walkFiles } from '../src/file-search';
import {
  readDiff,
  readDir,
  readFile,
  UNMERGED,
  type Unmerged,
  writeFile,
} from '../src/file-service';
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
import { interrogateGit, isDirty, listBranches, listRefs, switchBranch } from '../src/git-info';
import { createAsyncMemo } from '../src/git-memo';
import { fullyQualifiedRef, type RefEndpoint, rangeKey } from '../src/git-range';
import { decideSwitch, isKnownRef } from '../src/git-switch';
import { type HeadBlobShow, readHeadBlob } from '../src/head-blob';
import { IgnoreCache, isAuthoritative } from '../src/ignore-cache';
import { importClosure } from '../src/import-graph';
import { type BellScanState, countBareBells } from '../src/last-line';
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
import { shouldRaiseOsAttention } from '../src/os-attention';
import { CwdScanner } from '../src/osc-cwd';
import { isAncestorOf, normalizePath, resolveOwningSession } from '../src/owning-session';
import { isInsideAnyRoot, isInsideRoot } from '../src/path-guard';
import { type IndexedFile, resolveToken, type TokenResolution } from '../src/path-resolve';
import {
  parseDocs,
  restoreSessions,
  serializeDocs,
  serializeSessions,
  shouldPersistSessions,
} from '../src/persistence';
import { buildQueueEntry } from '../src/pipeline';
import { getProjectInfo } from '../src/project-info';
import type {
  AboutInfo,
  DiffBase,
  HostToWebview,
  PersistedDoc,
  RepoDTO,
  WebviewToHost,
} from '../src/protocol';
import { PtyHost, resolveLaunchSpec } from '../src/pty-host';
import { summarizeQueue } from '../src/queue-summary';
import type { QuitReason } from '../src/quit-guard';
import { busySessions, needsQuitConfirm, runningSessions } from '../src/quit-guard';
import { resolveRangePreset } from '../src/range-preset';
import { createGrantStore, hostCanonical } from '../src/read-grants';
import { filterExistingRepos, restoreRepos, serializeRepos, upsertRepo } from '../src/repo-history';
import { repoRelPath } from '../src/repo-rel';
import { detectRepos } from '../src/repo-scan';
import { revealActionFor } from '../src/reveal-action';
import {
  isMark,
  marksFor,
  normalizeRoot,
  parseMarksFile,
  serializeMarksFile,
  setMark as setReviewMark,
} from '../src/review-marks';
import { applyNotePatch, notesFingerprint, type ReviewNotesData } from '../src/review-notes';
import { orphanScrollbackFiles, scrollbackFileName } from '../src/scrollback-files';
import {
  appendScrollback,
  neutralizeReplay,
  restoreScrollback,
  SCROLLBACK_CAP_BYTES,
  scrollbackReplayPadding,
  serializeScrollback,
} from '../src/scrollback-persistence';
import { SessionActivity } from '../src/session-activity';
import { SessionManager } from '../src/session-manager';
import {
  type AppSettings,
  coerceSettings,
  restoreSettings,
  serializeSettings,
} from '../src/settings';
import { detectShells } from '../src/shells';
import type { SkillDestination, SkillInfo, SkillInstallResult } from '../src/skills';
import {
  INDEX_FILE_CAP,
  isOversizedForIndex,
  newIndexPaths,
  selectIndexCandidates,
} from '../src/source-index';
import { groundForTheme } from '../src/theme-ground';
import { loadTsconfigChain } from '../src/tsconfig-discovery';
import { type TsconfigDTO, toTsconfigDTO } from '../src/tsconfig-map';
import type { SpawnSpec } from '../src/types';
import { hardenWebviewPrefs, isHttpUrl } from '../src/webview-guard';
import {
  assignOwner,
  buildWinList,
  clampBoundsToDisplays,
  groupByProject as groupOwnedByProject,
  type OwnerMap,
  parseLayout,
  planLayoutRestore,
  removeOwner,
  serializeLayout,
  sessionsForWindow as sessionsOwnedBy,
  tearOutBounds,
  type WindowLayout,
  windowAtPoint,
} from '../src/window-registry';
import { extractOpenTarget, gitRootOf } from './arg-utils';
import { BoardWatcher } from './board-watcher';
import {
  acceptProposal,
  appendPipelineQueueEntry,
  listSpecs,
  type ProposalKind,
  readArchitectureForProject,
  readArchitectureProposal,
  readBoardForProject,
  readBoardProposal,
  readPipelineForProject,
  readPipelineQueueForProject,
  readReviewNotesForProject,
  readSpec,
  rejectProposal,
  removeReviewNotesArtifactFile,
  writeArchitectureArtifactFile,
  writeBoardArtifactFile,
  writePipelineArtifactFile,
  writeReviewNotesArtifactFile,
  writeSpec,
} from './conduit-fs';
import { Logger } from './logger';
import { NotesWatcher } from './notes-watcher';
import { OpenFileWatcher } from './open-file-watcher';
import { ProjectWatcher } from './project-watcher';
import { ProposalWatcher } from './proposal-watcher';
import { installSkill, listSkills } from './skills-service';
import { checkForUpdate, initUpdater, quitAndInstall } from './updater';

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
    };
  }
}

const aboutInfo: AboutInfo = readAboutInfo();

// Allow WebGL even when the GPU is blocklisted/unavailable, so the shader
// background (and xterm's WebGL renderer) work via software rendering as a
// fallback. Must run before app 'ready'.
app.commandLine.appendSwitch('ignore-gpu-blocklist');
app.commandLine.appendSwitch('enable-unsafe-swiftshader');

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
let primaryWindowId = -1;
// Stable 1-based display ordinal per window id, assigned in creation order. Used as the
// fallback `win:list` title ("Window 2") for a window that owns no named session yet, so
// the move picker stays stable even as windows open/close (multi-window Slice B).
const windowOrdinal = new Map<number, number>();
let nextWindowOrdinal = 1;
// Most-recently-focused window id, tracked on each window's `focus` event. Used to
// route launch targets when no window currently holds OS focus.
let lastFocusedWindowId = -1;
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
// window’s history is collected with it. See docs/specs/2026-08-20-renderer-crash-recovery.md.
const crashReloads = new WeakMap<BrowserWindow, number[]>();

const windowFor = (sessionId: string): BrowserWindow | undefined =>
  windows.get(sessionOwner.get(sessionId) ?? -1);

const focusedWindow = (): BrowserWindow | undefined =>
  BrowserWindow.getFocusedWindow() ??
  windows.get(lastFocusedWindowId) ??
  windows.values().next().value;

// Set by the app-ready closure; invoked on window focus so the git indicator self-heals
// against an external `git checkout` made while the app was unfocused (Slice A refresh).
let onWindowFocus: (() => void) | null = null;

// Set by the app-ready closure; broadcasts the `win:list` picker payload (needs the engine
// to count owned sessions). Called on window create/close/focus + after a session move
// (multi-window Slice B).
let broadcastWinList: (() => void) | null = null;

const userData = () => app.getPath('userData');
const sessionsFile = () => path.join(userData(), 'sessions.json');
const agentsFile = () => path.join(userData(), 'agents.json');
const reposFile = () => path.join(userData(), 'repos.json');
// Per-file "I've reviewed this" marks (spec 2026-08-27-review-supercharge §2 Lane B). Lives in
// userData beside sessions.json — never in the reviewed repo, where it would read as a change.
const reviewMarksFile = () => path.join(userData(), 'review-marks.json');
const settingsFile = () => path.join(userData(), 'settings.json');
// Persisted multi-window layout (geometry + per-window owned sessions) for restore-across-
// restart (Slice C). Mirrors sessionsFile(); gated on the same `restoreSessions` setting.
const windowsLayoutFile = () => path.join(userData(), 'windows.json');
// Persisted editor tabs (editor-tabs-persist), a SIBLING of sessions.json so a corrupt tab
// blob can never break session restore (spec §3.2 D3). Restore is gated on `restoreSessions`.
const docsFile = () => path.join(userData(), 'docs.json');
// Per-terminal-session scrollback (T2). One file per session; naming + sanitize live in
// src/scrollback-files.ts so the startup orphan sweep matches the exact same filenames.
const scrollbackFile = (sessionId: string) => path.join(userData(), scrollbackFileName(sessionId));

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
const contentSearchGen = new Map<string, number>();

// path-links v1: per-project file index for token suffix-search, cached briefly so files
// created after the cache was built still become linkable without a manual refresh.
const FILE_INDEX_TTL_MS = 5000;
const fileIndexCache = new Map<string, { files: IndexedFile[]; at: number; fromGit: boolean }>();

const statKind = (absPath: string): 'file' | 'dir' | null => {
  try {
    return fs.statSync(absPath).isDirectory() ? 'dir' : 'file';
  } catch {
    return null;
  }
};

/** Build (or reuse, within the TTL) the project file index for `root`. Prefers `git ls-files`
 *  (fast, respects .gitignore, includes untracked-but-not-ignored); falls back to a bounded
 *  filesystem walk when the root isn't a git repo. `fromGit` distinguishes the two so callers
 *  that only want the gitignore-respecting set (content search) can tell them apart. */
async function projectFileIndexMeta(
  root: string,
  opts: { fresh?: boolean } = {},
): Promise<{ files: IndexedFile[]; fromGit: boolean }> {
  const cached = fileIndexCache.get(root);
  // An incremental index is triggered BY a filesystem change, so serving it the TTL cache
  // would hand back exactly the pre-change listing it was called to notice. It still WRITES
  // the cache, so the refresh is shared with whatever asks next.
  if (!opts.fresh && cached && Date.now() - cached.at < FILE_INDEX_TTL_MS)
    return { files: cached.files, fromGit: cached.fromGit };
  let files: IndexedFile[];
  let fromGit: boolean;
  const lsFiles = await git(['ls-files', '--cached', '--others', '--exclude-standard'], root);
  if (lsFiles.trim()) {
    fromGit = true;
    files = lsFiles
      .split('\n')
      .map((rel) => rel.trim())
      .filter(Boolean)
      .map((rel) => ({ rel, abs: `${root}/${rel}` }));
  } else {
    fromGit = false;
    // A generous cap for the non-git fallback: this index also backs the source index for
    // go-to-definition, and the search-sized default truncated deep source directories out
    // of it (they were never even offered to selectIndexHits).
    files = walkFiles(root, 20000).map((h) => ({ rel: h.rel, abs: h.abs.replace(/\\/g, '/') }));
  }
  fileIndexCache.set(root, { files, at: Date.now(), fromGit });
  return { files, fromGit };
}

async function projectFileIndex(root: string): Promise<IndexedFile[]> {
  return (await projectFileIndexMeta(root)).files;
}

/** Files per `projectFiles` chunk — small enough that building one can't cost the renderer
 *  a frame, large enough that a 5000-file project is ~25 messages, not 5000. */
const INDEX_CHUNK_SIZE = 200;

/** What the source index has already streamed per root, so a `fsChanged` top-up sends only
 *  the files that appeared since — the whole point of the incremental path (spec contract 5).
 *  `nextSeq` keeps chunk ordinals monotonic per root: a top-up must never be `seq === 0`,
 *  which is the chunk that owns the compiler options. */
const projectIndexState = new Map<string, { sent: Set<string>; nextSeq: number }>();

/** On-demand module resolutions, keyed by root so a whole project's entries can be dropped in
 *  one pass — see docs/specs/2026-08-21-goto-definition-flows.md §1. A failure is cached too:
 *  a specifier that resolves nowhere would otherwise pay a full walk on every retry. */
const moduleResolveCache = new Map<string, CachedResolution>();

/** In-flight index work per root: the run to chain behind, and whether a top-up is already
 *  waiting for it. */
const indexRuns = new Map<string, { tail: Promise<void>; incrementalQueued: boolean }>();

/**
 * Run at most ONE index per root at a time, with at most one top-up queued behind it.
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
  reply: (msg: HostToWebview) => void,
  log: Logger,
  incremental: boolean,
): Promise<void> {
  const run = indexRuns.get(root) ?? { tail: Promise.resolve(), incrementalQueued: false };
  indexRuns.set(root, run);
  if (incremental && run.incrementalQueued) return run.tail;
  if (incremental) run.incrementalQueued = true;
  run.tail = run.tail.then(async () => {
    if (incremental) run.incrementalQueued = false;
    try {
      await indexProjectSources(root, seeds, reply, log, { incremental });
    } catch (e) {
      log.warn('index', 'project-index-failed', { root, incremental, error: String(e) });
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
  reply: (msg: HostToWebview) => void,
  log: Logger,
  opts: { incremental?: boolean } = {},
): Promise<void> {
  const prior = projectIndexState.get(root);
  // An incremental request for a root this process never indexed (a reloaded renderer) is a
  // full index, not a no-op — otherwise the root would never be indexed at all.
  const incremental = !!opts.incremental && prior !== undefined;
  // A re-index means the tree was re-read; a resolution cached against the old one may name a
  // file that has since moved.
  dropResolutionsForRoot(moduleResolveCache, root);

  const index = (await projectFileIndexMeta(root, { fresh: incremental })).files;
  const selected = selectIndexCandidates(
    index.map((f) => ({ rel: f.rel, abs: f.abs.replace(/\\/g, '/') })),
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

  // Read once, reuse for both the closure walk and the chunk payload.
  const cache = new Map<string, { content: string; language: string } | null>();
  const readCached = async (abs: string) => {
    const hit = cache.get(abs);
    if (hit !== undefined) return hit;
    const dto = await readFile(abs);
    const value = dto.binary || dto.error ? null : { content: dto.content, language: dto.language };
    cache.set(abs, value);
    return value;
  };

  const state = prior ?? { sent: new Set<string>(), nextSeq: 0 };
  projectIndexState.set(root, state);

  let ordered: string[];
  let priorityCount = 0;
  if (incremental) {
    ordered = newIndexPaths(
      hits.map((h) => h.abs),
      state.sent,
    );
    if (!ordered.length) {
      log.info('index', 'project-index-unchanged', { root });
      return;
    }
  } else {
    const candidates = new Set(hits.map((h) => h.abs));
    const normalizedSeeds = seeds.map((s) => s.replace(/\\/g, '/'));
    const priority = await importClosure(normalizedSeeds, candidates, async (p) => {
      const v = await readCached(p);
      return v?.content ?? null;
    });
    const prioritySet = new Set(priority);
    priorityCount = priority.length;
    ordered = [...priority, ...hits.map((h) => h.abs).filter((p) => !prioritySet.has(p))];
    state.sent = new Set<string>();
  }

  const total = ordered.length;
  const tsconfig = incremental ? undefined : readProjectTsconfig(root, log);
  let seq = state.nextSeq;
  for (let i = 0; i < total || seq === 0; i += INDEX_CHUNK_SIZE) {
    const slice = ordered.slice(i, i + INDEX_CHUNK_SIZE);
    const files: { path: string; content: string; language: string }[] = [];
    for (const abs of slice) {
      const dto = await readCached(abs);
      if (dto) files.push({ path: abs, content: dto.content, language: dto.language });
      state.sent.add(abs);
    }
    const done = i + INDEX_CHUNK_SIZE >= total;
    reply({
      type: 'projectFiles',
      root,
      files,
      seq,
      total,
      done,
      skipped,
      capped,
      ...(incremental ? { supplemental: true as const } : {}),
      ...(seq === 0 && tsconfig ? { tsconfig } : {}),
    });
    seq += 1;
    state.nextSeq = seq;
    if (done) break;
  }
  log.info('index', incremental ? 'project-index-topup' : 'project-indexed', {
    root,
    total,
    priority: priorityCount,
    skipped,
    capped,
  });
}

/** Resolve a batch of raw path tokens to candidate files for the terminal link provider.
 *  `root` is the session's cwd git root (see {@link sessionGitRoot}); tokens still resolve
 *  relative to `rawCwd` (the live cwd), which can be a subdir of `root`. */
async function resolvePathTokens(
  rawCwd: string,
  root: string,
  tokens: string[],
): Promise<TokenResolution[]> {
  const cwd = rawCwd.replace(/\\/g, '/');
  const files = await projectFileIndex(root);
  // Case-insensitive on Windows/macOS, sensitive on Linux — mirror the host filesystem.
  const caseSensitive = process.platform === 'linux';
  return tokens.map((t) => resolveToken(t, { cwd, root, files, caseSensitive }, statKind));
}

// terminal-commit-link: a commit oid is immutable, so collapse repeat validations across
// re-paints with a short TTL cache keyed by `${root}\0${token}` (mirrors FILE_INDEX_TTL_MS).
const COMMIT_VALIDATE_TTL_MS = 5000;
const commitValidateCache = new Map<string, { commit: string | null; at: number }>();

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

/**
 * Of `names` (a directory's children), the subset git ignores — via `git check-ignore`
 * with the names piped on stdin (cwd = the dir). check-ignore echoes each matched path
 * exactly as fed in, so the output lines are the child names to mark.
 *
 * Returns `null` when git did NOT answer (timeout, missing binary, crash). An empty Set
 * means "nothing here is ignored" and is only returned when git actually said so — exit 0,
 * exit 1 (nothing matched) or exit 128 (not a repo). Conflating the two is what made the
 * Explorer flicker: a timed-out call also leaves stdout empty, so every entry in the
 * directory briefly lost its dimming. See src/ignore-cache.ts.
 */
async function ignoredEntries(dir: string, names: string[]): Promise<Set<string> | null> {
  if (names.length === 0) return new Set();
  const r = await runGit(['check-ignore', '--stdin'], {
    cwd: dir,
    timeoutMs: GIT_TIMEOUT.metadata,
    maxBuffer: 4 * 1024 * 1024,
    stdin: `${names.join('\n')}\n`,
  });
  if (!isAuthoritative(r)) return null;
  return new Set(r.stdout.split(/\r?\n/).filter(Boolean));
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
  const fresh = await ignoredEntries(dir, names);
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
  const res = await runGit(['ls-files', '--unmerged', '--', rel], {
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
  if (res.ok) return res.bytes;
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
    // renderer draws its own draggable top bar + window controls.
    titleBarStyle: 'hidden',
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
  w.on('focus', () => {
    lastFocusedWindowId = w.id;
    w.flashFrame(false);
    onWindowFocus?.();
    // The focused window changes the picker's "current" framing; cheap to re-broadcast.
    broadcastWinList?.();
  });

  // Windows surfaces the mouse thumb buttons as the per-window `app-command` event, not as
  // DOM button 3/4. Forward them to THIS window's renderer (app-command is per-window, so
  // never broadcast) to drive the existing Back/Forward. preventDefault stops Chromium's
  // own (no-op here) history nav. See docs/specs/2026-06-30-mouse-nav-buttons.md §3.2.
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
  w.webContents.on('will-navigate', (event, url) => {
    // The app itself is loaded via loadFile(index.html); only that is allowed.
    if (url.startsWith('file://')) return;
    event.preventDefault();
    openExternalUrl(url);
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
  // See docs/specs/2026-08-20-renderer-crash-recovery.md.
  w.webContents.on('render-process-gone', (_ev, details) => {
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

  w.on('close', (ev) => opts.onClose(w, ev));
  w.on('closed', () => {
    windows.delete(w.id);
    windowOrdinal.delete(w.id);
    opts.onClosed(w.id);
  });

  void w.loadFile(path.join(__dirname, 'index.html'));
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
  const pendingOsOpens: { path: string; sessionId: string }[] = [];
  const sendOpenFileInEditor = (path: string, sessionId: string) => {
    if (rendererReady) sendToOwner(sessionId, { type: 'openFileInEditor', path, sessionId });
    else pendingOsOpens.push({ path, sessionId });
  };
  const flushPendingOsOpens = () => {
    rendererReady = true;
    for (const op of pendingOsOpens.splice(0)) {
      sendToOwner(op.sessionId, {
        type: 'openFileInEditor',
        path: op.path,
        sessionId: op.sessionId,
      });
    }
  };

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

  // Detected shells first (so nothing defaults to an agent), then configured agents.
  const registry = new AgentRegistry([...detectShells(), ...loadAgents(agentsFile())]);
  const mgr = new SessionManager(registry);

  // Runtime busy/needs-attention tracker (output-activity heuristic). Pure; the
  // host owns the wall clock + the sweep loop below.
  const activity = new SessionActivity();

  // Per-session CWD scanners: parse OSC cwd-report sequences from terminal output
  // to track the live working directory (E2a).
  const cwdScanners = new Map<string, CwdScanner>();

  // Per-session carry for the bare-bell scanner: where the previous term:data chunk left
  // the escape-sequence walk. Same lifecycle as cwdScanners.
  const bellScanState = new Map<string, BellScanState>();

  // ── Git indicator (Slice A) ────────────────────────────────────────────────
  // Per-session interrogation of activeCwd's git context, delivered on the existing
  // `state` broadcast (no new channel). Refresh triggers: cwd-change (E2 seam),
  // best-effort fs.watch of the resolved HEAD (an external `git checkout` that doesn't
  // move cwd), and window-focus. Debounced 150 ms per session; NO interval polling.
  const GIT_DEBOUNCE_MS = 150;
  const gitDebounce = new Map<string, ReturnType<typeof setTimeout>>();
  const gitWatchers = new Map<string, fs.FSWatcher>();
  const gitWatchedHead = new Map<string, string>();

  // Multi-repo: debounced sub-repo scan per session (re-detect on open + project changes).
  const repoScanDebounce = new Map<string, ReturnType<typeof setTimeout>>();
  const scheduleRepoScan = (sessionId: string) => {
    const existing = repoScanDebounce.get(sessionId);
    if (existing) clearTimeout(existing);
    repoScanDebounce.set(
      sessionId,
      setTimeout(async () => {
        repoScanDebounce.delete(sessionId);
        const s = mgr.get(sessionId);
        if (!s) return;
        if (!settings.multiRepoPicker) {
          mgr.setRepos(sessionId, []);
          return;
        }
        try {
          mgr.setRepos(sessionId, await detectRepos(s.projectPath));
        } catch (e) {
          log.error('repo', `scan failed for ${sessionId}: ${String(e)}`);
        }
      }, 150),
    );
  };

  // (Re)establish the HEAD watch each interrogation so it always tracks the CURRENT cwd's
  // HEAD (a worktree/branch switch re-points the git-dir). Best-effort: if fs.watch throws,
  // log once and lean on cwd-change + focus triggers.
  const loggedWatchFailure = new Set<string>();
  // Sessions whose watch was torn down (term:exit). A `term:exit` keeps the session in
  // `mgr` (status flips to 'exited', it isn't removed until an explicit kill), so an
  // mgr.get liveness check can't tell a live session from a torn-down one — this set is
  // the authoritative "do not (re)create a watcher" signal. The caller resolves the
  // headPath (from the same interrogation) and invokes this SYNCHRONOUSLY, so there's no
  // await between the guard checks and fs.watch — two overlapping refreshes cannot both
  // create a watcher, and a teardown that ran during the interrogation is seen here.
  const gitTornDown = new Set<string>();
  const ensureHeadWatch = (sessionId: string, headPath: string | undefined) => {
    if (!headPath) return;
    if (gitTornDown.has(sessionId) || !mgr.get(sessionId)) return;
    if (gitWatchedHead.get(sessionId) === headPath) return; // already watching this HEAD
    gitWatchers.get(sessionId)?.close();
    gitWatchers.delete(sessionId);
    try {
      const watcher = fs.watch(headPath, { persistent: false }, () => {
        scheduleGitRefresh(sessionId);
      });
      watcher.on('error', () => {
        watcher.close();
        gitWatchers.delete(sessionId);
        gitWatchedHead.delete(sessionId);
      });
      gitWatchers.set(sessionId, watcher);
      gitWatchedHead.set(sessionId, headPath);
    } catch (e) {
      if (!loggedWatchFailure.has(sessionId)) {
        loggedWatchFailure.add(sessionId);
        console.error(`[git-info] HEAD watch unavailable for ${sessionId}: ${String(e)}`);
      }
    }
  };

  // The git root for every surface (indicator, history, changes, switch). Shared with the
  // renderer via gitRootOf so change paths resolve against the same dir on both sides.
  const gitRoot = gitRootForSession;

  const runGitRefresh = async (sessionId: string) => {
    const session = mgr.get(sessionId);
    if (!session) return;
    // A relaunched session reuses its id; clear the torn-down latch so its HEAD can be
    // re-watched (teardown set it on the previous exit).
    gitTornDown.delete(sessionId);
    if (!settings.showGitIndicator) {
      mgr.setGit(sessionId, undefined);
      return;
    }
    const cwd = gitRoot(session);
    log.debug('git', 'refresh', { sessionId, cwd });
    let result: Awaited<ReturnType<typeof interrogateGit>>;
    try {
      result = await interrogateGit(cwd);
    } catch {
      result = { info: { kind: 'none' } };
    }
    // Drop a stale result if the active repo / cwd moved on while we were interrogating.
    const latest = mgr.get(sessionId);
    if (!latest || gitRoot(latest) !== cwd) return;
    ensureHeadWatch(sessionId, result.headPath);
    mgr.setGit(sessionId, result.info.kind === 'none' ? undefined : result.info);
  };

  function scheduleGitRefresh(sessionId: string) {
    const existing = gitDebounce.get(sessionId);
    if (existing) clearTimeout(existing);
    gitDebounce.set(
      sessionId,
      setTimeout(() => {
        gitDebounce.delete(sessionId);
        void runGitRefresh(sessionId);
      }, GIT_DEBOUNCE_MS),
    );
  }

  const teardownGitRefresh = (sessionId: string) => {
    // Latch torn-down BEFORE closing: a refresh awaiting interrogateGit right now must see
    // this when it resumes and calls ensureHeadWatch, so it won't recreate a watcher behind
    // the close below.
    gitTornDown.add(sessionId);
    const t = gitDebounce.get(sessionId);
    if (t) clearTimeout(t);
    gitDebounce.delete(sessionId);
    gitWatchers.get(sessionId)?.close();
    gitWatchers.delete(sessionId);
    gitWatchedHead.delete(sessionId);
    loggedWatchFailure.delete(sessionId);
  };

  // Re-evaluate every session's git (window focus, settings toggle). runGitRefresh itself
  // clears the indicator when showGitIndicator is off, so this needs no enabled-gate.
  const refreshAllGit = () => {
    for (const s of mgr.list()) scheduleGitRefresh(s.id);
  };
  onWindowFocus = refreshAllGit;

  // Session ids that have been relaunched and are waiting for their next term:start
  // so we can write a brief "— session relaunched —" marker to the fresh terminal.
  const pendingRelaunchMarker = new Set<string>();

  // Sessions mid-move between windows (multi-window Slice B). When ownership is reassigned,
  // the SOURCE window's TerminalPane unmounts and fires `term:dispose` — which would KILL the
  // live PTY we are trying to hand to the target window. A session in this set has its next
  // `term:dispose` swallowed (the flag is one-shot, cleared on consume) so the PTY survives the
  // hand-off. The target's fresh pane keeps the SAME sessionId, so no remount kills it.
  const movingSessions = new Set<string>();

  // Coalesce activity-driven broadcasts: the first change arms a trailing timer,
  // further changes within the window are absorbed, then one postState fires.
  // Bounds IPC under an output firehose (recordOutput is O(1) per chunk).
  let activityTimer: ReturnType<typeof setTimeout> | null = null;
  const ACTIVITY_COALESCE_MS = 120;
  const scheduleActivityBroadcast = () => {
    if (activityTimer) return;
    activityTimer = setTimeout(() => {
      activityTimer = null;
      postState();
    }, ACTIVITY_COALESCE_MS);
  };

  const pty = new PtyHost(
    (msg) => {
      // PtyHost only ever emits term:data / term:exit, both session-scoped — route only to
      // the owner window so a session's output never crosses into another window
      // (multi-window isolation). The narrowing makes `sessionId` available for routing.
      if (msg.type === 'term:data' || msg.type === 'term:exit') sendToOwner(msg.sessionId, msg);
      if (msg.type === 'term:data') {
        // Output activity drives the busy/needs-attention machine; byte count and bare
        // bells are the evidence it weighs (see the attention-signal-quality spec).
        // The scanner's state rides across chunks — an escape sequence straddling two
        // `onData` chunks would otherwise fabricate or swallow a bell.
        // Only an idle->busy edge is a change worth broadcasting.
        const scan = countBareBells(msg.data, bellScanState.get(msg.sessionId));
        bellScanState.set(msg.sessionId, scan.state);
        if (activity.recordOutput(msg.sessionId, Date.now(), msg.data.length, scan.bells))
          scheduleActivityBroadcast();

        // T2: accumulate the session's recent output into its scrollback ring and
        // debounce a write to disk. This callback only fires for genuine PTY output;
        // replayed history is sent via sendToOwner() in term:start and never re-enters here.
        if (settings.scrollbackPersistence) {
          scrollbacks.set(
            msg.sessionId,
            appendScrollback(scrollbacks.get(msg.sessionId) ?? '', msg.data, SCROLLBACK_CAP_BYTES),
          );
          scheduleScrollbackPersist(msg.sessionId);
        }

        // CWD tracking (E2a): when trackCwd is enabled, scan terminal output for
        // OSC cwd-report sequences and update the session's live cwd.
        if (settings.trackCwd) {
          let scanner = cwdScanners.get(msg.sessionId);
          if (!scanner) {
            scanner = new CwdScanner();
            cwdScanners.set(msg.sessionId, scanner);
          }
          const newCwd = scanner.push(msg.data);
          if (newCwd !== null) {
            const session = mgr.get(msg.sessionId);
            if (session && newCwd !== session.cwd) {
              // Existence check: must be a real directory on disk (E2a).
              try {
                if (fs.existsSync(newCwd) && fs.statSync(newCwd).isDirectory()) {
                  mgr.setCwd(msg.sessionId, newCwd);
                  // Multi-repo: a cd inside a detected sub-repo auto-follows (SessionManager
                  // ignores this while pinned). Recompute before the git refresh below.
                  mgr.setAutoRepo(msg.sessionId, repoForPath(session.repos ?? [], newCwd));
                  // Git indicator (Slice A): the active cwd / active repo moved — re-interrogate.
                  scheduleGitRefresh(msg.sessionId);
                }
              } catch {
                /* ignore stat errors (e.g. permission denied) */
              }
            }
          }
        }
      } else if (msg.type === 'term:exit') {
        log.info('pty', 'exit', { sessionId: msg.sessionId, code: msg.code });
        mgr.setStatus(msg.sessionId, 'exited');
        // A dead child is not waiting for anyone (spec contract 6) — drop its evidence
        // so the quiet after its last output can't be read as "finished, needs you".
        activity.recordExit(msg.sessionId);
        // Clean up the scanners for this session (E2a + the bell-scan carry).
        cwdScanners.delete(msg.sessionId);
        bellScanState.delete(msg.sessionId);
        // Git indicator (Slice A): tear down the per-session HEAD watch + debounce.
        teardownGitRefresh(msg.sessionId);
        // T2: flush the last screenful now (the process ended); keep the file so the
        // user can still see the final output until the session is killed.
        if (settings.scrollbackPersistence) flushScrollback(msg.sessionId);
      }
    },
    (m) => log.debug('pty', m),
  );

  // Per-terminal-session scrollback ring (T2): the recent output bytes, capped to a
  // trailing 256 KiB window in memory and debounced to scrollback-<id>.json. Fed from the
  // PtyHost output callback (term:data).
  const scrollbacks = new Map<string, string>();
  const scrollbackPersistTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const flushScrollback = (sessionId: string) => {
    const data = scrollbacks.get(sessionId);
    if (data === undefined) return;
    log.debug('scrollback', 'persist', { sessionId, bytes: data.length });
    persistFile(
      scrollbackFile(sessionId),
      serializeScrollback({ version: 1, sessionId, data }),
      `scrollback-${sessionId}.json`,
    );
  };
  const scheduleScrollbackPersist = (sessionId: string) => {
    if (scrollbackPersistTimers.has(sessionId)) return;
    scrollbackPersistTimers.set(
      sessionId,
      setTimeout(() => {
        scrollbackPersistTimers.delete(sessionId);
        flushScrollback(sessionId);
      }, 250),
    );
  };
  // Sessions whose persisted scrollback has already been replayed this app-run. Guards
  // against a TerminalPane remount (within one run) re-injecting the whole history again.
  const replayedScrollback = new Set<string>();

  // Low-frequency sweep detects busy->idle (task finished) and arms attention where the
  // evidence justifies it. Interval is <= half the busy window so detection latency stays
  // bounded; cheap (a Map scan). The machine emits an edge at most once per episode, so
  // there is no separate "already notified" guard here — a repainting TUI cannot re-ping.
  const sweepTimer = setInterval(() => {
    const { changed, edges } = activity.sweep(Date.now());
    if (!changed) return;
    scheduleActivityBroadcast();
    for (const edge of edges) {
      const session = mgr.get(edge.id);
      if (!session) continue;
      if (
        shouldRaiseOsAttention({
          becameNeedsAttention: true,
          // Any focused Conduit window counts as "the user is looking"; only raise OS
          // attention when none is focused.
          windowFocused: BrowserWindow.getFocusedWindow() !== null,
          enabled: settings.osAttention,
        })
      ) {
        const owner = windowFor(session.id);
        owner?.flashFrame(true);
        if (Notification.isSupported()) {
          const notif = new Notification({
            title: 'Conduit',
            body: edge.kind === 'bell' ? `${session.name} is waiting` : `${session.name} finished`,
          });
          notif.on('click', () => {
            const w = windowFor(session.id);
            if (w) {
              w.show();
              w.focus();
              sendToOwner(session.id, { type: 'activateSession', sessionId: session.id });
            }
          });
          notif.show();
        }
      }
    }
  }, 750);

  // User settings (theme/fonts/layout/behaviour), persisted to settings.json.
  let settings: AppSettings = restoreSettings(readBlob(settingsFile()));

  // Diagnostics logger (Slice A): the host's sole disk writer. Constructed here — before
  // window creation — so startup seams are captured. Level comes from settings and is
  // updated live on a settings change. `off` (via logLevel) or logging=false silences it.
  const log = new Logger(settings.logging ? settings.logLevel : 'off');
  hostLog = log;
  log.info('app', 'ready', { version: aboutInfo.version, e2e: process.env.CONDUIT_E2E === '1' });

  // Restore previously persisted sessions (as stale) + save on every change.
  if (settings.restoreSessions) {
    mgr.restore(restoreSessions(readBlob(sessionsFile())));
    for (const s of mgr.list()) scheduleRepoScan(s.id); // multi-repo: detect for restored sessions
  }

  // Scrollback files are only deleted on session dispose; a session that was never restored
  // would leak its scrollback-<id>.json forever. Sweep any that belong to no live/restored
  // session now that the manager reflects the startup set. Best-effort: a read/unlink failure
  // must never block launch.
  //
  // ONLY when restore is on: with restore off the manager starts empty, so every scrollback
  // would look orphaned and get deleted — wiping the scrollback of the very sessions the
  // persist gate deliberately preserves (a restore-off run keeps sessions.json intact, so its
  // scrollback must survive too, or toggling restore back on restores sessions with no history).
  if (shouldPersistSessions(settings)) {
    try {
      const dir = userData();
      const live = mgr.list().map((s) => s.id);
      for (const name of orphanScrollbackFiles(fs.readdirSync(dir), live)) {
        try {
          fs.rmSync(path.join(dir, name));
        } catch (err) {
          log.warn('scrollback', 'orphan sweep unlink failed', { name, err: String(err) });
        }
      }
    } catch (err) {
      log.warn('scrollback', 'orphan sweep skipped', { err: String(err) });
    }
  }
  // Snapshot the persist gate at STARTUP, not per-write: if restore was off at launch the manager
  // never loaded the saved sessions, so its (empty) state must never overwrite them — even if the
  // user toggles restore back ON mid-run (that takes effect next launch). Gating on the live
  // setting would let a mid-run re-enable + quit wipe the preserved list. See persistence.ts.
  const sessionsPersistGate = shouldPersistSessions(settings);
  mgr.onChange(() => {
    // Never persist once the quit has flushed: `before-quit` writes the final snapshot
    // synchronously and THEN calls pty.disposeAll(), whose exits drop every session from the
    // manager (exit-closes-session). That churn fired this handler and its async write landed
    // on top of the good snapshot — leaving sessions.json empty, so the next launch restored
    // nothing and the multi-window layout collapsed to one window (planLayoutRestore drops a
    // window that owns no restored session).
    if (sessionsPersistGate && !isQuitting)
      persistFile(sessionsFile(), serializeSessions(mgr.list()), 'sessions.json');
    postState();
  });

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

  // Per-window state (multi-window Slice A): each window receives only the sessions it
  // owns (filtered + grouped from the global model); shared fields (agents/repos/settings/
  // about) are identical per window. Merges runtime busy/needs-attention flags in-band.
  const postState = () => {
    const all = mgr.list();
    const agents = registry.list();
    const repos = reposForState();
    // D6: the card subtitle. Reads the PtyHost's tail (memoized between broadcasts), so it
    // rides this already-coalesced post rather than a timer or a round trip of its own.
    const withLastLine = (id: string) => ({ lastLine: pty.lastLine(id) });
    for (const [windowId, w] of windows) {
      const owned = sessionsOwnedBy(sessionOwner, windowId, all);
      const sessions = activity.apply(owned, withLastLine);
      const groups = groupOwnedByProject(owned).map((g) => ({
        projectPath: g.projectPath,
        sessions: activity.apply(g.sessions, withLastLine),
      }));
      w.webContents.send('to-webview', {
        type: 'state',
        agents,
        groups,
        sessions,
        repos,
        settings,
        about: aboutInfo,
        windowId,
      });
    }
  };

  // win:list (multi-window Slice B): the open windows + owned-session counts for the
  // "Move to window…" picker. Broadcast to every window; each renderer filters out its own
  // id (from state.windowId). Titles fall back to a stable per-window ordinal.
  broadcastWinList = () => {
    const list = buildWinList(
      [...windows.keys()],
      sessionOwner,
      mgr.list(),
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
    const all = mgr.list();
    return [...windows.values()].map((w) => ({
      bounds: w.getBounds(),
      sessionIds: sessionsOwnedBy(sessionOwner, w.id, all).map((s) => s.id),
    }));
  };

  const persistLayout = () => {
    if (!settings.restoreSessions || isQuitting) return; // see the mgr.onChange note
    const snapshot = buildLayoutSnapshot();
    if (snapshot.length === 0) return;
    log.debug('window', 'layout-persist', { windows: snapshot.length });
    persistFile(windowsLayoutFile(), serializeLayout(snapshot), 'windows.json');
  };

  // Durable, SYNCHRONOUS flush of the critical state on quit. The async persistFile writes are
  // fine for a graceful exit (Node drains them), but an auto-update REPLACES the app by
  // force-killing the running exe — cutting off any in-flight async write mid-stream. This runs
  // in before-quit, before the PTY teardown churns the model, so sessions/settings/layout are on
  // disk via an atomic rename before the installer can kill us. Without it, an interrupted write
  // truncated these files and the next launch lost all sessions + reset settings to defaults.
  const flushStateSync = () => {
    const write = (file: string, data: string, label: string) => {
      try {
        atomicWriteFileSync(file, data);
      } catch (e) {
        log.error('persist', `sync flush failed for ${label}: ${String(e)}`);
      }
    };
    write(settingsFile(), serializeSettings(settings), 'settings.json');
    // Startup-snapshot gate (see sessionsPersistGate note) so a restore-off run — even one that
    // toggled restore back on — never overwrites the saved session set on quit.
    if (sessionsPersistGate) write(sessionsFile(), serializeSessions(mgr.list()), 'sessions.json');
    // Editor tabs are low-stakes vs. sessions, but the same force-kill-on-update hazard applies,
    // so flush the last-known payload atomically alongside sessions (spec §3.2 durability).
    write(docsFile(), serializeDocs(lastDocs), 'docs.json');
    // Same force-kill-on-update hazard as sessions.json: an interrupted async write would leave
    // the marks file truncated and the next launch would show a finished review as unread. Gated
    // on an actual change this run — see reviewMarksDirty.
    if (reviewMarksDirty)
      write(reviewMarksFile(), serializeMarksFile(reviewMarks), 'review-marks.json');
    if (settings.restoreSessions) {
      const snapshot = buildLayoutSnapshot();
      if (snapshot.length > 0)
        write(windowsLayoutFile(), serializeLayout(snapshot), 'windows.json');
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

  // Reassign a live session's owner window WITHOUT restarting its PTY (multi-window
  // Slice B/C). The sessionId/React key never changes, so the target's TerminalPane mounts
  // (no remount that would kill ConPTY) and fires term:start → the attach path replays the
  // buffer. The `movingSessions` guard protects the live PTY from the source pane's unmount
  // teardown (term:dispose) that the postState below triggers by dropping the session from
  // the source window. Shared by the `session:move` and `session:dragEnd` handlers.
  const moveSessionToWindow = (sessionId: string, targetId: number): void => {
    movingSessions.add(sessionId);
    assignOwner(sessionOwner, sessionId, targetId);
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

  // Open a folder in the chosen terminal and remember it in history. `cardId` (N2),
  // when present, stamps the new session with the feature-board card it was started for.
  // `ownerWindowId` (multi-window Slice A) is the window the new session belongs to.
  function openRepo(
    p: string,
    agentId: string,
    ownerWindowId: number,
    cardId?: string,
  ): string | undefined {
    if (!p) return undefined;
    const agent = registry.get(agentId) ?? registry.list()[0];
    if (!agent) {
      dialog.showErrorBox('Conduit', 'No terminals available.');
      return undefined;
    }
    repos = upsertRepo(repos, {
      path: p,
      name: path.basename(p) || p,
      lastAgentId: agent.id,
      lastOpened: Date.now(),
    });
    persistFile(reposFile(), serializeRepos(repos), 'repos.json');
    const id = mgr.create(agent.id, p, undefined, cardId).id; // emits change -> postState
    // mgr.create's change fired postState BEFORE this assignment, so no window saw the new
    // session yet (it had no owner). Assign ownership, then re-post so the owner window
    // gets it immediately.
    assignOwner(sessionOwner, id, ownerWindowId);
    postState();
    scheduleRepoScan(id); // multi-repo: detect sub-repos under the opened folder
    return id;
  }

  const resolveSpec = (agentId?: string, cwd?: string): SpawnSpec =>
    resolveLaunchSpec(registry, agentId, cwd, (p) => fs.existsSync(p), os.homedir());

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

  const projectWatcher = new ProjectWatcher(
    (root) => {
      broadcast({ type: 'fsChanged', root });
      // ROOT-scoped, not per package: `fsChanged` carries no changed path, and
      // `shouldIgnoreWatchPath` drops every `node_modules` event before the debounce — so an
      // npm install emits nothing at all and no finer signal exists to key on. A resolution
      // costs one bounded walk and is only ever recomputed after a navigation misses.
      dropResolutionsForRoot(moduleResolveCache, root);
      // Multi-repo: a sub-repo may have been cloned/removed under this root — re-detect.
      for (const s of mgr.list()) if (s.projectPath === root) scheduleRepoScan(s.id);
    },
    {
      log: (m) => console.log('[watch]', m),
    },
  );

  const proposalWatcher = new ProposalWatcher();

  // Auto-update lifecycle (no-op in dev; active only in packaged builds). Update events are
  // shared notifications — broadcast to every window.
  const stopUpdater = initUpdater(broadcast, (event, data) => log.info('updater', event, data));

  // ── Quit / close / update-relaunch guard (W2) ────────────────────────────
  // Per-window confirm flags (multi-window Slice A): a window id is added once the user
  // confirms its close so the re-fired close event passes without a second prompt
  // (prevents an infinite preventDefault loop). Removed when its close is cancelled.
  const windowConfirmed = new Set<number>();

  /**
   * Ask the user to confirm a destructive action (quit/close/update-relaunch), scoped to
   * `targetWin` (multi-window Slice A): only that window's sessions are counted, the dialog
   * is sent to that window only, and only that window's `quitDecision` is accepted (two
   * windows' dialogs never cross).
   *
   * Sends `confirmQuit` to the renderer and waits for an explicit `quitDecision`.
   * The 3000 ms timeout is ONLY a guard against a wedged renderer that never even
   * shows the dialog: it is disarmed the moment the renderer ACKs with
   * `quitDialogShown`, so a dialog the user is reading never auto-resolves (the
   * earlier blanket timeout silently quit on its own, defeating the warning).
   * If the renderer never ACKs within 3000 ms it falls through to **proceed** —
   * so the app is never made unclosable. No native dialog (decision 2026-06-16).
   *
   * Returns true if the user confirmed (proceed), false if cancelled.
   */
  async function confirmWithRenderer(
    reason: QuitReason,
    targetWin: BrowserWindow,
  ): Promise<boolean> {
    const sessions = activity.apply(sessionsOwnedBy(sessionOwner, targetWin.id, mgr.list()));
    const running = runningSessions(sessions);
    const busy = busySessions(sessions).length;

    return new Promise<boolean>((resolve) => {
      const RENDERER_TIMEOUT_MS = 3000;

      let settled = false;
      const settle = (val: boolean) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(val);
      };

      const onDecision = (e: IpcMainEvent, m: WebviewToHost) => {
        // Only accept the decision from the target window's renderer so two windows'
        // dialogs don't cross (multi-window Slice A).
        if (e.sender !== targetWin.webContents) return;
        const t = (m as { type: string }).type;
        if (t === 'quitDialogShown') {
          // Renderer is alive and showing the dialog: disarm the fallback and wait
          // indefinitely for the user's explicit Cancel/Confirm.
          clearTimeout(timer);
        } else if (t === 'quitDecision') {
          settle((m as { proceed: boolean }).proceed);
        }
      };
      ipcMain.on('to-host', onDecision);

      // Fallback only for a renderer that never ACKs `quitDialogShown` (i.e. never
      // displays the dialog): the app must never be made unclosable.
      const timer = setTimeout(() => settle(true), RENDERER_TIMEOUT_MS);

      const cleanup = () => {
        clearTimeout(timer);
        ipcMain.removeListener('to-host', onDecision);
      };

      targetWin.webContents.send('to-webview', {
        type: 'confirmQuit',
        reason,
        running: running.length,
        busy,
      });
    });
  }

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

  async function sendProject(dispatch: Dispatch, p: string, changesRoot?: string) {
    // Arm/re-point the live watcher at whatever project the renderer is currently showing
    // (idempotent for the same root). requestProject fires on open + focus + cwd change.
    if (p) {
      projectWatcher.watch(p);
      // Re-detect sub-repos on every project refresh, not just on open + the fs-watch. The
      // watcher is rooted at the cwd, so a sibling repo/worktree created OUTSIDE it (but under
      // the opened folder) never triggers a re-scan — the picker then goes stale until restart.
      // Focus/cwd-change refreshes here are the reliable recovery (mirrors the explorer's
      // focus refresh). scheduleRepoScan is debounced and scans the session's projectPath.
      const np = normalizePath(p);
      for (const s of mgr.list()) {
        if (isAncestorOf(normalizePath(s.projectPath), np)) scheduleRepoScan(s.id);
      }
    }
    try {
      const info = await getProjectInfo(p, changesRoot ?? p);
      dispatch({
        type: 'project',
        path: p,
        changes: info.changes,
        files: info.files,
        customizations: info.customizations,
      });
    } catch {
      dispatch({ type: 'project', path: p, changes: [], files: [], customizations: [] });
    }
  }

  // Show a folder dialog (parented to the sender's window), then open the picked folder in
  // the chosen terminal, owned by that window (multi-window Slice A).
  async function browseRepo(agentId: string, senderWin: BrowserWindow | null) {
    const options = {
      properties: ['openDirectory' as const],
      title: 'Open a repository',
    };
    const picked = senderWin
      ? await dialog.showOpenDialog(senderWin, options)
      : await dialog.showOpenDialog(options);
    if (picked.canceled || !picked.filePaths[0]) return;
    const ownerId = senderWin?.id ?? focusedWindow()?.id ?? primaryWindowId;
    openRepo(picked.filePaths[0], agentId, ownerId);
  }

  // Fully tear down a session: kill its PTY, drop it from the model + every per-session
  // map, delete its scrollback file, and release its window ownership. Shared by the `kill`
  // handler and the per-window close guard (multi-window Slice A disposes all of a closing
  // window's sessions through this).
  const disposeSession = (id: string) => {
    pty.dispose(id);
    mgr.remove(id);
    activity.forget(id);
    cwdScanners.delete(id);
    bellScanState.delete(id);
    const repoTimer = repoScanDebounce.get(id);
    if (repoTimer) {
      clearTimeout(repoTimer);
      repoScanDebounce.delete(id);
    }
    // T2: the session is gone — drop its scrollback ring/timer and delete the file so
    // userData doesn't accumulate orphans. Best-effort, ENOENT-tolerant.
    scrollbacks.delete(id);
    const sbTimer = scrollbackPersistTimers.get(id);
    if (sbTimer) {
      clearTimeout(sbTimer);
      scrollbackPersistTimers.delete(id);
    }
    replayedScrollback.delete(id);
    // Drop the git torn-down latch so it doesn't accumulate across killed sessions
    // (term:exit from the dispose above already closed any live watcher).
    gitTornDown.delete(id);
    removeOwner(sessionOwner, id);
    fs.unlink(scrollbackFile(id), () => {});
  };

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
          postState();
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
          break;
        case 'log': {
          // Back-compatible: a bare {type:'log', message} defaults to info / scope 'renderer'.
          const level = m.level && m.level !== 'off' ? m.level : 'info';
          log[level](m.scope ?? 'renderer', m.message, m.data);
          break;
        }
        case 'revealLogs':
          void shell.openPath(log.logsDir());
          break;
        case 'openRepo':
          openRepo(m.path, m.agentId, senderId, m.cardId);
          break;
        case 'browseRepo':
          await browseRepo(m.agentId, senderWin);
          break;
        case 'requestProject':
          await sendProject(replyHere, m.path, m.changesRoot);
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
          replyHere({
            type: 'fileDiff',
            doc: await readDiff(m.path, gitShow, gitShowBuffer, scope),
            ...scope,
          });
          break;
        }
        case 'git:history': {
          const session = mgr.get(m.sessionId);
          if (!session) break;
          const cwd = gitRoot(session);
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
          });
          break;
        }
        case 'git:commitDiff': {
          const session = mgr.get(m.sessionId);
          // A silent break here stranded the Review pane on "Loading commit changes…" forever —
          // see docs/specs/2026-08-20-commit-review-memory-bounds.md §4.
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
          // hash; UI-originated reviews (History/branch band) omit it and use the pinned repo.
          const cwd = m.root ?? gitRoot(session);
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
          const session = mgr.get(m.sessionId);
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
            (await git(['ls-files', '--error-unmatch', '--', rel], root)).trim() !== '';
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
          const session = mgr.get(m.sessionId);
          if (!session) break;
          const cwd = gitRoot(session);
          const key = rangeKey(m.base, m.head);
          const error = await firstInvalidEndpoint(cwd, [m.base, m.head]);
          if (error) {
            replyHere({
              type: 'git:rangeDiffResult',
              sessionId: m.sessionId,
              key,
              files: [],
              error,
              requestId: m.requestId,
            });
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
        case 'git:resolveRange': {
          const session = mgr.get(m.sessionId);
          if (!session) break;
          const cwd = gitRoot(session);
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
          });
          break;
        }
        case 'git:refs': {
          const session = mgr.get(m.sessionId);
          if (!session) break;
          const cwd = gitRoot(session);
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
          });
          break;
        }
        case 'git:switch': {
          const session = mgr.get(m.sessionId);
          if (!session) break;
          const cwd = gitRoot(session);
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
            });
            break;
          }
          const busy = activity.statusOf(m.sessionId).busy;
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
            });
            break;
          }
          const result = await switchBranch(cwd, ref);
          log.info('git', 'switch', { sessionId: m.sessionId, ref, ok: result.ok });
          if (result.ok) {
            replyHere({ type: 'git:switchResult', sessionId: m.sessionId, ok: true });
            scheduleGitRefresh(m.sessionId);
          } else {
            replyHere({
              type: 'git:switchResult',
              sessionId: m.sessionId,
              ok: false,
              reason: 'failed',
              message: result.message,
            });
          }
          break;
        }
        case 'repo:pin':
          // Validate against the detected set before pinning (the renderer's root is untrusted).
          if (mgr.get(m.sessionId)?.repos?.some((r) => r.root === m.repoRoot)) {
            mgr.pinRepo(m.sessionId, m.repoRoot);
            scheduleGitRefresh(m.sessionId);
          }
          break;
        case 'repo:unpin':
          mgr.unpinRepo(m.sessionId);
          scheduleGitRefresh(m.sessionId);
          break;
        case 'repo:context': {
          const s = mgr.get(m.sessionId);
          if (s) {
            mgr.setAutoRepo(m.sessionId, repoForPath(s.repos ?? [], m.path));
            scheduleGitRefresh(m.sessionId);
          }
          break;
        }
        case 'rename':
          log.info('session', 'rename', { sessionId: m.id });
          mgr.rename(m.id, m.name);
          break;
        case 'setSessionIcon':
          mgr.setIconOverride(m.id, m.icon);
          break;
        case 'term:title':
          mgr.applyTitle(m.sessionId, m.title);
          break;
        case 'relaunch':
          mgr.setStatus(m.id, 'running');
          // Remember this session needs a "relaunched" marker the next time its
          // terminal starts (the renderer will send term:start once it remounts).
          pendingRelaunchMarker.add(m.id);
          break;
        case 'kill':
          disposeSession(m.id);
          break;
        case 'visible':
          // What this window has on screen (active + split). Seeing a session acknowledges
          // it and exempts it from arming; the sets are per window, so another window's
          // active session is not silenced. See the attention-signal-quality spec §4.
          if (activity.setVisible(senderId, m.ids)) scheduleActivityBroadcast();
          break;
        case 'duplicate': {
          log.info('session', 'duplicate', { sessionId: m.id });
          const dup = mgr.duplicate(m.id); // emits change -> postState
          if (dup) {
            // Owner = the source session's owner (same window), falling back to the sender.
            assignOwner(sessionOwner, dup.id, sessionOwner.get(m.id) ?? senderId);
            postState();
          }
          break;
        }
        case 'reorderSessions':
          mgr.reorder(m.order); // emits change -> postState (+ persists order)
          break;
        case 'updateSettings':
          // Coerce before persisting: drops unknown keys, clamps ranges, whitelists
          // enum strings, and runs the legacy codeBg→surfaceColor migration.
          settings = coerceSettings(m.settings as unknown as Record<string, unknown>);
          persistFile(settingsFile(), serializeSettings(settings), 'settings.json');
          // Push the new diagnostics level to the live logger (no restart). Log AFTER the
          // level update so a just-enabled level captures its own enabling.
          log.setLevel(settings.logging ? settings.logLevel : 'off');
          log.info('settings', 'save', {
            logging: settings.logging,
            logLevel: settings.logLevel,
          });
          // Broadcast the settings the host actually kept. The sender already applied its own
          // change optimistically, but nothing else had: every OTHER window, and any writer
          // that isn't the settings provider, learned about it only when some unrelated
          // broadcast (terminal output, a git refresh) happened to fire next — which for an
          // idle session can be never.
          postState();
          // Git indicator (Slice A): re-evaluate every session on a settings change;
          // runGitRefresh re-interrogates when on and clears the indicator when off.
          refreshAllGit();
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
        case 'indexProject':
          await queueProjectIndex(m.root, m.seeds ?? [], replyHere, log, !!m.incremental);
          break;
        case 'resolveModule': {
          const root = mgr.get(m.sessionId)?.projectPath;
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
          // These files are outside the index's own selection, so the root's "already sent"
          // set has to learn about them or the next `fsChanged` top-up re-streams them and
          // inflates the progress counters the status line reports.
          const state = projectIndexState.get(root);
          if (state) for (const f of value.files) state.sent.add(f.path);
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
          // ignored trees (vendor/, target/, .venv/, …) don't. projectFileIndex itself falls
          // back to walkFiles for non-git roots, so this preserves behavior there.
          const indexed = await projectFileIndex(m.root);
          replyHere({
            type: 'searchResults',
            root: m.root,
            results: indexToSearchHits(indexed, m.root),
          });
          break;
        }
        case 'contentSearch': {
          // Project-wide find-in-files (L5). For a git root, drive the search from the
          // gitignore-respecting file set (shared `projectFileIndex` — git ls-files) so
          // vendored/build/gitignored trees (vendor/, target/, .venv/, …) don't surface;
          // non-git roots fall back to the core's bounded BFS walk. Either way the result
          // caps, time budget, and binary/large-file skips still apply. `requestId` is
          // echoed back so a newer query supersedes this (stale) reply in the renderer.
          // Wrapped so a throw (e.g. a vanished root) surfaces as an inline error.
          let res: {
            results: Awaited<ReturnType<typeof searchContentFs>>['files'];
            truncated: boolean;
            error?: string;
          };
          const gen = ++contentSearchSeq;
          contentSearchGen.set(m.root, gen);
          const isCancelled = () => contentSearchGen.get(m.root) !== gen;
          try {
            const { files: indexed, fromGit } = await projectFileIndexMeta(m.root);
            const candidates = fromGit
              ? indexed.map((f) => ({ rel: f.rel, abs: f.abs.replace(/\\/g, '/') }))
              : undefined;
            const r = await searchContentFs(m.root, m.query, isCancelled, candidates);
            res = { results: r.files, truncated: r.truncated, error: r.error };
            log.debug('search', 'content', {
              root: m.root,
              matches: r.files.length,
              truncated: r.truncated,
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
            error: res.error,
          });
          break;
        }
        case 'term:start': {
          // Guard against a kill-race: a `kill` (pty.dispose + mgr.remove) that
          // races a late `term:start` from a remounting TerminalPane would spawn a
          // process for a session the manager no longer knows about — nothing would
          // ever dispose it until app quit. Bail early if the session is gone.
          if (!mgr.get(m.sessionId)) break;
          // ATTACH path (multi-window Slice B): the PTY is already running, so this term:start
          // is a window mounting a pane for a session that just moved here — NOT a cold start.
          // pty.start is idempotent (it would no-op), but we must replay the scrollback ring to
          // THIS attaching window (e.sender) so its terminal shows history, then fit the PTY to
          // the new window's size. We deliberately do NOT touch `replayedScrollback` — that
          // guards the one-time cold-start file restore; the attach replay is per-window and
          // intentionally separate. Skipping the spawn path avoids re-running the relaunch
          // marker / padding logic.
          if (pty.isAlive(m.sessionId)) {
            const ring = scrollbacks.get(m.sessionId);
            if (settings.scrollbackPersistence && ring) {
              reply(e, {
                type: 'term:data',
                sessionId: m.sessionId,
                data: '\r\n\x1b[2m— attached —\x1b[0m\r\n',
              });
              reply(e, { type: 'term:data', sessionId: m.sessionId, data: ring });
            }
            pty.resize(m.sessionId, m.cols, m.rows);
            mgr.touch(m.sessionId);
            log.info('pty', 'attach', { sessionId: m.sessionId, windowId: senderId });
            break;
          }
          // T2: replay persisted scrollback BEFORE pty.start, so restored history precedes
          // any live output and the (later) `— session relaunched —` banner. Once-per-run
          // guard so a pane remount within this run doesn't re-inject the whole history.
          let didReplay = false;
          if (settings.scrollbackPersistence && !replayedScrollback.has(m.sessionId)) {
            replayedScrollback.add(m.sessionId);
            const restored = restoreScrollback(readBlob(scrollbackFile(m.sessionId)));
            if (restored?.data) {
              didReplay = true;
              log.debug('scrollback', 'restore', {
                sessionId: m.sessionId,
                bytes: restored.data.length,
              });
              scrollbacks.set(m.sessionId, restored.data);
              sendToOwner(m.sessionId, {
                type: 'term:data',
                sessionId: m.sessionId,
                data: '\r\n\x1b[2m— restored —\x1b[0m\r\n',
              });
              // Neutralized because the child below this history is a NEW process: modes a
              // dead TUI left set (mouse tracking above all) would otherwise apply to it.
              // The ring keeps the raw bytes — the attach path replays a live child's real
              // state. See docs/specs/2026-08-20-scrollback-replay-neutralizer.md.
              sendToOwner(m.sessionId, {
                type: 'term:data',
                sessionId: m.sessionId,
                data: neutralizeReplay(restored.data),
              });
            }
          }
          const spec = resolveSpec(m.agentId, m.cwd);
          // E2b: inject a prompt-preserving cwd-emit hook for recognized shells when
          // trackCwd is enabled. The augmentation is purely ADDITIVE — it only appends
          // args and/or shallow-merges env; it never removes or reorders anything.
          // A shell whose id is not recognized (or trackCwd is off) launches exactly
          // as before (fail-safe: null augmentation → no change).
          if (settings.trackCwd) {
            const aug = cwdReportingAugmentation(m.agentId, spec.args);
            if (aug) {
              if (aug.args) spec.args = [...spec.args, ...aug.args];
              if (aug.env) spec.env = { ...spec.env, ...aug.env };
            }
          }
          log.info('pty', 'spawn', {
            sessionId: m.sessionId,
            agentId: m.agentId,
            command: spec.command,
            cwd: spec.cwd,
          });
          pty.start(m.sessionId, m.cols, m.rows, spec);
          // Opens the spawn grace: shell banners, the relaunch marker's follow-on repaint
          // and autoRelaunchStale's startup bursts are not evidence (spec contract 5).
          activity.recordSpawn(m.sessionId, Date.now());
          // A new child starts mid-nothing: never resume the dead one's escape-walk.
          bellScanState.delete(m.sessionId);
          mgr.touch(m.sessionId); // session became active
          // Git indicator (Slice A): interrogate the session's cwd on start so the bar
          // appears before the first `cd`. Establishes the HEAD watch too.
          scheduleGitRefresh(m.sessionId);
          // Write a brief system line the first time a relaunched session's terminal
          // starts so the user can see it is a fresh process, not the original run.
          if (pendingRelaunchMarker.delete(m.sessionId)) {
            sendToOwner(m.sessionId, {
              type: 'term:data',
              sessionId: m.sessionId,
              data: '\r\n\x1b[2m— session relaunched —\x1b[0m\r\n',
            });
          }
          // Must be the LAST thing sent before ConPTY's spawn output arrives (next tick):
          // scroll the restored history above the viewport so ConPTY's ESC[2J/repaint
          // can't erase it. See scrollbackReplayPadding for the full rationale.
          if (didReplay) {
            const pad = scrollbackReplayPadding(process.platform, m.rows);
            if (pad)
              sendToOwner(m.sessionId, { type: 'term:data', sessionId: m.sessionId, data: pad });
          }
          break;
        }
        case 'term:input':
          pty.input(m.sessionId, m.data);
          // Throttle: input fires per keystroke; avoid a disk write + state
          // broadcast on every character (30s is well under minute granularity).
          mgr.touch(m.sessionId, 30_000); // user interaction = activity
          break;
        case 'term:resize':
          log.debug('pty', 'resize', { sessionId: m.sessionId, cols: m.cols, rows: m.rows });
          pty.resize(m.sessionId, m.cols, m.rows);
          break;
        case 'term:dispose':
          // Slice B: a session mid-move keeps its live PTY — the dispose comes from the source
          // window's pane unmounting, not a real teardown. Swallow it once; the target window's
          // pane (same sessionId) attaches to the surviving process.
          if (movingSessions.delete(m.sessionId)) {
            log.debug('pty', 'dispose-skipped-moving', { sessionId: m.sessionId });
            break;
          }
          log.debug('pty', 'dispose', { sessionId: m.sessionId });
          pty.dispose(m.sessionId);
          break;
        case 'pathExists': {
          // D11: cheap existence check for terminal path-link validation. Intentionally
          // no workspace-containment guard — this is read-only (no write surface), and
          // the renderer can already open any path via readFile, which is also unguarded
          // by workspace roots. Only `exists` and `isDir` are returned; no file content.
          const p = m.path;
          let exists = false;
          let isDir = false;
          try {
            const stat = fs.statSync(p);
            exists = true;
            isDir = stat.isDirectory();
          } catch {
            /* path does not exist or is inaccessible */
          }
          replyHere({ type: 'pathExistsResult', path: p, exists, isDir });
          break;
        }
        case 'resolvePathToken': {
          // path-links v1: resolve a line's path tokens against the session's cwd git root +
          // file index. Roots off the LIVE cwd, NOT the pinned active repo (sessionGitRoot),
          // so a terminal always links files in the repo it is sitting in. Unknown session /
          // failure → empty results (renderer renders plain).
          const session = mgr.get(m.sessionId);
          let results: TokenResolution[] = [];
          if (session) {
            try {
              const root = await sessionGitRoot(session, git);
              results = await resolvePathTokens(activeCwd(session), root, m.tokens);
            } catch {
              results = [];
            }
          }
          replyHere({ type: 'resolvePathTokenResult', sessionId: m.sessionId, results });
          break;
        }
        case 'validateCommits': {
          // terminal-commit-link: confirm candidate hashes are real commits in the repo the
          // terminal's LIVE cwd sits in (sessionGitRoot) — NOT the UI-pinned active repo, which
          // would false-negative (or, with a colliding short-sha, link the wrong repo's commit)
          // when the pin differs from cwd. `root` rides the reply so a click can scope Review to
          // this same repo. Unknown session / failure → empty results (renderer renders plain).
          const session = mgr.get(m.sessionId);
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
          if (!mgr.get(m.sessionId)) break;
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
          if (!mgr.get(m.sessionId)) break;
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
          // W2: guard update-relaunch behind a session-running confirm. On proceed, mark
          // every window confirmed so the close events fired by quitAndInstall() pass
          // through. Scoped to the sender's window for the confirm dialog itself.
          if (!needsQuitConfirm(mgr.list())) {
            quitAndInstall();
          } else {
            void confirmWithRenderer('update', senderWin).then((proceed) => {
              if (proceed) {
                for (const id of windows.keys()) windowConfirmed.add(id);
                quitAndInstall();
              }
              // Cancel: stay open, update remains pending.
            });
          }
          break;
      }
    } catch (err: unknown) {
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
    for (const s of mgr.list()) if (s.projectPath) set.add(s.projectPath);
    for (const r of repos) if (r.path) set.add(r.path);
    return [...set];
  };

  // Write-file IPC (I2 + K2). A trust boundary: the renderer can ask to write any path,
  // so the host validates containment (src/path-guard) before touching disk. A write is
  // ALSO allowed when its canonical real path is a recorded read-grant — a file the host
  // itself served via readFile (go-to-definition / out-of-root recent), which can live
  // outside every write root. Grants hold exact files only (see src/read-grants.ts);
  // validateWrite is never weakened. Returns a typed result; on rejection or failure the
  // renderer keeps the buffer dirty and surfaces the reason (banner + toast).
  ipcMain.handle('writeFile', async (_e, p: string, content: string) => {
    try {
      return await writeFile(p, content, writeRoots(), readGrants);
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

  app.on('before-quit', () => {
    // Flag the quit BEFORE the cleanup below so the per-window close events fired during
    // teardown take the quit branch (preserve sessions for restore), not the per-window
    // dispose branch (Slice C).
    isQuitting = true;
    log.info('app', 'quit');
    // Capture the final state SYNCHRONOUSLY + atomically while windows + ownership are intact and
    // BEFORE pty.disposeAll() kills the PTYs. Synchronous so it completes before the auto-update
    // installer can force-kill the process (async writes would be truncated → data loss). Covers
    // settings, sessions, and the multi-window layout. Session RECORDS survive in `mgr` (the quit
    // branch in onWindowClose doesn't dispose them), so they restore next launch.
    flushStateSync();
    clearInterval(sweepTimer);
    if (activityTimer) clearTimeout(activityTimer);
    if (layoutPersistTimer) clearTimeout(layoutPersistTimer);
    boardWatcher.stop();
    notesWatcher.stop();
    projectWatcher.stop();
    proposalWatcher.stop();
    openFileWatcher.stop();
    stopUpdater();
    // T2: flush any pending scrollback so the last screenful survives a clean shutdown
    // (the debounce timer may not have fired yet).
    for (const sessionId of scrollbackPersistTimers.keys()) flushScrollback(sessionId);
    // Git indicator (Slice A): close every HEAD watcher + cancel pending refreshes so
    // no fs.watch handle keeps the main process alive past quit.
    for (const id of [...gitDebounce.keys(), ...gitWatchers.keys()]) teardownGitRefresh(id);
    pty.disposeAll();
  });

  // Per-window quit-guard close handler (multi-window Slice A, replaces the single global
  // win.on('close')). Covers custom ✕ (win:close → w.close()), OS close (Alt+F4 / taskbar),
  // and the update-relaunch path. The guard is scoped to THIS window's owned sessions: if it
  // owns running sessions and isn't already confirmed, prevent the close, confirm with that
  // window's renderer, dispose its sessions, then re-close (a confirmed flag lets the re-close
  // pass). Closing a window disposes only ITS sessions; window-all-closed quits the app.
  const onWindowClose = (w: BrowserWindow, ev: Electron.Event) => {
    log.info('window', 'close', { windowId: w.id });
    if (windowConfirmed.has(w.id)) return; // already confirmed — let it through
    // Quit (Cmd+Q, or closing the FINAL window) vs. deliberately closing one window among
    // several (Slice C). On quit we PRESERVE this window's sessions so they persist to
    // sessions.json and restore next launch (pre-multi-window semantics); the per-window
    // close still ENDS the closing window's sessions (Slice A). before-quit's disposeAll
    // kills the PTYs in the quit case — only the session RECORDS survive, as for restore.
    const isQuit = isQuitting || windows.size === 1;
    const owned = sessionsOwnedBy(sessionOwner, w.id, mgr.list());
    if (!needsQuitConfirm(owned)) return; // no running sessions in this window — no prompt
    ev.preventDefault();
    void confirmWithRenderer('quit', w).then((proceed) => {
      if (proceed) {
        windowConfirmed.add(w.id);
        // Only the deliberate single-window close disposes its sessions; on quit they stay in
        // `mgr` so they restore (with this window's geometry) next launch.
        if (!isQuit) {
          for (const s of sessionsOwnedBy(sessionOwner, w.id, mgr.list())) disposeSession(s.id);
        }
        w.close();
      }
      // Cancel: not confirmed; window survives.
    });
  };

  // Factory for an additional/empty window (New Window + the primary). Wires the engine-scoped
  // close guard + cleanup of the per-window confirm flag on 'closed'.
  function spawnWindow(opts?: { primary?: boolean }): BrowserWindow {
    const w = createWindow({
      primary: opts?.primary,
      onClose: onWindowClose,
      onClosed: (windowId) => {
        windowConfirmed.delete(windowId);
        // Its visible-session set dies with it, or sessions it was showing would stay
        // exempt from attention forever.
        activity.dropWindow(windowId);
        log.info('window', 'closed', { windowId });
        // A closed window drops out of the move picker (Slice B).
        broadcastWinList?.();
      },
    });
    log.info('window', 'create', { windowId: w.id });
    broadcastWinList?.();
    schedulePersistLayout?.(); // a new window changes the layout (Slice C)
    return w;
  }

  Menu.setApplicationMenu(null);

  // Restore the multi-window LAYOUT (Slice C, overrides Slice A D-4). Sessions were already
  // restored as stale into `mgr` above (gated on restoreSessions); here we recreate the
  // windows at their saved bounds and put each session back in its window, instead of
  // collapsing everything into one window. With no windows.json (first run / restore-off),
  // planLayoutRestore returns a single primary window owning all (or zero) restored sessions
  // — exactly the pre-Slice-C behavior. The first planned window is the primary (sets
  // primaryWindowId, the cold-launch OS-open + second-instance fallback target).
  const savedLayout = settings.restoreSessions ? parseLayout(readBlob(windowsLayoutFile())) : [];
  const restorePlan = planLayoutRestore(
    savedLayout,
    mgr.list().map((s) => s.id),
  );
  const workAreas = screen.getAllDisplays().map((d) => d.workArea);
  for (let i = 0; i < restorePlan.length; i++) {
    const planned = restorePlan[i];
    const w = spawnWindow({ primary: i === 0 });
    w.setBounds(clampBoundsToDisplays(planned.bounds, workAreas));
    for (const id of planned.sessionIds) assignOwner(sessionOwner, id, w.id);
  }
  // planLayoutRestore always yields ≥1 window, but guard against an empty plan defensively.
  if (windows.size === 0) spawnWindow({ primary: true });
  log.info('window', 'layout-restore', { windows: windows.size });
  postState();

  app.on('activate', () => {
    if (windows.size === 0) spawnWindow({ primary: true });
  });

  // Harden every guest <webview>'s own webContents once (app-level, not per window): route
  // popups/new windows to the system browser and block non-http(s) navigation.
  app.on('web-contents-created', (_e, contents) => {
    if (contents.getType() !== 'webview') return;
    contents.setWindowOpenHandler(({ url }) => {
      openExternalUrl(url);
      return { action: 'deny' };
    });
    contents.on('will-navigate', (navEvent, url) => {
      if (!isHttpUrl(url)) navEvent.preventDefault();
    });
  });

  // The OS integrations launch `Conduit.exe "<path>"`. "Open in Conduit" passes a folder;
  // "Open with Conduit" / a default-editor association passes a file. Classify the launch
  // target and route accordingly (openRepo falls back to registry.list()[0] when the agent
  // id is unknown). Used for both a second launch and this first launch.
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
  // parent dir), reuse an existing session whose projectPath is the nearest ancestor of the
  // file (else create one at the root), then tell the renderer to open the doc. The host has
  // no view of which docs are open in the renderer, so the nearest-ancestor (Rule 2) reuse is
  // all that applies here; the renderer's own resolveOwningSession Rule 1 still de-dupes an
  // already-open file when the doc actually opens.
  const openFileFromOS = (filePath: string, ownerWindowId: number) => {
    const root = gitRootOf(filePath, (p) => fs.existsSync(p)) ?? path.dirname(filePath);
    const existing = resolveOwningSession({
      path: filePath,
      sessions: mgr.list().map((s) => ({ id: s.id, projectPath: s.projectPath })),
      openDocs: [],
      activeId: null,
    });
    const sessionId = existing ?? openRepo(root, registry.list()[0]?.id ?? '', ownerWindowId);
    if (sessionId) sendOpenFileInEditor(filePath, sessionId);
  };

  // OS opens are owned by the given window (multi-window Slice A): the focused window for a
  // warm second-instance, the primary window at cold launch.
  const openArg = (argv: readonly string[], ownerWindowId: number) => {
    // argv[0] is the executable (the absolute path to Conduit.exe on a packaged build); skip
    // it explicitly, else classifyPath would return the exe itself as the file to open.
    const target = extractOpenTarget(argv, classifyPath, [process.execPath, argv[0] ?? '']);
    if (!target) return;
    log.info('app', 'os-open', { kind: target.kind, path: target.path });
    if (target.kind === 'dir') openRepo(target.path, registry.list()[0]?.id ?? '', ownerWindowId);
    else openFileFromOS(target.path, ownerWindowId);
  };

  app.on('second-instance', (_event, argv) => {
    log.info('app', 'second-instance');
    const target = focusedWindow();
    openArg(argv, target?.id ?? primaryWindowId);
    if (target) {
      if (target.isMinimized()) target.restore();
      target.focus();
    }
  });

  // First launch opened via the context menu while the app was closed → primary window.
  openArg(process.argv, primaryWindowId);
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
