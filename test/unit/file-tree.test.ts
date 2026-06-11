import { describe, expect, it } from 'vitest';
import type { DirEntryDTO } from '../../src/protocol';
import {
  applyEntries,
  joinPath,
  mergeEntries,
  pathsToRefresh,
  type TreeNode,
} from '../../webview/file-tree';

const ents = (...names: [string, 'dir' | 'file'][]): DirEntryDTO[] =>
  names.map(([name, kind]) => ({ name, kind }));

describe('joinPath', () => {
  it('joins with a forward slash and trims trailing separators', () => {
    expect(joinPath('/a/b', 'c.ts')).toBe('/a/b/c.ts');
    expect(joinPath('/a/b/', 'c.ts')).toBe('/a/b/c.ts');
    expect(joinPath('C:\\a\\b\\', 'c.ts')).toBe('C:\\a\\b/c.ts');
  });
});

describe('mergeEntries', () => {
  it('builds fresh collapsed nodes when nothing existed', () => {
    const out = mergeEntries(undefined, '/root', ents(['src', 'dir'], ['a.ts', 'file']));
    expect(out).toEqual([
      { name: 'src', path: '/root/src', kind: 'dir', expanded: false },
      { name: 'a.ts', path: '/root/a.ts', kind: 'file', expanded: false },
    ]);
  });

  it('adds a newly-appeared file without disturbing existing nodes', () => {
    const existing: TreeNode[] = [
      { name: 'a.ts', path: '/root/a.ts', kind: 'file', expanded: false },
    ];
    const out = mergeEntries(existing, '/root', ents(['a.ts', 'file'], ['NEW.ts', 'file']));
    expect(out.map((n) => n.name)).toEqual(['a.ts', 'NEW.ts']);
  });

  it('drops a removed entry', () => {
    const existing: TreeNode[] = [
      { name: 'a.ts', path: '/root/a.ts', kind: 'file', expanded: false },
      { name: 'gone.ts', path: '/root/gone.ts', kind: 'file', expanded: false },
    ];
    const out = mergeEntries(existing, '/root', ents(['a.ts', 'file']));
    expect(out.map((n) => n.name)).toEqual(['a.ts']);
  });

  it('preserves an expanded directory and its loaded children across a refresh', () => {
    const existing: TreeNode[] = [
      {
        name: 'src',
        path: '/root/src',
        kind: 'dir',
        expanded: true,
        children: [{ name: 'x.ts', path: '/root/src/x.ts', kind: 'file', expanded: false }],
      },
    ];
    const out = mergeEntries(existing, '/root', ents(['src', 'dir'], ['new.ts', 'file']));
    const src = out.find((n) => n.name === 'src');
    expect(src?.expanded).toBe(true);
    expect(src?.children?.map((c) => c.name)).toEqual(['x.ts']);
    expect(out.map((n) => n.name)).toEqual(['src', 'new.ts']);
  });

  it('treats a name that switched kind (file ⇄ dir) as a fresh node', () => {
    const existing: TreeNode[] = [
      { name: 'thing', path: '/root/thing', kind: 'file', expanded: false },
    ];
    const out = mergeEntries(existing, '/root', ents(['thing', 'dir']));
    expect(out[0]).toEqual({ name: 'thing', path: '/root/thing', kind: 'dir', expanded: false });
  });
});

describe('applyEntries', () => {
  it('merges at the root level when dirPath is the root', () => {
    const roots: TreeNode[] = [{ name: 'a.ts', path: '/root/a.ts', kind: 'file', expanded: false }];
    const out = applyEntries(roots, '/root', '/root', ents(['a.ts', 'file'], ['b.ts', 'file']));
    expect(out.map((n) => n.name)).toEqual(['a.ts', 'b.ts']);
  });

  it('merges into a nested directory and marks it expanded', () => {
    const roots: TreeNode[] = [{ name: 'src', path: '/root/src', kind: 'dir', expanded: false }];
    const out = applyEntries(roots, '/root', '/root/src', ents(['x.ts', 'file']));
    const src = out.find((n) => n.name === 'src');
    expect(src?.expanded).toBe(true);
    expect(src?.children?.map((c) => c.name)).toEqual(['x.ts']);
  });

  it('leaves unrelated branches untouched', () => {
    const roots: TreeNode[] = [
      {
        name: 'a',
        path: '/root/a',
        kind: 'dir',
        expanded: true,
        children: [{ name: 'keep.ts', path: '/root/a/keep.ts', kind: 'file', expanded: false }],
      },
      { name: 'b', path: '/root/b', kind: 'dir', expanded: false },
    ];
    const out = applyEntries(roots, '/root', '/root/b', ents(['new.ts', 'file']));
    const a = out.find((n) => n.name === 'a');
    expect(a?.children?.map((c) => c.name)).toEqual(['keep.ts']);
  });
});

describe('pathsToRefresh', () => {
  it('returns just the root when nothing is expanded', () => {
    const roots: TreeNode[] = [{ name: 'src', path: '/root/src', kind: 'dir', expanded: false }];
    expect(pathsToRefresh(roots, '/root')).toEqual(['/root']);
  });

  it('includes the root plus every expanded, loaded directory (depth-first)', () => {
    const roots: TreeNode[] = [
      {
        name: 'src',
        path: '/root/src',
        kind: 'dir',
        expanded: true,
        children: [
          {
            name: 'inner',
            path: '/root/src/inner',
            kind: 'dir',
            expanded: true,
            children: [],
          },
        ],
      },
      { name: 'lib', path: '/root/lib', kind: 'dir', expanded: false },
    ];
    expect(pathsToRefresh(roots, '/root')).toEqual(['/root', '/root/src', '/root/src/inner']);
  });

  it('skips an expanded directory that has not been loaded yet (no children)', () => {
    const roots: TreeNode[] = [{ name: 'src', path: '/root/src', kind: 'dir', expanded: true }];
    expect(pathsToRefresh(roots, '/root')).toEqual(['/root']);
  });
});
