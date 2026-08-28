import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { executeGitAction } from '../../src/git-actions';

/**
 * Host integration test for the real git-action executor. Creates a throwaway git
 * repo in the OS temp dir (NEVER the project repo), drives stage/unstage/discard/
 * stash against actual git + filesystem, and cleans up afterwards. Skips entirely
 * if git is unavailable. cwd is set explicitly on every executor call, so the real
 * project's git state is never touched.
 */

function hasGit(): boolean {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const GIT_AVAILABLE = hasGit();
const d = GIT_AVAILABLE ? describe : describe.skip;

/** Porcelain status as a map: path → 2-char XY code. */
function status(root: string): Map<string, string> {
  const out = execFileSync('git', ['status', '--porcelain'], { cwd: root }).toString();
  const m = new Map<string, string>();
  for (const line of out.split('\n')) {
    if (!line.trim()) continue;
    m.set(line.slice(3).trim(), line.slice(0, 2));
  }
  return m;
}

function gitInit(root: string): void {
  const run = (args: string[]) => execFileSync('git', args, { cwd: root, stdio: 'ignore' });
  run(['init']);
  run(['config', 'user.email', 'test@example.com']);
  run(['config', 'user.name', 'Test']);
  run(['config', 'commit.gpgsign', 'false']);
}

d('git-actions integration (real executor on a scratch repo)', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'conduit-git-it-'));
    gitInit(root);
    // Seed a committed baseline file so we have something to modify/restore.
    fs.writeFileSync(path.join(root, 'tracked.txt'), 'one\n');
    execFileSync('git', ['add', '-A'], { cwd: root, stdio: 'ignore' });
    execFileSync('git', ['commit', '-m', 'init'], { cwd: root, stdio: 'ignore' });
  });

  afterEach(() => {
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch {
      /* best-effort temp cleanup */
    }
  });

  it('stages a modified tracked file (status shows staged)', async () => {
    fs.writeFileSync(path.join(root, 'tracked.txt'), 'one\ntwo\n');
    expect(status(root).get('tracked.txt')).toBe(' M'); // unstaged
    const res = await executeGitAction({ root, op: 'stageFile', path: 'tracked.txt' });
    expect(res).toEqual({ ok: true });
    expect(status(root).get('tracked.txt')).toBe('M '); // staged
  });

  it('unstages a staged file', async () => {
    fs.writeFileSync(path.join(root, 'tracked.txt'), 'one\ntwo\n');
    await executeGitAction({ root, op: 'stageFile', path: 'tracked.txt' });
    expect(status(root).get('tracked.txt')).toBe('M ');
    const res = await executeGitAction({ root, op: 'unstageFile', path: 'tracked.txt' });
    expect(res).toEqual({ ok: true });
    expect(status(root).get('tracked.txt')).toBe(' M'); // back to unstaged
  });

  it('discards changes to a tracked file (worktree restored)', async () => {
    fs.writeFileSync(path.join(root, 'tracked.txt'), 'one\ntwo\n');
    const res = await executeGitAction({ root, op: 'discardTracked', path: 'tracked.txt' });
    expect(res).toEqual({ ok: true });
    // Normalize CRLF: git's core.autocrlf may rewrite EOLs on checkout (Windows).
    expect(fs.readFileSync(path.join(root, 'tracked.txt'), 'utf8').replace(/\r\n/g, '\n')).toBe(
      'one\n',
    );
    expect(status(root).has('tracked.txt')).toBe(false); // clean
  });

  it('discards an untracked file by deleting it from disk', async () => {
    const junk = path.join(root, 'junk.tmp');
    fs.writeFileSync(junk, 'scratch\n');
    expect(status(root).get('junk.tmp')).toBe('??');
    const res = await executeGitAction({ root, op: 'discardUntracked', path: 'junk.tmp' });
    expect(res).toEqual({ ok: true });
    expect(fs.existsSync(junk)).toBe(false);
    expect(status(root).has('junk.tmp')).toBe(false);
  });

  it('stages all, then unstages all', async () => {
    fs.writeFileSync(path.join(root, 'tracked.txt'), 'one\ntwo\n');
    fs.writeFileSync(path.join(root, 'new.txt'), 'fresh\n');
    expect((await executeGitAction({ root, op: 'stageAll' })).ok).toBe(true);
    const staged = status(root);
    expect(staged.get('tracked.txt')).toBe('M ');
    expect(staged.get('new.txt')).toBe('A ');
    expect((await executeGitAction({ root, op: 'unstageAll' })).ok).toBe(true);
    const unstaged = status(root);
    expect(unstaged.get('tracked.txt')).toBe(' M');
    expect(unstaged.get('new.txt')).toBe('??');
  });

  it('stash push hides changes, stash pop restores them', async () => {
    fs.writeFileSync(path.join(root, 'tracked.txt'), 'one\ntwo\n');
    expect((await executeGitAction({ root, op: 'stashPush' })).ok).toBe(true);
    expect(status(root).has('tracked.txt')).toBe(false); // clean after stash
    expect((await executeGitAction({ root, op: 'stashPop' })).ok).toBe(true);
    expect(status(root).get('tracked.txt')).toBe(' M'); // restored
  });

  it('rejects a path escaping the repo root', async () => {
    const res = await executeGitAction({ root, op: 'stageFile', path: '../escape.txt' });
    expect(res.ok).toBe(false);
  });

  it('rejects discarding the repo root as untracked', async () => {
    const res = await executeGitAction({ root, op: 'discardUntracked', path: '.' });
    expect(res.ok).toBe(false);
  });

  const read = (name: string) => fs.readFileSync(path.join(root, name), 'utf8');
  const cachedDiff = () =>
    execFileSync('git', ['diff', '--cached', '-U3'], { cwd: root, encoding: 'utf8' });

  /** 30 numbered lines, with the given 1-based lines replaced. */
  const numbered = (edits: Record<number, string>) =>
    `${Array.from({ length: 30 }, (_, i) => edits[i + 1] ?? `l${i + 1}`).join('\n')}\n`;

  /** A committed 30-line file with two separated edits in the worktree. */
  const seedTwoHunks = () => {
    fs.writeFileSync(path.join(root, 'two.txt'), numbered({}));
    execFileSync('git', ['add', '-A'], { cwd: root, stdio: 'ignore' });
    execFileSync('git', ['commit', '-m', 'two'], { cwd: root, stdio: 'ignore' });
    fs.writeFileSync(path.join(root, 'two.txt'), numbered({ 3: 'HUNK-A', 25: 'HUNK-B' }));
  };

  it('stages ONE of two hunks — git diff --cached holds exactly it', async () => {
    seedTwoHunks();
    const res = await executeGitAction({
      root,
      op: 'stageHunk',
      path: 'two.txt',
      range: { new: [25, 25], old: [25, 25] },
    });
    expect(res).toEqual({ ok: true });
    const staged = cachedDiff();
    expect(staged).toContain('HUNK-B');
    expect(staged).not.toContain('HUNK-A');
    // Staging moved nothing on disk — the worktree still carries both.
    expect(read('two.txt')).toContain('HUNK-A');
    expect(read('two.txt')).toContain('HUNK-B');
  });

  it('unstages one hunk back out of the index', async () => {
    seedTwoHunks();
    execFileSync('git', ['add', 'two.txt'], { cwd: root, stdio: 'ignore' });
    expect(cachedDiff()).toContain('HUNK-A');
    const res = await executeGitAction({
      root,
      op: 'unstageHunk',
      path: 'two.txt',
      range: { new: [3, 3], old: [3, 3] },
    });
    expect(res).toEqual({ ok: true });
    const staged = cachedDiff();
    expect(staged).not.toContain('HUNK-A');
    expect(staged).toContain('HUNK-B');
  });

  it('discards one hunk — the worktree returns to the index there and keeps the rest', async () => {
    seedTwoHunks();
    const res = await executeGitAction({
      root,
      op: 'discardHunk',
      path: 'two.txt',
      range: { new: [3, 3], old: [3, 3] },
    });
    expect(res).toEqual({ ok: true });
    expect(read('two.txt')).not.toContain('HUNK-A');
    expect(read('two.txt')).toContain('l3');
    expect(read('two.txt')).toContain('HUNK-B');
  });

  it('reports no-hunk when the range matches nothing, and stages nothing', async () => {
    seedTwoHunks();
    const res = await executeGitAction({
      root,
      op: 'stageHunk',
      path: 'two.txt',
      range: { new: [900, 910], old: [900, 910] },
    });
    expect(res).toEqual({ ok: false, error: 'no-hunk' });
    expect(cachedDiff()).toBe('');
  });

  it('changes nothing when the file moved under the range', async () => {
    seedTwoHunks();
    // The diff the renderer is holding describes a file that no longer exists on disk.
    fs.writeFileSync(path.join(root, 'two.txt'), 'entirely different content\n');
    const res = await executeGitAction({
      root,
      op: 'stageHunk',
      path: 'two.txt',
      range: { new: [3, 3], old: [3, 3] },
    });
    expect(res.ok).toBe(false);
    expect(cachedDiff()).toBe('');
    expect(read('two.txt')).toBe('entirely different content\n');
  });

  it('refuses a hunk op whose path escapes the root', async () => {
    const res = await executeGitAction({
      root,
      op: 'stageHunk',
      path: '../escape.txt',
      range: { new: [1, 1], old: [1, 1] },
    });
    expect(res.ok).toBe(false);
    expect(cachedDiff()).toBe('');
  });
});
