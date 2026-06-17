import { describe, expect, it } from 'vitest';
import type { ChangeDTO, DirEntryDTO } from '../../src/protocol';
import {
  ancestorDirChain,
  applyEntries,
  buildChangeMap,
  collapseAll,
  expandLoaded,
  findNode,
  isSearchActive,
  joinPath,
  mergeEntries,
  pathsToRefresh,
  resolveCreateTarget,
  type TreeNode,
} from '../../webview/file-tree';

const ents = (...names: [string, 'dir' | 'file'][]): DirEntryDTO[] =>
  names.map(([name, kind]) => ({ name, kind }));

describe('ancestorDirChain', () => {
  it('returns the root for a direct child file', () => {
    expect(ancestorDirChain('/root/a.ts', '/root')).toEqual(['/root']);
  });

  it('lists root + each intermediate dir down to the file parent', () => {
    expect(ancestorDirChain('/root/src/lib/x.ts', '/root')).toEqual([
      '/root',
      '/root/src',
      '/root/src/lib',
    ]);
  });

  it('tolerates a trailing separator on the root and mixed slashes', () => {
    expect(ancestorDirChain('C:\\proj\\src\\x.ts', 'C:\\proj\\')).toEqual([
      'C:\\proj\\',
      'C:\\proj/src',
    ]);
  });

  it('returns [] when the file is not under the root', () => {
    expect(ancestorDirChain('/other/a.ts', '/root')).toEqual([]);
    expect(ancestorDirChain('/root', '/root')).toEqual([]);
  });
});

describe('findNode', () => {
  const tree: TreeNode[] = [
    {
      name: 'src',
      path: '/root/src',
      kind: 'dir',
      expanded: true,
      children: [{ name: 'x.ts', path: '/root/src/x.ts', kind: 'file', expanded: false }],
    },
    { name: 'a.ts', path: '/root/a.ts', kind: 'file', expanded: false },
  ];

  it('finds a top-level node', () => {
    expect(findNode(tree, '/root/a.ts')?.name).toBe('a.ts');
  });

  it('finds a nested node', () => {
    expect(findNode(tree, '/root/src/x.ts')?.name).toBe('x.ts');
  });

  it('returns undefined when absent', () => {
    expect(findNode(tree, '/root/nope.ts')).toBeUndefined();
  });
});

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

describe('isSearchActive', () => {
  it('returns false for empty string', () => {
    expect(isSearchActive('')).toBe(false);
  });
  it('returns false for whitespace-only string', () => {
    expect(isSearchActive('   ')).toBe(false);
  });
  it('returns true for non-empty non-whitespace string', () => {
    expect(isSearchActive('foo')).toBe(true);
    expect(isSearchActive('  bar  ')).toBe(true);
  });
});

describe('collapseAll', () => {
  it('collapses all expanded directories recursively', () => {
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
          { name: 'a.ts', path: '/root/src/a.ts', kind: 'file', expanded: false },
        ],
      },
    ];
    const result = collapseAll(roots);
    expect(result[0].expanded).toBe(false);
    expect(result[0].children?.[0].expanded).toBe(false);
    // files are unchanged
    expect(result[0].children?.[1].expanded).toBe(false);
  });

  it('does not mutate original nodes', () => {
    const roots: TreeNode[] = [
      { name: 'src', path: '/root/src', kind: 'dir', expanded: true, children: [] },
    ];
    const result = collapseAll(roots);
    expect(roots[0].expanded).toBe(true); // original unchanged
    expect(result[0].expanded).toBe(false);
  });

  it('handles dirs without children (unloaded)', () => {
    const roots: TreeNode[] = [{ name: 'src', path: '/root/src', kind: 'dir', expanded: true }];
    const result = collapseAll(roots);
    expect(result[0].expanded).toBe(false);
    expect(result[0].children).toBeUndefined();
  });

  it('is idempotent — calling on an already-collapsed tree is safe (single button behaviour)', () => {
    // The "Collapse all" button always calls collapseAll regardless of current state.
    // When everything is already collapsed the result must be identical in shape.
    const roots: TreeNode[] = [
      {
        name: 'lib',
        path: '/root/lib',
        kind: 'dir',
        expanded: false,
        children: [
          { name: 'utils', path: '/root/lib/utils', kind: 'dir', expanded: false, children: [] },
          { name: 'b.ts', path: '/root/lib/b.ts', kind: 'file', expanded: false },
        ],
      },
    ];
    const result = collapseAll(roots);
    // All dirs remain collapsed; calling again is a safe no-op.
    expect(result[0].expanded).toBe(false);
    expect(result[0].children?.[0].expanded).toBe(false);
    expect(result[0].children?.[1].name).toBe('b.ts');
  });
});

