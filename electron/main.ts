import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { app, BrowserWindow, dialog, ipcMain, Menu, Notification, shell } from 'electron';
import { activeCwd } from '../src/active-cwd';
import { AgentRegistry } from '../src/agent-registry';
import { fingerprint } from '../src/board-watch';
import { loadAgents, readBlob } from '../src/config';
import { searchContentFs } from '../src/content-search-fs';
import { cwdReportingAugmentation } from '../src/cwd-reporting';
import { walkFiles } from '../src/file-search';
import { readDiff, readDir, readFile, writeFile } from '../src/file-service';
import { fsCopy, fsMove } from '../src/fs-dnd';
import { fsImport } from '../src/fs-import';
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
import { interrogateGit } from '../src/git-info';
import { shouldRaiseOsAttention } from '../src/os-attention';
import { CwdScanner } from '../src/osc-cwd';
import { isInsideRoot } from '../src/path-guard';
import { restoreSessions, serializeSessions } from '../src/persistence';
import { buildQueueEntry } from '../src/pipeline';
import { getProjectInfo } from '../src/project-info';
import type { AboutInfo, HostToWebview, RepoDTO, WebviewToHost } from '../src/protocol';
import { PtyHost, resolveLaunchSpec } from '../src/pty-host';
import { summarizeQueue } from '../src/queue-summary';
import type { QuitReason } from '../src/quit-guard';
import { busySessions, needsQuitConfirm, runningSessions } from '../src/quit-guard';
import { createGrantStore, hostCanonical } from '../src/read-grants';
import { restoreRepos, serializeRepos, upsertRepo } from '../src/repo-history';
import { revealActionFor } from '../src/reveal-action';
import {
  appendScrollback,
  restoreScrollback,
  SCROLLBACK_CAP_BYTES,
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
import type { SpawnSpec } from '../src/types';
import { extractDirArg } from './arg-utils';
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
  readSpec,
  rejectProposal,
  writeArchitectureArtifactFile,
  writeBoardArtifactFile,
  writePipelineArtifactFile,
  writeSpec,
} from './conduit-fs';
import { OpenFileWatcher } from './open-file-watcher';
import { ProjectWatcher } from './project-watcher';
import { ProposalWatcher } from './proposal-watcher';
import { checkForUpdate, initUpdater, quitAndInstall } from './updater';

function readAboutInfo(): AboutInfo {
  try {
    // package.json lives one directory above __dirname (out/main.js → root).
    const pkgPath = path.join(__dirname, '..', 'package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as {
      version?: string;
      author?: string | { name?: string };
    };
    const version = typeof pkg.version === 'string' ? pkg.version : '0.0.0';
    const rawAuthor = pkg.author;
    const author =
      typeof rawAuthor === 'string'
        ? rawAuthor
        : typeof rawAuthor === 'object' && rawAuthor?.name
          ? rawAuthor.name
          : 'Nima Karami';
    return {
      version,
      author,
      electronVersion: process.versions.electron ?? '',
      nodeVersion: process.versions.node ?? '',
      chromeVersion: process.versions.chrome ?? '',
    };
  } catch {
    return {
      version: '0.0.0',
      author: 'Nima Karami',
      electronVersion: process.versions.electron ?? '',
      nodeVersion: process.versions.node ?? '',
      chromeVersion: process.versions.chrome ?? '',
    };
  }
}

const aboutInfo: AboutInfo = readAboutInfo();

// Allow WebGL even when the GPU is blocklisted/unavailable, so the shader
// background (and xterm's WebGL renderer) work via software rendering as a
// fallback. Must run before app 'ready'.
app.commandLine.appendSwitch('ignore-gpu-blocklist');
app.commandLine.appendSwitch('enable-unsafe-swiftshader');

let win: BrowserWindow | null = null;

// Set by the app-ready closure; invoked on window focus so the git indicator self-heals
// against an external `git checkout` made while the app was unfocused (Slice A refresh).
let onWindowFocus: (() => void) | null = null;

const userData = () => app.getPath('userData');
const sessionsFile = () => path.join(userData(), 'sessions.json');
const agentsFile = () => path.join(userData(), 'agents.json');
const reposFile = () => path.join(userData(), 'repos.json');
const settingsFile = () => path.join(userData(), 'settings.json');
// Per-terminal-session scrollback (T2). One file per session; session ids are
// app-generated and filename-safe, but a defensive sanitize keeps any stray separator
// out of the path.
const scrollbackFile = (sessionId: string) =>
  path.join(userData(), `scrollback-${sessionId.replace(/[^\w.-]/g, '_')}.json`);

