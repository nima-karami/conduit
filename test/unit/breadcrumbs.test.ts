import { describe, expect, it } from 'vitest';
import {
  breadcrumbPathSegments,
  enclosingSymbolChain,
  type NavTreeNode,
} from '../../src/breadcrumbs';

// ─── breadcrumbPathSegments ────────────────────────────────────────────────

describe('breadcrumbPathSegments', () => {
  // --- POSIX inside root ---

  it('returns relative segments for a file inside rootCwd (POSIX)', () => {
    const segs = breadcrumbPathSegments('/home/user/project/src/utils.ts', '/home/user/project');
    expect(segs.map((s) => s.name)).toEqual(['src', 'utils.ts']);
  });

  it('sets dirPath to the parent dir for each segment (POSIX)', () => {
    const segs = breadcrumbPathSegments('/home/user/project/src/utils.ts', '/home/user/project');
    // 'src' segment: parent is /home/user/project
    expect(segs[0].dirPath).toBe('/home/user/project');
    // 'utils.ts' segment: parent is /home/user/project/src
    expect(segs[1].dirPath).toBe('/home/user/project/src');
  });

  it('handles deeply nested path inside root (POSIX)', () => {
    const segs = breadcrumbPathSegments(
      '/home/user/project/src/features/auth/login.ts',
      '/home/user/project',
    );
    expect(segs.map((s) => s.name)).toEqual(['src', 'features', 'auth', 'login.ts']);
    expect(segs[0].dirPath).toBe('/home/user/project');
    expect(segs[1].dirPath).toBe('/home/user/project/src');
    expect(segs[2].dirPath).toBe('/home/user/project/src/features');
    expect(segs[3].dirPath).toBe('/home/user/project/src/features/auth');
  });

  it('returns single segment when file is directly in rootCwd (POSIX)', () => {
    const segs = breadcrumbPathSegments('/home/user/project/index.ts', '/home/user/project');
    expect(segs.map((s) => s.name)).toEqual(['index.ts']);
    expect(segs[0].dirPath).toBe('/home/user/project');
  });

  // --- POSIX outside root ---

  it('returns all path segments for a file outside rootCwd (POSIX)', () => {
    const segs = breadcrumbPathSegments('/opt/other/file.ts', '/home/user/project');
    expect(segs.map((s) => s.name)).toEqual(['opt', 'other', 'file.ts']);
  });

  it('sets correct dirPaths for file outside rootCwd (POSIX)', () => {
    const segs = breadcrumbPathSegments('/opt/other/file.ts', '/home/user/project');
    expect(segs[0].dirPath).toBe('/');
    expect(segs[1].dirPath).toBe('/opt');
    expect(segs[2].dirPath).toBe('/opt/other');
  });

  // --- Windows paths ---

  it('handles Windows backslash paths inside root', () => {
    const segs = breadcrumbPathSegments(
      'G:\\awby\\projects\\conduit\\src\\breadcrumbs.ts',
      'G:\\awby\\projects\\conduit',
    );
    expect(segs.map((s) => s.name)).toEqual(['src', 'breadcrumbs.ts']);
  });

  it('sets correct Windows dirPaths', () => {
    const segs = breadcrumbPathSegments(
      'G:\\awby\\projects\\conduit\\src\\breadcrumbs.ts',
      'G:\\awby\\projects\\conduit',
    );
    expect(segs[0].dirPath).toBe('G:/awby/projects/conduit');
    expect(segs[1].dirPath).toBe('G:/awby/projects/conduit/src');
  });

  it('handles Windows mixed slash paths inside root', () => {
    const segs = breadcrumbPathSegments(
      'G:/awby/projects/conduit/webview/components/breadcrumb-bar.tsx',
      'G:/awby/projects/conduit',
    );
    expect(segs.map((s) => s.name)).toEqual(['webview', 'components', 'breadcrumb-bar.tsx']);
  });

  it('handles Windows paths outside root', () => {
    const segs = breadcrumbPathSegments('C:/Users/foo/file.ts', 'G:/awby/projects/conduit');
    expect(segs.map((s) => s.name)).toContain('file.ts');
  });

  it('returns empty array for empty filePath', () => {
    const segs = breadcrumbPathSegments('', '/home/user');
    expect(segs).toEqual([]);
  });
});

