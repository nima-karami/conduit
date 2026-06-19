import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { GitInfo, GitOperation } from './types';

/**
 * Host-side git interrogation (Slice A of the branch/worktree indicator). `getGitInfo`
 * derives a `GitInfo` for a cwd by spawning `git` with an ARG ARRAY (never a shell
 * string — the cwd can't inject), following the `git-actions.ts` precedent. Values come
 * from `git rev-parse`; an in-progress operation is detected by cheap `fs.access` on the
 * gitdir marker files (no extra spawn); dirty is the one optionally-slow `git status`
 * call and is dropped first under time pressure.
 *
 * Every interrogation is bounded by a hard timeout; on timeout/error it resolves to
 * `{ kind: 'none' }` and logs host-side — it NEVER throws into the broadcast. After the
 * first "git not found" the module caches `gitAvailable = false` for the process so a
 * git-less machine never re-spawns.
 *
 * The renderer never imports this (it pulls node:child_process/fs) — `GitInfo` reaches the
 * renderer only via the `state` broadcast.
 */

const DEFAULT_TIMEOUT_MS = 1500;
const MAX_BUFFER = 1024 * 1024;

/** Process-level latch: once git is confirmed missing, stop trying to spawn it. */
let gitAvailable = true;

/** Test-only: reset the process-level gitAvailable latch between cases. */
export function __resetGitAvailableForTest(): void {
  gitAvailable = true;
}

interface GitInfoOptions {
  /** Hard per-interrogation timeout. Defaults to 1500 ms. */
  timeoutMs?: number;
  /** Override the git binary (tests use this to force the not-found path). */
  gitBin?: string;
  /** Host log sink for swallowed errors (defaults to console.error). */
  log?: (msg: string) => void;
}

type RunResult = { ok: true; stdout: string } | { ok: false; notFound: boolean };

/** Run git with an arg array, bounded by a deadline. Never rejects. */
function runGit(
  gitBin: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
): Promise<RunResult> {
  return new Promise((resolve) => {
    execFile(
      gitBin,
      args,
      { cwd, windowsHide: true, maxBuffer: MAX_BUFFER, timeout: timeoutMs },
      (err, stdout) => {
        if (err) {
          // ENOENT (git missing) is distinct from a non-zero exit (e.g. not a repo).
          const notFound = (err as NodeJS.ErrnoException).code === 'ENOENT';
          resolve({ ok: false, notFound });
          return;
        }
        resolve({ ok: true, stdout: stdout.toString() });
      },
    );
  });
}

/** Map a gitdir marker file/dir to the operation it signals. First match wins. */
const OPERATION_MARKERS: ReadonlyArray<readonly [string, GitOperation]> = [
  ['rebase-merge', 'rebase'],
  ['rebase-apply', 'rebase'],
  ['MERGE_HEAD', 'merge'],
  ['CHERRY_PICK_HEAD', 'cherry-pick'],
  ['REVERT_HEAD', 'revert'],
  ['BISECT_LOG', 'bisect'],
];

async function detectOperation(gitDir: string): Promise<GitOperation | undefined> {
  for (const [marker, op] of OPERATION_MARKERS) {
    try {
      await fs.promises.access(path.join(gitDir, marker));
      return op;
    } catch {
      /* marker absent — try the next */
    }
  }
  return undefined;
}

/**
 * Read the unborn branch name from `<gitDir>/HEAD`'s `ref: refs/heads/<name>` symref.
 * This is the ONE place we hand-read HEAD — `rev-parse` can't resolve an unborn HEAD
 * (it points at a branch ref that doesn't exist yet). Returns undefined if unreadable.
 */
