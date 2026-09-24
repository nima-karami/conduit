import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { gitIgnoredNames, gitListedFiles } from '../../src/git-listing';

// Without -z git C-quotes these names under the default core.quotePath, and the quoted form
// names no file: quick-open and search lost them, and the Explorer never dimmed them.
const cp = (...points: number[]) => String.fromCodePoint(...points);
const CAFE = `caf${cp(0xe9)}.txt`;
const CJK = `${cp(0x65e5, 0x672c)}.txt`;
const IGNORED = `ign${cp(0xf6)}red.log`;
const SPACED = 'with space.txt';

describe('gitListedFiles / gitIgnoredNames on real git', () => {
  let root: string;

  beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'conduit-git-listing-'));
    const git = (...args: string[]) => execFileSync('git', args, { cwd: root, stdio: 'ignore' });
    git('init', '-q');
    git('config', 'core.quotePath', 'true');
    fs.writeFileSync(path.join(root, '.gitignore'), `${IGNORED}\n`);
    for (const n of [CAFE, CJK, SPACED, IGNORED]) fs.writeFileSync(path.join(root, n), 'x\n');
    git('add', CAFE);
  });

  afterAll(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('lists tracked and untracked names verbatim, leaving the ignored one out', async () => {
    expect((await gitListedFiles(root)).sort()).toEqual(['.gitignore', CAFE, CJK, SPACED].sort());
  });

  it('reports an ignored non-ASCII name as the name it was given', async () => {
    expect(await gitIgnoredNames(root, [CAFE, IGNORED, SPACED])).toEqual(new Set([IGNORED]));
  });
});
