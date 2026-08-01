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

// The 8f graph, in the model's real shape (src/architecture.ts): typed `inputs`/`outputs`
// with `{ kind: 'ref', interfaceId }` types and a document-level interface registry. An earlier
// version of this fixture invented a schema (`ports[]`, `{ kind: 'iface', name }`, no
// `rootGraph`), so `restoreArchitecture` returned null and every canvas shot was silently the
// four-node built-in seed rather than this graph.
const ref = (id) => ({ kind: 'ref', interfaceId: id });
const IFACES = {
  'if-archdoc': {
    id: 'if-archdoc',
    name: 'ArchDoc',
    fields: [
      { name: 'version', type: { kind: 'primitive', name: 'number' } },
      { name: 'rootGraph', type: { kind: 'primitive', name: 'string' } },
      { name: 'graphs', type: { kind: 'primitive', name: 'json' } },
    ],
  },
  'if-archnode': {
    id: 'if-archnode',
    name: 'ArchNode',
    fields: [
      { name: 'id', type: { kind: 'primitive', name: 'string' } },
      { name: 'title', type: { kind: 'primitive', name: 'string' } },
      { name: 'kind', type: { kind: 'primitive', name: 'string' } },
    ],
  },
  'if-archedge': {
    id: 'if-archedge',
    name: 'ArchEdge',
    fields: [
      { name: 'source', type: { kind: 'primitive', name: 'string' } },
      { name: 'target', type: { kind: 'primitive', name: 'string' } },
      { name: 'label', type: { kind: 'primitive', name: 'string' }, optional: true },
    ],
  },
  'if-plandoc': {
    id: 'if-plandoc',
    name: 'PlanDoc',
    fields: [{ name: 'steps', type: { kind: 'list', of: ref('if-archnode') } }],
  },
  'if-typeref': {
    id: 'if-typeref',
    name: 'TypeRef',
    fields: [{ name: 'kind', type: { kind: 'primitive', name: 'string' } }],
  },
};

const ARCH_NODES = [
  {
    id: 'agent',
    title: 'CLI Agent',
    subtitle: 'reads/writes the contract',
    kind: 'external',
    x: 88,
    y: 0,
    outputs: [{ id: 'p1', name: 'proposal', type: ref('if-archdoc') }],
  },
  {
    id: 'model',
    title: 'Arch Model',
    subtitle: 'pure reducers (architecture.ts)',
    kind: 'library',
    x: 60,
    y: 160,
    inputs: [{ id: 'p2', name: 'doc', type: ref('if-archdoc') }],
    outputs: [{ id: 'p3', name: 'next', type: ref('if-archdoc') }],
  },
  {
    id: 'canvas',
    title: 'Architecture Canvas',
    subtitle: 'React Flow view',
    kind: 'frontend',
    x: 413,
    y: 160,
    inputs: [{ id: 'p4', name: 'doc', type: ref('if-archdoc') }],
    outputs: [{ id: 'p5', name: 'edits', type: ref('if-archdoc') }],
  },
  {
    id: 'host',
    title: 'Electron Host',
    subtitle: 'IPC · persistence · watcher',
    kind: 'service',
    x: 772,
    y: 160,
    inputs: [
      { id: 'p6', name: 'fromDisk', type: ref('if-archdoc') },
      { id: 'p10', name: 'fromRenderer', type: ref('if-archdoc') },
    ],
    outputs: [
      { id: 'p7', name: 'toRenderer', type: ref('if-archdoc') },
      { id: 'p11', name: 'toDisk', type: ref('if-archdoc') },
    ],
  },
  {
    id: 'file',
    title: '.conduit/architecture.json',
    subtitle: 'source of truth',
    kind: 'storage',
    x: 1130,
    y: 160,
    inputs: [{ id: 'p8', name: 'write', type: ref('if-archdoc') }],
    outputs: [{ id: 'p12', name: 'doc', type: ref('if-archdoc') }],
  },
  {
    id: 'undo',
    title: 'Undo / Redo',
    subtitle: 'arch-history.ts',
    kind: 'library',
    x: 60,
    y: 330,
    inputs: [{ id: 'p9', name: 'push', type: ref('if-archdoc') }],
    outputs: [{ id: 'p13', name: 'restore', type: ref('if-archdoc') }],
  },
];

const ARCH_EDGES = [
  {
    id: 'e1',
    source: 'agent',
    sourcePort: 'p1',
    target: 'canvas',
    targetPort: 'p4',
    label: 'proposed.json → diff',
  },
  {
    id: 'e2',
    source: 'model',
    sourcePort: 'p3',
    target: 'canvas',
    targetPort: 'p4',
    label: 'next doc',
  },
  {
    id: 'e3',
    source: 'canvas',
    sourcePort: 'p5',
    target: 'host',
    targetPort: 'p10',
    label: 'IPC · debounced save',
  },
  {
    id: 'e4',
    source: 'host',
    sourcePort: 'p11',
    target: 'file',
    targetPort: 'p8',
    label: 'load · atomic write',
  },
  {
    id: 'e5',
    source: 'canvas',
    sourcePort: 'p5',
    target: 'undo',
    targetPort: 'p9',
    label: 'undo / redo',
  },
];

const archDoc = (nodes, edges) => ({
  version: 1,
  rootGraph: 'root',
  graphs: { root: { id: 'root', title: 'Architecture', nodes, edges } },
  interfaces: IFACES,
});

const envelope = (kind, data) => ({ conduit: 1, kind, updatedAt: Date.now(), data });

/** Exported so a unit test can round-trip it through the real `restoreArchitecture`. */
export const ARCH_FIXTURE_DOC = archDoc(ARCH_NODES, ARCH_EDGES);

const ARCHITECTURE = envelope('architecture', ARCH_FIXTURE_DOC);

// A pending agent proposal (`.conduit/architecture.proposed.json`): the canonical graph plus one
// new component. That is the real mechanism behind 8f's dashed "Plan View" card — the canvas shows
// it as an ADDED node once the human opens the proposal for review.
export const ARCH_FIXTURE_PROPOSAL = archDoc(
  [
    ...ARCH_NODES,
    {
      id: 'plan',
      title: 'Plan View',
      subtitle: 'proposed · not yet accepted',
      kind: 'frontend',
      x: 413,
      y: 330,
      inputs: [{ id: 'p20', name: 'plan', type: ref('if-plandoc') }],
    },
  ],
  [
    ...ARCH_EDGES,
    { id: 'e6', source: 'canvas', sourcePort: 'p5', target: 'plan', targetPort: 'p20' },
  ],
);

const ARCHITECTURE_PROPOSAL = envelope('architecture', ARCH_FIXTURE_PROPOSAL);

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

/**
 * Put a pending agent proposal on disk, or take it away. The canvas scenes drive this rather
 * than the fixture shipping one: a proposal is a working-tree file, so leaving it there would
 * add an untracked row to every Changes/Review shot in the run.
 */
export function setArchProposal(present) {
  const file = join(ROOT, '.conduit', 'architecture.proposed.json');
  if (present) writeFileSync(file, JSON.stringify(ARCHITECTURE_PROPOSAL, null, 2));
  else rmSync(file, { force: true });
}
