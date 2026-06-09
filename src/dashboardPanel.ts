import * as vscode from 'vscode';
import * as os from 'os';
import * as fs from 'fs';
import { SessionManager } from './sessionManager';
import { AgentRegistry } from './agentRegistry';
import { HostToWebview, WebviewToHost } from './protocol';
import { PtyHost, resolveLaunchSpec } from './ptyHost';
import { getProjectInfo } from './projectInfo';
import { SpawnSpec } from './types';

export class DashboardPanel {
  static current: DashboardPanel | undefined;
  private readonly panel: vscode.WebviewPanel;
  private readonly disposables: vscode.Disposable[] = [];
  private readonly pty: PtyHost;
  private readonly out: vscode.OutputChannel;

  static show(ctx: vscode.ExtensionContext, mgr: SessionManager, reg: AgentRegistry) {
    if (DashboardPanel.current) {
      DashboardPanel.current.panel.reveal();
      return;
    }
    const panel = vscode.window.createWebviewPanel('agentDeck', 'Agent Deck', vscode.ViewColumn.Active, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(ctx.extensionUri, 'out')],
    });
    DashboardPanel.current = new DashboardPanel(panel, ctx, mgr, reg);

    if (vscode.workspace.getConfiguration('agentDeck').get<boolean>('openInNewWindow', false)) {
      void Promise.resolve(
        vscode.commands.executeCommand('workbench.action.moveEditorToNewWindow'),
      ).then(undefined, () => undefined);
    }
  }

  private constructor(
    panel: vscode.WebviewPanel,
    ctx: vscode.ExtensionContext,
    private readonly mgr: SessionManager,
    private readonly reg: AgentRegistry,
  ) {
    this.panel = panel;
    this.out = vscode.window.createOutputChannel('Agent Deck');
    this.disposables.push(this.out);
    this.pty = new PtyHost((msg) => this.onPty(msg), (m) => this.out.appendLine(m));
    this.panel.webview.html = this.html(ctx);
    this.disposables.push(this.panel.webview.onDidReceiveMessage((m: WebviewToHost) => this.handle(m)));
    this.disposables.push(this.mgr.onChange(() => this.post()));
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
  }

  private onPty(msg: HostToWebview) {
    this.send(msg);
    if (msg.type === 'term:exit') this.mgr.setStatus(msg.sessionId, 'exited');
  }

  private handle(m: WebviewToHost) {
    try {
      switch (m.type) {
        case 'ready':
          this.post();
          break;
        case 'log':
          this.out.appendLine(`webview: ${m.message}`);
          break;
        case 'newSession':
          void this.newSession();
          break;
        case 'requestProject':
          void this.sendProject(m.path);
          break;
        case 'rename':
          this.mgr.rename(m.id, m.name);
          break;
        case 'relaunch':
          this.mgr.setStatus(m.id, 'running');
          break;
        case 'kill':
          this.pty.dispose(m.id);
          this.mgr.remove(m.id);
          break;
        case 'term:start':
          this.pty.start(m.sessionId, m.cols, m.rows, this.resolveSpec(m.agentId, m.cwd));
          break;
        case 'term:input':
          this.pty.input(m.sessionId, m.data);
          break;
        case 'term:resize':
          this.pty.resize(m.sessionId, m.cols, m.rows);
          break;
        case 'term:dispose':
          this.pty.dispose(m.sessionId);
          break;
      }
    } catch (e: unknown) {
      this.send({ type: 'error', message: e instanceof Error ? e.message : String(e) });
    }
  }

  /** Interactive create: pick an agent, then a project folder. */
  private async newSession() {
    const agents = this.reg.list();
    if (agents.length === 0) {
      void vscode.window.showWarningMessage('Agent Deck: no agents configured (agentDeck.agents).');
      return;
    }
    const agentPick = await vscode.window.showQuickPick(
      agents.map((a) => ({ label: a.label, description: a.command, id: a.id })),
      { placeHolder: 'Select an agent' },
    );
    if (!agentPick) return;

    const folder = await this.pickFolder();
    if (!folder) return;

    this.mgr.create(agentPick.id, folder);
  }

  private async pickFolder(): Promise<string | undefined> {
    const folders = vscode.workspace.workspaceFolders ?? [];
    const browse = '$(folder-opened) Browse…';
    const items = [...folders.map((f) => f.uri.fsPath), browse];
    if (folders.length > 0) {
      const pick = await vscode.window.showQuickPick(items, { placeHolder: 'Project folder' });
      if (!pick) return undefined;
      if (pick !== browse) return pick;
    }
    const picked = await vscode.window.showOpenDialog({
      canSelectFolders: true,
      canSelectFiles: false,
      openLabel: 'Use this folder',
    });
    return picked?.[0]?.fsPath;
  }

  private async sendProject(p: string) {
    try {
      const info = await getProjectInfo(p);
      this.send({ type: 'project', path: p, changes: info.changes, files: info.files });
    } catch {
      this.send({ type: 'project', path: p, changes: [], files: [] });
    }
  }

  private workspaceCwd(): string {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? os.homedir();
  }

  private resolveSpec(agentId?: string, cwd?: string): SpawnSpec {
    return resolveLaunchSpec(this.reg, agentId, cwd, (p) => fs.existsSync(p), this.workspaceCwd());
  }

  private post() {
    this.send({ type: 'state', agents: this.reg.list(), groups: this.mgr.groupByProject() });
  }

  private send(msg: HostToWebview) {
    void this.panel.webview.postMessage(msg);
  }

  private html(ctx: vscode.ExtensionContext): string {
    const scriptUri = this.panel.webview.asWebviewUri(vscode.Uri.joinPath(ctx.extensionUri, 'out', 'webview.js'));
    const styleUri = this.panel.webview.asWebviewUri(vscode.Uri.joinPath(ctx.extensionUri, 'out', 'webview.css'));
    const csp = [
      `default-src 'none'`,
      `script-src ${this.panel.webview.cspSource}`,
      `style-src ${this.panel.webview.cspSource} 'unsafe-inline' https://fonts.googleapis.com`,
      `font-src ${this.panel.webview.cspSource} https://fonts.gstatic.com`,
    ].join('; ');
    return `<!DOCTYPE html><html><head><meta charset="utf-8">
      <meta http-equiv="Content-Security-Policy" content="${csp}">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <link rel="stylesheet" href="${styleUri}">
      </head><body><div id="root"></div><script src="${scriptUri}"></script></body></html>`;
  }

  dispose() {
    DashboardPanel.current = undefined;
    this.pty.disposeAll();
    this.disposables.forEach((d) => d.dispose());
    this.panel.dispose();
  }
}
