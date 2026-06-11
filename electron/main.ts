import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { app, BrowserWindow, dialog, ipcMain, Menu, shell } from 'electron';
import { AgentRegistry } from '../src/agent-registry';
import { fingerprint } from '../src/board-watch';
import { loadAgents, readBlob } from '../src/config';
import { walkFiles } from '../src/file-search';
import { readDiff, readDir, readFile, writeFile } from '../src/file-service';
import { restoreSessions, serializeSessions } from '../src/persistence';
import { getProjectInfo } from '../src/project-info';
import type { HostToWebview, RepoDTO, WebviewToHost } from '../src/protocol';
import { PtyHost, resolveLaunchSpec } from '../src/pty-host';
import { restoreRepos, serializeRepos, upsertRepo } from '../src/repo-history';
import { SessionActivity } from '../src/session-activity';
import { SessionManager } from '../src/session-manager';
import { type AppSettings, restoreSettings, serializeSettings } from '../src/settings';
import { detectShells } from '../src/shells';
import type { SpawnSpec } from '../src/types';
import { BoardWatcher } from './board-watcher';
import {
  readArchitectureForProject,
  readBoardForProject,
  writeArchitectureArtifactFile,
  writeBoardArtifactFile,
} from './conduit-fs';

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
    fs.writeFile(sessionsFile(), serializeSessions(mgr.list()), () => {});
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
    });
  };

  // Open a folder in the chosen terminal and remember it in history.
  function openRepo(p: string, agentId: string) {
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
    fs.writeFile(reposFile(), serializeRepos(repos), () => {});
    mgr.create(agent.id, p); // emits change -> postState (includes updated repos)
  }

  const resolveSpec = (agentId?: string, cwd?: string): SpawnSpec =>
    resolveLaunchSpec(registry, agentId, cwd, (p) => fs.existsSync(p), os.homedir());

  // Live feature board: one watch on the OPENED project's `.conduit/board.json`. When an
  // external agent advances a card by editing the file, push the fresh board to the
  // renderer (self-writes are suppressed inside the watcher via the recorded fingerprint).
  const boardWatcher = new BoardWatcher();

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
          openRepo(m.path, m.agentId);
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
        case 'readFile':
          send({ type: 'fileContent', doc: await readFile(m.path) });
          break;
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
          settings = m.settings;
          fs.writeFile(settingsFile(), serializeSettings(settings), () => {});
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
          // Per-project board at `<root>/.conduit/board.json` (empty if absent/none).
          const board = readBoardForProject(m.path);
          send({ type: 'board', path: m.path, board });
          // Start (or switch to) a live watch so an external agent's edits update the
          // open board without reopening it. Re-tag the reply with the request's path
          // so a stale reply for a previous project can't land in the renderer.
          boardWatcher.watch(m.path, (b) => send({ type: 'board', path: m.path, board: b }));
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
        case 'requestArchitecture':
          // Read from `.conduit/architecture.json`, migrating the legacy bare
          // `<root>/architecture.json` forward when `.conduit/` doesn't have it yet.
          send({
            type: 'architecture',
            path: m.path,
            doc: readArchitectureForProject(m.path),
          });
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
        case 'searchFiles':
          send({ type: 'searchResults', root: m.root, results: walkFiles(m.root) });
          break;
        case 'term:start':
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

  // Write-file IPC (I2). A trust boundary: the renderer can ask to write any path,
  // so the host validates containment (src/path-guard) before touching disk. Returns
  // a typed result; on rejection or failure the renderer keeps the buffer dirty.
  ipcMain.handle('writeFile', async (_e, p: string, content: string) => {
    try {
      return await writeFile(p, content, writeRoots());
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
