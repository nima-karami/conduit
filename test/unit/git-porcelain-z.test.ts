import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { executeGitAction } from '../../src/git-actions';
import { gitChanges, parseStatusZ } from '../../src/project-info';
import { discardAllPlan } from '../../webview/changes-actions';
import { reviewBulkTargets } from '../../webview/review-repos';

// Real git on a scratch repo: with the default core.quotePath, a non-ASCII (or `"` / `\`) name
// used to reach every ChangeDTO C-quoted, so each op that fed the path back into git missed it.

const cp = (...points: number[]) => String.fromCodePoint(...points);
const BACKSLASH = String.fromCharCode(92);
const CAFE = `caf${cp(0xe9)}.txt`;
const CJK = `${cp(0x65e5, 0x672c, 0x8a9e)}.txt`;
const SPACED = 'with space.txt';
const GLOB = 'n[1].txt';
const GLOB_SIBLING = 'n1.txt';
// Windows filenames cannot hold either character; CI (ubuntu) runs these.
const POSIX_ONLY =
  process.platform === 'win32' ? [] : [`back${BACKSLASH}slash.txt`, 'say "hi".txt'];
const NAMES = [CAFE, CJK, SPACED, ...POSIX_ONLY];

describe('parseStatusZ', () => {
  const BS_NAME = `back${BACKSLASH}slash.txt`;
  const QUOTED = 'say "hi".txt';
  const NUL = String.fromCharCode(0);

  it('reads names verbatim and a rename record as destination then source', () => {
    const out = [
      `R  ${CAFE}`,
      'old.txt',
      `?? ${BS_NAME}`,
      ` M ${QUOTED}`,
      `C  ${CJK}`,
      SPACED,
      '',
    ].join(NUL);
    expect(parseStatusZ(out)).toEqual([
      { x: 'R', y: ' ', p: CAFE, orig: 'old.txt' },
      { x: '?', y: '?', p: BS_NAME },
      { x: ' ', y: 'M', p: QUOTED },
      { x: 'C', y: ' ', p: CJK, orig: SPACED },
    ]);
  });
});

function hasGit(): boolean {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}
const d = hasGit() ? describe : describe.skip;

/** path → XY, read NUL-separated so the assertion never depends on the parser under test. */
function status(root: string): Map<string, string> {
  const out = execFileSync('git', ['status', '--porcelain', '-z', '--untracked-files=all'], {
    cwd: root,
  }).toString('utf8');
  const fields = out.split('\0');
  const m = new Map<string, string>();
  for (let i = 0; i < fields.length; i++) {
    const f = fields[i];
    if (!f) continue;
    m.set(f.slice(3), f.slice(0, 2));
    if (f[0] === 'R' || f[0] === 'C') i++;
  }
  return m;
}

const write = (root: string, rel: string, text: string) =>
  fs.writeFileSync(path.join(root, rel), text);

