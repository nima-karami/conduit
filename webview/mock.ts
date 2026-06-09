import { AgentDefinition, Session } from '../src/types';
import { ProjectGroupDTO } from '../src/protocol';
import { VMCustomization, VMChange, VMFileNode } from './viewModel';

// Mock state used ONLY in the browser preview (no extension host). Mirrors the
// shape the host sends so the webview code path is identical.
export const mockAgents: AgentDefinition[] = [
  { id: 'claude', label: 'Claude Code', command: 'claude', args: [], icon: 'sparkle', color: 'terminal.ansiMagenta', cwdStrategy: 'workspaceFolder' },
  { id: 'shell', label: 'Shell', command: '', args: [], icon: 'terminal', color: 'terminal.ansiGreen', cwdStrategy: 'workspaceFolder' },
];

const now = Date.now();
const ago = (mins: number) => now - mins * 60_000;

export const mockGroups: ProjectGroupDTO[] = [
  {
    projectPath: 'G:/awby/projects/nextjs-portfolio',
    sessions: [
      { id: 'portfolio', name: 'Portfolio Redesign', agentId: 'claude', projectPath: 'G:/awby/projects/nextjs-portfolio', status: 'running', createdAt: ago(660) },
    ],
  },
  {
    projectPath: 'G:/awby/projects/terminal-ui',
    sessions: [
      { id: 'vscode-ext', name: 'VS Code Ext', agentId: 'claude', projectPath: 'G:/awby/projects/terminal-ui', status: 'running', createdAt: ago(4) },
    ],
  },
  {
    projectPath: 'G:/awby/projects/engine',
    sessions: [
      { id: 'job-hunt', name: 'Job Hunt', agentId: 'shell', projectPath: 'G:/awby/projects/engine', status: 'stale', createdAt: ago(960) },
    ],
  },
];

export const customizations: VMCustomization[] = [
  { id: 'agents', label: 'Agents', icon: 'agent', count: 3 },
  { id: 'skills', label: 'Skills', icon: 'skill', count: 21 },
  { id: 'instructions', label: 'Instructions', icon: 'doc', count: 2 },
  { id: 'hooks', label: 'Hooks', icon: 'hook' },
  { id: 'mcp', label: 'MCP Servers', icon: 'server', count: 1 },
];

export const changes: VMChange[] = [
  { path: 'app/page.tsx', added: 142, removed: 38, kind: 'M' },
  { path: 'app/layout.tsx', added: 64, removed: 12, kind: 'M' },
  { path: 'components/Hero.tsx', added: 311, removed: 0, kind: 'A' },
  { path: 'components/Nav.tsx', added: 56, removed: 140, kind: 'M' },
  { path: 'lib/use-terminal.tsx', added: 402, removed: 211, kind: 'M' },
  { path: 'lib/mcp-client.ts', added: 96, removed: 0, kind: 'A' },
  { path: '.env.example', added: 13, removed: 6, kind: 'M' },
  { path: 'next.config.ts', added: 28, removed: 19, kind: 'M' },
  { path: 'README.md', added: 74, removed: 22, kind: 'M' },
  { path: 'old/legacy-hero.tsx', added: 0, removed: 244, kind: 'D' },
];

export const files: VMFileNode[] = [
  { name: 'nextjs-portfolio', kind: 'dir', depth: 0, expanded: true },
  { name: 'app', kind: 'dir', depth: 1, expanded: true },
  { name: 'page.tsx', kind: 'file', status: 'M', depth: 2 },
  { name: 'layout.tsx', kind: 'file', status: 'M', depth: 2 },
  { name: 'components', kind: 'dir', depth: 1, expanded: true },
  { name: 'Hero.tsx', kind: 'file', status: 'A', depth: 2 },
  { name: 'Nav.tsx', kind: 'file', status: 'M', depth: 2 },
  { name: 'lib', kind: 'dir', depth: 1 },
  { name: 'public', kind: 'dir', depth: 1 },
  { name: '.env.example', kind: 'file', status: 'M', depth: 1 },
  { name: 'README.md', kind: 'file', status: 'M', depth: 1 },
];
