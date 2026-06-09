import * as assert from 'assert';
import * as vscode from 'vscode';

// Entry point invoked by @vscode/test-electron. Must export `run`.
export async function run(): Promise<void> {
  // Ensure the extension is activated before asserting on its contributions.
  const ext = vscode.extensions.getExtension('nima.agent-deck');
  assert.ok(ext, 'agent-deck extension should be found');
  await ext!.activate();

  // The command should be registered once the extension activates.
  const cmds = await vscode.commands.getCommands(true);
  assert.ok(
    cmds.includes('agentDeck.openDashboard'),
    'agentDeck.openDashboard command should be registered',
  );

  // Running the command should open the dashboard webview without throwing.
  await vscode.commands.executeCommand('agentDeck.openDashboard');

  // Smoke: terminals API is reachable (used by the real TerminalHost).
  assert.ok(Array.isArray(vscode.window.terminals), 'terminals API available');
}
