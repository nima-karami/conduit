// Host-only ref work for the app-control tools (spec 2026-10-30-conduit-mcp-app-control §2.2).
// Git is injected, as in src/range-preset.ts, so electron/main.ts stays the only place that spawns
// and the argv is testable on CI's ubuntu.
import { PRETTY_FORMAT, parseCommits } from '../git-history';
import type { RefEndpoint } from '../git-range';
import type { CommitNode } from '../protocol';
import { type Result, toolError } from './types';

export interface GitRun {
  ok: boolean;
  stdout: string;
  stderr: string;
}
export type GitCall = (cwd: string, args: string[]) => Promise<GitRun>;
export const MAX_REF_CHARS = 256;

const MAX_GIT_MESSAGE_CHARS = 200;

const badRef = (message: string): Result<never> => ({
  ok: false,
  error: toolError('bad_ref', message),
});

const firstLine = (s: string): string =>
  s
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l.length > 0) ?? '';

/** A leading '-' never reaches git: rev-parse has no --end-of-options on older git (plan r1). */
function checkValue(value: string): Result<never> | null {
  if (value.length === 0 || value.length > MAX_REF_CHARS)
    return {
      ok: false,
      error: toolError('invalid_args', `a ref must be 1–${MAX_REF_CHARS} characters`),
    };
  if (value.startsWith('-')) return badRef('a ref may not start with "-"');
  return null;
}

/** Every classified ref must also name a commit: a tag on a tree is bad_ref (plan B7). */
async function commitSha(git: GitCall, repoRoot: string, value: string): Promise<Result<string>> {
  const r = await git(repoRoot, ['rev-parse', '--verify', '--quiet', `${value}^{commit}`]);
  const sha = firstLine(r.stdout);
  if (!r.ok || !sha) return badRef(`${value} is not a commit`);
  return { ok: true, value: sha };
}

/** Range endpoint (spec §2.2). Never called with the literal 'working'. */
export async function classifyRef(
  git: GitCall,
  repoRoot: string,
  value: string,
): Promise<Result<RefEndpoint>> {
  const invalid = checkValue(value);
  if (invalid) return invalid;
  const named = await git(repoRoot, ['rev-parse', '--symbolic-full-name', value]);
  // rev-parse succeeds on an ambiguous name and only warns, so stderr is the signal.
  if (!named.ok || /ambiguous/i.test(named.stderr))
    return badRef(
      (firstLine(named.stderr) || `${value} could not be resolved`).slice(0, MAX_GIT_MESSAGE_CHARS),
    );
  const sha = await commitSha(git, repoRoot, value);
  if (!sha.ok) return sha;
  const full = firstLine(named.stdout);
  if (full.startsWith('refs/heads/'))
    return { ok: true, value: { kind: 'branch', ref: full.slice('refs/heads/'.length) } };
  if (full.startsWith('refs/remotes/'))
    return {
      ok: true,
      value: { kind: 'branch', ref: full.slice('refs/remotes/'.length), remote: true },
    };
  if (full.startsWith('refs/tags/'))
    return { ok: true, value: { kind: 'tag', ref: full.slice('refs/tags/'.length) } };
  return { ok: true, value: { kind: 'commit', sha: sha.value } };
}

/** One commit with parents and full decorations (`git log -1`), at any depth. */
export async function lookupCommit(
  git: GitCall,
  repoRoot: string,
  value: string,
): Promise<Result<CommitNode>> {
  const invalid = checkValue(value);
  if (invalid) return invalid;
  const sha = await commitSha(git, repoRoot, value);
  if (!sha.ok) return sha;
  const r = await git(repoRoot, [
    'log',
    '-1',
    '--parents',
    '--decorate=full',
    `--pretty=${PRETTY_FORMAT}`,
    '--end-of-options',
    sha.value,
  ]);
  const node = r.ok ? parseCommits(r.stdout)[0] : undefined;
  if (!node) return badRef(`${value} is not a commit`);
  return { ok: true, value: node };
}

/** `rev-parse --show-toplevel` of `folder`, forward-slashed; not_a_repo on failure. */
export async function repoRootOf(git: GitCall, folder: string): Promise<Result<string>> {
  const r = await git(folder, ['rev-parse', '--show-toplevel']);
  const root = firstLine(r.stdout);
  if (!r.ok || !root)
    return { ok: false, error: toolError('not_a_repo', `${folder} is not in a git repository`) };
  return { ok: true, value: root.replace(/\\/g, '/') };
}
