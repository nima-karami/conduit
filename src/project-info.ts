import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  GIT_TIMEOUT,
  type GitFailure,
  type GitResult,
  gitFailureOf,
  mapWithConcurrency,
  runGit,
} from './git-exec';
import { parseNumstatZ } from './git-history';
import type { ChangeDTO, ChangeKind } from './protocol';

// Per-file cap for the Changes line-count reads (mirrors file-service's 2 MB diff cap). An
// untracked file over this is counted via a bounded stream and never fully buffered.
const MAX_FILE_BYTES = 2 * 1024 * 1024;
// How many working-tree files to line-count at once (bounds the fs threadpool + memory).
const COUNT_CONCURRENCY = 8;
const HEAD_CONCURRENCY = 4;
let activeHeadReads = 0;
const waitingHeadReads: (() => void)[] = [];
async function deletedFileLines(cwd: string, file: string): Promise<number> {
  if (activeHeadReads < HEAD_CONCURRENCY) activeHeadReads++;
  else await new Promise<void>((resolve) => waitingHeadReads.push(resolve));
  try {
    return countLines((await run('git', ['show', `HEAD:${file}`], cwd)).stdout);
  } finally {
    const next = waitingHeadReads.shift();
    if (next) next();
    else activeHeadReads--;
  }
}

// All callers pass 'git'; the arg array is what matters. Bounded via the shared runner so a wedged
// git (index.lock, stalled FS) fails like any other failure instead of hanging the Changes load.
function run(_cmd: string, args: string[], cwd: string): Promise<GitResult> {
  return runGit(args, { cwd, timeoutMs: GIT_TIMEOUT.diff, maxBuffer: 8 * 1024 * 1024 });
}

/** Map a single porcelain status code (one side, X or Y) to a ChangeKind. */
function kindFromCode(code: string): ChangeKind {
  if (code === '?') return 'U';
  if (code === 'A') return 'A';
  if (code === 'D') return 'D';
  if (code === 'R') return 'R';
  return 'M';
}

interface StatusEntry {
  x: string;
  y: string;
  p: string;
  /** A rename's or copy's source. */
  orig?: string;
}

/** Parse `git status --porcelain -z`: NUL-terminated, never C-quoted, and a rename or copy
 *  record is followed by one more field holding its SOURCE path. */
