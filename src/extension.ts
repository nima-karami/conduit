import * as vscode from 'vscode';
import { AgentRegistry } from './agentRegistry';
import { VsCodeTerminalHost } from './terminalHost';
import { SessionManager } from './sessionManager';
import { DashboardPanel } from './dashboardPanel';
import { AgentDefinition } from './types';

export function activate(context: vscode.ExtensionContext) {
  const defs = vscode.workspace
    .getConfiguration('agentDeck')
    .get<AgentDefinition[]>('agents', []);
  const registry = new AgentRegistry(defs);
  const host = new VsCodeTerminalHost();
  const manager = new SessionManager(registry, host);

  context.subscriptions.push(
    vscode.commands.registerCommand('agentDeck.openDashboard', () =>
      DashboardPanel.show(context, manager, registry),
    ),
    { dispose: () => host.cleanup() },
  );
}

export function deactivate() {}
