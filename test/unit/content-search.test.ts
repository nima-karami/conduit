import { describe, expect, it } from 'vitest';
import {
  buildMatcher,
  type ContentSearchDeps,
  type Dirent,
  globToRegExp,
  isStaleResponse,
  parseGlobs,
  pathPasses,
  scanText,
  searchContent,
} from '../../src/content-search';

function cols(text: string, line: string): number[] {
  const built = buildMatcher({ text });
  if ('error' in built) throw new Error(built.error);
  return built.match(line).map((h) => h.col);
}

describe('buildMatcher — literal mode', () => {
  it('finds all literal occurrences (0-based columns)', () => {
    expect(cols('ab', 'ab x ab y ab')).toEqual([0, 5, 10]);
  });

  it('is case-insensitive by default', () => {
    const built = buildMatcher({ text: 'foo' });
    if ('error' in built) throw new Error(built.error);
    expect(built.match('FOO Foo foo').map((h) => h.col)).toEqual([0, 4, 8]);
  });

  it('honours matchCase', () => {
    const built = buildMatcher({ text: 'foo', matchCase: true });
    if ('error' in built) throw new Error(built.error);
    expect(built.match('FOO Foo foo').map((h) => h.col)).toEqual([8]);
  });

  it('treats regex metacharacters as literal text', () => {
    // The '.' must match a literal dot, not any char.
    expect(cols('a.b', 'a.b axb a.b')).toEqual([0, 8]);
  });
});

describe('buildMatcher — whole-word mode', () => {
  it('matches only at ASCII word boundaries', () => {
    const built = buildMatcher({ text: 'cat', wholeWord: true });
    if ('error' in built) throw new Error(built.error);
    // "category" and "scatter" must not match; standalone "cat" must.
    expect(built.match('cat category scatter cat.').map((h) => h.col)).toEqual([0, 21]);
  });
});

describe('buildMatcher — regex mode', () => {
  it('compiles a user regex', () => {
    const built = buildMatcher({ text: 'a\\d+', regex: true });
    if ('error' in built) throw new Error(built.error);
    expect(built.match('a12 b a3').map((h) => h.col)).toEqual([0, 6]);
  });

  it('returns a structured error for an invalid pattern (never throws)', () => {
    const built = buildMatcher({ text: '(', regex: true });
    expect('error' in built).toBe(true);
  });

  it('does not loop forever on a zero-width match', () => {
    const built = buildMatcher({ text: 'x*', regex: true });
    if ('error' in built) throw new Error(built.error);
    // Should terminate and report a match at the start of "xx".
    const hits = built.match('xx ');
    expect(hits.length).toBeGreaterThan(0);
  });
});

describe('globToRegExp', () => {
  it('* matches any run including slashes', () => {
    expect(globToRegExp('*.ts').test('src/a.ts')).toBe(true);
    expect(globToRegExp('src/*').test('src/deep/a.ts')).toBe(true);
  });

  it('? matches exactly one char', () => {
    expect(globToRegExp('a?.ts').test('ab.ts')).toBe(true);
    expect(globToRegExp('a?.ts').test('abc.ts')).toBe(false);
  });

  it('escapes regex metachars so a glob cannot inject a pattern', () => {
    expect(globToRegExp('a.b').test('a.b')).toBe(true);
    expect(globToRegExp('a.b').test('axb')).toBe(false);
  });
});

describe('pathPasses', () => {
  it('include empty = include everything', () => {
    expect(pathPasses('src/a.ts', [], [])).toBe(true);
  });

  it('include filters to matching paths', () => {
    const inc = parseGlobs('*.ts');
    expect(pathPasses('src/a.ts', inc, [])).toBe(true);
    expect(pathPasses('src/a.js', inc, [])).toBe(false);
  });

  it('exclude wins over include', () => {
    const inc = parseGlobs('*.ts');
    const exc = parseGlobs('*test*');
    expect(pathPasses('src/a.test.ts', inc, exc)).toBe(false);
    expect(pathPasses('src/a.ts', inc, exc)).toBe(true);
  });
});

