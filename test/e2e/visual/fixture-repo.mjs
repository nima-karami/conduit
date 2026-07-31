/**
 * Build (once per run) a throwaway git repo with enough shape to exercise every visual
 * surface: real history, a dirty worktree covering all four status letters, and
 * `.conduit/` artifacts so Board and Canvas have content.
 *
 * Lives outside the repo (os.tmpdir) so a screenshot run never dirties the checkout.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = join(tmpdir(), 'conduit-visual-fixture');

const git = (cwd, ...args) =>
  execFileSync('git', args, { cwd, stdio: 'pipe', encoding: 'utf8' }).trim();

const FILES = {
  'README.md': '# demo-repo\n\nA fixture repository for Conduit visual verification.\n',
  'package.json': '{\n  "name": "demo-repo",\n  "version": "1.0.0"\n}\n',
  'AGENTS.md': '# Agents\n\nSee CLAUDE.md.\n',
  '.gitignore': 'node_modules\ndist\n',
  'webview/app.tsx': 'export function App() {\n  return <div className="shell" />;\n}\n',
  'webview/sidebar.tsx':
    'export function Sidebar() {\n  return <aside className="sidebar" />;\n}\n',
  'webview/icons.tsx': 'export const IconSearch = () => null;\n',
  'webview/styles.css': ':root {\n  --bg: #131419;\n}\n',
  'webview/themes.ts': "export const THEMES = [{ id: 'aero', label: 'Aero' }];\n",
  'src/protocol.ts': 'export type Msg = { type: string };\n',
  'src/session-icon.ts': "export const iconFor = () => 'terminal';\n",
  'docs/CHANGELOG.md': '# Changelog\n\n## 0.1.0\n\n- first cut\n',
};

const ARCHITECTURE = {
  conduit: 1,
  kind: 'architecture',
  updatedAt: Date.now(),
  data: {
    version: 1,
    graphs: {
      root: {
        nodes: [
          {
            id: 'agent',
            title: 'CLI Agent',
            subtitle: 'reads/writes the contract',
            kind: 'external',
            x: 40,
            y: 40,
            ports: [
              { id: 'p1', name: 'proposal', dir: 'out', type: { kind: 'iface', name: 'ArchDoc' } },
            ],
          },
          {
            id: 'model',
            title: 'Arch Model',
            subtitle: 'pure reducers (architecture.ts)',
            kind: 'library',
            x: 40,
            y: 220,
            ports: [
              { id: 'p2', name: 'doc', dir: 'in', type: { kind: 'iface', name: 'ArchDoc' } },
              { id: 'p3', name: 'next', dir: 'out', type: { kind: 'iface', name: 'ArchDoc' } },
            ],
          },
          {
            id: 'canvas',
            title: 'Architecture Canvas',
            subtitle: 'React Flow view',
            kind: 'frontend',
            x: 360,
            y: 220,
            ports: [
              { id: 'p4', name: 'doc', dir: 'in', type: { kind: 'iface', name: 'ArchDoc' } },
              { id: 'p5', name: 'edits', dir: 'out', type: { kind: 'iface', name: 'ArchDoc' } },
            ],
          },
          {
            id: 'host',
            title: 'Electron Host',
            subtitle: 'IPC · persistence · watcher',
            kind: 'service',
            x: 680,
            y: 220,
            ports: [
              {
                id: 'p6',
                name: 'fromRenderer',
                dir: 'in',
                type: { kind: 'iface', name: 'ArchDoc' },
              },
              { id: 'p7', name: 'toDisk', dir: 'out', type: { kind: 'iface', name: 'ArchDoc' } },
            ],
          },
          {
            id: 'file',
            title: '.conduit/architecture.json',
            subtitle: 'source of truth',
            kind: 'storage',
            x: 1000,
            y: 220,
            ports: [
              { id: 'p8', name: 'write', dir: 'in', type: { kind: 'iface', name: 'ArchDoc' } },
            ],
          },
          {
            id: 'undo',
            title: 'Undo / Redo',
            subtitle: 'arch-history.ts',
            kind: 'library',
            x: 40,
            y: 400,
            ports: [
              { id: 'p9', name: 'push', dir: 'in', type: { kind: 'iface', name: 'ArchDoc' } },
            ],
          },
        ],
        edges: [
          {
            id: 'e1',
            from: { node: 'agent', port: 'p1' },
            to: { node: 'canvas', port: 'p4' },
            label: 'proposed.json → diff',
          },
          {
            id: 'e2',
            from: { node: 'model', port: 'p3' },
            to: { node: 'canvas', port: 'p4' },
            label: 'next doc',
          },
          {
            id: 'e3',
            from: { node: 'canvas', port: 'p5' },
            to: { node: 'host', port: 'p6' },
            label: 'IPC · debounced save',
          },
          {
            id: 'e4',
            from: { node: 'host', port: 'p7' },
            to: { node: 'file', port: 'p8' },
            label: 'atomic write',
          },
          {
            id: 'e5',
            from: { node: 'canvas', port: 'p5' },
            to: { node: 'undo', port: 'p9' },
            label: 'undo / redo',
          },
        ],
      },
    },
    interfaces: [
      {
        name: 'ArchDoc',
        fields: [
          { name: 'nodes', type: { kind: 'list', of: { kind: 'iface', name: 'ArchNode' } } },
        ],
      },
      { name: 'ArchNode', fields: [{ name: 'id', type: { kind: 'prim', name: 'string' } }] },
    ],
  },
};

const card = (id, title, notes, stage, ageDays) => ({
  id,
  title,
  notes,
  stage,
  createdAt: Date.now() - ageDays * 86_400_000,
  updatedAt: Date.now() - Math.max(0, ageDays - 2) * 86_400_000,
});

const BOARD = {
  conduit: 1,
  kind: 'board',
  updatedAt: Date.now(),
  data: {
    version: 1,
    cards: [
      card(
        'c1',
        'Plan view: commentable step outline',
        'Render .conduit/plan.json as a navigable outline; per-step approve.',
        'wishlist',
        21,
      ),
      card(
        'c2',
        'Generate architecture from repo',
        'Agent drafts .conduit/architecture.json by reading the codebase.',
        'wishlist',
        18,
      ),
      card(
        'c3',
        'macOS build + notarization',
        'Code signing unblocks macOS auto-update.',
        'wishlist',
        14,
      ),
      card(
        'c4',
        'Virtualize the architecture canvas',
        '500-node graphs freeze for ~21s on open. Unvirtualized O(N) rebuild is the ceiling.',
        'planning',
        12,
      ),
      card(
        'c5',
        'Search within a review diff',
        'Find-in-diff across all file cards, with match counts per file.',
        'planning',
        9,
      ),
      card(
        'c6',
        'Robustness Phase 2: graceful git states',
        'with-timeout on every git IPC; loading / error / retry states.',
        'building',
        6,
      ),
      card(
        'c7',
        'Surface follows theme (surfaceColor: auto)',
        'Editor + terminal surfaces are dark on every theme.',
        'building',
        4,
      ),
      card(
        'c8',
        'Reviewable agent proposals on the canvas',
        'Proposal opens as an editable draft: green = added, amber = edited.',
        'done',
        25,
      ),
      card(
        'c9',
        'Skills installer',
        'Install bundled Conduit skills into .claude/skills.',
        'done',
        28,
      ),
      card(
        'c10',
        'Compare any two refs',
        'Branches, tags, remotes, pasted SHAs. No checkout.',
        'done',
        31,
      ),
    ],
  },
};

/**
 * @param {{ fresh?: boolean }} [opts]
 * @returns {string} Absolute path to the fixture repo (forward slashes).
 */
