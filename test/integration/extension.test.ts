import * as assert from 'assert';
import * as os from 'os';
import * as vscode from 'vscode';
import { AgentRegistry } from '../../src/agentRegistry';
import { VsCodeTerminalHost } from '../../src/terminalHost';
import { SessionManager } from '../../src/sessionManager';
import { AgentDefinition } from '../../src/types';

// Entry point invoked by @vscode/test-electron. Must export `run`.
export async function run(): Promise<void> {
  // --- 1. Extension activates and contributes its command ---
  const ext = vscode.extensions.getExtension('nima.agent-deck');
  assert.ok(ext, 'agent-deck extension should be found');
  await ext!.activate();

  const cmds = await vscode.commands.getCommands(true);
  assert.ok(
    cmds.includes('agentDeck.openDashboard'),
    'agentDeck.openDashboard command should be registered',
  );

  // --- 2. Opening the dashboard does not throw ---
  await vscode.commands.executeCommand('agentDeck.openDashboard');

  // --- 3. End-to-end: the real terminal host actually spawns a terminal ---
  const echoAgent: AgentDefinition = {
    id: 'echo',
    label: 'Echo',
    command: 'echo',
    args: ['agent-deck-e2e'],
    icon: 'terminal',
    color: 'terminal.ansiGreen',
    cwdStrategy: 'workspaceFolder',
  };
  const registry = new AgentRegistry([echoAgent]);
  const host = new VsCodeTerminalHost();
  const manager = new SessionManager(registry, host);

  const before = vscode.window.terminals.length;
  const session = manager.create('echo', os.tmpdir());
  assert.strictEqual(session.status, 'running', 'new session should be running');

  const after = vscode.window.terminals.length;
  assert.strictEqual(after, before + 1, 'a real VS Code terminal should be created');

  const term = vscode.window.terminals.find((t) => t.name === session.name);
  assert.ok(term, `a terminal named "${session.name}" should exist`);

  // Cleanup
  manager.kill(session.id);
  host.cleanup();
}