describe('expandLoaded', () => {
  it('expands only directories that already have children (loaded)', () => {
    const roots: TreeNode[] = [
      { name: 'loaded', path: '/root/loaded', kind: 'dir', expanded: false, children: [] },
      { name: 'unloaded', path: '/root/unloaded', kind: 'dir', expanded: false },
    ];
    const result = expandLoaded(roots);
    expect(result[0].expanded).toBe(true);
    expect(result[1].expanded).toBe(false);
  });

  it('expands recursively into loaded children', () => {
    const roots: TreeNode[] = [
      {
        name: 'outer',
        path: '/root/outer',
        kind: 'dir',
        expanded: false,
        children: [
          {
            name: 'inner',
            path: '/root/outer/inner',
            kind: 'dir',
            expanded: false,
            children: [],
          },
        ],
      },
    ];
    const result = expandLoaded(roots);
    expect(result[0].expanded).toBe(true);
    expect(result[0].children?.[0].expanded).toBe(true);
  });

  it('does not mutate original nodes', () => {
    const roots: TreeNode[] = [
      { name: 'src', path: '/root/src', kind: 'dir', expanded: false, children: [] },
    ];
    const result = expandLoaded(roots);
    expect(roots[0].expanded).toBe(false);
    expect(result[0].expanded).toBe(true);
  });
});

describe('resolveCreateTarget', () => {
  it('returns selectedDir when one is selected', () => {
    expect(resolveCreateTarget('/root/src', '/root')).toBe('/root/src');
  });
  it('falls back to projectPath when nothing is selected', () => {
    expect(resolveCreateTarget(null, '/root')).toBe('/root');
  });
});

const change = (path: string, kind: ChangeDTO['kind'], staged = false): ChangeDTO => ({
  path,
  kind,
  staged,
  added: 0,
  removed: 0,
});

describe('buildChangeMap', () => {
  it('returns an empty map for no changes', () => {
    expect(buildChangeMap([])).toEqual(new Map());
  });

  it('maps each changed file to its kind', () => {
    const m = buildChangeMap([
      change('a.ts', 'M'),
      change('b.ts', 'A'),
      change('c.ts', 'D'),
      change('d.ts', 'U'),
    ]);
    expect(m.get('a.ts')).toBe('M');
    expect(m.get('b.ts')).toBe('A');
    expect(m.get('c.ts')).toBe('D');
    expect(m.get('d.ts')).toBe('U');
  });

  it('rolls up to ancestor folders', () => {
    const m = buildChangeMap([change('src/components/Button.tsx', 'M')]);
    expect(m.get('src/components/Button.tsx')).toBe('M');
    expect(m.get('src/components')).toBe('M');
    expect(m.get('src')).toBe('M');
  });

  it('does not add a dot for unchanged entries', () => {
    const m = buildChangeMap([change('changed.ts', 'A')]);
    expect(m.has('other.ts')).toBe(false);
    expect(m.has('some/folder')).toBe(false);
  });

  it('MM precedence: unstaged kind wins over staged for the same path', () => {
    // Porcelain MM: one staged entry (A) and one unstaged entry (M) for the same path.
    const m = buildChangeMap([change('file.ts', 'A', true), change('file.ts', 'M', false)]);
    expect(m.get('file.ts')).toBe('M');
  });

  it('MM precedence: first entry kept when both are staged (degenerate case)', () => {
    const m = buildChangeMap([change('file.ts', 'A', true), change('file.ts', 'M', true)]);
    expect(m.get('file.ts')).toBe('A');
  });

  it('folder kind follows highest-priority descendant (D > M > A > U)', () => {
    const m = buildChangeMap([change('pkg/a.ts', 'A'), change('pkg/b.ts', 'D')]);
    // D has higher priority than A, so the folder rolls up to D.
    expect(m.get('pkg')).toBe('D');
  });

  it('a folder with only added descendants gets A', () => {
    const m = buildChangeMap([change('lib/util.ts', 'A'), change('lib/types.ts', 'A')]);
    expect(m.get('lib')).toBe('A');
  });

  it('normalizes backslash paths to forward slashes', () => {
    const m = buildChangeMap([change('src\\utils\\helper.ts', 'M')]);
    expect(m.get('src/utils/helper.ts')).toBe('M');
    expect(m.get('src/utils')).toBe('M');
    expect(m.get('src')).toBe('M');
  });
});
