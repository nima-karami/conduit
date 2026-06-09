import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { ChangeDTO, ChangeKind, FileNodeDTO } from './protocol';

const IGNORED = new Set(['.git', 'node_modules', 'dist', 'out', '.next', '.vscode-test']);
const MAX_DEPTH = 2;

function run(cmd: string, args: string[], cwd: string): Promise<string> {
  return new Promise((resolve) => {
    execFile(cmd, args, { cwd, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
      resolve(err ? '' : stdout);
    });
  });
}

function kindFromStatus(xy: string): ChangeKind {
  if (xy.includes('?')) return 'U';
  if (xy.includes('A')) return 'A';
  if (xy.includes('D')) return 'D';
  return 'M';
}

async function gitChanges(cwd: string): Promise<ChangeDTO[]> {
  const status = await run('git', ['status', '--porcelain'], cwd);
  if (!status.trim()) return [];

  // numstat (added/removed) for tracked changes vs HEAD.
  const numstat = await run('git', ['diff', '--numstat', 'HEAD'], cwd);
  const stats = new Map<string, { added: number; removed: number }>();
  for (const line of numstat.split('\n')) {
    const m = line.match(/^(\d+|-)\t(\d+|-)\t(.+)$/);
    if (m) {
      stats.set(m[3].trim(), {
        added: m[1] === '-' ? 0 : Number(m[1]),
        removed: m[2] === '-' ? 0 : Number(m[2]),
      });
    }
  }

  const changes: ChangeDTO[] = [];
  for (const line of status.split('\n')) {
    if (!line.trim()) continue;
    const xy = line.slice(0, 2);
    let p = line.slice(3).trim();
    if (p.includes(' -> ')) p = p.split(' -> ')[1]; // renames
    p = p.replace(/^"(.*)"$/, '$1');
    const st = stats.get(p) ?? { added: 0, removed: 0 };
    changes.push({ path: p, added: st.added, removed: st.removed, kind: kindFromStatus(xy) });
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

export async function getProjectInfo(
  cwd: string,
): Promise<{ changes: ChangeDTO[]; files: FileNodeDTO[] }> {
  if (!cwd || !fs.existsSync(cwd)) return { changes: [], files: [] };
  const [changes, files] = await Promise.all([
    gitChanges(cwd),
    Promise.resolve(fileTree(cwd)),
  ]);
  // Tag file nodes with git status by matching path suffix.
  const statusByName = new Map<string, ChangeKind>();
  for (const c of changes) statusByName.set(c.path.split('/').pop()!, c.kind);
  for (const f of files) {
    if (f.kind === 'file' && statusByName.has(f.name)) f.status = statusByName.get(f.name);
  }
  return { changes, files };
}
