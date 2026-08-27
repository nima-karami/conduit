import * as path from 'node:path';
import { MAX_BYTES, toLf } from './file-service';
import type { HeadBlobReason } from './protocol';
import { repoRelPath } from './repo-rel';

/** One `git show HEAD:<rel>` outcome, narrowed to what the classification below needs. */
export interface HeadBlobShow {
  ok: boolean;
  /** Raw stdout bytes; empty unless ok. */
  bytes: Buffer;
  /** Process exit code; null when killed. */
  code: number | null;
  /** git could not be run, timed out, was aborted, or overflowed maxBuffer — a real failure
   *  rather than "HEAD has no such blob". */
  failed: boolean;
}

/**
 * Git primitives, injected. This module spawns nothing: `electron/main.ts` stays the single
 * owner of the `git show HEAD:<rel>` path that readDiff already uses (spec §3), and the
 * rev-parse lookups it supplies are memoised there.
 */
export interface HeadBlobDeps {
  /** Repo top level for a directory; '' when the directory is not in a repo. */
  repoRoot(dir: string): Promise<string>;
  /** Current HEAD sha for a repo root; null on an unborn HEAD. */
  headSha(root: string): Promise<string | null>;
  showBlob(root: string, rel: string): Promise<HeadBlobShow>;
}

export interface HeadBlobResult {
  headSha: string | null;
  text: string | null;
  reason?: HeadBlobReason;
}

/** git's exit code when a path resolves but HEAD holds no blob for it. */
const NO_SUCH_BLOB = 128;

export async function readHeadBlob(absPath: string, deps: HeadBlobDeps): Promise<HeadBlobResult> {
  const root = await deps.repoRoot(path.dirname(absPath));
  if (!root) return { headSha: null, text: null, reason: 'notRepo' };

  const rel = repoRelPath(root, absPath);
  if (rel === null) return { headSha: null, text: null, reason: 'notRepo' };

  const headSha = await deps.headSha(root);
  // An unborn HEAD has no blob for anything, so every file in the repo is new.
  if (headSha === null) return { headSha: null, text: null, reason: 'untracked' };

  const show = await deps.showBlob(root, rel);
  if (show.failed) return { headSha, text: null, reason: 'error' };
  if (!show.ok) {
    // Exit 128 IS the tracked check — spawning `ls-files --error-unmatch` for it would double
    // the per-file cost the memo above exists to avoid.
    return { headSha, text: null, reason: show.code === NO_SUCH_BLOB ? 'untracked' : 'error' };
  }
  if (show.bytes.length > MAX_BYTES) return { headSha, text: null, reason: 'oversize' };
  if (show.bytes.includes(0)) return { headSha, text: null, reason: 'binary' };
  return { headSha, text: toLf(show.bytes.toString('utf8')) };
}