describe('scanText', () => {
  const matcher = (text: string) => {
    const built = buildMatcher({ text });
    if ('error' in built) throw new Error(built.error);
    return built.match;
  };

  it('reports 1-based line + column and the trimmed line text', () => {
    const r = scanText('alpha\n  beta xx\ngamma', matcher('xx'), 0);
    expect(r.matches).toEqual([{ line: 2, column: 8, lineText: 'beta xx' }]);
  });

  it('strips a trailing CR so column math matches the visible line', () => {
    const r = scanText('a xx\r\nb', matcher('xx'), 0);
    expect(r.matches[0]).toMatchObject({ line: 1, column: 3 });
  });

  it('respects the per-file cap', () => {
    const text = Array.from({ length: 500 }, () => 'hit').join('\n');
    const r = scanText(text, matcher('hit'), 0, { perFileCap: 10, totalCap: 100000 });
    expect(r.matches.length).toBe(10);
    expect(r.fileTruncated).toBe(true);
  });

  it('respects the running total cap', () => {
    const text = Array.from({ length: 500 }, () => 'hit').join('\n');
    const r = scanText(text, matcher('hit'), 95, { perFileCap: 10000, totalCap: 100 });
    expect(r.totalAfter).toBe(100);
    expect(r.fileTruncated).toBe(true);
  });
});

interface MemFile {
  content: string;
  /** Raw bytes override (for binary sniff tests); defaults to utf8 of content. */
  bytes?: number[];
}
type MemTree = Record<string, Record<string, 'dir' | MemFile>>;

function memDeps(tree: MemTree, now: () => number = () => 0): ContentSearchDeps {
  const dirent = (name: string, kind: 'dir' | MemFile): Dirent => ({
    name,
    isDirectory: () => kind === 'dir',
    isFile: () => kind !== 'dir',
  });
  return {
    readdir: (p: string) => {
      const node = tree[p];
      if (!node) throw new Error(`ENOENT ${p}`);
      return Object.entries(node).map(([name, kind]) => dirent(name, kind));
    },
    readFile: (p: string) => {
      // Find the file in its parent dir.
      const slash = p.lastIndexOf('/');
      const dir = p.slice(0, slash);
      const name = p.slice(slash + 1);
      const f = tree[dir]?.[name];
      if (!f || f === 'dir') throw new Error(`ENOENT ${p}`);
      const bytes = (f as MemFile).bytes ?? [...Buffer.from((f as MemFile).content, 'utf8')];
      const arr = bytes as number[] & { toString(enc: 'utf8'): string };
      arr.toString = ((enc: string) =>
        enc === 'utf8' ? (f as MemFile).content : '') as typeof arr.toString;
      return arr;
    },
    now,
  };
}

