import { GIT_TIMEOUT, runGit } from './git-exec';
import { isAuthoritative } from './ignore-cache';

export type GitListing =
  | { kind: 'listed'; rels: string[] }
  /** git answered: `root` is in no repo. */
  | { kind: 'not-repo' }
  /** The listing outgrew the buffer: unlike `failed`, asking again gives the same answer. */
  | { kind: 'truncated' }
  /** git never answered (timeout, missing binary, vanished cwd): nothing is known. */
  | { kind: 'failed' };

/** Bounded because the whole listing is buffered in the main process: ~400k typical paths. */
const LISTING_MAX_BUFFER = 32 * 1024 * 1024;

/** Every path git would list for `root`: tracked plus untracked-but-not-ignored, minus tracked
 *  files deleted from the worktree but not staged. `-z` because without it git C-quotes any
 *  non-ASCII name, and the quoted form names no file. `-t` tags each record, so the deleted ones
 *  (`R`, which `--cached` lists as well) come out of the same spawn. */
export async function gitListedFiles(
  root: string,
  maxBuffer = LISTING_MAX_BUFFER,
): Promise<GitListing> {
  const r = await runGit(
    ['ls-files', '-z', '-t', '--cached', '--deleted', '--others', '--exclude-standard'],
    { cwd: root, timeoutMs: GIT_TIMEOUT.diff, maxBuffer },
  );
  if (r.ok) return { kind: 'listed', rels: parseTaggedListing(r.stdout) };
  if (r.truncated) return { kind: 'truncated' };
  const answered = r.code === 128 && !r.timedOut && !r.cwdMissing;
  return answered ? { kind: 'not-repo' } : { kind: 'failed' };
}

/** `ls-files -z -t` records ("<tag> <path>") to paths, each once, leaving out the `R` (deleted)
 *  ones. An unmerged path has a record per stage, hence the dedupe. */
export function parseTaggedListing(stdout: string): string[] {
  const deleted = new Set<string>();
  const listed = new Set<string>();
  for (const rec of stdout.split('\0')) {
    if (rec.length < 3) continue;
    const rel = rec.slice(2);
    if (rec[0] === 'R') deleted.add(rel);
    else listed.add(rel);
  }
  return [...listed].filter((rel) => !deleted.has(rel));
}

/**
 * Of `names` (a directory's children), the subset git ignores — via `git check-ignore`
 * with the names piped on stdin (cwd = the dir). check-ignore echoes each matched path
 * exactly as fed in, so the output fields are the child names to mark; `-z` both ways keeps a
 * non-ASCII name from being C-quoted on the way back.
 *
 * Returns `null` when git did NOT answer (timeout, missing binary, crash). An empty Set
 * means "nothing here is ignored" and is only returned when git actually said so — exit 0,
 * exit 1 (nothing matched) or exit 128 (not a repo). Conflating the two is what made the
 * Explorer flicker: a timed-out call also leaves stdout empty, so every entry in the
 * directory briefly lost its dimming. See src/ignore-cache.ts.
 */
export async function gitIgnoredNames(dir: string, names: string[]): Promise<Set<string> | null> {
  if (names.length === 0) return new Set();
  const r = await runGit(['check-ignore', '-z', '--stdin'], {
    cwd: dir,
    timeoutMs: GIT_TIMEOUT.metadata,
    maxBuffer: 4 * 1024 * 1024,
    stdin: `${names.join('\0')}\0`,
  });
  if (!isAuthoritative(r)) return null;
  return new Set(r.stdout.split('\0').filter(Boolean));
}
