// The `git show` blob path and its memoised rev-parse lookups. Electron-free, so the host and the
// remote server share one implementation. See docs/plans/2026-11-16-remote-ssh-git.plan.md §decision 2.
import * as path from 'node:path';
import { UNMERGED, type Unmerged } from './file-service';
import { GIT_TIMEOUT, runGit } from './git-exec';
import { resolveLfsImage } from './git-lfs';
import { createAsyncMemo } from './git-memo';
import type { HeadBlobShow } from './head-blob';
import type { DiffBase } from './protocol';
import { repoRelPath } from './repo-rel';

/** Text blobs keep readDiff's original ceiling; only the image side, which reads raw bytes,
 *  needs the larger one. One show path, two caps — never one loosened cap for both. */
const TEXT_BLOB_MAX_BUFFER = 8 * 1024 * 1024;
const IMAGE_BLOB_MAX_BUFFER = 32 * 1024 * 1024;

export interface GitShow {
  /** Repo top level for a directory; '' when it is not in a repo. */
  repoTopLevel(dir: string): Promise<string>;
  /** HEAD sha for a repo root; null on an unborn HEAD. */
  headShaFor(root: string): Promise<string | null>;
  gitShow(absPath: string, ref?: DiffBase): Promise<string | Unmerged>;
  gitShowBuffer(absPath: string, ref?: DiffBase): Promise<Buffer | null | Unmerged>;
  /** The same reads, in a repo whose top level the caller has already chosen (never recomputed). */
  gitShowIn(root: string, absPath: string, ref?: DiffBase): Promise<string | Unmerged>;
  gitShowBufferIn(root: string, absPath: string, ref?: DiffBase): Promise<Buffer | null | Unmerged>;
}

/**
 * THE `git show` blob path for this process — readDiff's text and image sides (at either
 * baseline) and the editor's change decorations all come through here, so there is one cap,
 * one timeout and one set of outcome flags rather than a second implementation per caller.
 */
export async function gitShowBlob(
  root: string,
  rel: string,
  ref: DiffBase,
  maxBuffer = TEXT_BLOB_MAX_BUFFER,
): Promise<HeadBlobShow> {
  const res = await runGit(['show', ref === 'index' ? `:${rel}` : `HEAD:${rel}`], {
    cwd: root,
    timeoutMs: GIT_TIMEOUT.diff,
    maxBuffer,
  });
  return {
    ok: res.ok,
    bytes: res.stdoutBuffer,
    code: res.code,
    failed: res.notFound || res.timedOut || res.aborted || res.truncated,
  };
}

/**
 * Is this path unmerged (a conflict, so no stage-0 blob)? Spawned ONLY after an index read
 * already failed: a failed `git show :<rel>` is equally a staged deletion or an untracked
 * file, and only those cases pay for the extra call.
 */
async function indexUnmerged(root: string, rel: string): Promise<boolean> {
  const res = await runGit(['--literal-pathspecs', 'ls-files', '--unmerged', '--', rel], {
    cwd: root,
    timeoutMs: GIT_TIMEOUT.metadata,
  });
  return res.ok && res.stdout.trim() !== '';
}

/**
 * The memos are per instance, so one process builds one `createGitShow()` and shares it: one
 * fsChanged wakes every open editor, and N editors must share one toplevel and one HEAD lookup.
 * See spec 2026-08-27-review-supercharge §2 Lane A ("N shows, not 2N spawns").
 */
export function createGitShow(): GitShow {
  // The toplevel of a directory is effectively immutable for a session; HEAD is not, hence the
  // much shorter TTL — long enough to collapse one burst.
  const repoRootMemo = createAsyncMemo<string>({ ttlMs: 30_000, max: 200 });
  // Cache KEY only: with a 1 s TTL this can lag the blob's real HEAD by a commit, which costs
  // one stale cache hit that the next fsChanged corrects — never a wrong baseline, because the
  // blob itself is always read fresh.
  const headShaMemo = createAsyncMemo<string | null>({ ttlMs: 1_000, max: 50 });

  const repoTopLevel = (dir: string): Promise<string> =>
    repoRootMemo.get(dir, async () => {
      const r = await runGit(['rev-parse', '--show-toplevel'], {
        cwd: dir,
        timeoutMs: GIT_TIMEOUT.metadata,
      });
      return r.ok ? r.stdout.trim() : '';
    });

  const headShaFor = (root: string): Promise<string | null> =>
    headShaMemo.get(root, async () => {
      const r = await runGit(['rev-parse', 'HEAD'], { cwd: root, timeoutMs: GIT_TIMEOUT.metadata });
      return r.ok ? r.stdout.trim() || null : null;
    });

  /** The text blob of `absPath` in the repo whose top level is `root`, which the caller checked. */
  const gitShowIn = async (
    root: string,
    absPath: string,
    ref: DiffBase = 'head',
  ): Promise<string | Unmerged> => {
    const rel = repoRelPath(root, absPath);
    if (!rel) return '';
    const res = await gitShowBlob(root, rel, ref);
    if (res.ok) return res.bytes.toString('utf8');
    return ref === 'index' && (await indexUnmerged(root, rel)) ? UNMERGED : '';
  };

  /**
   * Binary-safe blob read in the repo whose top level is `root`. Resolves `null` when the ref has
   * no blob for the path (new/untracked file) or the read fails — the caller treats that as "added".
   */
  const gitShowBufferIn = async (
    root: string,
    absPath: string,
    ref: DiffBase = 'head',
  ): Promise<Buffer | null | Unmerged> => {
    const rel = repoRelPath(root, absPath);
    if (!rel) return null;
    const res = await gitShowBlob(root, rel, ref, IMAGE_BLOB_MAX_BUFFER);
    if (res.ok) {
      return resolveLfsImage(res.bytes, {
        gitBin: 'git',
        cwd: root,
        timeoutMs: GIT_TIMEOUT.metadata,
        maxBytes: IMAGE_BLOB_MAX_BUFFER,
      });
    }
    return ref === 'index' && (await indexUnmerged(root, rel)) ? UNMERGED : null;
  };

  const gitShow = async (absPath: string, ref: DiffBase = 'head'): Promise<string | Unmerged> => {
    const root = await repoTopLevel(path.dirname(absPath));
    return root ? gitShowIn(root, absPath, ref) : '';
  };

  const gitShowBuffer = async (
    absPath: string,
    ref: DiffBase = 'head',
  ): Promise<Buffer | null | Unmerged> => {
    const root = await repoTopLevel(path.dirname(absPath));
    return root ? gitShowBufferIn(root, absPath, ref) : null;
  };

  return { repoTopLevel, headShaFor, gitShow, gitShowBuffer, gitShowIn, gitShowBufferIn };
}
