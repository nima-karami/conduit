import * as vscode from 'vscode';
import { AgentRegistry } from './agentRegistry';
import { SessionManager } from './sessionManager';
import { DashboardPanel } from './dashboardPanel';
import { AgentDefinition } from './types';
import { serializeSessions, restoreSessions } from './persistence';

const STORAGE_KEY = 'agentDeck.sessions';

export function activate(context: vscode.ExtensionContext) {
  const defs = vscode.workspace
    .getConfiguration('agentDeck')
    .get<AgentDefinition[]>('agents', []);
  const registry = new AgentRegistry(defs);
  const manager = new SessionManager(registry);

  // Restore previously persisted sessions (as stale) and save on every change.
  manager.restore(restoreSessions(context.globalState.get<string>(STORAGE_KEY)));
  context.subscriptions.push(
    manager.onChange(() => {
      void context.globalState.update(STORAGE_KEY, serializeSessions(manager.list()));
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('agentDeck.openDashboard', () =>
      DashboardPanel.show(context, manager, registry),
    ),
  );
}

export function deactivate() {}
