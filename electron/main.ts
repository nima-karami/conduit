import { app, BrowserWindow, ipcMain, dialog } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { AgentRegistry } from '../src/agentRegistry';
import { SessionManager } from '../src/sessionManager';
import { PtyHost, resolveLaunchSpec } from '../src/ptyHost';
import { getProjectInfo } from '../src/projectInfo';
import { HostToWebview, WebviewToHost } from '../src/protocol';
import { serializeSessions, restoreSessions } from '../src/persistence';
import { loadAgents, readBlob } from '../src/config';
import { SpawnSpec } from '../src/types';

let win: BrowserWindow | null = null;

const userData = () => app.getPath('userData');
const sessionsFile = () => path.join(userData(), 'sessions.json');
const agentsFile = () => path.join(userData(), 'agents.json');

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
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  void win.loadFile(path.join(__dirname, 'index.html'));
  win.on('closed', () => (win = null));
}

app.whenReady().then(() => {
  const registry = new AgentRegistry(loadAgents(agentsFile()));
  const mgr = new SessionManager(registry);
  const pty = new PtyHost(
    (msg) => {
      send(msg);
      if (msg.type === 'term:exit') mgr.setStatus(msg.sessionId, 'exited');
    },
    (m) => console.log('[pty]', m),
  );

  // Restore previously persisted sessions (as stale) + save on every change.
  mgr.restore(restoreSessions(readBlob(sessionsFile())));
  mgr.onChange(() => {
    fs.writeFile(sessionsFile(), serializeSessions(mgr.list()), () => {});
    postState();
  });

  const postState = () =>
    send({ type: 'state', agents: registry.list(), groups: mgr.groupByProject() });

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

  // Interactive create: pick an agent (native dialog when >1), then a folder.
  async function newSession() {
    const agents = registry.list();
    if (agents.length === 0) {
      dialog.showErrorBox('Agent Deck', 'No agents configured (agents.json).');
      return;
    }
    let agent = agents[0];
    if (agents.length > 1) {
      const r = await dialog.showMessageBox(win ?? undefined!, {
        type: 'question',
        message: 'Select an agent',
        buttons: [...agents.map((a) => a.label), 'Cancel'],
        cancelId: agents.length,
        noLink: true,
      });
      if (r.response >= agents.length) return;
      agent = agents[r.response];
    }
    const picked = await dialog.showOpenDialog(win ?? undefined!, {
      properties: ['openDirectory'],
      title: 'Project folder',
    });
    if (picked.canceled || !picked.filePaths[0]) return;
    mgr.create(agent.id, picked.filePaths[0]);
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
        case 'newSession':
          await newSession();
          break;
        case 'requestProject':
          await sendProject(m.path);
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
  app.on('before-quit', () => pty.disposeAll());

  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
