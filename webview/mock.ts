import { VMProject, VMCustomization, VMChange, VMFileNode, VMMessage } from './viewModel';

export const projects: VMProject[] = [
  {
    name: 'engine',
    sessions: [{ id: 'job-hunt', name: 'Job Hunt', status: 'idle', updatedAt: '16 hrs ago' }],
  },
  {
    name: 'nextjs-portfolio',
    sessions: [
      {
        id: 'portfolio',
        name: 'Portfolio Redesign',
        status: 'active',
        branch: 'redesign/v2',
        added: 4411,
        removed: 1789,
        updatedAt: '11 hrs ago',
      },
    ],
  },
  {
    name: 'nima-career-mcp',
    sessions: [{ id: 'career-mcp', name: 'Career MCP', status: 'idle', updatedAt: '16 hrs ago' }],
  },
  {
    name: 'terminal-ui',
    sessions: [
      { id: 'vscode-ext', name: 'VS Code Ext', status: 'running', updatedAt: '4 mins ago' },
    ],
  },
  {
    name: 'vega-life-os',
    sessions: [
      { id: 'vega', name: 'VEGA', status: 'idle', branch: 'main', added: 0, removed: 1, updatedAt: '11 hrs ago' },
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
  { path: 'app/globals.css', added: 220, removed: 95, kind: 'M' },
  { path: 'components/Hero.tsx', added: 311, removed: 0, kind: 'A' },
  { path: 'components/ProjectCard.tsx', added: 178, removed: 4, kind: 'M' },
  { path: 'components/Nav.tsx', added: 56, removed: 140, kind: 'M' },
  { path: 'lib/use-terminal.tsx', added: 402, removed: 211, kind: 'M' },
  { path: 'lib/mcp-client.ts', added: 96, removed: 0, kind: 'A' },
  { path: 'lib/analytics.ts', added: 41, removed: 7, kind: 'M' },
  { path: 'public/og-default.png', added: 0, removed: 0, kind: 'A' },
  { path: '.env.example', added: 13, removed: 6, kind: 'M' },
  { path: 'next.config.ts', added: 28, removed: 19, kind: 'M' },
  { path: 'package.json', added: 9, removed: 3, kind: 'M' },
  { path: 'README.md', added: 74, removed: 22, kind: 'M' },
  { path: 'styles/tokens.css', added: 188, removed: 0, kind: 'A' },
  { path: 'old/legacy-hero.tsx', added: 0, removed: 244, kind: 'D' },
];

export const files: VMFileNode[] = [
  { name: 'nextjs-portfolio', kind: 'dir', depth: 0, expanded: true },
  { name: '.claude', kind: 'dir', depth: 1 },
  { name: 'app', kind: 'dir', depth: 1, expanded: true },
  { name: 'page.tsx', kind: 'file', status: 'M', depth: 2 },
  { name: 'layout.tsx', kind: 'file', status: 'M', depth: 2 },
  { name: 'globals.css', kind: 'file', status: 'M', depth: 2 },
  { name: 'components', kind: 'dir', depth: 1, expanded: true },
  { name: 'Hero.tsx', kind: 'file', status: 'A', depth: 2 },
  { name: 'ProjectCard.tsx', kind: 'file', status: 'M', depth: 2 },
  { name: 'Nav.tsx', kind: 'file', status: 'M', depth: 2 },
  { name: 'lib', kind: 'dir', depth: 1 },
  { name: 'public', kind: 'dir', depth: 1 },
  { name: 'node_modules', kind: 'dir', depth: 1 },
  { name: '.env.example', kind: 'file', status: 'M', depth: 1 },
  { name: 'next.config.ts', kind: 'file', status: 'M', depth: 1 },
  { name: 'package.json', kind: 'file', status: 'M', depth: 1 },
  { name: 'README.md', kind: 'file', status: 'M', depth: 1 },
];

export const conversation: VMMessage[] = [
  {
    role: 'assistant',
    blocks: [
      { type: 'h2', text: 'A — Conversational layer: design' },
      {
        type: 'p',
        spans: [
          { t: 'strong', v: 'Architecture. ' },
          { t: 'text', v: 'The terminal posts to ' },
          { t: 'code', v: '/api/chat' },
          { t: 'text', v: ' (a Vercel route) which owns the vendored ' },
          { t: 'code', v: 'career://guidance' },
          {
            t: 'text',
            v: ' system prompt, caps tokens and history, and applies rate limits. Claude auto-discovers and calls the MCP tools (',
          },
          { t: 'code', v: 'search_experience' },
          { t: 'text', v: ', ' },
          { t: 'code', v: 'assemble_resume' },
          { t: 'text', v: ') server-side, then the answer is streamed back.' },
        ],
      },
      { type: 'h3', text: 'Terminal reframe' },
      {
        type: 'p',
        spans: [
          { t: 'text', v: 'Input parsing in ' },
          { t: 'code', v: 'use-terminal.tsx' },
          { t: 'text', v: ' flips from command matching to natural language. Two design choices matter:' },
        ],
      },
      {
        type: 'ul',
        items: [
          [
            { t: 'strong', v: 'Streaming into a buffer. ' },
            { t: 'text', v: 'Tokens append to a single live block instead of a new line per chunk.' },
          ],
          [
            { t: 'strong', v: 'Tool calls as inline cards. ' },
            { t: 'text', v: 'When Claude invokes a tool, render a compact card showing the call and its result.' },
          ],
        ],
      },
      {
        type: 'code',
        lang: 'ts',
        lines: [
          "export async function POST(req: Request) {",
          "  const { messages } = await req.json();",
          "  const stream = await anthropic.messages.stream({",
          "    model: 'claude-haiku-4-5',",
          "    system: GUIDANCE_PROMPT,",
          "    messages,",
          "    tools: mcpTools,",
          "  });",
          "  return new Response(stream.toReadableStream());",
          "}",
        ],
      },
      {
        type: 'p',
        spans: [
          { t: 'text', v: 'If this looks right, I can turn it into a step-by-step implementation plan. See ' },
          { t: 'link', v: 'the streaming docs' },
          { t: 'text', v: ' for the response contract.' },
        ],
      },
    ],
  },
];
