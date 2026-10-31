// Argv checked against git 2.42.0.windows.2 (this machine). Every shape used —
// `rev-parse --symbolic-full-name <v>`, `rev-parse --verify --quiet <v>^{commit}`,
// `log -1 … --end-of-options <sha>` — works on git ≥ 2.24.
import { describe, expect, it } from 'vitest';
import {
  classifyRef,
  type GitCall,
  type GitRun,
  lookupCommit,
  MAX_REF_CHARS,
  repoRootOf,
} from '../../src/conduit-mcp/git-refs';
import { PRETTY_FORMAT } from '../../src/git-history';

const SHA = 'a'.repeat(40);
const PARENT = 'b'.repeat(40);

/** Answers by the argv joined with spaces; records every call. */
function fakeGit(table: Record<string, Partial<GitRun>>) {
  const calls: { cwd: string; args: string[] }[] = [];
  const git: GitCall = async (cwd, args) => {
    calls.push({ cwd, args });
    const hit = table[args.join(' ')];
    return { ok: hit?.ok ?? false, stdout: hit?.stdout ?? '', stderr: hit?.stderr ?? '' };
  };
  return { git, calls };
}

const symbolic = (v: string) => `rev-parse --symbolic-full-name ${v}`;
const verify = (v: string) => `rev-parse --verify --quiet ${v}^{commit}`;
const logArgs = (sha: string) =>
  `log -1 --parents --decorate=full --pretty=${PRETTY_FORMAT} --end-of-options ${sha}`;

/** One record exactly as `git log --pretty=PRETTY_FORMAT` frames it. */
function logRecord(): string {
  const fmt = PRETTY_FORMAT.replace(/^format:/, '');
  return `${fmt
    .replace('%H', SHA)
    .replace('%P', PARENT)
    .replace('%D', 'HEAD -> refs/heads/main, tag: refs/tags/v1')
    .replace('%an', 'Ann')
    .replace('%ae', 'ann@x')
    .replace('%at', '1700000000')
    .replace('%s', 'c1')
    .replace('%b', '')}\n`;
}

describe('git-refs input checks', () => {
  it('a leading "-" is bad_ref without running git', async () => {
    const { git, calls } = fakeGit({});
    const a = await classifyRef(git, '/r', '-x');
    expect(a).toMatchObject({ ok: false, error: { code: 'bad_ref' } });
    const b = await lookupCommit(git, '/r', '--output=/tmp/x');
    expect(b).toMatchObject({ ok: false, error: { code: 'bad_ref' } });
    expect(calls).toEqual([]);
  });

  it('length 0 or > 256 → invalid_args', async () => {
    const { git, calls } = fakeGit({});
    for (const v of ['', 'x'.repeat(MAX_REF_CHARS + 1)]) {
      expect(await classifyRef(git, '/r', v)).toMatchObject({
        ok: false,
        error: { code: 'invalid_args' },
      });
      expect(await lookupCommit(git, '/r', v)).toMatchObject({
        ok: false,
        error: { code: 'invalid_args' },
      });
    }
    expect(calls).toEqual([]);
  });

  it('a control character (NUL, newline, DEL) is bad_ref without running git', async () => {
    const { git, calls } = fakeGit({});
    for (const v of ['main\0', 'a\nb', 'x\x7f', '\x1fy']) {
      expect([v, await classifyRef(git, '/r', v)]).toMatchObject([
        v,
        { ok: false, error: { code: 'bad_ref' } },
      ]);
      expect([v, await lookupCommit(git, '/r', v)]).toMatchObject([
        v,
        { ok: false, error: { code: 'bad_ref' } },
      ]);
    }
    expect(calls).toEqual([]);
  });
});

