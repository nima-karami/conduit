import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { confineFsPath } from '../../src/network/fs-confine';

// B confines a peer's path to a session's folders before it reads anything (plan decision 4).

let root: string;
let proj: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(tmpdir(), 'fs-confine-'));
  proj = path.join(root, 'proj');
  fs.mkdirSync(proj);
  fs.writeFileSync(path.join(proj, 'a.txt'), 'hi');
  fs.writeFileSync(path.join(root, 'outside.txt'), 'nope');
  fs.writeFileSync(path.join(proj, '.env'), 'TOKEN=1');
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('confineFsPath', () => {
  it('accepts a file inside a root and returns its real path', async () => {
    const r = await confineFsPath(path.join(proj, 'a.txt'), [proj]);
    expect(r).toEqual({ ok: true, real: fs.realpathSync.native(path.join(proj, 'a.txt')) });
  });

  it('refuses a relative path', async () => {
    expect(await confineFsPath('a.txt', [proj])).toEqual({ ok: false, code: 'refused' });
  });

  it('refuses a path outside every root', async () => {
    const r = await confineFsPath(path.join(root, 'outside.txt'), [proj]);
    expect(r).toEqual({ ok: false, code: 'refused' });
  });

  it('refuses a .. segment that would climb out of a root', async () => {
    const r = await confineFsPath(`${proj}/../outside.txt`, [proj]);
    expect(r).toEqual({ ok: false, code: 'refused' });
  });

  it('refuses a deny-listed entry inside a root', async () => {
    const r = await confineFsPath(path.join(proj, '.env'), [proj]);
    expect(r).toEqual({ ok: false, code: 'refused' });
  });

  it('reports a missing path inside a root as not_found', async () => {
    const r = await confineFsPath(path.join(proj, 'missing.txt'), [proj]);
    expect(r).toEqual({ ok: false, code: 'not_found' });
  });

  it.skipIf(process.platform === 'win32')(
    'refuses a symlink inside a root that points outside it',
    async () => {
      fs.symlinkSync(path.join(root, 'outside.txt'), path.join(proj, 'link.txt'));
      const r = await confineFsPath(path.join(proj, 'link.txt'), [proj]);
      expect(r).toEqual({ ok: false, code: 'refused' });
    },
  );

  it.skipIf(process.platform === 'win32')(
    'refuses a symlink inside the folder that points at a denied entry inside it',
    async () => {
      fs.symlinkSync(path.join(proj, '.env'), path.join(proj, 'cfg'));
      expect(await confineFsPath(path.join(proj, 'cfg'), [proj])).toEqual({
        ok: false,
        code: 'refused',
      });
      fs.mkdirSync(path.join(root, '.ssh'));
      fs.writeFileSync(path.join(root, '.ssh', 'id_rsa'), 'key');
      fs.symlinkSync(path.join(root, '.ssh', 'id_rsa'), path.join(proj, 'k'));
      expect(await confineFsPath(path.join(proj, 'k'), [root])).toEqual({
        ok: false,
        code: 'refused',
      });
    },
  );

  it.skipIf(process.platform === 'win32')(
    'serves a path under a root that is itself a symlink',
    async () => {
      const alias = path.join(root, 'alias');
      fs.symlinkSync(proj, alias);
      const r = await confineFsPath(path.join(alias, 'a.txt'), [alias]);
      expect(r).toEqual({ ok: true, real: fs.realpathSync.native(path.join(proj, 'a.txt')) });
    },
  );

  it.skipIf(process.platform === 'win32')(
    'refuses a dangling symlink inside a root instead of calling it missing',
    async () => {
      fs.symlinkSync(path.join(root, 'nowhere'), path.join(proj, 'dangling'));
      const r = await confineFsPath(path.join(proj, 'dangling'), [proj]);
      expect(r).toEqual({ ok: false, code: 'refused' });
    },
  );
});
