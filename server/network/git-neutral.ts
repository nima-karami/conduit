import { GIT_TIMEOUT, runGit, withGitEnv } from '../../src/git-exec';

// B runs its git reads on a repo the session can write (CON-45 G1 re-review, findings 1 and 2).
// Every spawn is pinned to the dirs git-serve checked, so a `.git` file, a `commondir` or a
// `core.worktree` written later can't move it, and every config key that names a program git would
// run during status, numstat, log or show is overridden to nothing. The race between the check and
// the spawn stays open; see docs/plans/2026-11-16-remote-ssh-git.plan.md "Accepted residual".

/** The real dirs git-serve checked for one request. */
export interface PinnedRepo {
  gitDir: string;
  commonDir: string;
  top: string;
}

export type NeutralEnv =
  | { ok: true; env: Readonly<Record<string, string>> }
  | { ok: false; reason: string };

/** Program keys per driver section; a driver's name is the repo's choice, so each is found by listing. */
const DRIVER_PROGRAM_KEYS: Readonly<Record<string, readonly string[]>> = {
  filter: ['clean', 'smudge', 'process'],
  diff: ['textconv', 'command'],
};

/**
 * Repository extensions that change only how git reads its own files. Any other one (e.g.
 * `partialclone`, which fetches missing objects from a remote) may make a read reach out, so it is
 * refused rather than guessed at.
 */
const KNOWN_EXTENSIONS = new Set([
  'objectformat',
  'compatobjectformat',
  'refstorage',
  'worktreeconfig',
  'preciousobjects',
]);

/** Overrides that hold for every repo. `log.showSignature` is what starts `gpg.program`. */
const FIXED_OVERRIDES: readonly (readonly [string, string])[] = [
  ['core.fsmonitor', 'false'],
  ['core.hooksPath', '/dev/null'],
  ['log.showSignature', 'false'],
];

/** The env that pins a spawn to the checked dirs, before any config is known. */
export function pinnedEnv(repo: PinnedRepo): Record<string, string> {
  return {
    GIT_DIR: repo.gitDir,
    GIT_COMMON_DIR: repo.commonDir,
    GIT_WORK_TREE: repo.top,
    // A missing object must never be fetched from a promisor remote during a read.
    GIT_NO_LAZY_FETCH: '1',
    GIT_TERMINAL_PROMPT: '0',
  };
}

/** `git config --list -z`: `key\nvalue\0` per entry, or a bare `key\0` for a valueless one. */
export function parseConfigList(stdout: string): string[] {
  return stdout
    .split('\0')
    .filter((entry) => entry !== '')
    .map((entry) => {
      const nl = entry.indexOf('\n');
      return nl === -1 ? entry : entry.slice(0, nl);
    });
}

/** Section, subsection and variable of a listed key; git lowercases the section and variable. */
function splitKey(key: string): { section: string; sub: string | null; name: string } {
  const first = key.indexOf('.');
  const last = key.lastIndexOf('.');
  if (first === -1) return { section: key, sub: null, name: '' };
  return {
    section: key.slice(0, first),
    sub: first === last ? null : key.slice(first + 1, last),
    name: key.slice(last + 1),
  };
}

/** The env for one repo's reads, from the keys its effective config lists. */
export function neutralEnv(repo: PinnedRepo, keys: readonly string[]): NeutralEnv {
  const overrides: [string, string][] = FIXED_OVERRIDES.map(([k, v]) => [k, v]);
  const seen = new Set<string>();
  for (const key of keys) {
    const { section, sub, name } = splitKey(key);
    if (section === 'extensions' && !KNOWN_EXTENSIONS.has(name))
      return { ok: false, reason: `extension_${name}` };
    const programKeys = DRIVER_PROGRAM_KEYS[section];
    if (programKeys === undefined || sub === null) continue;
    const driver = `${section}.${sub}`;
    if (seen.has(driver)) continue;
    seen.add(driver);
    for (const k of programKeys) overrides.push([`${driver}.${k}`, '']);
    // A required filter with no program fails the read instead of passing the content through.
    if (section === 'filter') overrides.push([`${driver}.required`, 'false']);
  }
  const env: Record<string, string> = {
    ...pinnedEnv(repo),
    GIT_CONFIG_COUNT: String(overrides.length),
  };
  overrides.forEach(([k, v], i) => {
    env[`GIT_CONFIG_KEY_${i}`] = k;
    env[`GIT_CONFIG_VALUE_${i}`] = v;
  });
  return { ok: true, env };
}

/** Lists the repo's effective config (listing runs nothing) and builds the env for its reads. */
export async function readNeutralEnv(repo: PinnedRepo): Promise<NeutralEnv> {
  const listed = await withGitEnv(pinnedEnv(repo), () =>
    runGit(['config', '--list', '-z'], { cwd: repo.top, timeoutMs: GIT_TIMEOUT.metadata }),
  );
  if (!listed.ok) return { ok: false, reason: 'config_unreadable' };
  return neutralEnv(repo, parseConfigList(listed.stdout));
}