describe('classifyRef', () => {
  const resolving = (v: string, full: string) =>
    fakeGit({
      [symbolic(v)]: { ok: true, stdout: `${full}\n` },
      [verify(v)]: { ok: true, stdout: `${SHA}\n` },
    });

  it('branch / remote / tag / sha classification', async () => {
    const cases: [string, string, unknown][] = [
      ['main', 'refs/heads/main', { kind: 'branch', ref: 'main' }],
      [
        'origin/main',
        'refs/remotes/origin/main',
        { kind: 'branch', ref: 'origin/main', remote: true },
      ],
      ['v1', 'refs/tags/v1', { kind: 'tag', ref: 'v1' }],
      ['abc1234', '', { kind: 'commit', sha: SHA }],
      ['HEAD', 'HEAD', { kind: 'commit', sha: SHA }],
    ];
    for (const [v, full, want] of cases) {
      const { git } = resolving(v, full);
      expect(await classifyRef(git, '/r', v)).toStrictEqual({ ok: true, value: want });
    }
  });

  it('rev-parse argv never carries --end-of-options; git log has it right before the sha', async () => {
    const { git, calls } = fakeGit({
      [symbolic('main')]: { ok: true, stdout: 'refs/heads/main\n' },
      [verify('main')]: { ok: true, stdout: `${SHA}\n` },
      [logArgs(SHA)]: { ok: true, stdout: logRecord() },
    });
    await classifyRef(git, '/r', 'main');
    await lookupCommit(git, '/r', 'main');
    const revParse = calls.filter((c) => c.args[0] === 'rev-parse');
    expect(revParse.length).toBe(3);
    for (const c of revParse) expect(c.args).not.toContain('--end-of-options');
    const log = calls.filter((c) => c.args[0] === 'log');
    expect(log).toHaveLength(1);
    expect(log[0].args.slice(-2)).toEqual(['--end-of-options', SHA]);
    for (const c of calls) expect(c.cwd).toBe('/r');
  });

  it("ambiguous → bad_ref with git's first stderr line, ≤ 200 chars", async () => {
    const long = `warning: refname 'x' is ambiguous.${'z'.repeat(300)}`;
    const { git } = fakeGit({
      [symbolic('x')]: { ok: true, stdout: 'refs/heads/x\n', stderr: `\n${long}\nmore\n` },
      [verify('x')]: { ok: true, stdout: `${SHA}\n` },
    });
    const r = await classifyRef(git, '/r', 'x');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('bad_ref');
    expect(r.error.message).toBe(long.slice(0, 200));
  });

  it("an unresolvable name → bad_ref with git's first stderr line", async () => {
    const { git } = fakeGit({
      [symbolic('nope')]: { ok: false, stderr: "fatal: ambiguous argument 'nope'\n" },
    });
    expect(await classifyRef(git, '/r', 'nope')).toMatchObject({
      ok: false,
      error: { code: 'bad_ref', message: "fatal: ambiguous argument 'nope'" },
    });
  });

  it('not a commit → bad_ref', async () => {
    const { git } = fakeGit({
      [symbolic('treetag')]: { ok: true, stdout: 'refs/tags/treetag\n' },
      [verify('treetag')]: { ok: false },
    });
    expect(await classifyRef(git, '/r', 'treetag')).toMatchObject({
      ok: false,
      error: { code: 'bad_ref', message: 'treetag is not a commit' },
    });
  });
});

describe('lookupCommit', () => {
  it('lookupCommit returns the parsed node', async () => {
    const { git } = fakeGit({
      [verify('v1')]: { ok: true, stdout: `${SHA}\n` },
      [logArgs(SHA)]: { ok: true, stdout: logRecord() },
    });
    expect(await lookupCommit(git, '/r', 'v1')).toStrictEqual({
      ok: true,
      value: {
        sha: SHA,
        parents: [PARENT],
        refs: [
          { kind: 'head', name: 'HEAD' },
          { kind: 'branch', name: 'main' },
          { kind: 'tag', name: 'v1' },
        ],
        author: 'Ann',
        email: 'ann@x',
        date: 1700000000,
        subject: 'c1',
      },
    });
  });

  it('bad_ref on an empty log or an unverifiable ref', async () => {
    const empty = fakeGit({
      [verify('v1')]: { ok: true, stdout: `${SHA}\n` },
      [logArgs(SHA)]: { ok: true, stdout: '' },
    });
    expect(await lookupCommit(empty.git, '/r', 'v1')).toMatchObject({
      ok: false,
      error: { code: 'bad_ref' },
    });
    const missing = fakeGit({});
    expect(await lookupCommit(missing.git, '/r', 'nope')).toMatchObject({
      ok: false,
      error: { code: 'bad_ref', message: 'nope is not a commit' },
    });
    expect(missing.calls).toHaveLength(1);
  });
});

describe('repoRootOf', () => {
  it('repoRootOf forward-slashes and maps failure to not_a_repo', async () => {
    const win = fakeGit({ 'rev-parse --show-toplevel': { ok: true, stdout: 'C:\\w\\repo\n' } });
    expect(await repoRootOf(win.git, '/w/repo/sub')).toStrictEqual({
      ok: true,
      value: 'C:/w/repo',
    });
    expect(win.calls).toEqual([{ cwd: '/w/repo/sub', args: ['rev-parse', '--show-toplevel'] }]);
    const posix = fakeGit({ 'rev-parse --show-toplevel': { ok: true, stdout: '/w/repo\n' } });
    expect(await repoRootOf(posix.git, '/w/repo')).toStrictEqual({ ok: true, value: '/w/repo' });
    for (const answer of [{ ok: false }, { ok: true, stdout: '\n' }]) {
      const g = fakeGit({ 'rev-parse --show-toplevel': answer });
      expect(await repoRootOf(g.git, '/x')).toMatchObject({
        ok: false,
        error: { code: 'not_a_repo', message: '/x is not in a git repository' },
      });
    }
  });
});
