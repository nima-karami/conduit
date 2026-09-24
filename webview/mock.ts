import type { DiffScope, DirEntryDTO, RepoDTO, SearchHit } from '../src/protocol';
import type { SkillInfo } from '../src/skills';
import type { AgentDefinition, Project, Session } from '../src/types';
import type { VMChange, VMCustomization, VMFileNode } from './view-model';

/** Preview catalog for the Skills panel (no host): the bundled skills, all not-installed. */
export function mockSkills(): SkillInfo[] {
  const none = { installedVersion: null, status: 'not-installed' as const };
  return [
    {
      id: 'conduit-architecture',
      name: 'Conduit Architecture',
      description: "Read and update a project's architecture diagram via a reviewed proposal.",
      version: '1.0.0',
      project: { ...none },
      global: { ...none },
    },
    {
      id: 'conduit-plan',
      name: 'Conduit Plan',
      description: 'Author and maintain a structured, commentable plan Conduit renders.',
      version: '1.0.0',
      project: { ...none },
      global: { ...none },
    },
  ];
}

// Mock state used ONLY in the browser preview (no host). Mirrors the host's shape so the
// webview code path is identical.
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

export const mockProjects: Project[] = [
  { id: 'p-mock-a', name: 'nextjs-portfolio', order: 0 },
  { id: 'p-mock-b', name: 'conduit', order: 1 },
];