export function parseStatusZ(out: string): StatusEntry[] {
  const entries: StatusEntry[] = [];
  const fields = out.split('\0');
  for (let i = 0; i < fields.length; i++) {
    const f = fields[i];
    if (f.length < 4) continue;
    const x = f[0];
    const y = f[1];
    const moved = x === 'R' || x === 'C' || y === 'R' || y === 'C';
    const orig = moved ? fields[++i] : undefined;
    entries.push({ x, y, p: f.slice(3), ...(orig ? { orig } : {}) });
  }
  return entries;
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

export type RepoRead =
  | { ok: true; changes: ChangeDTO[]; trackedDirty: boolean }
  | { ok: false; reason: GitFailure };

/** One `status --porcelain -z --untracked-files=all`; with `lines:false` it is the only git
 *  process and added/removed stay 0. See docs/specs/2026-10-16-multi-repo-tracking.md §3. */
export async function readRepoChanges(cwd: string, opts: { lines: boolean }): Promise<RepoRead> {
  // --untracked-files=all expands a new untracked directory into its individual files;
  // the default collapses them to a single `dir/` entry (only the folder shows up).
  const statusRun = await run('git', ['status', '--porcelain', '-z', '--untracked-files=all'], cwd);
  const failure = gitFailureOf(statusRun);
  if (failure) return { ok: false, reason: failure };
  const rawEntries = parseStatusZ(statusRun.stdout);
  // Same meaning as GitInfo.dirty (non-empty porcelain with --untracked-files=no).
  const trackedDirty = rawEntries.some(({ x, y }) => !(x === '?' && y === '?'));
  if (!opts.lines) return { ok: true, changes: changesFrom(rawEntries), trackedDirty };

  // Two numstat passes: staged side (index vs HEAD, --cached) and unstaged side
  // (worktree vs index). Newly-added staged files, deleted files, and untracked
  // files do not appear in numstat (they are absent from one of the two compared
  // trees). We handle those separately by counting lines directly.
  const [stagedOut, unstagedOut] = await Promise.all([
    run('git', ['diff', '--numstat', '-z', '--cached'], cwd),
    run('git', ['diff', '--numstat', '-z'], cwd),
  ]);
  const stagedStats = parseNumstatZ(stagedOut.stdout);
  const unstagedStats = parseNumstatZ(unstagedOut.stdout);

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

  // HEAD, rather than index, preserves the count when a staged edit was subsequently deleted.
  // Aggregate deletions avoid one process per file; unresolved/conflicted paths retain the
  // bounded blob-read fallback.
  const deletedStats = needsHead.size
    ? parseNumstatZ(
        (
          await run(
            'git',
            [
              'diff',
              '--numstat',
              '-z',
              '--no-renames',
              '--no-ext-diff',
              '--no-textconv',
              '--diff-filter=D',
              'HEAD',
            ],
            cwd,
          )
        ).stdout,
      )
    : new Map<string, { added: number; removed: number }>();
  const headLineCounts = new Map<string, number>();
  await mapWithConcurrency([...needsHead], HEAD_CONCURRENCY, async (p) => {
    headLineCounts.set(p, deletedStats.get(p)?.removed ?? (await deletedFileLines(cwd, p)));
  });

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

  return {
    ok: true,
    changes: changesFrom(rawEntries, {
      stagedStats,
      unstagedStats,
      headLineCounts,
      fileLineCounts,
    }),
    trackedDirty,
  };
}

type LineStats = Map<string, { added: number; removed: number }>;

interface LineSources {
  stagedStats: LineStats;
  unstagedStats: LineStats;
  headLineCounts: Map<string, number>;
  fileLineCounts: Map<string, number>;
}

const NO_LINES: LineSources = {
  stagedStats: new Map(),
  unstagedStats: new Map(),
  headLineCounts: new Map(),
  fileLineCounts: new Map(),
};

/** Porcelain marks a conflict with `U` on either side, or with `AA` / `DD`. */
const isConflicted = (x: string, y: string): boolean =>
  x === 'U' || y === 'U' || (x === 'A' && y === 'A') || (x === 'D' && y === 'D');

function changesFrom(
  rawEntries: StatusEntry[],
  { stagedStats, unstagedStats, headLineCounts, fileLineCounts }: LineSources = NO_LINES,
): ChangeDTO[] {
  const changes: ChangeDTO[] = [];
  // Emit one ChangeDTO for a single side (staged or unstaged) of an entry, when
  // its status code is a real change. Shared by both sides to avoid duplication.
  const pushSide = (
    p: string,
    code: string,
    numstatMap: Map<string, { added: number; removed: number }>,
    staged: boolean,
    conflicted = false,
    orig?: string,
  ) => {
    if (code === ' ' || code === '?') return;
    const kind = kindFromCode(code);
    const { added, removed } =
      kind === 'D'
        ? { added: 0, removed: headLineCounts.get(p) ?? 0 }
        : resolveLineCounts(kind, numstatMap.get(p), fileLineCounts.get(p), undefined);
    changes.push({
      path: p,
      added,
      removed,
      kind,
      staged,
      ...(conflicted ? { conflicted } : {}),
      ...(staged && orig !== undefined ? { origPath: orig } : {}),
    });
  };
  for (const { p, x, y, orig } of rawEntries) {
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
    pushSide(p, x, stagedStats, true, conflicted, orig); // staged side (index vs HEAD)
    pushSide(p, y, unstagedStats, false, conflicted); // unstaged side (worktree vs index)
  }
  return changes;
}
