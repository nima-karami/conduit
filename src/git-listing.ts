import { GIT_TIMEOUT, runGit } from './git-exec';
import { isAuthoritative } from './ignore-cache';

/** Every path git would list for `root` — tracked plus untracked-but-not-ignored — or [] when
 *  git gave nothing (not a repo, or a failure). `-z` because without it git C-quotes any
 *  non-ASCII name, and the quoted form names no file. */
export async function gitListedFiles(root: string): Promise<string[]> {
  const r = await runGit(['ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
    cwd: root,
    timeoutMs: GIT_TIMEOUT.diff,
    maxBuffer: 8 * 1024 * 1024,
  });
  return r.stdout.split('\0').filter(Boolean);
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
