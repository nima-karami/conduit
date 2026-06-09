import * as vscode from 'vscode';
import { SessionManager } from './sessionManager';
import { AgentRegistry } from './agentRegistry';
import { HostToWebview, WebviewToHost } from './protocol';
import { PtyHost, defaultShellSpec } from './ptyHost';

export class DashboardPanel {
  static current: DashboardPanel | undefined;
  private readonly panel: vscode.WebviewPanel;
  private readonly disposables: vscode.Disposable[] = [];
  private readonly pty: PtyHost;

  static show(ctx: vscode.ExtensionContext, mgr: SessionManager, reg: AgentRegistry) {
    if (DashboardPanel.current) {
      DashboardPanel.current.panel.reveal();
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      'agentDeck',
      'Agent Deck',
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(ctx.extensionUri, 'out')],
      },
    );
    DashboardPanel.current = new DashboardPanel(panel, ctx, mgr, reg);

    const openInNewWindow = vscode.workspace
      .getConfiguration('agentDeck')
      .get<boolean>('openInNewWindow', true);
    if (openInNewWindow) {
      // Best-effort: pop the dashboard into its own (auxiliary) window.
      void Promise.resolve(
        vscode.commands.executeCommand('workbench.action.moveEditorToNewWindow'),
      ).then(undefined, () => {
        /* command unavailable in this VS Code build — leave as a tab */
      });
    }
  }

  private constructor(
    panel: vscode.WebviewPanel,
    ctx: vscode.ExtensionContext,
    private readonly mgr: SessionManager,
    private readonly reg: AgentRegistry,
  ) {
    this.panel = panel;
    this.pty = new PtyHost((msg) => this.send(msg));
    this.panel.webview.html = this.html(ctx);
    this.disposables.push(
      this.panel.webview.onDidReceiveMessage((m: WebviewToHost) => this.handle(m)),
    );
    this.disposables.push(this.mgr.onChange(() => this.post()));
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
  }

  private handle(m: WebviewToHost) {
    try {
      switch (m.type) {
        case 'ready':
          this.post();
          break;
        case 'create':
          this.mgr.create(m.agentId, m.projectPath);
          break;
        case 'focus':
          this.mgr.focus(m.id);
          break;
        case 'rename':
          this.mgr.rename(m.id, m.name);
          break;
        case 'relaunch':
          this.mgr.relaunch(m.id);
          break;
        case 'kill':
          this.mgr.kill(m.id);
          break;
        case 'term:start':
          this.pty.start(m.sessionId, m.cols, m.rows, defaultShellSpec(this.workspaceCwd()));
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
      const message = e instanceof Error ? e.message : String(e);
      this.send({ type: 'error', message });
    }
  }

  private workspaceCwd(): string {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? require('os').homedir();
  }

  private post() {
    this.send({ type: 'state', agents: this.reg.list(), groups: this.mgr.groupByProject() });
  }

  private send(msg: HostToWebview) {
    void this.panel.webview.postMessage(msg);
  }

  private html(ctx: vscode.ExtensionContext): string {
    const scriptUri = this.panel.webview.asWebviewUri(
      vscode.Uri.joinPath(ctx.extensionUri, 'out', 'webview.js'),
    );
    const styleUri = this.panel.webview.asWebviewUri(
      vscode.Uri.joinPath(ctx.extensionUri, 'out', 'webview.css'),
    );
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
