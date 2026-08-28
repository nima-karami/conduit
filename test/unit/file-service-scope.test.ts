import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { readDiff, UNMERGED, type Unmerged } from '../../src/file-service';
import type { DiffBase } from '../../src/protocol';

/**
 * Host integration test for readDiff's staged/unstaged baselines (spec
 * 2026-08-27-review-supercharge §2 Lane D). Uses a throwaway repo in the OS temp dir and a
 * REAL `git show` so the `HEAD:<rel>` vs `:<rel>` ref forms are exercised, not a stub of them.
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

const roots: string[] = [];
afterAll(() => {
  for (const r of roots) fs.rmSync(r, { recursive: true, force: true });
});

function makeRepo(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rd-scope-'));
  roots.push(root);
  const run = (args: string[]) => execFileSync('git', args, { cwd: root, stdio: 'ignore' });
  run(['init']);
  run(['config', 'user.email', 'test@example.com']);
  run(['config', 'user.name', 'Test']);
  run(['config', 'commit.gpgsign', 'false']);
  return root;
}

/** The two ref forms electron/main.ts builds, plus its unmerged fallback, against a real repo. */
function showFor(root: string) {
  return async (abs: string, ref: DiffBase): Promise<string | Unmerged> => {
    const rel = path.relative(root, abs).split(path.sep).join('/');
    const spec = ref === 'index' ? `:${rel}` : `HEAD:${rel}`;
    try {
      // stderr ignored: a failed show is an EXPECTED outcome here (no blob, or unmerged).
      return execFileSync('git', ['show', spec], {
        cwd: root,
        stdio: ['ignore', 'pipe', 'ignore'],
      }).toString('utf8');
    } catch {
      if (ref !== 'index') return '';
      const staged = execFileSync('git', ['ls-files', '--unmerged', '--', rel], {
        cwd: root,
      }).toString();
      return staged.trim() === '' ? '' : UNMERGED;
    }
  };
}

