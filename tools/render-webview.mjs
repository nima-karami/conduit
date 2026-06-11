// Writes out/preview.html (gitignored) referencing the built webview bundle by
// relative path, with mock state injected. Serve out/ with tools/preview-server.mjs
// and open http://127.0.0.1:<port>/preview.html in playwright-cli to verify the UI.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

const mock = {
  type: 'state',
  agents: [
    {
      id: 'claude',
      label: 'Claude Code',
      command: 'claude',
      args: [],
      icon: 'sparkle',
      color: 'terminal.ansiMagenta',
      cwdStrategy: 'workspaceFolder',
    },
    {
      id: 'aider',
      label: 'Aider',
      command: 'aider',
      args: [],
      icon: 'robot',
      color: 'terminal.ansiCyan',
      cwdStrategy: 'workspaceFolder',
    },
  ],
  groups: [
    {
      projectPath: 'G:/awby/projects/terminal-ui',
      sessions: [
        {
          id: '1',
          name: 'Claude Code — terminal-ui',
          agentId: 'claude',
          projectPath: 'G:/awby/projects/terminal-ui',
          status: 'running',
          createdAt: 1,
        },
        {
          id: '2',
          name: 'Aider — terminal-ui',
          agentId: 'aider',
          projectPath: 'G:/awby/projects/terminal-ui',
          status: 'exited',
          createdAt: 2,
        },
      ],
    },
    {
      projectPath: 'G:/awby/projects/other-app',
      sessions: [
        {
          id: '3',
          name: 'Claude Code — other-app',
          agentId: 'claude',
          projectPath: 'G:/awby/projects/other-app',
          status: 'stale',
          createdAt: 3,
        },
      ],
    },
  ],
};

// NOTE: deliberately do NOT define window.acquireVsCodeApi here — its absence
// makes the webview bridge use its browser fake-shell so the terminal is visible
// in the preview. Inside VS Code, acquireVsCodeApi exists and a real PTY is used.
const html = `<!DOCTYPE html><html><head><meta charset="utf-8">
<link rel="stylesheet" href="./webview.css">
<style>html,body{background:#0c0d10;}</style>
</head><body>
<div id="root"></div>
<script src="./webview.js"></script>
</body></html>`;
void mock;

writeFileSync(join(process.cwd(), 'out', 'preview.html'), html);
console.log('out/preview.html written');
