import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ChangeDTO, ChangeKind, CustomizationCount, FileNodeDTO } from './protocol';

const IGNORED = new Set(['.git', 'node_modules', 'dist', 'out', '.next', '.vscode-test']);
const MAX_DEPTH = 2;

function run(cmd: string, args: string[], cwd: string): Promise<string> {
  return new Promise((resolve) => {
    execFile(cmd, args, { cwd, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
      resolve(err ? '' : stdout);
    });
  });
}

/** Map a single porcelain status code (one side, X or Y) to a ChangeKind. */
function kindFromCode(code: string): ChangeKind {
  if (code === '?') return 'U';
  if (code === 'A') return 'A';
  if (code === 'D') return 'D';
  return 'M';
}

function parseNumstat(out: string): Map<string, { added: number; removed: number }> {
  const stats = new Map<string, { added: number; removed: number }>();
  for (const line of out.split('\n')) {
    const m = line.match(/^(\d+|-)\t(\d+|-)\t(.+)$/);
    if (m) {
      stats.set(m[3].trim(), {
        added: m[1] === '-' ? 0 : Number(m[1]),
        removed: m[2] === '-' ? 0 : Number(m[2]),
      });
    }
  }
  return stats;
}

async function gitChanges(cwd: string): Promise<ChangeDTO[]> {
  const status = await run('git', ['status', '--porcelain'], cwd);
  if (!status.trim()) return [];

  // Two numstat passes: staged side (index vs HEAD, --cached) and unstaged side
  // (worktree vs index). Untracked files appear in neither and default to 0/0.
  const [stagedOut, unstagedOut] = await Promise.all([
    run('git', ['diff', '--numstat', '--cached'], cwd),
    run('git', ['diff', '--numstat'], cwd),
  ]);
  const stagedStats = parseNumstat(stagedOut);
  const unstagedStats = parseNumstat(unstagedOut);

  const changes: ChangeDTO[] = [];
  for (const line of status.split('\n')) {
    if (!line.trim()) continue;
    const x = line[0]; // index (staged) status
    const y = line[1]; // worktree (unstaged) status
    let p = line.slice(3).trim();
    if (p.includes(' -> ')) p = p.split(' -> ')[1]; // renames
    p = p.replace(/^"(.*)"$/, '$1');

    if (x === '?' && y === '?') {
      // Untracked: a single unstaged entry.
      changes.push({ path: p, added: 0, removed: 0, kind: 'U', staged: false });
      continue;
    }
    // Staged side: X is a real change code (not space, not ?).
    if (x !== ' ' && x !== '?') {
      const st = stagedStats.get(p) ?? { added: 0, removed: 0 };
      changes.push({
        path: p,
        added: st.added,
        removed: st.removed,
        kind: kindFromCode(x),
        staged: true,
      });
    }
    // Unstaged side: Y is a real change code.
    if (y !== ' ' && y !== '?') {
      const st = unstagedStats.get(p) ?? { added: 0, removed: 0 };
      changes.push({
        path: p,
        added: st.added,
        removed: st.removed,
        kind: kindFromCode(y),
        staged: false,
      });
    }
  }
  return changes;
}

function fileTree(root: string): FileNodeDTO[] {
  const out: FileNodeDTO[] = [];
  const walk = (dir: string, depth: number) => {
    if (depth > MAX_DEPTH) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries
      .filter((e) => !IGNORED.has(e.name))
      .sort((a, b) => {
        if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
        return a.name.localeCompare(b.name);
      })
      .forEach((e) => {
        out.push({ name: e.name, kind: e.isDirectory() ? 'dir' : 'file', depth });
        if (e.isDirectory()) walk(path.join(dir, e.name), depth + 1);
      });
  };
  walk(root, 0);
  return out.slice(0, 400); // safety cap
}

function countEntries(dir: string, predicate: (e: fs.Dirent) => boolean): number {
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).filter(predicate).length;
  } catch {
    return 0;
  }
}

function readJson(file: string): Record<string, unknown> | undefined {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return undefined;
  }
}

function countHooks(hooks: unknown): number {
  if (!hooks || typeof hooks !== 'object') return 0;
  let n = 0;
  for (const arr of Object.values(hooks as Record<string, unknown>)) {
    if (Array.isArray(arr)) n += arr.length;
  }
  return n;
}

/** Count Claude Code customizations across the project and the user's ~/.claude. */
function getCustomizations(cwd: string): CustomizationCount[] {
  const roots = [path.join(cwd, '.claude'), path.join(os.homedir(), '.claude')];
  const sum = (fn: (root: string) => number) => roots.reduce((a, r) => a + fn(r), 0);

  const agents = sum((r) =>
    countEntries(path.join(r, 'agents'), (e) => e.isFile() && e.name.endsWith('.md')),
  );
  const skills = sum((r) => countEntries(path.join(r, 'skills'), (e) => e.isDirectory()));

  let instructions = 0;
  for (const f of [
    path.join(cwd, 'CLAUDE.md'),
    path.join(cwd, 'AGENTS.md'),
    path.join(os.homedir(), '.claude', 'CLAUDE.md'),
  ]) {
    if (fs.existsSync(f)) instructions++;
  }

  let hooks = 0;
  let mcp = 0;
  for (const r of roots) {
    for (const sf of ['settings.json', 'settings.local.json']) {
      const s = readJson(path.join(r, sf));
      if (s) {
        hooks += countHooks(s.hooks);
        if (s.mcpServers && typeof s.mcpServers === 'object')
          mcp += Object.keys(s.mcpServers).length;
      }
    }
  }
  const mcpJson = readJson(path.join(cwd, '.mcp.json'));
  if (mcpJson?.mcpServers && typeof mcpJson.mcpServers === 'object') {
    mcp += Object.keys(mcpJson.mcpServers as object).length;
  }

  return [
    { id: 'agents', count: agents },
    { id: 'skills', count: skills },
    { id: 'instructions', count: instructions },
    { id: 'hooks', count: hooks },
    { id: 'mcp', count: mcp },
  ];
}

export async function getProjectInfo(
  cwd: string,
): Promise<{ changes: ChangeDTO[]; files: FileNodeDTO[]; customizations: CustomizationCount[] }> {
  if (!cwd || !fs.existsSync(cwd)) return { changes: [], files: [], customizations: [] };
  const [changes, files] = await Promise.all([gitChanges(cwd), Promise.resolve(fileTree(cwd))]);
  // Tag file nodes with git status by matching path suffix.
  const statusByName = new Map<string, ChangeKind>();
  for (const c of changes) {
    const name = c.path.split('/').pop();
    if (name) statusByName.set(name, c.kind);
  }
  for (const f of files) {
    if (f.kind === 'file' && statusByName.has(f.name)) f.status = statusByName.get(f.name);
  }
  return { changes, files, customizations: getCustomizations(cwd) };
}
