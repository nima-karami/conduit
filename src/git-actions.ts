import * as fs from 'node:fs';
import * as path from 'node:path';
import { GIT_TIMEOUT, runGit } from './git-exec';
import { type HunkRange, selectHunks } from './hunk-patch';
import { isInsideRoot } from './path-guard';

/**
 * Host-side git-action layer (L1). Two halves, both small and testable:
 *
 *  - PURE command construction (`buildGitArgs`, `planGitAction`): turns a renderer
 *    request into either a git ARG ARRAY (never a shell string), a filesystem
 *    delete (untracked discard), or a typed rejection. Path containment is enforced
 *    here using `isInsideRoot` from path-guard — the same containment backbone the
 *    write-file IPC uses — so a malicious path can never reach git or `fs.rm`.
 *  - A thin executor (`runGitAction`, see electron/main wiring) shells out via
 *    `execFile('git', args, { cwd: root })`. Kept out of this pure module so the
 *    command logic is unit-tested without spawning processes.
 *
 * Every path argument is passed AFTER a `--` separator so a path that begins with
 * `-` can never be misread as an option, and is always made repo-relative with
 * forward slashes (git's canonical pathspec form, cross-platform).
 */

/** Hunk-scoped ops. The host builds their patch from git's own diff — see
 *  spec 2026-08-27-review-supercharge §2 Lane E and src/hunk-patch.ts. */
export type HunkOp = 'stageHunk' | 'unstageHunk' | 'discardHunk';

export type GitOp =
  | 'stageFile'
  | 'unstageFile'
  | 'discardTracked'
  | 'discardUntracked'
  | 'stageAll'
  | 'unstageAll'
  | 'stashPush'
  | 'stashPop'
  | HunkOp;

export interface GitActionRequest {
  root: string;
  op: GitOp;
  /** Repo-relative or absolute path; required for per-file ops, ignored for bulk ops. */
  path?: string;
  /** Hunk ops only: the line range the user pointed at. Untrusted, and it never needs to be
   *  trusted — it is only ever compared against numbers read out of git's own diff. */
  range?: HunkRange;
}

/** `error` is human-readable text for the file/bulk ops and a stable CODE for the hunk ops
 *  (`no-hunk`, `apply-failed`), which the renderer maps to the spec's copy; `message` carries
 *  git's own stderr for the failure detail. */
export type GitActionResult = { ok: true } | { ok: false; error: string; message?: string };

/** A validated plan the executor can run without further checks. */
export type GitActionPlan =
  | { kind: 'git'; args: string[]; stdin?: string }
  | { kind: 'hunk'; op: HunkOp; diffArgs: string[]; applyArgs: string[]; range: HunkRange }
  | { kind: 'delete'; absPath: string }
  | { kind: 'reject'; error: string };

const HUNK_OPS = new Set<GitOp>(['stageHunk', 'unstageHunk', 'discardHunk']);

const PER_FILE_OPS = new Set<GitOp>(['stageFile', 'unstageFile', 'discardTracked']);

/** Ops that take no path and are inherently scoped to the repo by `cwd`. */
const BULK_OPS = new Set<GitOp>(['stageAll', 'unstageAll', 'stashPush', 'stashPop']);

/** Normalize a path to a repo-relative, forward-slash pathspec. */
function toRelPathspec(target: string, root: string): string {
  const abs = path.isAbsolute(target) ? target : path.resolve(root, target);
  // git always wants '/'. Replace '\' on ANY host: path.sep is '/' on posix, so
  // split(path.sep).join('/') silently left win32-style backslashes intact there
  // (the bug that turned CI red on the Linux runner).
  return path.relative(root, abs).replace(/\\/g, '/');
}

/**
 * Build the git ARG ARRAY for an op. `relPath` is the already-validated,
 * repo-relative pathspec for per-file ops. Returns `null` for ops that are not git
 * commands (untracked discard is a filesystem delete) — callers must handle those
 * separately. Pure; no IO.
 */
