import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { folderKey } from '../../src/folder-key';
import {
  type FolderProbeDeps,
  findFolderConflict,
  folderKeysOf,
  placementConflict,
  probeFolder,
} from '../../src/folder-validation';

type Kind = 'dir' | 'not-dir' | 'missing';

const WIN_A = 'C:\\src\\RMB';

function deps(
  p: typeof path.win32 | typeof path.posix,
  kinds: Record<string, Kind>,
  real: Record<string, string> = {},
) {
  const realpath = vi.fn(async (x: string) => real[x] ?? x);
  const d: FolderProbeDeps = {
    path: p,
    kind: async (x) => kinds[x] ?? 'missing',
    realpath,
  };
  return { d, realpath };
}

const flavours = [
  { name: 'win32', p: path.win32, abs: 'C:\\w\\a', root: 'C:\\', rel: 'w\\a' },
  { name: 'posix', p: path.posix, abs: '/w/a', root: '/', rel: 'w/a' },
] as const;

describe.each(flavours)('probeFolder ($name)', ({ p, abs, root, rel }) => {
  it('relative, empty, NUL, >4096, non-string → invalid-path', async () => {
    const { d, realpath } = deps(p, { [abs]: 'dir' });
    for (const raw of [rel, '', `${abs}\0x`, abs + 'x'.repeat(4096), 7, null, undefined, [abs]]) {
      expect(await probeFolder(raw, d)).toEqual({ reason: 'invalid-path' });
    }
    expect(realpath).not.toHaveBeenCalled();
  });

  it('absent → status missing with lexical key, realpath never called', async () => {
    const { d, realpath } = deps(p, {});
    const r = await probeFolder(abs, d);
    expect(r).toEqual({
      status: 'missing',
      stored: abs,
      key: abs.replace(/\\/g, '/').toLowerCase(),
    });
    expect(realpath).not.toHaveBeenCalled();
  });

  it('file → not-a-directory', async () => {
    const { d } = deps(p, { [abs]: 'not-dir' });
    expect(await probeFolder(abs, d)).toEqual({ reason: 'not-a-directory' });
  });

  it('C:\\ and / → filesystem-root', async () => {
    expect(await probeFolder(root, deps(p, { [root]: 'dir' }).d)).toEqual({
      reason: 'filesystem-root',
    });
    expect(await probeFolder(root, deps(p, {}).d)).toEqual({ reason: 'filesystem-root' });
  });

  it('a present junction whose realpath is a filesystem root → filesystem-root', async () => {
    const { d } = deps(p, { [abs]: 'dir' }, { [abs]: root });
    expect(await probeFolder(abs, d)).toEqual({ reason: 'filesystem-root' });
  });

  it('present → realKey from async realpath', async () => {
    const target = p === path.win32 ? 'D:\\Real\\T' : '/real/T';
    const { d, realpath } = deps(p, { [abs]: 'dir' }, { [abs]: target });
    const r = await probeFolder(abs, d);
    expect(r).toEqual({
      status: 'present',
      stored: abs,
      key: abs.replace(/\\/g, '/').toLowerCase(),
      realKey: p === path.win32 ? 'd:/real/t' : '/real/T',
    });
    expect(realpath).toHaveBeenCalledWith(abs);
  });

  it('stores the resolved path', async () => {
    const messy = p === path.win32 ? 'C:\\w\\x\\..\\a\\' : '/w/x/../a/';
    const { d } = deps(p, { [abs]: 'dir' });
    const r = await probeFolder(messy, d);
    expect(r).toMatchObject({ status: 'present', stored: abs });
  });

  it('realpath rejecting (folder vanished after stat) → missing', async () => {
    const d: FolderProbeDeps = {
      path: p,
      kind: async () => 'dir',
      realpath: async () => {
        throw Object.assign(new Error('gone'), { code: 'ENOENT' });
      },
    };
    expect(await probeFolder(abs, d)).toMatchObject({ status: 'missing', stored: abs });
  });
});

describe('placementConflict', () => {
  it('equal → duplicate', () => {
    expect(placementConflict(['c:/w/a'], ['c:/w/b', 'c:/w/a'])).toBe('duplicate');
  });

  it('a real key equal to an existing key wins over a lexical overlap', () => {
    expect(placementConflict(['/w/a/sub', '/r/x'], ['/w/a', '/r/x'])).toBe('duplicate');
  });

  it('parent/child → overlaps', () => {
    expect(placementConflict(['/w/a/b'], ['/w/a'])).toBe('overlaps');
    expect(placementConflict(['/w'], ['/w/a'])).toBe('overlaps');
  });

  it('/a vs /ab → null', () => {
    expect(placementConflict(['/a'], ['/ab'])).toBeNull();
    expect(placementConflict(['/ab'], ['/a'])).toBeNull();
    expect(placementConflict(['/a'], [])).toBeNull();
  });
});

describe('findFolderConflict', () => {
  it('equal key → duplicate with index', () => {
    expect(findFolderConflict('/w/a', ['/w/b', '/w/a'])).toEqual({ kind: 'duplicate', index: 1 });
  });

  it('a duplicate anywhere wins over an earlier overlap', () => {
    expect(findFolderConflict('/w/a', ['/w', '/w/a'])).toEqual({ kind: 'duplicate', index: 1 });
  });

  it('candidate under an existing → inside', () => {
    expect(findFolderConflict('/w/a/b', ['/x', '/w/a'])).toEqual({ kind: 'inside', index: 1 });
  });

  it('candidate above an existing → contains', () => {
    expect(findFolderConflict('/w', ['/x', '/w/a'])).toEqual({ kind: 'contains', index: 1 });
  });

  it('/a vs /ab → null', () => {
    expect(findFolderConflict('/a', ['/ab'])).toBeNull();
    expect(findFolderConflict('/ab', ['/a'])).toBeNull();
    expect(findFolderConflict('/a', [])).toBeNull();
  });

  it('win32 case/slash variants → duplicate', () => {
    expect(findFolderConflict(folderKey(WIN_A), [folderKey('c:/Src/Rmb/')])).toEqual({
      kind: 'duplicate',
      index: 0,
    });
  });
});

describe('folderKeysOf', () => {
  it('adds cached real keys', () => {
    const realKeys = new Map([
      ['c:/w/link', 'd:/target'],
      ['c:/w/plain', 'c:/w/plain'],
    ]);
    expect(folderKeysOf(['C:\\w\\Link', 'C:\\w\\plain', 'C:\\w\\unseen'], realKeys)).toEqual([
      'c:/w/link',
      'd:/target',
      'c:/w/plain',
      'c:/w/unseen',
    ]);
  });
});
