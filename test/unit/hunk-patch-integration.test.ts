import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { hunkRange, selectHunks } from '../../src/hunk-patch';
import { computeFileReview } from '../../src/review-hunks';

/**
 * The real contract for src/hunk-patch.ts: whatever it emits, `git apply` must take. Everything
 * here runs against a throwaway repo in the OS temp dir — never the project repo.
 */

function hasGit(): boolean {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const d = hasGit() ? describe : describe.skip;

d('hunk-patch against real git', () => {
  let root: string;

  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });

  /** git's own index→worktree diff for one path, canonicalised the way the host asks for it. */
  const diffFor = (rel: string, cached = false) =>
    git(
      'diff',
      ...(cached ? ['--cached'] : []),
      '--no-ext-diff',
      '--no-color',
      '--src-prefix=a/',
      '--dst-prefix=b/',
      '-U3',
      '--',
      rel,
    );

  /** Apply a patch for real; throws on rejection. */
  const applyPatch = (patch: string, extra: string[] = []) =>
    execFileSync('git', ['apply', ...extra, '--whitespace=nowarn'], {
      cwd: root,
      input: patch,
      encoding: 'utf8',
    });

  /** Bytes of a worktree file, EOLs and the final newline intact. */
  const bytes = (name: string) => fs.readFileSync(path.join(root, name), 'utf8');

  /** Feed a patch to `git apply <extra> --check`; returns null on success, stderr on rejection. */
  const applyCheck = (patch: string, extra: string[] = []): string | null => {
    try {
      execFileSync('git', ['apply', ...extra, '--whitespace=nowarn', '--check'], {
        cwd: root,
        input: patch,
        encoding: 'utf8',
      });
      return null;
    } catch (e) {
      return String((e as { stderr?: string }).stderr ?? e);
    }
  };

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'conduit-hunkpatch-'));
    const run = (args: string[]) => execFileSync('git', args, { cwd: root, stdio: 'ignore' });
    run(['init']);
    run(['config', 'user.email', 'test@example.com']);
    run(['config', 'user.name', 'Test']);
    run(['config', 'commit.gpgsign', 'false']);
    run(['config', 'core.autocrlf', 'false']);
  });

  afterEach(() => {
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch {
      /* best-effort temp cleanup */
    }
  });

  const commit = (files: Record<string, string>) => {
    for (const [name, content] of Object.entries(files))
      fs.writeFileSync(path.join(root, name), content);
    execFileSync('git', ['add', '-A'], { cwd: root, stdio: 'ignore' });
    execFileSync('git', ['commit', '-m', 'seed'], { cwd: root, stdio: 'ignore' });
  };

  const numbered = (n: number, f: (i: number) => string, eol = '\n') =>
    Array.from({ length: n }, (_, i) => f(i + 1)).join(eol) + eol;

  it('selects exactly one of two hunks and git accepts it for the index', () => {
    commit({ 'two.txt': numbered(30, (i) => `l${i}`) });
    const before = numbered(30, (i) => `l${i}`).split('\n');
    before[2] = 'CHANGED-A'; // new line 3
    before[24] = 'CHANGED-B'; // new line 25
    fs.writeFileSync(path.join(root, 'two.txt'), before.join('\n'));

    const raw = diffFor('two.txt');
    expect(raw.match(/^@@ /gm)).toHaveLength(2);

    const patch = selectHunks(raw, { new: [25, 25], old: [25, 25] });
    expect(patch.match(/^@@ /gm)).toHaveLength(1);
    expect(patch).toContain('CHANGED-B');
    expect(patch).not.toContain('CHANGED-A');
    expect(applyCheck(patch, ['--cached'])).toBeNull();
  });

  it('accepts a range derived from computeFileReview via hunkRange', () => {
    const head = numbered(20, (i) => `l${i}`);
    commit({ 'derived.txt': head });
    const work = head.replace('l7\n', 'SEVEN\n');
    fs.writeFileSync(path.join(root, 'derived.txt'), work);

    const review = computeFileReview(head, work);
    const patch = selectHunks(diffFor('derived.txt'), hunkRange(review.hunks[0]));
    expect(patch).toContain('SEVEN');
    expect(applyCheck(patch, ['--cached'])).toBeNull();
  });

  it('round-trips a CRLF file for both the index and a reverse worktree apply', () => {
    const head = numbered(12, (i) => `c${i}`, '\r\n');
    commit({ 'crlf.txt': head });
    fs.writeFileSync(path.join(root, 'crlf.txt'), head.replace('c6\r\n', 'CRLF-CHANGED\r\n'));

    const patch = selectHunks(diffFor('crlf.txt'), { new: [6, 6], old: [6, 6] });
    expect(patch).toContain('+CRLF-CHANGED\r\n');
    expect(applyCheck(patch, ['--cached'])).toBeNull();
    expect(applyCheck(patch, ['--reverse'])).toBeNull();
  });

  it('round-trips a file with no newline at EOF', () => {
    commit({ 'noeof.txt': 'alpha\nbeta\ngamma' });
    fs.writeFileSync(path.join(root, 'noeof.txt'), 'alpha\nbeta\nGAMMA');

    const raw = diffFor('noeof.txt');
    expect(raw).toContain('\\ No newline at end of file');
    const patch = selectHunks(raw, { new: [3, 3], old: [3, 3] });
    expect(patch).toContain('\\ No newline at end of file');
    expect(applyCheck(patch, ['--cached'])).toBeNull();
    expect(applyCheck(patch, ['--reverse'])).toBeNull();
  });

  it('selects a pure deletion by its old-side span', () => {
    commit({ 'del.txt': numbered(15, (i) => `d${i}`) });
    const kept = numbered(15, (i) => `d${i}`)
      .split('\n')
      .filter((l) => l !== 'd8' && l !== 'd9')
      .join('\n');
    fs.writeFileSync(path.join(root, 'del.txt'), kept);

    // Deletion of old 8-9; nothing on the new side, so the empty span sits at new line 8.
    const patch = selectHunks(diffFor('del.txt'), { new: [8, 7], old: [8, 9] });
    expect(patch).toContain('-d8');
    expect(patch).toContain('-d9');
    expect(applyCheck(patch, ['--cached'])).toBeNull();
  });

  it('a patch built before the tree moved is REJECTED, not half-applied', () => {
    commit({ 'race.txt': numbered(20, (i) => `r${i}`) });
    fs.writeFileSync(
      path.join(root, 'race.txt'),
      numbered(20, (i) => `r${i}`).replace('r10', 'TEN'),
    );
    const patch = selectHunks(diffFor('race.txt'), { new: [10, 10], old: [10, 10] });

    // Each apply target has to move for ITS check to fail: a plain apply reads the worktree,
    // `--cached` reads the index. Rewriting only the worktree leaves a --cached apply valid.
    fs.writeFileSync(path.join(root, 'race.txt'), 'totally different content\n');
    expect(applyCheck(patch, ['--reverse'])).not.toBeNull();

    execFileSync('git', ['add', 'race.txt'], { cwd: root, stdio: 'ignore' });
    expect(applyCheck(patch, ['--cached'])).not.toBeNull();
  });

  // ---- Post-state proof. `git apply --check` says a patch is well formed; only reading the
  // resulting bytes back proves the CONTENT survived. These run on the CI box too, which is
  // where it matters: the e2e that used to be the only post-state check is win32-only.

  it('applies an LF selection to the worktree and leaves the rest of the file alone', () => {
    const head = numbered(20, (i) => `l${i}`);
    commit({ 'lf.txt': head });
    const dirty = head.replace('l5\n', 'FIVE\n').replace('l17\n', 'SEVENTEEN\n');
    fs.writeFileSync(path.join(root, 'lf.txt'), dirty);

    const patch = selectHunks(diffFor('lf.txt'), { new: [5, 5], old: [5, 5] });
    applyPatch(patch, ['--reverse']);

    // Exactly the one hunk came back; the other edit and every EOL are untouched.
    expect(bytes('lf.txt')).toBe(head.replace('l17\n', 'SEVENTEEN\n'));
  });

  it('applies a CRLF selection without rewriting a single line ending', () => {
    const head = numbered(12, (i) => `c${i}`, '\r\n');
    commit({ 'crlf.txt': head });
    fs.writeFileSync(path.join(root, 'crlf.txt'), head.replace('c6\r\n', 'CRLF-CHANGED\r\n'));

    const patch = selectHunks(diffFor('crlf.txt'), { new: [6, 6], old: [6, 6] });
    applyPatch(patch, ['--reverse']);

    const after = bytes('crlf.txt');
    expect(after).toBe(head);
    // Belt and braces: not one lone LF crept in.
    expect(after).not.toMatch(/[^\r]\n/);
  });

  it('applies a no-EOF-newline selection and does NOT add a trailing newline', () => {
    commit({ 'noeof.txt': 'alpha\nbeta\ngamma' });
    fs.writeFileSync(path.join(root, 'noeof.txt'), 'alpha\nbeta\nGAMMA');

    const patch = selectHunks(diffFor('noeof.txt'), { new: [3, 3], old: [3, 3] });
    applyPatch(patch, ['--reverse']);

    const after = bytes('noeof.txt');
    expect(after).toBe('alpha\nbeta\ngamma');
    expect(after.endsWith('\n')).toBe(false);
  });

  it('stages an insertion at EOF', () => {
    const head = numbered(8, (i) => `e${i}`);
    commit({ 'eof.txt': head });
    fs.writeFileSync(path.join(root, 'eof.txt'), `${head}APPENDED\n`);

    // Nothing on the old side: the empty span sits just past the last old line.
    const patch = selectHunks(diffFor('eof.txt'), { new: [9, 9], old: [9, 8] });
    expect(patch).toContain('+APPENDED');
    applyPatch(patch, ['--cached']);
    expect(git('diff', '--cached', '-U3')).toContain('+APPENDED');
  });

  it('stages a deletion at the very start of the file', () => {
    const head = numbered(8, (i) => `b${i}`);
    commit({ 'bof.txt': head });
    fs.writeFileSync(
      path.join(root, 'bof.txt'),
      head
        .split('\n')
        .filter((l) => l !== 'b1')
        .join('\n'),
    );

    // Nothing on the new side: the empty span sits at new line 1, the old span is line 1.
    const patch = selectHunks(diffFor('bof.txt'), { new: [1, 0], old: [1, 1] });
    expect(patch).toContain('-b1');
    applyPatch(patch, ['--cached']);
    expect(git('diff', '--cached', '-U3')).toContain('-b1');
  });

  it('REFUSES a wholesale rewrite rather than selecting the one hunk it collapsed into', () => {
    const head = numbered(30, (i) => `w${i}`);
    commit({ 'rewrite.txt': head });
    fs.writeFileSync(path.join(root, 'rewrite.txt'), 'entirely different content\n');

    // A 3-line click against a file that is now ONE giant hunk. Matching it would stage the
    // whole file — the over-selection the new-side rule exists to refuse.
    expect(selectHunks(diffFor('rewrite.txt'), { new: [3, 3], old: [3, 3] })).toBe('');
  });

  it('keeps a rename header with the hunk it selects', () => {
    const head = numbered(20, (i) => `r${i}`);
    commit({ 'before.txt': head });
    execFileSync('git', ['mv', 'before.txt', 'after.txt'], { cwd: root, stdio: 'ignore' });
    fs.writeFileSync(path.join(root, 'after.txt'), head.replace('r9\n', 'NINE\n'));
    execFileSync('git', ['add', '-A'], { cwd: root, stdio: 'ignore' });

    const raw = git(
      'diff',
      '--cached',
      '-M',
      '--no-ext-diff',
      '--no-color',
      '--src-prefix=a/',
      '--dst-prefix=b/',
      '-U3',
      '--',
      'after.txt',
    );
    const patch = selectHunks(raw, { new: [9, 9], old: [9, 9] });
    expect(patch).toContain('+NINE');
    // The rename metadata rides along verbatim, so git can still place the patch.
    if (raw.includes('rename from')) expect(patch).toContain('rename from');
    expect(applyCheck(patch, ['--cached', '--reverse'])).toBeNull();
  });

  it('refuses a globbed multi-file diff, leaving the sibling untouched', () => {
    // A bracket makes the filename a PATHSPEC. Without --literal-pathspecs git diffs BOTH and
    // the old parser emitted the sibling's hunk under this file's header — discarding a hunk
    // of "a[bc].txt" reverted "ab.txt".
    const head = numbered(6, (i) => `g${i}`);
    commit({ 'a[bc].txt': head, 'ab.txt': head });
    fs.writeFileSync(path.join(root, 'a[bc].txt'), head.replace('g3\n', 'TARGET\n'));
    fs.writeFileSync(path.join(root, 'ab.txt'), head.replace('g3\n', 'SIBLING\n'));

    const globbed = git(
      'diff',
      '--no-ext-diff',
      '--no-color',
      '--src-prefix=a/',
      '--dst-prefix=b/',
      '-U3',
      '--',
      'a[bc].txt',
    );
    // Proof the hazard is real on this git: one path, two files in the output.
    expect((globbed.match(/^diff --git /gm) ?? []).length).toBeGreaterThan(1);
    expect(selectHunks(globbed, { new: [3, 3], old: [3, 3] })).toBe('');

    // And with the flag the host actually passes, only the requested file is described.
    const literal = git(
      '--literal-pathspecs',
      'diff',
      '--no-ext-diff',
      '--no-color',
      '--src-prefix=a/',
      '--dst-prefix=b/',
      '-U3',
      '--',
      'a[bc].txt',
    );
    expect((literal.match(/^diff --git /gm) ?? []).length).toBe(1);
    const patch = selectHunks(literal, { new: [3, 3], old: [3, 3] });
    expect(patch).toContain('TARGET');
    expect(patch).not.toContain('SIBLING');
    applyPatch(patch, ['--reverse']);
    expect(bytes('ab.txt')).toContain('SIBLING');
    expect(bytes('a[bc].txt')).toBe(head);
  });

  it('reads git HEAD→index hunks for an unstage and reverses them cleanly', () => {
    const head = numbered(16, (i) => `u${i}`);
    commit({ 'staged.txt': head });
    fs.writeFileSync(path.join(root, 'staged.txt'), head.replace('u4', 'STAGED-FOUR'));
    execFileSync('git', ['add', 'staged.txt'], { cwd: root, stdio: 'ignore' });

    const patch = selectHunks(diffFor('staged.txt', true), { new: [4, 4], old: [4, 4] });
    expect(patch).toContain('+STAGED-FOUR');
    expect(applyCheck(patch, ['--cached', '--reverse'])).toBeNull();
  });
});