export function buildGitArgs(op: GitOp, relPath?: string): string[] | null {
  switch (op) {
    case 'stageFile':
      return ['add', '--', relPath ?? ''];
    case 'unstageFile':
      // `git restore --staged` (git >= 2.23) unstages exactly this path without
      // touching unrelated staged entries.
      return ['restore', '--staged', '--', relPath ?? ''];
    case 'discardTracked':
      // Revert the worktree file to its index state (git >= 2.23).
      return ['restore', '--', relPath ?? ''];
    case 'stageAll':
      return ['add', '-A'];
    case 'unstageAll':
      // Legacy-compatible bulk unstage: mixed reset with no paths unstages all.
      return ['reset'];
    case 'stashPush':
      return ['stash', 'push'];
    case 'stashPop':
      return ['stash', 'pop'];
    case 'discardUntracked':
      // Not a git command — the executor deletes the file from disk.
      return null;
    default:
      return null;
  }
}

/**
 * The two git invocations a hunk op needs. The diff is pinned to a canonical shape because a
 * user's `diff.external`, `color.diff = always` or `diff.noPrefix` would otherwise produce
 * output `git apply -p1` cannot read. `git apply` gets NO path argument: it reads the patch
 * from stdin, and `-` would be taken as a filename.
 */
export function buildHunkPlan(
  op: HunkOp,
  relPath: string,
): { diffArgs: string[]; applyArgs: string[] } {
  return {
    diffArgs: [
      'diff',
      ...(op === 'unstageHunk' ? ['--cached'] : []),
      '--no-ext-diff',
      '--no-color',
      '--src-prefix=a/',
      '--dst-prefix=b/',
      '-U3',
      '--',
      relPath,
    ],
    applyArgs: [
      'apply',
      // stage/unstage rewrite the INDEX; discard reverts the WORKTREE to the index.
      ...(op === 'discardHunk' ? [] : ['--cached']),
      ...(op === 'stageHunk' ? [] : ['--reverse']),
      '--whitespace=nowarn',
    ],
  };
}

const emptyRange = (r: HunkRange | undefined): boolean =>
  !r || (r.new[1] < r.new[0] && r.old[1] < r.old[0]);

/**
 * Validate a request and produce a runnable plan. Enforces path containment for any
 * op that touches a specific path (git per-file ops and the untracked delete), so a
 * `..`/absolute escape is rejected before git or `fs.rm` ever runs.
 */
export function planGitAction(req: GitActionRequest): GitActionPlan {
  const { root, op, path: rawPath } = req;
  if (!root) return { kind: 'reject', error: 'No repository root.' };

  if (op === 'discardUntracked') {
    if (!rawPath) return { kind: 'reject', error: 'No file path provided.' };
    const abs = path.isAbsolute(rawPath) ? rawPath : path.resolve(root, rawPath);
    // Never allow the repo root itself (would target the whole tree).
    if (path.resolve(abs) === path.resolve(root)) {
      return { kind: 'reject', error: 'Refusing to delete the repository root.' };
    }
    if (!isInsideRoot(abs, root)) {
      return { kind: 'reject', error: `Refusing to act outside the repository: ${rawPath}` };
    }
    return { kind: 'delete', absPath: path.resolve(abs) };
  }

  if (HUNK_OPS.has(op)) {
    if (!rawPath) return { kind: 'reject', error: 'No file path provided.' };
    if (emptyRange(req.range)) return { kind: 'reject', error: 'No hunk range provided.' };
    const abs = path.isAbsolute(rawPath) ? rawPath : path.resolve(root, rawPath);
    if (!isInsideRoot(abs, root)) {
      return { kind: 'reject', error: `Refusing to act outside the repository: ${rawPath}` };
    }
    const hunkOp = op as HunkOp;
    return {
      kind: 'hunk',
      op: hunkOp,
      ...buildHunkPlan(hunkOp, toRelPathspec(rawPath, root)),
      // Non-null: emptyRange() already rejected the undefined case.
      range: req.range as HunkRange,
    };
  }

  if (PER_FILE_OPS.has(op)) {
    if (!rawPath) return { kind: 'reject', error: 'No file path provided.' };
    const abs = path.isAbsolute(rawPath) ? rawPath : path.resolve(root, rawPath);
    if (!isInsideRoot(abs, root)) {
      return { kind: 'reject', error: `Refusing to act outside the repository: ${rawPath}` };
    }
    const rel = toRelPathspec(rawPath, root);
    const args = buildGitArgs(op, rel);
    if (!args) return { kind: 'reject', error: `Unsupported op: ${op}` };
    return { kind: 'git', args };
  }

  if (BULK_OPS.has(op)) {
    const args = buildGitArgs(op);
    if (!args) return { kind: 'reject', error: `Unsupported op: ${op}` };
    return { kind: 'git', args };
  }

  return { kind: 'reject', error: `Unknown op: ${String(op)}` };
}

