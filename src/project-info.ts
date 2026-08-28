import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { GIT_TIMEOUT, mapWithConcurrency, runGit } from './git-exec';
import { IGNORED_DIRS } from './ignore-dirs';
import type { ChangeDTO, ChangeKind, CustomizationCount, FileNodeDTO } from './protocol';

const MAX_DEPTH = 2;
// Per-file cap for the Changes line-count reads (mirrors file-service's 2 MB diff cap). An
// untracked file over this is counted via a bounded stream and never fully buffered.
const MAX_FILE_BYTES = 2 * 1024 * 1024;
// How many working-tree files to line-count at once (bounds the fs threadpool + memory).
const COUNT_CONCURRENCY = 8;

// All callers pass 'git'; the arg array is what matters. Bounded via the shared runner so a wedged
// git (index.lock, stalled FS) yields '' like any other failure instead of hanging the Changes load.
function run(_cmd: string, args: string[], cwd: string): Promise<string> {
  return runGit(args, { cwd, timeoutMs: GIT_TIMEOUT.diff, maxBuffer: 8 * 1024 * 1024 }).then(
    (r) => r.stdout,
  );
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

/**
 * Count lines in a content string, VS Code / GitHub convention: a final line
 * without a trailing newline still counts; an empty string is 0.
 */
export function countLines(content: string): number {
  if (content.length === 0) return 0;
  const newlines = (content.match(/\n/g) ?? []).length;
  return content.endsWith('\n') ? newlines : newlines + 1;
}

/**
 * Count a file's lines via a bounded, async STREAM — never the synchronous whole-file read the
 * Changes load used to do (a big untracked file froze the host, spec 2026-07-07). Stops reading once
 * `capBytes` is exceeded (flagging `oversize`); a NUL byte marks the file binary → 0 lines. Never
 * rejects — a missing/unreadable file resolves to `{ lines: 0, oversize: false }`.
 */
export function countLinesOfFile(
  abs: string,
  capBytes: number,
): Promise<{ lines: number; oversize: boolean }> {
  return new Promise((resolve) => {
    let lines = 0;
    let bytes = 0;
    let sawContent = false;
    let lastByte = -1;
    let settled = false;
    const finish = (oversize: boolean, binary: boolean) => {
      if (settled) return;
      settled = true;
      // A file with content whose last byte isn't a newline still has a final unterminated line —
      // match countLines() exactly so a non-oversize file's count is identical to the old read.
      const total = binary ? 0 : sawContent && lastByte !== 0x0a ? lines + 1 : lines;
      resolve({ lines: total, oversize });
    };
    const stream = fs.createReadStream(abs);
    stream.on('data', (data: string | Buffer) => {
      const chunk = Buffer.isBuffer(data) ? data : Buffer.from(data);
      if (chunk.length > 0) {
        sawContent = true;
        lastByte = chunk[chunk.length - 1];
      }
      if (chunk.includes(0)) {
        stream.destroy();
        finish(false, true);
        return;
      }
      for (let i = 0; i < chunk.length; i++) if (chunk[i] === 0x0a) lines++;
      bytes += chunk.length;
      if (bytes > capBytes) {
        stream.destroy();
        finish(true, false);
      }
    });
    stream.on('end', () => finish(false, false));
    stream.on('error', () => finish(false, false));
  });
}

/**
 * Resolve the added/removed line counts for a single change entry. Added/Untracked
 * count the whole working-tree file, Deleted counts the whole HEAD version, and
 * everything else trusts numstat (which also covers renames).
 */
export function resolveLineCounts(
  kind: ChangeKind,
  numstat: { added: number; removed: number } | undefined,
  addedLines: number | undefined,
  headContent: string | undefined,
): { added: number; removed: number } {
  switch (kind) {
    case 'A':
    case 'U':
      return { added: addedLines ?? 0, removed: 0 };
    case 'D':
      return { added: 0, removed: countLines(headContent ?? '') };
    default:
      return numstat ?? { added: 0, removed: 0 };
  }
}

async function gitChanges(cwd: string): Promise<ChangeDTO[]> {
  // --untracked-files=all expands a new untracked directory into its individual files;
  // the default collapses them to a single `dir/` entry (only the folder shows up).
  const status = await run('git', ['status', '--porcelain', '--untracked-files=all'], cwd);
  if (!status.trim()) return [];

  // Two numstat passes: staged side (index vs HEAD, --cached) and unstaged side
  // (worktree vs index). Newly-added staged files, deleted files, and untracked
  // files do not appear in numstat (they are absent from one of the two compared
  // trees). We handle those separately by counting lines directly.
  const [stagedOut, unstagedOut] = await Promise.all([
    run('git', ['diff', '--numstat', '--cached'], cwd),
    run('git', ['diff', '--numstat'], cwd),
  ]);
  const stagedStats = parseNumstat(stagedOut);
  const unstagedStats = parseNumstat(unstagedOut);

  // Parse all porcelain lines first so we know which files need extra fetches.
  type RawEntry = {
    p: string;
    x: string;
    y: string;
  };
  const rawEntries: RawEntry[] = [];
  for (const line of status.split('\n')) {
    if (!line.trim()) continue;
    const x = line[0]; // index (staged) status
    const y = line[1]; // worktree (unstaged) status
    let p = line.slice(3).trim();
    if (p.includes(' -> ')) p = p.split(' -> ')[1]; // renames
    p = p.replace(/^"(.*)"$/, '$1');
    rawEntries.push({ p, x, y });
  }

  // Identify files that need HEAD content (deleted) or working-tree content
  // (added staged or untracked). Batch all fetches in parallel.
  const needsHead = new Set<string>();
  const needsFile = new Set<string>();
  for (const { p, x, y } of rawEntries) {
    if (x === '?' && y === '?') {
      needsFile.add(p);
      continue;
    }
    if (x !== ' ' && x !== '?') {
      const kind = kindFromCode(x);
      if (kind === 'A') needsFile.add(p);
      if (kind === 'D') needsHead.add(p);
    }
    if (y !== ' ' && y !== '?') {
      const kind = kindFromCode(y);
      if (kind === 'A') needsFile.add(p);
      if (kind === 'D') needsHead.add(p);
    }
  }

  // Fetch HEAD content for deleted files via `git show HEAD:<path>`.
  const headContents = new Map<string, string>();
  await Promise.all(
    [...needsHead].map(async (p) => {
      const content = await run('git', ['show', `HEAD:${p}`], cwd);
      headContents.set(p, content);
    }),
  );

  // Line-count working-tree files for added/untracked entries — async + streamed + concurrency-
  // bounded so a big untracked file can never freeze the host (was a synchronous readFileSync loop).
  const fileLineCounts = new Map<string, number>();
  const needFileList = [...needsFile];
  const counts = await mapWithConcurrency(needFileList, COUNT_CONCURRENCY, (p) =>
    countLinesOfFile(path.join(cwd, p), MAX_FILE_BYTES),
  );
  needFileList.forEach((p, i) => {
    fileLineCounts.set(p, counts[i].lines);
  });

  /** Porcelain marks a conflict with `U` on either side, or with `AA` / `DD`. */
  const isConflicted = (x: string, y: string): boolean =>
    x === 'U' || y === 'U' || (x === 'A' && y === 'A') || (x === 'D' && y === 'D');

  const changes: ChangeDTO[] = [];
  // Emit one ChangeDTO for a single side (staged or unstaged) of an entry, when
  // its status code is a real change. Shared by both sides to avoid duplication.
  const pushSide = (
    p: string,
    code: string,
    numstatMap: Map<string, { added: number; removed: number }>,
    staged: boolean,
    conflicted = false,
  ) => {
    if (code === ' ' || code === '?') return;
    const kind = kindFromCode(code);
    const { added, removed } = resolveLineCounts(
      kind,
      numstatMap.get(p),
      fileLineCounts.get(p),
      headContents.get(p),
    );
    changes.push({ path: p, added, removed, kind, staged, ...(conflicted ? { conflicted } : {}) });
  };
  for (const { p, x, y } of rawEntries) {
    if (x === '?' && y === '?') {
      // Untracked: a single unstaged entry.
      const { added, removed } = resolveLineCounts(
        'U',
        undefined,
        fileLineCounts.get(p),
        undefined,
      );
      changes.push({ path: p, added, removed, kind: 'U', staged: false });
      continue;
    }
    const conflicted = isConflicted(x, y);
    pushSide(p, x, stagedStats, true, conflicted); // staged side (index vs HEAD)
    pushSide(p, y, unstagedStats, false, conflicted); // unstaged side (worktree vs index)
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
      .filter((e) => !IGNORED_DIRS.has(e.name))
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

/**
 * Build the project view. The file tree comes from `cwd` (the opened root — the explorer
 * browses the whole tree), while git `changes` are scoped to `changesRoot` (the session's
 * active repo, for multi-repo workspaces). They coincide for a single-repo project.
 */
export async function getProjectInfo(
  cwd: string,
  changesRoot: string = cwd,
): Promise<{ changes: ChangeDTO[]; files: FileNodeDTO[]; customizations: CustomizationCount[] }> {
  if (!cwd || !fs.existsSync(cwd)) return { changes: [], files: [], customizations: [] };
  const [changes, files] = await Promise.all([
    changesRoot && fs.existsSync(changesRoot)
      ? gitChanges(changesRoot)
      : Promise.resolve<ChangeDTO[]>([]),
    Promise.resolve(fileTree(cwd)),
  ]);
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