describe('searchContent', () => {
  const tree: MemTree = {
    '/proj': {
      src: 'dir',
      'README.md': { content: 'hello world\nfind me\n' },
      node_modules: 'dir',
    },
    '/proj/src': {
      'a.ts': { content: 'const x = 1;\nfind me here\n' },
      'b.ts': { content: 'no match in here\n' },
    },
    '/proj/node_modules': { 'bloat.js': { content: 'find me find me\n' } },
  };

  it('groups matches by file with 1-based line/col', () => {
    const res = searchContent('/proj', { text: 'find me' }, memDeps(tree));
    const byRel = Object.fromEntries(res.files.map((f) => [f.rel, f.matches]));
    expect(byRel['README.md']).toEqual([{ line: 2, column: 1, lineText: 'find me' }]);
    expect(byRel['src/a.ts']).toEqual([{ line: 2, column: 1, lineText: 'find me here' }]);
    expect(byRel['src/b.ts']).toBeUndefined();
  });

  it('skips ignored directories (node_modules)', () => {
    const res = searchContent('/proj', { text: 'find me' }, memDeps(tree));
    expect(res.files.some((f) => f.rel.includes('node_modules'))).toBe(false);
  });

  it('applies include/exclude globs on relative paths', () => {
    const inc = searchContent('/proj', { text: 'find me', include: '*.ts' }, memDeps(tree));
    expect(inc.files.map((f) => f.rel).sort()).toEqual(['src/a.ts']);
    const exc = searchContent('/proj', { text: 'find me', exclude: 'src/*' }, memDeps(tree));
    expect(exc.files.map((f) => f.rel).sort()).toEqual(['README.md']);
  });

  it('returns an inline error for an invalid regex (no files)', () => {
    const res = searchContent('/proj', { text: '(', regex: true }, memDeps(tree));
    expect(res.error).toBeTruthy();
    expect(res.files).toEqual([]);
  });

  it('returns empty for a blank query', () => {
    const res = searchContent('/proj', { text: '' }, memDeps(tree));
    expect(res).toEqual({ files: [], truncated: false });
  });

  it('skips binary files (NUL byte sniff)', () => {
    const binTree: MemTree = {
      '/p': { 'bin.dat': { content: 'find me', bytes: [102, 0, 105, 110, 100] } },
    };
    const res = searchContent('/p', { text: 'find' }, memDeps(binTree));
    expect(res.files).toEqual([]);
  });

  it('truncates when the total cap is exhausted', () => {
    const big: MemTree = {
      '/p': {
        'a.txt': { content: Array.from({ length: 50 }, () => 'find me').join('\n') },
        'b.txt': { content: Array.from({ length: 50 }, () => 'find me').join('\n') },
      },
    };
    const res = searchContent('/p', { text: 'find me' }, memDeps(big), {
      perFileCap: 1000,
      totalCap: 10,
      timeBudgetMs: 100000,
    });
    expect(res.truncated).toBe(true);
    const total = res.files.reduce((n, f) => n + f.matches.length, 0);
    expect(total).toBe(10);
  });

  it('matches a file by NAME even when its contents do not match', () => {
    const res = searchContent('/proj', { text: 'README' }, memDeps(tree));
    const readme = res.files.find((f) => f.rel === 'README.md');
    expect(readme).toBeDefined();
    expect(readme?.nameMatch).toBe(true);
    expect(readme?.matches).toEqual([]); // "README" isn't in the file body
  });

  it('matches a FOLDER name (path segment), surfacing files under it', () => {
    const res = searchContent('/proj', { text: 'src' }, memDeps(tree));
    const rels = res.files.map((f) => f.rel).sort();
    expect(rels).toEqual(['src/a.ts', 'src/b.ts']);
    expect(res.files.every((f) => f.nameMatch === true)).toBe(true);
  });

  it('flags nameMatch on a file that matches BOTH name and contents', () => {
    // "a.ts" appears in the path; the body also contains "a.ts" here.
    const t: MemTree = { '/p': { 'a.ts': { content: 'see a.ts below\nx\n' } } };
    const res = searchContent('/p', { text: 'a.ts' }, memDeps(t));
    const f = res.files.find((x) => x.rel === 'a.ts');
    expect(f?.nameMatch).toBe(true);
    expect(f?.matches.length).toBe(1);
  });

  it('honours include/exclude on name matches too', () => {
    const res = searchContent('/proj', { text: 'a.ts', exclude: 'src/*' }, memDeps(tree));
    expect(res.files).toEqual([]);
  });

  it('surfaces a name match for a binary/oversize file (no content scan)', () => {
    const binTree: MemTree = {
      '/p': { 'logo.png': { content: '', bytes: [137, 80, 0, 78, 71] } },
    };
    const res = searchContent('/p', { text: 'logo' }, memDeps(binTree));
    expect(res.files.map((f) => f.rel)).toEqual(['logo.png']);
    expect(res.files[0]?.nameMatch).toBe(true);
  });

  it('does not flag nameMatch on a normal content-only hit', () => {
    const res = searchContent('/proj', { text: 'find me' }, memDeps(tree));
    expect(res.files.every((f) => f.nameMatch === undefined)).toBe(true);
  });

  it('truncates when the time budget is exhausted (partial results)', () => {
    let t = 0;
    const clock = () => {
      t += 1000;
      return t;
    };
    const res = searchContent('/proj', { text: 'find me' }, memDeps(tree, clock), {
      perFileCap: 1000,
      totalCap: 1000,
      timeBudgetMs: 1,
    });
    expect(res.truncated).toBe(true);
  });
});

describe('isStaleResponse', () => {
  it('is stale when the response id is not the latest issued', () => {
    expect(isStaleResponse(1, 2)).toBe(true);
    expect(isStaleResponse(2, 2)).toBe(false);
  });
});