/** Write `data` to `filePath`, surfacing disk/permission errors that empty callbacks would swallow. */
function persistFile(filePath: string, data: string, label: string): void {
  fs.writeFile(filePath, data, (err) => {
    if (err) console.error(`[persist] failed to write ${label}:`, err);
  });
}

function git(args: string[], cwd: string): Promise<string> {
  return new Promise((resolve) => {
    execFile('git', args, { cwd, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) =>
      resolve(err ? '' : stdout),
    );
  });
}

async function gitShow(absPath: string): Promise<string> {
  const dir = path.dirname(absPath);
  const root = (await git(['rev-parse', '--show-toplevel'], dir)).trim();
  if (!root) return '';
  const rel = path.relative(root, absPath).split(path.sep).join('/');
  return git(['show', `HEAD:${rel}`], root);
}

/**
 * Binary-safe HEAD blob read. The text `gitShow`/`git()` above utf8-decode stdout,
 * which corrupts image bytes; this returns the raw Buffer via `encoding: 'buffer'`.
 * Resolves `null` when the path has no HEAD blob (new/untracked file) or the read
 * fails — the caller treats that as "added".
 */
function gitShowBuffer(absPath: string): Promise<Buffer | null> {
  return new Promise((resolve) => {
    const dir = path.dirname(absPath);
    execFile(
      'git',
      ['rev-parse', '--show-toplevel'],
      { cwd: dir, windowsHide: true },
      (rpErr, rpOut) => {
        const root = rpErr ? '' : String(rpOut).trim();
        if (!root) return resolve(null);
        const rel = path.relative(root, absPath).split(path.sep).join('/');
        execFile(
          'git',
          ['show', `HEAD:${rel}`],
          { cwd: root, windowsHide: true, encoding: 'buffer', maxBuffer: 32 * 1024 * 1024 },
          (err, stdout) => resolve(err ? null : (stdout as Buffer)),
        );
      },
    );
  });
}

function send(msg: HostToWebview) {
  win?.webContents.send('to-webview', msg);
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

function createWindow() {
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 900,
    minHeight: 560,
    backgroundColor: '#0c0d10',
    title: 'Conduit',
    // The smoke suite (CONDUIT_E2E=1) launches the window hidden so runs don't pop
    // up windows or steal focus. Playwright drives the renderer over CDP either way;
    // backgroundThrottling:false below keeps a hidden window rendering normally.
    show: process.env.CONDUIT_E2E !== '1',
    // App icon: .ico on Windows for taskbar/alt-tab, .png otherwise.
    icon: path.join(
      __dirname,
      '..',
      'assets',
      process.platform === 'win32' ? 'icon.ico' : 'icon.png',
    ),
    // Hide the native title bar (keep the frame so resizing stays native); the
    // renderer draws its own draggable top bar + window controls.
    titleBarStyle: 'hidden',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      // Don't throttle the renderer's compositor/timers while the window is
      // minimized or hidden. Otherwise the animated background's paint state goes
      // stale and Chromium shows a brief flash when the window is restored after a
      // long minimize (wishlist focus-restore-flash). Keeping it warm trades a little
      // background GPU for a clean restore.
      backgroundThrottling: false,
    },
  });
  const emitMax = () => win?.webContents.send('win:maximized', win.isMaximized());
  win.on('maximize', emitMax);
  win.on('unmaximize', emitMax);
  // Stop taskbar flash when the window regains focus (T1A).
  win.on('focus', () => {
    win?.flashFrame(false);
    onWindowFocus?.();
  });

  // Links must never navigate the app window away (that strands the user in a
  // chrome-less full-screen page with no back button — wishlist E4). Route
  // external URLs to the real browser; deny any in-window/new-window navigation.
  win.webContents.setWindowOpenHandler(({ url }) => {
    openExternalUrl(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    // The app itself is loaded via loadFile(index.html); only that is allowed.
    if (url.startsWith('file://')) return;
    event.preventDefault();
    openExternalUrl(url);
  });

  void win.loadFile(path.join(__dirname, 'index.html'));
  win.on('closed', () => (win = null));
}

