import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
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

export type GitOp =
  | 'stageFile'
  | 'unstageFile'
  | 'discardTracked'
  | 'discardUntracked'
  | 'stageAll'
  | 'unstageAll'
  | 'stashPush'
  | 'stashPop';

export interface GitActionRequest {
  root: string;
  op: GitOp;
  /** Repo-relative or absolute path; required for per-file ops, ignored for bulk ops. */
  path?: string;
}

export type GitActionResult = { ok: true } | { ok: false; error: string };

/** A validated plan the executor can run without further checks. */
export type GitActionPlan =
  | { kind: 'git'; args: string[] }
  | { kind: 'delete'; absPath: string }
  | { kind: 'reject'; error: string };

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

/** Run git with an arg array; reject with stderr/message on a non-zero exit. */
function gitExec(args: string[], cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      args,
      { cwd, windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
      (err, _stdout, stderr) => {
        if (err) reject(new Error(stderr?.toString().trim() || err.message));
        else resolve();
      },
    );
  });
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
    if (plan.kind === 'git') {
      await gitExec(plan.args, req.root);
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