export function ensureFixtureRepo({ fresh = false } = {}) {
  if (fresh) rmSync(ROOT, { recursive: true, force: true });
  if (existsSync(join(ROOT, '.git'))) return ROOT.replace(/\\/g, '/');

  mkdirSync(ROOT, { recursive: true });
  git(ROOT, 'init', '-q', '-b', 'main');
  git(ROOT, 'config', 'user.email', 'fixture@conduit.local');
  git(ROOT, 'config', 'user.name', 'Conduit Fixture');

  const write = (rel, body) => {
    const abs = join(ROOT, rel);
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, body);
  };

  for (const [rel, body] of Object.entries(FILES)) write(rel, body);
  git(ROOT, 'add', '-A');
  git(ROOT, 'commit', '-qm', 'chore: scaffold the workspace');

  // A few commits so History has lanes and the graph is worth looking at.
  const commits = [
    [
      'webview/styles.css',
      ':root {\n  --bg: #131419;\n  --panel: #1b1d24;\n}\n',
      'feat(theme): panel token',
    ],
    [
      'webview/sidebar.tsx',
      'export function Sidebar() {\n  return <aside className="sidebar" data-live />;\n}\n',
      'feat(sessions): live marker on the rail',
    ],
    [
      'src/session-icon.ts',
      "export const iconFor = (busy: boolean) => (busy ? 'spinner' : 'terminal');\n",
      'feat(status): busy glyph',
    ],
    [
      'docs/CHANGELOG.md',
      '# Changelog\n\n## 0.2.0\n\n- status system\n\n## 0.1.0\n\n- first cut\n',
      'docs: changelog 0.2.0',
    ],
  ];
  for (const [rel, body, msg] of commits) {
    write(rel, body);
    git(ROOT, 'add', '-A');
    git(ROOT, 'commit', '-qm', msg);
  }

  // `.conduit/` artifacts — committed, as ADR 0002 intends.
  write('.conduit/architecture.json', JSON.stringify(ARCHITECTURE, null, 2));
  write('.conduit/board.json', JSON.stringify(BOARD, null, 2));
  git(ROOT, 'add', '-A');
  git(ROOT, 'commit', '-qm', 'chore(conduit): board + architecture artifacts');

  // Dirty worktree covering every status letter the Changes rail renders: M A D U.
  write(
    'README.md',
    '# demo-repo\n\n> Revamp in progress.\n\nA fixture repository for Conduit visual verification.\n',
  );
  write(
    'webview/app.tsx',
    'export function App() {\n  // reworked shell\n  return <div className="shell" data-theme="aero" />;\n}\n',
  );
  write(
    'src/feature-flags.ts',
    'export const FLAGS = {\n  newSessionRail: true,\n  compactReview: false,\n};\n',
  );
  git(ROOT, 'add', 'src/feature-flags.ts');
  git(ROOT, 'rm', '-q', 'AGENTS.md');
  write('NOTES.md', '# Scratch notes\n\n- new sidebar rail\n- review pane density\n');

  return ROOT.replace(/\\/g, '/');
}

export const FIXTURE_ROOT = ROOT.replace(/\\/g, '/');
