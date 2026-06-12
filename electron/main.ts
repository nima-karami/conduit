import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { app, BrowserWindow, dialog, ipcMain, Menu, shell } from 'electron';
import { AgentRegistry } from '../src/agent-registry';
import { fingerprint } from '../src/board-watch';
import { loadAgents, readBlob } from '../src/config';
import { searchContentFs } from '../src/content-search-fs';
import { walkFiles } from '../src/file-search';
import { readDiff, readDir, readFile, writeFile } from '../src/file-service';
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
import { isInsideRoot } from '../src/path-guard';
import { restoreSessions, serializeSessions } from '../src/persistence';
import { buildQueueEntry } from '../src/pipeline';
import { getProjectInfo } from '../src/project-info';
import type { AboutInfo, HostToWebview, RepoDTO, WebviewToHost } from '../src/protocol';
import { PtyHost, resolveLaunchSpec } from '../src/pty-host';
import { summarizeQueue } from '../src/queue-summary';
import { createGrantStore, hostCanonical } from '../src/read-grants';
import { restoreRepos, serializeRepos, upsertRepo } from '../src/repo-history';
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
import { ProposalWatcher } from './proposal-watcher';

// ---------- About info (read once at startup) ----------
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

const userData = () => app.getPath('userData');
const sessionsFile = () => path.join(userData(), 'sessions.json');
const agentsFile = () => path.join(userData(), 'agents.json');
const reposFile = () => path.join(userData(), 'repos.json');
const settingsFile = () => path.join(userData(), 'settings.json');

/**
 * Write `data` to `filePath`, logging any failure with `label` as context.
 * Does NOT change what is written or when — only surfaces disk/permission errors
 * that were previously swallowed by empty callbacks.
 */
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
    },
  });
  const emitMax = () => win?.webContents.send('win:maximized', win.isMaximized());
  win.on('maximize', emitMax);
  win.on('unmaximize', emitMax);

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
  // Detected shells first (so nothing defaults to an agent), then configured agents.
  const registry = new AgentRegistry([...detectShells(), ...loadAgents(agentsFile())]);
  const mgr = new SessionManager(registry);

  // Runtime busy/needs-attention tracker (output-activity heuristic). Pure; the
  // host owns the wall clock + the sweep loop below.
  const activity = new SessionActivity();

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
      } else if (msg.type === 'term:exit') {
        mgr.setStatus(msg.sessionId, 'exited');
      }
    },
    (m) => console.log('[pty]', m),
  );

  // Low-frequency sweep detects busy->idle (task finished). Interval is <= half
  // the busy window so detection latency stays bounded; cheap (a Map scan).
  const sweepTimer = setInterval(() => {
    if (activity.sweep(Date.now())) scheduleActivityBroadcast();
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

  // Repos for the UI: history (most recent first) plus a Home entry if absent.
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

  // Live feature board: one watch on the OPENED project's `.conduit/board.json`. When an
  // external agent advances a card by editing the file, push the fresh board to the
  // renderer (self-writes are suppressed inside the watcher via the recorded fingerprint).
  const boardWatcher = new BoardWatcher();

  // Live proposal watcher (N1): one watch on the OPENED project's `.conduit/` for the two
  // `*.proposed.json` siblings. When an agent writes a proposal (or the app accepts/rejects
  // one), push the fresh proposal state to the renderer so the banner appears/clears live.
  const proposalWatcher = new ProposalWatcher();

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
        case 'readDiff':
          send({ type: 'fileDiff', doc: await readDiff(m.path, gitShow) });
          break;
        case 'rename':
          mgr.rename(m.id, m.name);
          break;
        case 'relaunch':
          mgr.setStatus(m.id, 'running');
          break;
        case 'kill':
          pty.dispose(m.id);
          mgr.remove(m.id);
          activity.forget(m.id);
          break;
        case 'focus':
          // Renderer's active session changed; clear its needs-attention flag.
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
          break;
        case 'revealInExplorer':
          shell.showItemInFolder(m.path);
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
        case 'term:start':
          // Guard against a kill-race: a `kill` (pty.dispose + mgr.remove) that
          // races a late `term:start` from a remounting TerminalPane would spawn a
          // process for a session the manager no longer knows about — nothing would
          // ever dispose it until app quit. Bail early if the session is gone.
          if (!mgr.get(m.sessionId)) break;
          pty.start(m.sessionId, m.cols, m.rows, resolveSpec(m.agentId, m.cwd));
          mgr.touch(m.sessionId); // session became active
          break;
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
    proposalWatcher.stop();
    pty.disposeAll();
  });

  Menu.setApplicationMenu(null);
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
