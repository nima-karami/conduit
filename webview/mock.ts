import type { DirEntryDTO, ProjectGroupDTO, RepoDTO, SearchHit } from '../src/protocol';
import type { AgentDefinition } from '../src/types';
import type { VMChange, VMCustomization, VMFileNode } from './view-model';

// Mock state used ONLY in the browser preview (no extension host). Mirrors the
// shape the host sends so the webview code path is identical.
export const mockAgents: AgentDefinition[] = [
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
    id: 'shell:pwsh',
    label: 'PowerShell 7',
    command: 'pwsh.exe',
    args: [],
    icon: 'terminal',
    color: 'green',
    cwdStrategy: 'workspaceFolder',
  },
  {
    id: 'shell:powershell',
    label: 'Windows PowerShell',
    command: 'powershell.exe',
    args: [],
    icon: 'terminal',
    color: 'green',
    cwdStrategy: 'workspaceFolder',
  },
  {
    id: 'shell:gitbash',
    label: 'Git Bash',
    command: 'bash.exe',
    args: [],
    icon: 'terminal',
    color: 'green',
    cwdStrategy: 'workspaceFolder',
  },
  {
    id: 'shell:cmd',
    label: 'Command Prompt',
    command: 'cmd.exe',
    args: [],
    icon: 'terminal',
    color: 'green',
    cwdStrategy: 'workspaceFolder',
  },
];

const now = Date.now();
const ago = (mins: number) => now - mins * 60_000;

export const mockRepos: RepoDTO[] = [
  {
    path: 'G:/awby/projects/terminal-ui',
    name: 'terminal-ui',
    lastAgentId: 'shell:powershell',
    lastOpened: ago(4),
  },
  {
    path: 'G:/awby/projects/nextjs-portfolio',
    name: 'nextjs-portfolio',
    lastAgentId: 'shell:gitbash',
    lastOpened: ago(660),
  },
  {
    path: 'G:/awby/projects/engine',
    name: 'engine',
    lastAgentId: 'shell:cmd',
    lastOpened: ago(960),
  },
  { path: 'C:/Users/karam', name: 'Home', lastOpened: 0 },
];

export const mockGroups: ProjectGroupDTO[] = [
  {
    projectPath: 'G:/awby/projects/nextjs-portfolio',
    sessions: [
      {
        id: 'portfolio',
        name: 'Portfolio Redesign',
        agentId: 'claude',
        projectPath: 'G:/awby/projects/nextjs-portfolio',
        status: 'running',
        createdAt: ago(660),
        lastActiveAt: ago(8),
      },
      {
        id: 'portfolio-tests',
        name: 'Test Runner',
        agentId: 'shell:gitbash',
        projectPath: 'G:/awby/projects/nextjs-portfolio',
        status: 'running',
        createdAt: ago(30),
        lastActiveAt: ago(1),
        busy: true, // preview: exercise the busy (animated dot) state
      },
    ],
  },
  {
    projectPath: 'G:/awby/projects/terminal-ui',
    sessions: [
      {
        id: 'vscode-ext',
        name: 'Terminal UI',
        agentId: 'shell:powershell',
        projectPath: 'G:/awby/projects/terminal-ui',
        status: 'running',
        createdAt: ago(4),
        lastActiveAt: ago(4),
        needsAttention: true, // preview: exercise the needs-attention highlight
      },
    ],
  },
  {
    projectPath: 'G:/awby/projects/engine',
    sessions: [
      {
        id: 'job-hunt',
        name: 'Job Hunt',
        agentId: 'shell:gitbash',
        projectPath: 'G:/awby/projects/engine',
        status: 'stale',
        createdAt: ago(960),
        lastActiveAt: ago(720),
      },
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
  // Staged (index) side.
  { path: 'app/page.tsx', added: 142, removed: 38, kind: 'M', staged: true },
  { path: 'components/Hero.tsx', added: 311, removed: 0, kind: 'A', staged: true },
  { path: 'old/legacy-hero.tsx', added: 0, removed: 244, kind: 'D', staged: true },
  // Unstaged (worktree) side.
  { path: 'app/layout.tsx', added: 64, removed: 12, kind: 'M', staged: false },
  { path: 'components/Nav.tsx', added: 56, removed: 140, kind: 'M', staged: false },
  { path: 'lib/use-terminal.tsx', added: 402, removed: 211, kind: 'M', staged: false },
  { path: 'lib/mcp-client.ts', added: 96, removed: 0, kind: 'A', staged: false },
  { path: '.env.example', added: 13, removed: 6, kind: 'M', staged: false },
  { path: 'next.config.ts', added: 28, removed: 19, kind: 'M', staged: false },
  { path: 'README.md', added: 74, removed: 22, kind: 'M', staged: false },
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

export const mockDir: DirEntryDTO[] = [
  { name: 'src', kind: 'dir' },
  { name: 'README.md', kind: 'file' },
  { name: 'package.json', kind: 'file' },
];

export const mockSearch: SearchHit[] = [
  'app/page.tsx',
  'app/layout.tsx',
  'components/Hero.tsx',
  'components/Nav.tsx',
  'lib/use-terminal.tsx',
  'lib/mcp-client.ts',
  'next.config.ts',
  'package.json',
  'README.md',
  'tsconfig.json',
  '.env.example',
  'public/favicon.ico',
].map((rel) => ({ rel, abs: `G:/awby/projects/nextjs-portfolio/${rel}` }));

/**
 * Preview-only in-memory corpus for the content search (find-in-files) panel. Keyed by
 * forward-slash relative path → file text. The bridge mock runs the REAL pure search core
 * (src/content-search) against this so the case / whole-word / regex / glob toggles
 * genuinely change the grouped results in the browser preview (no real host needed).
 */
export const mockSearchCorpus: Record<string, string> = {
  'app/page.tsx': `import { Hero } from '../components/Hero';\n\nexport default function Page() {\n  // TODO: wire up the hero search box\n  return <Hero title="Search" />;\n}\n`,
  'components/Hero.tsx': `export function Hero({ title }: { title: string }) {\n  const search = title.toLowerCase();\n  return <h1>{search}</h1>; // hero heading\n}\n`,
  'lib/use-terminal.tsx': `export function useTerminal() {\n  // search the buffer for the prompt\n  const Search = true;\n  return Search;\n}\n`,
  'lib/mcp-client.ts': `export const SEARCH_LIMIT = 100;\nexport function search(q: string) {\n  return q.trim();\n}\n`,
  'README.md': `# Portfolio\n\nA tiny site. Use the global search to find things.\n\n- search is fast\n- Search is case-insensitive by default\n`,
  'package.json': `{\n  "name": "nextjs-portfolio",\n  "scripts": { "dev": "next dev" }\n}\n`,
};

export const mockFileText = `export function hello(name: string) {\n  return \`hi \${name}\`;\n}\n\nconst greeting = hello('world');\nconsole.log(greeting);\n`;
export const mockMarkdown = `# Title\n\nSome **bold** text and a [link to example](https://example.com) and a list:\n\n- one\n- two\n\n\`\`\`ts\nconst a = 1;\n\`\`\`\n`;