d('readDiff base/side scoping', () => {
  /** committed → staged edit → worktree edit, so all three baselines differ. */
  function bothSides(): { root: string; file: string; show: ReturnType<typeof showFor> } {
    const root = makeRepo();
    const file = path.join(root, 'both.ts');
    fs.writeFileSync(file, 'head\n');
    execFileSync('git', ['add', '.'], { cwd: root, stdio: 'ignore' });
    execFileSync('git', ['commit', '-m', 'base'], { cwd: root, stdio: 'ignore' });
    fs.writeFileSync(file, 'index\n');
    execFileSync('git', ['add', 'both.ts'], { cwd: root, stdio: 'ignore' });
    fs.writeFileSync(file, 'worktree\n');
    return { root, file, show: showFor(root) };
  }

  it('defaults to HEAD→worktree (today, unchanged)', async () => {
    const { file, show } = bothSides();
    const dto = await readDiff(file, show);
    expect(dto.head).toBe('head\n');
    expect(dto.work).toBe('worktree\n');
  });

  it('staged scope reads HEAD→index', async () => {
    const { file, show } = bothSides();
    const dto = await readDiff(file, show, undefined, { base: 'head', side: 'index' });
    expect(dto.head).toBe('head\n');
    expect(dto.work).toBe('index\n');
  });

  it('unstaged scope reads index→worktree', async () => {
    const { file, show } = bothSides();
    const dto = await readDiff(file, show, undefined, { base: 'index', side: 'worktree' });
    expect(dto.head).toBe('index\n');
    expect(dto.work).toBe('worktree\n');
  });

  it('a staged-only file shows its change under staged and nothing under unstaged', async () => {
    const root = makeRepo();
    const file = path.join(root, 'staged-only.ts');
    fs.writeFileSync(file, 'one\n');
    execFileSync('git', ['add', '.'], { cwd: root, stdio: 'ignore' });
    execFileSync('git', ['commit', '-m', 'base'], { cwd: root, stdio: 'ignore' });
    fs.writeFileSync(file, 'two\n');
    execFileSync('git', ['add', 'staged-only.ts'], { cwd: root, stdio: 'ignore' });
    const show = showFor(root);

    const staged = await readDiff(file, show, undefined, { base: 'head', side: 'index' });
    expect(staged.head).toBe('one\n');
    expect(staged.work).toBe('two\n');

    const unstaged = await readDiff(file, show, undefined, { base: 'index', side: 'worktree' });
    expect(unstaged.head).toBe(unstaged.work);
  });

  it('an unstaged-only file shows its change under unstaged and nothing under staged', async () => {
    const root = makeRepo();
    const file = path.join(root, 'unstaged-only.ts');
    fs.writeFileSync(file, 'one\n');
    execFileSync('git', ['add', '.'], { cwd: root, stdio: 'ignore' });
    execFileSync('git', ['commit', '-m', 'base'], { cwd: root, stdio: 'ignore' });
    fs.writeFileSync(file, 'two\n');
    const show = showFor(root);

    const unstaged = await readDiff(file, show, undefined, { base: 'index', side: 'worktree' });
    expect(unstaged.head).toBe('one\n');
    expect(unstaged.work).toBe('two\n');

    const staged = await readDiff(file, show, undefined, { base: 'head', side: 'index' });
    expect(staged.head).toBe(staged.work);
  });

  /** A real `git merge` conflict: the path is left UNMERGED, with no stage-0 index blob. */
  function conflictedRepo(): { root: string; file: string } {
    const root = makeRepo();
    const file = path.join(root, 'conflict.ts');
    const run = (args: string[]) => execFileSync('git', args, { cwd: root, stdio: 'ignore' });
    fs.writeFileSync(file, 'a\nb\nc\n');
    run(['add', '.']);
    run(['commit', '-m', 'base']);
    run(['checkout', '-b', 'other']);
    fs.writeFileSync(file, 'a\nOTHER\nc\n');
    run(['commit', '-am', 'other']);
    run(['checkout', '-']);
    fs.writeFileSync(file, 'a\nMINE\nc\n');
    run(['commit', '-am', 'mine']);
    try {
      run(['merge', 'other']);
    } catch {
      /* the conflict IS the fixture */
    }
    const stages = execFileSync('git', ['ls-files', '--unmerged', '--', 'conflict.ts'], {
      cwd: root,
    }).toString();
    expect(stages.trim()).not.toBe('');
    return { root, file };
  }

  it('reports a conflicted path as unmerged rather than a whole-file deletion', async () => {
    const { root, file } = conflictedRepo();
    const show = showFor(root);

    const staged = await readDiff(file, show, undefined, { base: 'head', side: 'index' });
    expect(staged.unmerged).toBe(true);
    // The bug this guards: an empty index read looks exactly like an empty blob, so the card
    // rendered every HEAD line as removed.
    expect(staged.head).toBe('');
    expect(staged.work).toBe('');

    const unstaged = await readDiff(file, show, undefined, { base: 'index', side: 'worktree' });
    expect(unstaged.unmerged).toBe(true);
    expect(unstaged.head).toBe('');
    expect(unstaged.work).toBe('');
  });

  it('still diffs a conflicted path normally under All scope', async () => {
    const { root, file } = conflictedRepo();
    const dto = await readDiff(file, showFor(root));
    expect(dto.unmerged).toBeUndefined();
    expect(dto.head).toContain('MINE');
    expect(dto.work).toContain('<<<<<<<');
  });

  it('CRLF index text is LF-normalised like the other sides', async () => {
    const root = makeRepo();
    const file = path.join(root, 'crlf.txt');
    fs.writeFileSync(file, 'a\r\nb\r\n');
    execFileSync('git', ['-c', 'core.autocrlf=false', 'add', '.'], { cwd: root, stdio: 'ignore' });
    execFileSync('git', ['commit', '-m', 'base'], { cwd: root, stdio: 'ignore' });
    const dto = await readDiff(file, showFor(root), undefined, { base: 'head', side: 'index' });
    expect(dto.work).toBe('a\nb\n');
  });
});