d('non-ASCII and special filenames through status and the git actions', () => {
  let root: string;
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, stdio: 'ignore' });

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'conduit-porcelain-z-'));
    git('init', '-q');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'Test');
    git('config', 'commit.gpgsign', 'false');
    git('config', 'core.autocrlf', 'false');
    // The machine's own setting must not decide the result: git's default is to quote.
    git('config', 'core.quotePath', 'true');
    write(root, 'plain.txt', 'p\n');
    write(root, 'old.txt', 'a\nb\n');
    for (const n of NAMES) write(root, n, 'one\n');
    git('add', '-A');
    git('commit', '-q', '-m', 'init');
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  const modifyAll = () => {
    for (const n of NAMES) write(root, n, 'one\ntwo\n');
    write(root, 'plain.txt', 'p\nq\n');
  };

  it('status reports the real names, with numstat line counts keyed by them', async () => {
    modifyAll();
    const changes = await gitChanges(root);
    for (const n of NAMES) {
      expect(changes).toContainEqual({ path: n, added: 1, removed: 0, kind: 'M', staged: false });
    }
  });

  it('status carries a staged rename as its new path plus its source', async () => {
    git('mv', 'old.txt', CAFE.replace('.txt', '-moved.txt'));
    const changes = await gitChanges(root);
    expect(changes).toEqual([
      expect.objectContaining({
        path: CAFE.replace('.txt', '-moved.txt'),
        origPath: 'old.txt',
        staged: true,
      }),
    ]);
  });

  it('per-file stage stages exactly the named file, glob characters included', async () => {
    modifyAll();
    write(root, GLOB, 'g\n');
    write(root, GLOB_SIBLING, 's\n');
    for (const c of await gitChanges(root)) {
      if (c.path === 'plain.txt' || c.path === GLOB_SIBLING) continue;
      expect(await executeGitAction({ root, op: 'stageFile', path: c.path })).toEqual({ ok: true });
    }
    const s = status(root);
    for (const n of NAMES) expect(s.get(n)).toBe('M ');
    expect(s.get(GLOB)).toBe('A ');
    expect(s.get(GLOB_SIBLING)).toBe('??');
    expect(s.get('plain.txt')).toBe(' M');
  });

  it('Stage all over the exact listed paths stages every file', async () => {
    modifyAll();
    const repo = { root, name: 'r', tag: 'home' as const, changes: await gitChanges(root) };
    const [target] = reviewBulkTargets([repo], false);
    expect(await executeGitAction({ root, op: 'stageAll', paths: target.paths })).toEqual({
      ok: true,
    });
    const s = status(root);
    for (const n of [...NAMES, 'plain.txt']) expect(s.get(n)).toBe('M ');
  });

  it('Unstage all over the exact listed paths unstages both sides of a rename', async () => {
    modifyAll();
    git('add', '-A');
    git('mv', 'old.txt', 'new.txt');
    const repo = { root, name: 'r', tag: 'home' as const, changes: await gitChanges(root) };
    const [target] = reviewBulkTargets([repo], true);
    expect(await executeGitAction({ root, op: 'unstageAll', paths: target.paths })).toEqual({
      ok: true,
    });
    const s = status(root);
    for (const n of [...NAMES, 'plain.txt']) expect(s.get(n)).toBe(' M');
    expect(s.get('old.txt')).toBe(' D');
    expect(s.get('new.txt')).toBe('??');
  });

  // The same sequence app.tsx `discardAll` runs: unstage, restore tracked, delete untracked.
  const discardAll = async (paths?: string[]) => {
    const plan = discardAllPlan(await gitChanges(root), paths);
    const results = [
      plan.unstage === undefined
        ? await executeGitAction({ root, op: 'unstageAll' })
        : plan.unstage.length > 0
          ? await executeGitAction({ root, op: 'unstageAll', paths: plan.unstage })
          : { ok: true as const },
    ];
    for (const p of plan.restore) {
      results.push(await executeGitAction({ root, op: 'discardTracked', path: p }));
    }
    for (const p of plan.remove) {
      results.push(await executeGitAction({ root, op: 'discardUntracked', path: p }));
    }
    return results;
  };

  const seedDiscard = () => {
    modifyAll();
    git('add', CAFE);
    write(root, CAFE, 'one\ntwo\nthree\n');
    write(root, `new-${CJK}`, 'u\n');
    git('mv', 'old.txt', 'new.txt');
    write(root, 'new.txt', 'a\nb\nc\n');
    write(root, 'staged-new.txt', 'n');
    git('add', 'staged-new.txt');
  };

  it('Discard all over the exact listed paths returns the repo to HEAD', async () => {
    seedDiscard();
    const repo = { root, name: 'r', tag: 'home' as const, changes: await gitChanges(root) };
    const [target] = reviewBulkTargets([repo]);
    for (const r of await discardAll(target.paths)) expect(r).toEqual({ ok: true });
    expect(status(root).size).toBe(0);
  });

  it('whole-repo Discard all returns the repo to HEAD, a staged rename included', async () => {
    seedDiscard();
    for (const r of await discardAll()) expect(r).toEqual({ ok: true });
    expect(status(root).size).toBe(0);
  });
});