app.whenReady().then(() => {
  // Single-instance: a second launch (e.g. the "Open in Conduit" context menu while the
  // app is already running) must route its folder into THIS instance, not open a duplicate.
  // The loser instance quits immediately; the primary handles `second-instance` below.
  if (!app.requestSingleInstanceLock()) {
    app.quit();
    return;
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

  // ── Git indicator (Slice A) ────────────────────────────────────────────────
  // Per-session interrogation of activeCwd's git context, delivered on the existing
  // `state` broadcast (no new channel). Refresh triggers: cwd-change (E2 seam),
  // best-effort fs.watch of the resolved HEAD (an external `git checkout` that doesn't
  // move cwd), and window-focus. Debounced 150 ms per session; NO interval polling.
  const GIT_DEBOUNCE_MS = 150;
  const gitDebounce = new Map<string, ReturnType<typeof setTimeout>>();
  const gitWatchers = new Map<string, fs.FSWatcher>();
  const gitWatchedHead = new Map<string, string>();

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
    const cwd = activeCwd(session);
    let result: Awaited<ReturnType<typeof interrogateGit>>;
    try {
      result = await interrogateGit(cwd);
    } catch {
      result = { info: { kind: 'none' } };
    }
    // Drop a stale result if the cwd moved on while we were interrogating.
    const latest = mgr.get(sessionId);
    if (!latest || activeCwd(latest) !== cwd) return;
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
      send(msg);
      if (msg.type === 'term:data') {
        // Output activity drives the busy/needs-attention machine. Only an
        // idle->busy edge (or an attention clear) is a change worth broadcasting.
        if (activity.recordOutput(msg.sessionId, Date.now())) scheduleActivityBroadcast();

        // T2: accumulate the session's recent output into its scrollback ring and
        // debounce a write to disk. This callback only fires for genuine PTY output;
        // replayed history is sent via send() in term:start and never re-enters here.
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
                  // Git indicator (Slice A): the active cwd moved — re-interrogate.
                  scheduleGitRefresh(msg.sessionId);
                }
              } catch {
                /* ignore stat errors (e.g. permission denied) */
              }
            }
          }
        }
      } else if (msg.type === 'term:exit') {
        mgr.setStatus(msg.sessionId, 'exited');
        // Clean up the scanner for this session (E2a).
        cwdScanners.delete(msg.sessionId);
        // Git indicator (Slice A): tear down the per-session HEAD watch + debounce.
        teardownGitRefresh(msg.sessionId);
        // T2: flush the last screenful now (the process ended); keep the file so the
        // user can still see the final output until the session is killed.
        if (settings.scrollbackPersistence) flushScrollback(msg.sessionId);
      }
    },
    (m) => console.log('[pty]', m),
  );

  // Per-terminal-session scrollback ring (T2): the recent output bytes, capped to a
  // trailing 256 KiB window in memory and debounced to scrollback-<id>.json. Fed from the
  // PtyHost output callback (term:data).
  const scrollbacks = new Map<string, string>();
  const scrollbackPersistTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const flushScrollback = (sessionId: string) => {
    const data = scrollbacks.get(sessionId);
    if (data === undefined) return;
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

  // Sessions we've already raised an OS notification for this attention episode. A
  // session that emits intermittent output (a repainting TUI, a finished agent whose
  // CLI redraws its prompt) cycles busy->idle repeatedly, each idle looking like a fresh
  // "finished" edge — without this guard it would re-notify on every cycle. Cleared only
  // when the user acknowledges by focusing the session (or it's killed), so a genuinely
  // new finish after the user has looked notifies again.
  const osNotified = new Set<string>();

  // Low-frequency sweep detects busy->idle (task finished). Interval is <= half
  // the busy window so detection latency stays bounded; cheap (a Map scan).
  const sweepTimer = setInterval(() => {
    const now = Date.now();
    // Snapshot which sessions had needsAttention BEFORE the sweep so we can detect
    // the false->true edge (newly-finished sessions) after it.
    const preAttention = new Set(
      mgr
        .list()
        .filter((s) => activity.statusOf(s.id).needsAttention)
        .map((s) => s.id),
    );
    if (!activity.sweep(now)) return;
    scheduleActivityBroadcast();
    // Find sessions that just crossed the busy->needs-attention edge this sweep.
    const newlyFinished = mgr
      .list()
      .filter((s) => activity.statusOf(s.id).needsAttention && !preAttention.has(s.id));
    for (const session of newlyFinished) {
      if (osNotified.has(session.id)) continue; // already alerted this episode — don't spam
      if (
        shouldRaiseOsAttention({
          becameNeedsAttention: true,
          windowFocused: win?.isFocused() ?? false,
          enabled: settings.osAttention,
        })
      ) {
        osNotified.add(session.id);
        win?.flashFrame(true);
        if (Notification.isSupported()) {
          const notif = new Notification({
            title: 'Conduit',
            body: `${session.name} finished`,
          });
          notif.on('click', () => {
            if (win) {
              win.show();
              win.focus();
              send({ type: 'activateSession', sessionId: session.id });
            }
          });
          notif.show();
        }
      }
    }
  }, 750);

  // User settings (theme/fonts/layout/behaviour), persisted to settings.json.
  let settings: AppSettings = restoreSettings(readBlob(settingsFile()));

  // Restore previously persisted sessions (as stale) + save on every change.
  if (settings.restoreSessions) mgr.restore(restoreSessions(readBlob(sessionsFile())));
  mgr.onChange(() => {
    persistFile(sessionsFile(), serializeSessions(mgr.list()), 'sessions.json');
    postState();
  });

  // Recently-opened repositories (with the terminal last used in each).
  let repos = restoreRepos(readBlob(reposFile()));

  // History (most recent first) plus a Home entry if absent.
  const reposForState = (): RepoDTO[] => {
    const home = os.homedir();
    const sorted = [...repos].sort((a, b) => b.lastOpened - a.lastOpened);
    if (!sorted.some((r) => r.path === home)) {
      sorted.push({ path: home, name: 'Home', lastOpened: 0 });
    }
    return sorted;
  };

  const postState = () => {
    // Merge runtime busy/needs-attention flags onto every session (both the flat
    // list and the per-project groups) so the renderer receives them in-band.
    const sessions = activity.apply(mgr.list());
    const groups = mgr.groupByProject().map((g) => ({
      projectPath: g.projectPath,
      sessions: activity.apply(g.sessions),
    }));
    send({
      type: 'state',
      agents: registry.list(),
      groups,
      sessions,
      repos: reposForState(),
      settings,
      about: aboutInfo,
    });
  };

  // Open a folder in the chosen terminal and remember it in history. `cardId` (N2),
  // when present, stamps the new session with the feature-board card it was started for.
  function openRepo(p: string, agentId: string, cardId?: string) {
    if (!p) return;
    const agent = registry.get(agentId) ?? registry.list()[0];
    if (!agent) {
      dialog.showErrorBox('Conduit', 'No terminals available.');
      return;
    }
    repos = upsertRepo(repos, {
      path: p,
      name: path.basename(p) || p,
      lastAgentId: agent.id,
      lastOpened: Date.now(),
    });
    persistFile(reposFile(), serializeRepos(repos), 'repos.json');
    mgr.create(agent.id, p, undefined, cardId); // emits change -> postState (includes updated repos)
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

  const openFileWatcher = new OpenFileWatcher((p) => send({ type: 'fileChanged', path: p }));

  const projectWatcher = new ProjectWatcher((root) => send({ type: 'fsChanged', root }), {
    log: (m) => console.log('[watch]', m),
  });

  const proposalWatcher = new ProposalWatcher();

  // Auto-update lifecycle (no-op in dev; active only in packaged builds).
  const stopUpdater = initUpdater(send);

  // ── Quit / close / update-relaunch guard (W2) ────────────────────────────
  // Flag: set to true once the user confirms quit so the close event re-fires
  // without triggering a second prompt (prevents an infinite preventDefault loop).
  // Reset when the close is cancelled (window survives).
  let quitConfirmed = false;

  /**
   * Ask the user to confirm a destructive action (quit/close/update-relaunch).
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
  async function confirmWithRenderer(reason: QuitReason): Promise<boolean> {
    const sessions = activity.apply(mgr.list());
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

      const onDecision = (_e: unknown, m: WebviewToHost) => {
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

      send({ type: 'confirmQuit', reason, running: running.length, busy });
    });
  }

  /** Read the current proposal for a kind and push it (or `null`) to the renderer. */
  function sendProposal(p: string, kind: ProposalKind) {
    if (kind === 'board') {
      send({ type: 'proposal', path: p, kind, proposed: readBoardProposal(p) });
    } else {
      send({ type: 'proposal', path: p, kind, proposed: readArchitectureProposal(p) });
    }
  }

  /** Re-push the canonical artifact for a kind (after an accept rewrote it). */
  function sendCanonical(p: string, kind: ProposalKind) {
    if (kind === 'board') {
      send({ type: 'board', path: p, board: readBoardForProject(p) });
    } else {
      send({ type: 'architecture', path: p, doc: readArchitectureForProject(p) });
    }
  }

  // Arm a single live proposal watch for a project (idempotent enough: watch() replaces any
  // prior watch). Fired on board OR canvas open; whichever kind changed is pushed.
  function armProposalWatch(p: string) {
    proposalWatcher.watch(p, (kind) => sendProposal(p, kind));
  }

  async function sendProject(p: string) {
    // Arm/re-point the live watcher at whatever project the renderer is currently showing
    // (idempotent for the same root). requestProject fires on open + focus + cwd change.
    if (p) projectWatcher.watch(p);
    try {
      const info = await getProjectInfo(p);
      send({
        type: 'project',
        path: p,
        changes: info.changes,
        files: info.files,
        customizations: info.customizations,
      });
    } catch {
      send({ type: 'project', path: p, changes: [], files: [], customizations: [] });
    }
  }

  // Show a folder dialog, then open the picked folder in the chosen terminal.
  async function browseRepo(agentId: string) {
    const options = {
      properties: ['openDirectory' as const],
      title: 'Open a repository',
    };
    const picked = win
      ? await dialog.showOpenDialog(win, options)
      : await dialog.showOpenDialog(options);
    if (picked.canceled || !picked.filePaths[0]) return;
    openRepo(picked.filePaths[0], agentId);
  }

  async function handle(m: WebviewToHost) {
    try {
      switch (m.type) {
        case 'ready':
          postState();
          break;
        case 'log':
          console.log('[webview]', m.message);
          break;
        case 'openRepo':
          openRepo(m.path, m.agentId, m.cardId);
          break;
        case 'browseRepo':
          await browseRepo(m.agentId);
          break;
        case 'requestProject':
          await sendProject(m.path);
          break;
        case 'readDir':
          send({ type: 'dirEntries', path: m.path, entries: await readDir(m.path) });
          break;
        case 'readFile': {
          const doc = await readFile(m.path);
          // Record a write-grant for a file the host itself chose to serve (K2). Only on
          // a successful, non-binary, non-error read — never grant a path that failed to
          // read, and never a directory (readFile only ever serves files). This lets the
          // editor save a go-to-definition target / out-of-root recent that lives outside
          // every write root, while validateWrite still governs arbitrary paths.
          if (!doc.error && !doc.binary) readGrants.add(m.path);
          send({ type: 'fileContent', doc });
          break;
        }
        case 'watchFiles': {
          // Watch exactly the files the renderer reports open. These paths were all served
          // via readFile, so they're files the host already chose to expose — watching is
          // read-only and adds no new trust surface.
          openFileWatcher.setPaths(m.paths);
          break;
        }
        case 'readDiff':
          send({ type: 'fileDiff', doc: await readDiff(m.path, gitShow, gitShowBuffer) });
          break;
        case 'rename':
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
        case 'kill': {
          pty.dispose(m.id);
          mgr.remove(m.id);
          activity.forget(m.id);
          cwdScanners.delete(m.id);
          // T2: the session is gone — drop its scrollback ring/timer and delete the file
          // so userData doesn't accumulate orphans. Best-effort, ENOENT-tolerant.
          scrollbacks.delete(m.id);
          const sbTimer = scrollbackPersistTimers.get(m.id);
          if (sbTimer) {
            clearTimeout(sbTimer);
            scrollbackPersistTimers.delete(m.id);
          }
          replayedScrollback.delete(m.id);
          osNotified.delete(m.id);
          // Drop the git torn-down latch so it doesn't accumulate across killed sessions
          // (term:exit from the dispose above already closed any live watcher).
          gitTornDown.delete(m.id);
          fs.unlink(scrollbackFile(m.id), () => {});
          break;
        }
        case 'focus':
          // Renderer's active session changed; clear its needs-attention flag and the
          // OS-notification guard so a future finish (after the user has looked) re-alerts.
          osNotified.delete(m.id);
          if (activity.focus(m.id)) scheduleActivityBroadcast();
          break;
        case 'duplicate':
          mgr.duplicate(m.id); // emits change -> postState
          break;
        case 'reorderSessions':
          mgr.reorder(m.order); // emits change -> postState (+ persists order)
          break;
        case 'updateSettings':
          // Coerce before persisting: drops unknown keys, clamps ranges, whitelists
          // enum strings, and runs the legacy codeBg→surfaceColor migration.
          settings = coerceSettings(m.settings as unknown as Record<string, unknown>);
          persistFile(settingsFile(), serializeSettings(settings), 'settings.json');
          // Git indicator (Slice A): re-evaluate every session on a settings change;
          // runGitRefresh re-interrogates when on and clears the indicator when off.
          refreshAllGit();
          break;
        case 'revealInExplorer':
          if (revealActionFor(m.path) === 'openPath') {
            void shell.openPath(m.path);
          } else {
            shell.showItemInFolder(m.path);
          }
          break;
        case 'indexProject': {
          const SRC = new Set(['ts', 'tsx', 'js', 'jsx', 'mts', 'cts', 'mjs', 'cjs']);
          const hits = walkFiles(m.root)
            .filter((h) => SRC.has(h.rel.split('.').pop()?.toLowerCase() ?? ''))
            .slice(0, 400);
          const files: { path: string; content: string; language: string }[] = [];
          for (const h of hits) {
            const dto = await readFile(h.abs);
            if (!dto.binary && !dto.error)
              files.push({ path: h.abs, content: dto.content, language: dto.language });
          }
          send({ type: 'projectFiles', root: m.root, files });
          break;
        }
        case 'requestBoard': {
          // The board + its has-spec indicators (G3) + pipeline-queue summary (N3), sent
          // as one consistent batch. Always re-tagged with the request's path (m.path) so
          // a stale watcher reply for a previous project can't land in the renderer.
          const sendBoardBundle = (board: ReturnType<typeof readBoardForProject>) => {
            send({ type: 'board', path: m.path, board });
            send({ type: 'specsList', path: m.path, cardIds: listSpecs(m.path) });
            send({
              type: 'pipelineQueue',
              path: m.path,
              summary: summarizeQueue(readPipelineQueueForProject(m.path).entries),
            });
          };
          // Per-project board at `<root>/.conduit/board.json` (empty if absent/none).
          sendBoardBundle(readBoardForProject(m.path));
          // Live watch so an external agent's edits update the open board without reopening.
          boardWatcher.watch(m.path, sendBoardBundle);
          // Surface any pending board proposal (N1) + watch for it appearing/clearing live.
          sendProposal(m.path, 'board');
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
            .then(() => boardWatcher.recordWrite(fingerprint(m.board)))
            .catch((err: unknown) => {
              const message = err instanceof Error ? err.message : String(err);
              console.error('Failed to write .conduit/board.json:', message);
              send({ type: 'error', message: `Could not save board: ${message}` });
            });
          break;
        case 'requestSpec': {
          // A card's spec at `<root>/.conduit/specs/<id>.md` (G3). Absent = empty content,
          // `exists: false` — the renderer seeds a heading from the card title it holds.
          const content = readSpec(m.path, m.cardId);
          send({
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
            .then(() => send({ type: 'specsList', path: m.path, cardIds: listSpecs(m.path) }))
            .catch((err: unknown) => {
              const message = err instanceof Error ? err.message : String(err);
              console.error('Failed to write .conduit/specs:', message);
              send({ type: 'error', message: `Could not save spec: ${message}` });
            });
          break;
        case 'requestArchitecture':
          // Read from `.conduit/architecture.json`, migrating the legacy bare
          // `<root>/architecture.json` forward when `.conduit/` doesn't have it yet.
          send({
            type: 'architecture',
            path: m.path,
            doc: readArchitectureForProject(m.path),
          });
          // Surface any pending architecture proposal (N1) + watch for changes live.
          sendProposal(m.path, 'architecture');
          armProposalWatch(m.path);
          break;
        case 'updateArchitecture':
          // Write the committed `.conduit/` envelope atomically. Unlike the legacy
          // swallowing write, surface a failed save to the renderer (ADR §5) so a
          // committed artifact is never silently mistaken for saved.
          writeArchitectureArtifactFile(m.path, m.doc).catch((err: unknown) => {
            const message = err instanceof Error ? err.message : String(err);
            console.error('Failed to write .conduit/architecture.json:', message);
            send({ type: 'error', message: `Could not save architecture: ${message}` });
          });
          break;
        case 'requestProposal':
          // Surface the current proposal state for a kind (N1). `null` when none pending.
          sendProposal(m.path, m.kind);
          break;
        case 'acceptProposal': {
          // Apply the proposed whole document to the canonical file, delete the proposal,
          // then push BOTH the now-empty proposal state (clears the banner) and the fresh
          // canonical doc (so the view reflects the applied change without a reload). The
          // canonical write records a self-write fingerprint so the board watcher doesn't
          // re-emit our own apply as an external edit.
          const kind = m.kind;
          acceptProposal(m.path, kind)
            .then(() => {
              if (kind === 'board')
                boardWatcher.recordWrite(fingerprint(readBoardForProject(m.path)));
              sendCanonical(m.path, kind);
              if (kind === 'board')
                send({ type: 'specsList', path: m.path, cardIds: listSpecs(m.path) });
              sendProposal(m.path, kind);
            })
            .catch((err: unknown) => {
              const message = err instanceof Error ? err.message : String(err);
              console.error('Failed to accept proposal:', message);
              send({ type: 'error', message: `Could not accept proposal: ${message}` });
            });
          break;
        }
        case 'rejectProposal': {
          // Delete the proposal; the canonical doc is untouched. Re-push the (now-null)
          // proposal state so the banner clears even without a live watch event.
          const kind = m.kind;
          rejectProposal(m.path, kind)
            .then(() => sendProposal(m.path, kind))
            .catch((err: unknown) => {
              const message = err instanceof Error ? err.message : String(err);
              console.error('Failed to reject proposal:', message);
              send({ type: 'error', message: `Could not reject proposal: ${message}` });
            });
          break;
        }
        case 'requestPipeline':
          // Per-project skill-per-transition config at `<root>/.conduit/pipeline.json`
          // (empty if absent/none). The board encodes the pipeline, not just the status (G4).
          send({ type: 'pipeline', path: m.path, config: readPipelineForProject(m.path) });
          break;
        case 'updatePipeline':
          // Human-owned config; surface a failed save (ADR §5), never swallow it.
          writePipelineArtifactFile(m.path, m.config).catch((err: unknown) => {
            const message = err instanceof Error ? err.message : String(err);
            console.error('Failed to write .conduit/pipeline.json:', message);
            send({ type: 'error', message: `Could not save pipeline: ${message}` });
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
              // Re-emit the updated queue summary so the header badge increments live.
              send({
                type: 'pipelineQueue',
                path: qPath,
                summary: summarizeQueue(readPipelineQueueForProject(qPath).entries),
              });
            })
            .catch((err: unknown) => {
              const message = err instanceof Error ? err.message : String(err);
              console.error('Failed to record pipeline transition:', message);
              send({ type: 'error', message: `Could not record transition: ${message}` });
            });
          break;
        }
        case 'searchFiles':
          send({ type: 'searchResults', root: m.root, results: walkFiles(m.root) });
          break;
        case 'contentSearch': {
          // Project-wide find-in-files (L5). Bounded by the core's ignore set, result
          // caps, time budget, and binary/large-file skips. `requestId` is echoed back so
          // a newer query supersedes this (stale) reply in the renderer. Wrapped so a
          // throw (e.g. a vanished root) surfaces as an inline error, not a dead panel.
          let res: {
            results: ReturnType<typeof searchContentFs>['files'];
            truncated: boolean;
            error?: string;
          };
          try {
            const r = searchContentFs(m.root, m.query);
            res = { results: r.files, truncated: r.truncated, error: r.error };
          } catch (e: unknown) {
            res = {
              results: [],
              truncated: false,
              error: e instanceof Error ? e.message : String(e),
            };
          }
          send({
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
          // T2: replay persisted scrollback BEFORE pty.start, so restored history precedes
          // any live output and the (later) `— session relaunched —` banner. Once-per-run
          // guard so a pane remount within this run doesn't re-inject the whole history.
          if (settings.scrollbackPersistence && !replayedScrollback.has(m.sessionId)) {
            replayedScrollback.add(m.sessionId);
            const restored = restoreScrollback(readBlob(scrollbackFile(m.sessionId)));
            if (restored?.data) {
              scrollbacks.set(m.sessionId, restored.data);
              send({
                type: 'term:data',
                sessionId: m.sessionId,
                data: '\r\n\x1b[2m— restored —\x1b[0m\r\n',
              });
              send({ type: 'term:data', sessionId: m.sessionId, data: restored.data });
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
          pty.start(m.sessionId, m.cols, m.rows, spec);
          mgr.touch(m.sessionId); // session became active
          // Git indicator (Slice A): interrogate the session's cwd on start so the bar
          // appears before the first `cd`. Establishes the HEAD watch too.
          scheduleGitRefresh(m.sessionId);
          // Write a brief system line the first time a relaunched session's terminal
          // starts so the user can see it is a fresh process, not the original run.
          if (pendingRelaunchMarker.delete(m.sessionId)) {
            send({
              type: 'term:data',
              sessionId: m.sessionId,
              data: '\r\n\x1b[2m— session relaunched —\x1b[0m\r\n',
            });
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
          pty.resize(m.sessionId, m.cols, m.rows);
          break;
        case 'term:dispose':
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
          send({ type: 'pathExistsResult', path: p, exists, isDir });
          break;
        }
        case 'updateCheck':
          checkForUpdate();
          break;
        case 'updateRelaunch':
          // W2: guard update-relaunch behind a session-running confirm. On proceed, set
          // quitConfirmed so the close event fired by quitAndInstall() passes through.
          if (!needsQuitConfirm(mgr.list())) {
            quitAndInstall();
          } else {
            void confirmWithRenderer('update').then((proceed) => {
              if (proceed) {
                quitConfirmed = true;
                quitAndInstall();
              }
              // Cancel: stay open, update remains pending.
            });
          }
          break;
      }
    } catch (e: unknown) {
      send({ type: 'error', message: e instanceof Error ? e.message : String(e) });
    }
  }

  ipcMain.on('to-host', (_e, m: WebviewToHost) => void handle(m));

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
  ipcMain.handle('fs-move', async (_e, from: string, to: string) => {
    try {
      return await fsMove(from, to, writeRoots());
    } catch (e: unknown) {
      return { ok: false as const, error: e instanceof Error ? e.message : String(e) };
    }
  });
  ipcMain.handle('fs-copy', async (_e, from: string, to: string) => {
    try {
      return await fsCopy(from, to, writeRoots());
    } catch (e: unknown) {
      return { ok: false as const, error: e instanceof Error ? e.message : String(e) };
    }
  });
  // OS drag-and-drop import: copy external files/folders into a target dir inside a root.
  // Only the TARGET is path-guarded; the sources are arbitrary OS paths the user dragged in.
  ipcMain.handle('fs-import', async (_e, sources: string[], targetDir: string) => {
    try {
      return await fsImport(sources, targetDir, writeRoots());
    } catch (e: unknown) {
      return { ok: false as const, error: e instanceof Error ? e.message : String(e) };
    }
  });

  // Custom window controls (native title bar is hidden).
  ipcMain.on('win:minimize', () => win?.minimize());
  ipcMain.on('win:toggleMaximize', () => (win?.isMaximized() ? win.unmaximize() : win?.maximize()));
  ipcMain.on('win:close', () => win?.close());
  ipcMain.handle('win:isMaximized', () => win?.isMaximized() ?? false);

  // Renderer asks the host to open a link in the real browser (non-destructive).
  ipcMain.on('open-external', (_e, url: string) => openExternalUrl(url));

  app.on('before-quit', () => {
    clearInterval(sweepTimer);
    if (activityTimer) clearTimeout(activityTimer);
    boardWatcher.stop();
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

  Menu.setApplicationMenu(null);
  createWindow();

  // Intercept the BrowserWindow close event (W2 quit-guard spine).
  // This single seam covers: custom ✕ (renderer → win:close → win.close()),
  // OS close (Alt+F4 / taskbar), and the update-relaunch path. The update
  // handler sets quitConfirmed=true before quitAndInstall() so the close event
  // that fires through the update path passes through without a second prompt.
  win?.on('close', (e) => {
    if (quitConfirmed) return; // already confirmed — let it through
    if (!needsQuitConfirm(mgr.list())) return; // no running sessions — no prompt needed
    e.preventDefault();
    void confirmWithRenderer('quit').then((proceed) => {
      if (proceed) {
        quitConfirmed = true;
        win?.close();
      }
      // Cancel: quitConfirmed stays false; window survives.
    });
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });

  // "Open in Conduit" launches `Conduit.exe "<dir>"`. Resolve the directory argument and
  // open a session there with the default terminal (openRepo falls back to registry.list()[0]
  // when the agent id is unknown). Used for both a second launch and this first launch.
  const isDir = (p: string) => {
    try {
      return fs.statSync(p).isDirectory();
    } catch {
      return false;
    }
  };
  const openDirArg = (argv: readonly string[]) => {
    const dir = extractDirArg(argv, isDir);
    if (dir) openRepo(dir, registry.list()[0]?.id ?? '');
  };

  app.on('second-instance', (_event, argv) => {
    openDirArg(argv);
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  // First launch opened via the context menu while the app was closed.
  openDirArg(process.argv);
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
