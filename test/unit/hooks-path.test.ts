import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

// Hermetic: every repo here is a temp dir; the real repo's config is never touched.
const REPO = resolve(__dirname, '..', '..');
const HUSKY_BIN = join(REPO, 'node_modules', 'husky', 'bin.js');
const TMP = mkdtempSync(join(tmpdir(), 'con34-hooks-'));

afterAll(() => {
  rmSync(TMP, { recursive: true, force: true });
});

// Inherited GIT_* vars would point git at the outer repo when this runs inside a hook.
const GIT_FREE_ENV = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')),
);

function git(cwd: string, ...args: string[]): string {
  return execFileSync(
    'git',
    [
      '-c',
      'user.name=t',
      '-c',
      'user.email=t@example.invalid',
      '-c',
      'commit.gpgsign=false',
      ...args,
    ],
    { cwd, env: GIT_FREE_ENV, encoding: 'utf8' },
  );
}

function trackedHuskyFiles(): string[] {
  return git(REPO, 'ls-files', '--', '.husky/_')
    .split('\n')
    .filter((line) => line.length > 0);
}

describe('pre-commit hook in a linked git worktree', () => {
  it('runs the pre-commit hook when committing from a worktree that never ran husky', () => {
    const marker = join(TMP, 'hook-ran.log');
    const main = join(TMP, 'main');
    const wt = join(TMP, 'wt');
    mkdirSync(main);
    git(main, 'init', '-q', '-b', 'main');

    // The clone gets exactly the repo's tracked .husky files, as a fresh checkout would.
    for (const rel of git(REPO, 'ls-files', '--', '.husky').split('\n').filter(Boolean)) {
      mkdirSync(join(main, rel, '..'), { recursive: true });
      copyFileSync(join(REPO, rel), join(main, rel));
    }
    // Swap in a marker hook so the test does not need lint-staged's node_modules.
    writeFileSync(
      join(main, '.husky', 'pre-commit'),
      `#!/usr/bin/env sh\necho "$(pwd -P)" >> '${marker}'\n`,
    );
    chmodSync(join(main, '.husky', 'pre-commit'), 0o755);
    writeFileSync(join(main, 'a.txt'), 'a\n');
    // -f: husky's own .husky/_/.gitignore ("*") would hide the shims from a plain add.
    git(main, 'add', '-f', '--', '.husky', 'a.txt');
    git(main, 'commit', '-q', '-m', 'init');

    // The repo's real setup: what `npm install` runs through the prepare script.
    execFileSync(process.execPath, [HUSKY_BIN], { cwd: main, env: GIT_FREE_ENV });

    writeFileSync(join(main, 'a.txt'), 'a2\n');
    git(main, 'commit', '-q', '-am', 'main');
    expect(readFileSync(marker, 'utf8').trim().split('\n')).toEqual([realpathSync(main)]);

    git(main, 'worktree', 'add', '-q', wt, '-b', 'wt1');
    writeFileSync(join(wt, 'b.txt'), 'b\n');
    git(wt, 'add', 'b.txt');
    git(wt, 'commit', '-q', '-m', 'from worktree');

    const ranIn = readFileSync(marker, 'utf8').trim().split('\n');
    expect(ranIn).toContain(realpathSync(wt));
  });

  it('tracks husky-generated .husky/_ byte-for-byte, so worktrees get the shims on checkout', () => {
    const tracked = trackedHuskyFiles();
    expect(tracked).toContain('.husky/_/h');

    const gen = join(TMP, 'gen');
    mkdirSync(gen);
    git(gen, 'init', '-q', '-b', 'main');
    execFileSync(process.execPath, [HUSKY_BIN], { cwd: gen, env: GIT_FREE_ENV });

    const generated = readdirSync(join(gen, '.husky', '_')).sort();
    expect(tracked.map((p) => p.slice('.husky/_/'.length)).sort()).toEqual(generated);
    for (const name of generated) {
      expect(readFileSync(join(REPO, '.husky', '_', name), 'utf8')).toBe(
        readFileSync(join(gen, '.husky', '_', name), 'utf8'),
      );
    }
    expect(existsSync(join(REPO, '.husky', '_', 'h'))).toBe(true);
  });
});