// ─── enclosingSymbolChain ─────────────────────────────────────────────────

describe('enclosingSymbolChain', () => {
  const tree: NavTreeNode = {
    text: '<global>',
    kind: 'module',
    spans: [{ start: 0, length: 1000 }],
    childItems: [
      {
        text: 'MyClass',
        kind: 'class',
        spans: [{ start: 10, length: 300 }],
        childItems: [
          {
            text: 'constructor',
            kind: 'constructor',
            spans: [{ start: 20, length: 50 }],
          },
          {
            text: 'save',
            kind: 'method',
            spans: [{ start: 80, length: 100 }],
            childItems: [
              {
                text: 'innerHelper',
                kind: 'function',
                spans: [{ start: 90, length: 40 }],
              },
            ],
          },
          {
            text: 'load',
            kind: 'method',
            spans: [{ start: 200, length: 80 }],
          },
        ],
      },
      {
        text: 'helperFn',
        kind: 'function',
        spans: [{ start: 400, length: 80 }],
      },
    ],
  };

  it('returns [] for null tree', () => {
    expect(enclosingSymbolChain(null, 50)).toEqual([]);
  });

  it('returns [] for undefined tree', () => {
    expect(enclosingSymbolChain(undefined, 50)).toEqual([]);
  });

  it('returns [] for empty tree (no children)', () => {
    const emptyTree: NavTreeNode = {
      text: '<global>',
      kind: 'module',
      spans: [],
      childItems: [],
    };
    expect(enclosingSymbolChain(emptyTree, 50)).toEqual([]);
  });

  it('returns [] when offset is outside all symbols', () => {
    // offset 700 is past all spans (max is 400+80=480)
    expect(enclosingSymbolChain(tree, 700)).toEqual([]);
  });

  it('resolves a top-level function', () => {
    const chain = enclosingSymbolChain(tree, 420);
    expect(chain.length).toBe(1);
    expect(chain[0].text).toBe('helperFn');
    expect(chain[0].kind).toBe('function');
  });

  it('includes siblings for a top-level symbol', () => {
    const chain = enclosingSymbolChain(tree, 420);
    const sibs = chain[0].siblings.map((s) => s.text);
    expect(sibs).toContain('MyClass');
    expect(sibs).toContain('helperFn');
  });

  it('resolves class > method (2 levels, offset in method body outside inner fn)', () => {
    // 'save' spans 80-180; 'innerHelper' spans 90-130.
    // offset 140 is inside 'save' but NOT inside 'innerHelper' (130..end).
    const chain = enclosingSymbolChain(tree, 140);
    expect(chain.map((s) => s.text)).toEqual(['MyClass', 'save']);
  });

  it('includes method siblings at the class level', () => {
    const chain = enclosingSymbolChain(tree, 100);
    const methSibs = chain[1].siblings.map((s) => s.text);
    expect(methSibs).toContain('constructor');
    expect(methSibs).toContain('save');
    expect(methSibs).toContain('load');
  });

  it('resolves class > method > nested function (3 levels)', () => {
    // innerHelper is at 90-130, inside save (80-180), inside MyClass (10-310)
    const chain = enclosingSymbolChain(tree, 95);
    expect(chain.map((s) => s.text)).toEqual(['MyClass', 'save', 'innerHelper']);
  });

  it('resolves class only when inside class but outside any method', () => {
    // offset 30 is inside MyClass (10-310) and inside constructor (20-70)
    // actually: let's pick offset 15 which is in MyClass but before constructor starts at 20
    const chain = enclosingSymbolChain(tree, 15);
    // MyClass (10-310) contains 15; but none of the children do
    expect(chain.map((s) => s.text)).toEqual(['MyClass']);
  });

  it('includes start offset for each chain item', () => {
    const chain = enclosingSymbolChain(tree, 95);
    expect(chain[0].start).toBe(10); // MyClass starts at 10
    expect(chain[1].start).toBe(80); // save starts at 80
    expect(chain[2].start).toBe(90); // innerHelper starts at 90
  });
});