export const mockSessions: Session[] = [
  {
    id: 'portfolio',
    name: 'Portfolio Redesign',
    agentId: 'claude',
    projectId: 'p-mock-a',
    home: 'G:/awby/projects/nextjs-portfolio',
    roots: ['G:/awby/projects/portfolio-assets'],
    repos: [
      {
        root: 'G:/awby/projects/nextjs-portfolio',
        name: '.',
        folder: 'G:/awby/projects/nextjs-portfolio',
        tag: 'home',
      },
    ],
    repoGit: {
      'G:/awby/projects/nextjs-portfolio': {
        kind: 'branch',
        branch: 'main',
        dirty: true,
      },
    },
    status: 'running',
    createdAt: ago(660),
    lastActiveAt: ago(8),
    // N2 preview: linked to the seed board's "Feature Kanban board" card (seed-f9),
    // so a running status badge renders on that card in the feature board.
    cardId: 'seed-f9',
  },
  {
    id: 'portfolio-tests',
    name: 'Test Runner',
    agentId: 'shell:gitbash',
    home: 'G:/awby/projects/nextjs-portfolio',
    roots: ['G:/awby/projects/api-contracts'],
    // Preview of the Files tab's missing-folder box.
    missingRoots: ['G:/awby/projects/api-contracts'],
    repos: [
      {
        root: 'G:/awby/projects/nextjs-portfolio',
        name: '.',
        folder: 'G:/awby/projects/nextjs-portfolio',
        tag: 'home',
      },
    ],
    repoGit: {
      'G:/awby/projects/nextjs-portfolio': {
        kind: 'branch',
        branch: 'main',
        dirty: true,
      },
    },
    status: 'running',
    createdAt: ago(30),
    lastActiveAt: ago(1),
    busy: true, // preview: exercise the busy (animated dot) state
  },
  {
    id: 'vscode-ext',
    name: 'Terminal UI',
    agentId: 'shell:powershell',
    projectId: 'p-mock-b',
    home: 'G:/awby/projects/terminal-ui',
    roots: [],
    repos: [
      {
        root: 'G:/awby/projects/terminal-ui',
        name: '.',
        folder: 'G:/awby/projects/terminal-ui',
        tag: 'home',
      },
    ],
    repoGit: {
      'G:/awby/projects/terminal-ui': {
        kind: 'branch',
        branch: 'main',
        dirty: true,
      },
    },
    status: 'running',
    createdAt: ago(4),
    lastActiveAt: ago(4),
    needsAttention: true, // preview: exercise the needs-attention highlight
  },
  {
    id: 'job-hunt',
    name: 'Job Hunt',
    agentId: 'shell:gitbash',
    home: 'G:/awby/projects/engine',
    roots: [],
    repos: [
      {
        root: 'G:/awby/projects/engine',
        name: '.',
        folder: 'G:/awby/projects/engine',
        tag: 'home',
      },
    ],
    repoGit: {
      'G:/awby/projects/engine': { kind: 'branch', branch: 'main', dirty: true },
    },
    status: 'stale',
    createdAt: ago(960),
    lastActiveAt: ago(720),
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
 * Preview-only corpus for the content-search panel (rel path → file text). The bridge mock
 * runs the REAL pure search core against this so the case/word/regex/glob toggles genuinely
 * change the grouped results without a host.
 */
export const mockSearchCorpus: Record<string, string> = {
  'app/page.tsx': `import { Hero } from '../components/Hero';\n\nexport default function Page() {\n  // TODO: wire up the hero search box\n  return <Hero title="Search" />;\n}\n`,
  'components/Hero.tsx': `export function Hero({ title }: { title: string }) {\n  const search = title.toLowerCase();\n  return <h1>{search}</h1>; // hero heading\n}\n`,
  'lib/use-terminal.tsx': `export function useTerminal() {\n  // search the buffer for the prompt\n  const Search = true;\n  return Search;\n}\n`,
  'lib/mcp-client.ts': `export const SEARCH_LIMIT = 100;\nexport function search(q: string) {\n  return q.trim();\n}\n`,
  'README.md': `# Portfolio\n\nA tiny site. Use the global search to find things.\n\n- search is fast\n- Search is case-insensitive by default\n`,
  'package.json': `{\n  "name": "nextjs-portfolio",\n  "scripts": { "dev": "next dev" }\n}\n`,
};

/**
 * Preview-only diff corpus for the Review view (R3), matched on basename. Each head/work
 * pair has separated edits + long unchanged runs so the stacked hunk cards + fold rows are
 * demonstrable without a real git repo.
 */
function numbered(prefix: string, n: number): string {
  return Array.from({ length: n }, (_, i) => `  ${prefix} line ${i + 1};`).join('\n');
}
export const mockDiffs: Record<string, { head: string; work: string }> = {
  'page.tsx': {
    head: `import { Hero } from '../components/Hero';\n${numbered('// section', 14)}\nexport default function Page() {\n  return <Hero title="Hello" />;\n}\n`,
    work: `import { Hero } from '../components/Hero';\nimport { Nav } from '../components/Nav';\n${numbered('// section', 14)}\nexport default function Page() {\n  return (\n    <>\n      <Nav />\n      <Hero title="Welcome" subtitle="Now with search" />\n    </>\n  );\n}\n`,
  },
  'layout.tsx': {
    head: `export const metadata = { title: 'Site' };\n${numbered('const a', 18)}\nexport default function Layout({ children }) {\n  return <html><body>{children}</body></html>;\n}\n`,
    work: `export const metadata = { title: 'Portfolio', description: 'A tiny site' };\n${numbered('const a', 18)}\nexport default function Layout({ children }) {\n  return (\n    <html lang="en">\n      <body className="dark">{children}</body>\n    </html>\n  );\n}\n`,
  },
  'Nav.tsx': {
    head: `export function Nav() {\n  const links = ['Home', 'About'];\n${numbered('const x', 22)}\n  return <nav>{links.join(' ')}</nav>;\n}\n`,
    work: `export function Nav() {\n  const links = ['Home', 'Work', 'About', 'Contact'];\n${numbered('const x', 22)}\n  return (\n    <nav className="sticky">\n      {links.map((l) => (\n        <a key={l}>{l}</a>\n      ))}\n    </nav>\n  );\n}\n`,
  },
  'Hero.tsx': {
    head: '',
    work: `export function Hero({ title, subtitle }: { title: string; subtitle?: string }) {\n  return (\n    <header className="hero">\n      <h1>{title}</h1>\n      {subtitle && <p>{subtitle}</p>}\n    </header>\n  );\n}\n`,
  },
  'use-terminal.tsx': {
    head: `export function useTerminal() {\n${numbered('const t', 30)}\n  return null;\n}\n`,
    work: `import { useEffect } from 'react';\nexport function useTerminal(id: string) {\n${numbered('const t', 30)}\n  useEffect(() => {\n    // wire the pty stream\n  }, [id]);\n  return id;\n}\n`,
  },
  'README.md': {
    head: `# Portfolio\n\nA tiny site.\n${numbered('-', 10)}\n`,
    work: `# Portfolio\n\nA tiny personal site, now with global search.\n${numbered('-', 10)}\n\n## Getting started\n\nRun \`npm run dev\`.\n`,
  },
};

/** Index blobs for the files that have a staged side (the `Nav` import is staged, the rest of
 *  page.tsx's edit is not), so the preview can show three different scoped diffs of one file.
 *  A file without an entry has nothing staged: its index is its head. */
const mockIndex: Record<string, string> = {
  'page.tsx': `import { Hero } from '../components/Hero';\nimport { Nav } from '../components/Nav';\n${numbered('// section', 14)}\nexport default function Page() {\n  return <Hero title="Hello" />;\n}\n`,
};

const MOCK_FALLBACK = { head: 'const a = 1;\n', work: 'const a = 2;\n' };

/** The mock `readDiff`: the Review corpus matched on basename, narrowed to `scope`'s sides. */
export function mockDiffFor(path: string, scope: DiffScope): { head: string; work: string } {
  const leaf =
    path
      .replace(/[\\/]+$/, '')
      .split(/[\\/]/)
      .pop() ?? path;
  const { head, work } = mockDiffs[leaf] ?? MOCK_FALLBACK;
  const index = mockIndex[leaf] ?? head;
  if (scope.side === 'index') return { head, work: index };
  if (scope.base === 'index') return { head: index, work };
  return { head, work };
}

export const mockFileText = `export function hello(name: string) {\n  return \`hi \${name}\`;\n}\n\nconst greeting = hello('world');\nconsole.log(greeting);\n`;
export const mockMarkdown = `# Title\n\nSome **bold** text and a [link to example](https://example.com) and a list:\n\n- one\n- two\n\n\`\`\`ts\nconst a = 1;\n\`\`\`\n`;
