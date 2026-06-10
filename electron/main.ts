import { app, BrowserWindow, ipcMain, dialog, Menu, shell } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { AgentRegistry } from '../src/agentRegistry';
import { SessionManager } from '../src/sessionManager';
import { PtyHost, resolveLaunchSpec } from '../src/ptyHost';
import { getProjectInfo } from '../src/projectInfo';
import { HostToWebview, WebviewToHost, RepoDTO } from '../src/protocol';
import { serializeSessions, restoreSessions } from '../src/persistence';
import { serializeRepos, restoreRepos, upsertRepo } from '../src/repoHistory';
import { loadAgents, readBlob } from '../src/config';
import { detectShells } from '../src/shells';
import { SpawnSpec } from '../src/types';
import { readDir, readFile, readDiff } from '../src/fileService';
import { walkFiles } from '../src/fileSearch';
import { AppSettings, restoreSettings, serializeSettings } from '../src/settings';
import { restoreBoard, serializeBoard } from '../src/board';
import { execFile } from 'child_process';

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
// Board lives in the repo root so the overnight agent and the app share one file.
const boardFile = () => path.join(__dirname, '..', 'board.json');

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

function createWindow() {
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 900,
    minHeight: 560,
    backgroundColor: '#0c0d10',
    title: 'Agent Deck',
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
  void win.loadFile(path.join(__dirname, 'index.html'));
  win.on('closed', () => (win = null));
}

app.whenReady().then(() => {
  // Detected shells first (so nothing defaults to an agent), then configured agents.
  const registry = new AgentRegistry([...detectShells(), ...loadAgents(agentsFile())]);
  const mgr = new SessionManager(registry);
  const pty = new PtyHost(
    (msg) => {
      send(msg);
      if (msg.type === 'term:exit') mgr.setStatus(msg.sessionId, 'exited');
    },
    (m) => console.log('[pty]', m),
  );

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

  const postState = () =>
    send({ type: 'state', agents: registry.list(), groups: mgr.groupByProject(), repos: reposForState(), settings });

  // Open a folder in the chosen terminal and remember it in history.
  function openRepo(p: string, agentId: string) {
    if (!p) return;
    const agent = registry.get(agentId) ?? registry.list()[0];
    if (!agent) {
      dialog.showErrorBox('Agent Deck', 'No terminals available.');
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

  async function sendProject(p: string) {
    try {
      const info = await getProjectInfo(p);
      send({ type: 'project', path: p, changes: info.changes, files: info.files, customizations: info.customizations });
    } catch {
      send({ type: 'project', path: p, changes: [], files: [], customizations: [] });
    }
  }

  // Show a folder dialog, then open the picked folder in the chosen terminal.
  async function browseRepo(agentId: string) {
    const picked = await dialog.showOpenDialog(win ?? undefined!, {
      properties: ['openDirectory'],
      title: 'Open a repository',
    });
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
          const hits = walkFiles(m.root).filter((h) => SRC.has(h.rel.split('.').pop()?.toLowerCase() ?? '')).slice(0, 400);
          const files: { path: string; content: string; language: string }[] = [];
          for (const h of hits) {
            const dto = await readFile(h.abs);
            if (!dto.binary && !dto.error) files.push({ path: h.abs, content: dto.content, language: dto.language });
          }
          send({ type: 'projectFiles', root: m.root, files });
          break;
        }
        case 'requestBoard':
          send({ type: 'board', board: restoreBoard(readBlob(boardFile())) });
          break;
        case 'updateBoard':
          fs.writeFile(boardFile(), serializeBoard(m.board), () => {});
          break;
        case 'searchFiles':
          send({ type: 'searchResults', root: m.root, results: walkFiles(m.root) });
          break;
        case 'term:start':
          pty.start(m.sessionId, m.cols, m.rows, resolveSpec(m.agentId, m.cwd));
          break;
        case 'term:input':
          pty.input(m.sessionId, m.data);
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

  // Custom window controls (native title bar is hidden).
  ipcMain.on('win:minimize', () => win?.minimize());
  ipcMain.on('win:toggleMaximize', () => (win?.isMaximized() ? win.unmaximize() : win?.maximize()));
  ipcMain.on('win:close', () => win?.close());
  ipcMain.handle('win:isMaximized', () => win?.isMaximized() ?? false);

  app.on('before-quit', () => pty.disposeAll());

  Menu.setApplicationMenu(null);
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