function readUnbornBranch(gitDir: string): string | undefined {
  try {
    const head = fs.readFileSync(path.join(gitDir, 'HEAD'), 'utf8').trim();
    const m = /^ref:\s*refs\/heads\/(.+)$/.exec(head);
    return m ? m[1] : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Construct a GitInfo from raw facts, enforcing the §3 type-level invariants centrally
 * so the host never emits a shape the renderer's narrowing can't trust.
 */
function makeGitInfo(facts: {
  kind: GitInfo['kind'];
  branch?: string;
  unborn?: boolean;
  sha?: string;
  isWorktree?: boolean;
  worktreeName?: string;
  dirty?: boolean;
  operation?: GitOperation;
}): GitInfo {
  if (facts.kind === 'bare') {
    // Bare repos have no working tree: drop branch/sha/dirty/operation entirely.
    return { kind: 'bare' };
  }
  if (facts.kind === 'none') return { kind: 'none' };

  const info: GitInfo = { kind: facts.kind };
  if (facts.kind === 'branch') {
    info.branch = facts.branch ?? 'HEAD';
    if (facts.unborn) info.unborn = true;
  }
  if (facts.kind === 'detached') {
    info.sha = facts.sha ?? '';
  }
  if (facts.isWorktree && facts.worktreeName) {
    info.isWorktree = true;
    info.worktreeName = facts.worktreeName;
  }
  if (facts.dirty !== undefined) info.dirty = facts.dirty;
  if (facts.operation) info.operation = facts.operation;
  return info;
}

/** A git interrogation result plus the HEAD file to watch for refresh (when in a repo). */
export interface GitInterrogation {
  info: GitInfo;
  /** Absolute path to the `HEAD` to watch (the per-worktree git-dir's HEAD); undefined
   * when cwd is not a repo / git is unavailable. Watched for an external checkout that
   * doesn't move cwd. */
  headPath?: string;
}

/**
 * Derive the GitInfo for a cwd. Bounded, non-throwing; `{ kind: 'none' }` on any
 * not-a-repo / timeout / error path.
 */
export async function getGitInfo(cwd: string, opts: GitInfoOptions = {}): Promise<GitInfo> {
  return (await interrogateGit(cwd, opts)).info;
}

/**
 * Like `getGitInfo` but also returns the HEAD path to watch, resolved from the same
 * `rev-parse` this already runs — so the host's refresh seam gets both from one
 * interrogation instead of spawning a second `rev-parse --git-dir` just for the watch.
 */
export async function interrogateGit(
  cwd: string,
  opts: GitInfoOptions = {},
): Promise<GitInterrogation> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const gitBin = opts.gitBin ?? 'git';
  const log = opts.log ?? ((m: string) => console.error(m));

  if (!gitAvailable) return { info: { kind: 'none' } };
  if (!cwd) return { info: { kind: 'none' } };

  // Bare-ness + the gitdirs first. `--show-toplevel` errors in a bare repo, so it can't
  // ride this call; bare is resolved here before we ever ask for a work-tree top-level.
  const base = await runGit(
    gitBin,
    ['rev-parse', '--is-bare-repository', '--git-dir', '--git-common-dir'],
    cwd,
    timeoutMs,
  );

  if (!base.ok) {
    if (base.notFound) {
      gitAvailable = false;
      log('[git-info] git not found on PATH — disabling git interrogation for this process');
    }
    // Non-zero exit here means "not a git repo" (or timeout) — both → none, no log spam.
    return { info: { kind: 'none' } };
  }

  const baseLines = base.stdout.split('\n').map((l) => l.trim());
  const [isBare, gitDirRaw, gitCommonRaw] = baseLines;

  // Resolve the gitdir to an absolute path (rev-parse may return it relative to cwd).
  const gitDir = gitDirRaw ? path.resolve(cwd, gitDirRaw) : '';
  const gitCommon = gitCommonRaw ? path.resolve(cwd, gitCommonRaw) : '';
  // HEAD lives in the per-worktree git-dir (not the shared common dir), so a linked
  // worktree watches its own HEAD.
  const headPath = gitDir ? path.join(gitDir, 'HEAD') : undefined;

  if (isBare === 'true') return { info: makeGitInfo({ kind: 'bare' }), headPath };

  // Work-tree top-level (for the worktree label) — safe now that bare is ruled out.
  const top = await runGit(gitBin, ['rev-parse', '--show-toplevel'], cwd, timeoutMs);
  const topLevel = top.ok ? top.stdout.trim() : '';

  // Linked worktree: its private git-dir differs from the shared common dir.
  const isWorktree = !!gitDir && !!gitCommon && path.resolve(gitDir) !== path.resolve(gitCommon);
  const worktreeName = isWorktree && topLevel ? path.basename(topLevel) : undefined;

  const operation = gitDir ? await detectOperation(gitDir) : undefined;

  // Branch vs detached: --abbrev-ref returns "HEAD" when detached.
  const abbrev = await runGit(gitBin, ['rev-parse', '--abbrev-ref', 'HEAD'], cwd, timeoutMs);

  let kind: GitInfo['kind'];
  let branch: string | undefined;
  let unborn = false;
  let sha: string | undefined;

  if (!abbrev.ok) {
    // rev-parse HEAD fails on an unborn HEAD (fresh init, zero commits). Distinguish it
    // from a real error by reading the symref name out of HEAD directly.
    const unbornName = gitDir ? readUnbornBranch(gitDir) : undefined;
    if (unbornName) {
      kind = 'branch';
      branch = unbornName;
      unborn = true;
    } else {
      log(`[git-info] HEAD unresolved and no unborn symref for ${cwd}`);
      return { info: { kind: 'none' }, headPath };
    }
  } else {
    const name = abbrev.stdout.trim();
    if (name === 'HEAD') {
      const short = await runGit(gitBin, ['rev-parse', '--short=7', 'HEAD'], cwd, timeoutMs);
      kind = 'detached';
      sha = short.ok ? short.stdout.trim().slice(0, 7) : '';
    } else {
      kind = 'branch';
      branch = name;
    }
  }

  // Dirty is the single optionally-slow call and the first thing dropped under the
  // timeout. An unborn HEAD has no index baseline; skip it (dot hidden) to stay cheap.
  let dirty: boolean | undefined;
  if (!unborn) {
    const status = await runGit(
      gitBin,
      ['status', '--porcelain', '--untracked-files=no', '-z'],
      cwd,
      timeoutMs,
    );
    if (status.ok) dirty = status.stdout.length > 0;
  }

  return {
    info: makeGitInfo({ kind, branch, unborn, sha, isWorktree, worktreeName, dirty, operation }),
    headPath,
  };
}
