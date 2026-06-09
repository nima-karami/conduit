import * as assert from 'assert';
import * as os from 'os';
import * as vscode from 'vscode';
import { PtyHost, defaultShellSpec } from '../../src/ptyHost';
import { HostToWebview } from '../../src/protocol';

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

  // --- 3. node-pty actually runs inside VS Code's Electron runtime ---
  const marker = 'PTY_MARKER_42';
  const got = await new Promise<string>((resolve, reject) => {
    let buf = '';
    const pty = new PtyHost((msg: HostToWebview) => {
      if (msg.type === 'term:data') {
        buf += msg.data;
        if (buf.includes(marker)) {
          pty.disposeAll();
          resolve(buf);
        }
      }
    });
    pty.start('e2e', 80, 24, defaultShellSpec(os.tmpdir()));
    pty.input('e2e', `echo ${marker}\r\n`);
    setTimeout(() => {
      pty.disposeAll();
      reject(new Error(`no PTY output containing marker; got ${buf.length} bytes`));
    }, 8000);
  });
  assert.ok(got.includes(marker), 'node-pty should echo the marker in the VS Code host');
  // (Agent→spec resolution + cwd fallback is covered by the resolveLaunchSpec unit tests.)
}