/** Run git with an arg array; reject with stderr/message on a non-zero exit. Routed through the
 *  shared runner. Actions are user-initiated mutations that may run hooks of arbitrary duration, so
 *  (unlike the read surfaces) they are intentionally NOT time-bounded. */
async function gitExec(plan: { args: string[]; stdin?: string }, cwd: string): Promise<void> {
  const r = await runGit(plan.args, {
    cwd,
    maxBuffer: 8 * 1024 * 1024,
    ...(plan.stdin === undefined ? {} : { stdin: plan.stdin }),
  });
  if (!r.ok) {
    throw new Error(
      r.stderr.trim() || (r.notFound ? 'git not found' : `git exited with code ${r.code}`),
    );
  }
}

/**
 * Read git's own diff for one path, keep the hunks the range touches, hand the result back to
 * git on stdin. Two invocations, atomic in the one that matters: `git apply` takes the whole
 * patch or none of it, which is what makes "the file moved under the diff" a clean failure
 * rather than a half-applied file (spec 2026-08-27-review-supercharge §2 Lane E, §4).
 */
async function runHunkPlan(
  plan: Extract<GitActionPlan, { kind: 'hunk' }>,
  root: string,
): Promise<GitActionResult> {
  const diff = await runGit(plan.diffArgs, {
    cwd: root,
    timeoutMs: GIT_TIMEOUT.diff,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (!diff.ok) {
    return {
      ok: false,
      error: 'apply-failed',
      message: diff.stderr.trim() || `git diff exited with code ${diff.code}`,
    };
  }
  const patch = selectHunks(diff.stdout, plan.range);
  if (!patch) return { ok: false, error: 'no-hunk' };
  try {
    await gitExec({ args: plan.applyArgs, stdin: patch }, root);
    return { ok: true };
  } catch (e: unknown) {
    return {
      ok: false,
      error: 'apply-failed',
      message: e instanceof Error ? e.message : String(e),
    };
  }
}

/**
 * Execute a validated git action against the real filesystem/git. This is the thin
 * executor: it plans (enforcing containment), then either runs git or deletes an
 * untracked file. Shared by the Electron IPC handler and the integration test so
 * both drive identical logic. Returns a typed ok/error — never throws.
 */
export async function executeGitAction(req: GitActionRequest): Promise<GitActionResult> {
  const plan = planGitAction(req);
  if (plan.kind === 'reject') return { ok: false, error: plan.error };
  try {
    if (plan.kind === 'hunk') return await runHunkPlan(plan, req.root);
    if (plan.kind === 'git') {
      await gitExec(plan, req.root);
      return { ok: true };
    }
    // plan.kind === 'delete' — untracked discard removes the file from disk.
    const stat = fs.statSync(plan.absPath);
    if (stat.isDirectory()) return { ok: false, error: 'Refusing to delete a directory.' };
    fs.rmSync(plan.absPath);
    return { ok: true };
  } catch (e: unknown) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
