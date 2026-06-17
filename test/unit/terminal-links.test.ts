import { describe, expect, it } from 'vitest';
import { detectPathTokens } from '../../webview/terminal-links';

// The detection module normalizes resolved paths to forward slashes internally.
// This test suite is platform-neutral and asserts on the forward-slash form.

describe('detectPathTokens — POSIX absolute paths', () => {
  it('matches a bare absolute POSIX path', () => {
    const tokens = detectPathTokens('/home/user/project/app.tsx', undefined);
    expect(tokens).toHaveLength(1);
    expect(tokens[0].path).toBe('/home/user/project/app.tsx');
    expect(tokens[0].line).toBeUndefined();
  });

  it('matches with :line suffix', () => {
    const tokens = detectPathTokens('Error at /src/main.ts:109', undefined);
    expect(tokens).toHaveLength(1);
    expect(tokens[0].path).toBe('/src/main.ts');
    expect(tokens[0].line).toBe(109);
    expect(tokens[0].col).toBeUndefined();
  });

  it('matches with :line:col suffix', () => {
    const tokens = detectPathTokens('see /src/main.ts:42:7', undefined);
    expect(tokens).toHaveLength(1);
    expect(tokens[0].path).toBe('/src/main.ts');
    expect(tokens[0].line).toBe(42);
    expect(tokens[0].col).toBe(7);
  });

  it('strips trailing period', () => {
    const tokens = detectPathTokens('Look at /foo/bar.ts.', undefined);
    expect(tokens).toHaveLength(1);
    expect(tokens[0].path).toBe('/foo/bar.ts');
  });

  it('strips trailing comma', () => {
    const tokens = detectPathTokens('/foo/bar.ts,', undefined);
    expect(tokens).toHaveLength(1);
    expect(tokens[0].path).toBe('/foo/bar.ts');
  });

  it('strips trailing closing paren', () => {
    const tokens = detectPathTokens('(see /foo/bar.ts)', undefined);
    expect(tokens).toHaveLength(1);
    expect(tokens[0].path).toBe('/foo/bar.ts');
  });

  it('strips trailing closing bracket', () => {
    const tokens = detectPathTokens('[/foo/bar.ts]', undefined);
    expect(tokens).toHaveLength(1);
    expect(tokens[0].path).toBe('/foo/bar.ts');
  });

  it('reports correct start index', () => {
    const line = 'Error: /src/app.tsx:10 is bad';
    const tokens = detectPathTokens(line, undefined);
    expect(tokens).toHaveLength(1);
    expect(tokens[0].start).toBe(7);
  });

  it('end index encompasses the :line suffix', () => {
    const line = 'Error: /src/app.tsx:10 is bad';
    const tokens = detectPathTokens(line, undefined);
    expect(tokens[0].end).toBeGreaterThan(tokens[0].start + '/src/app.tsx'.length);
  });
});

describe('detectPathTokens — Windows absolute paths', () => {
  it('matches C:\\ style path', () => {
    const tokens = detectPathTokens('C:\\Users\\foo\\bar.ts', undefined);
    expect(tokens).toHaveLength(1);
    expect(tokens[0].path).toMatch(/bar\.ts/);
  });

  it('matches C:/ style path (forward slashes)', () => {
    const tokens = detectPathTokens('D:/work/project/index.js', undefined);
    expect(tokens).toHaveLength(1);
    expect(tokens[0].path).toMatch(/index\.js/);
  });

  it('matches Windows path with :line suffix', () => {
    const tokens = detectPathTokens('C:\\src\\app.tsx:109', undefined);
    expect(tokens).toHaveLength(1);
    expect(tokens[0].line).toBe(109);
  });

  it('matches Windows path with :line:col suffix', () => {
    const tokens = detectPathTokens('C:/project/src/app.tsx:5:12', undefined);
    expect(tokens).toHaveLength(1);
    expect(tokens[0].line).toBe(5);
    expect(tokens[0].col).toBe(12);
  });
});

describe('detectPathTokens — relative paths', () => {
  const CWD = '/project/sub';

  it('resolves ./ relative path against activeCwd', () => {
    const tokens = detectPathTokens('./src/app.tsx', CWD);
    expect(tokens).toHaveLength(1);
    expect(tokens[0].path).toBe('/project/sub/src/app.tsx');
  });

  it('resolves ../ relative path against activeCwd', () => {
    const tokens = detectPathTokens('../other/file.ts', CWD);
    expect(tokens).toHaveLength(1);
    expect(tokens[0].path).toBe('/project/other/file.ts');
  });

  it('skips relative paths when activeCwd is absent', () => {
    const tokens = detectPathTokens('./src/app.tsx', undefined);
    expect(tokens).toHaveLength(0);
  });

  it('resolves relative path with :line suffix', () => {
    const tokens = detectPathTokens('./src/app.tsx:42', CWD);
    expect(tokens).toHaveLength(1);
    expect(tokens[0].line).toBe(42);
    expect(tokens[0].path).toBe('/project/sub/src/app.tsx');
  });

  it('resolves relative path with :line:col suffix', () => {
    const tokens = detectPathTokens('../lib/util.ts:8:3', CWD);
    expect(tokens).toHaveLength(1);
    expect(tokens[0].line).toBe(8);
    expect(tokens[0].col).toBe(3);
  });
});

describe('detectPathTokens — non-path prose', () => {
  it('does not match a bare word', () => {
    expect(detectPathTokens('hello world', undefined)).toHaveLength(0);
  });

  it('does not match https:// URL (lookbehind excludes :/ prefix)', () => {
    const tokens = detectPathTokens('See https://example.com for details', undefined);
    expect(tokens).toHaveLength(0);
  });

  it('does not match http:// URL', () => {
    const tokens = detectPathTokens('Visit http://localhost:3000/api', undefined);
    expect(tokens).toHaveLength(0);
  });

  it('does not match a single slash', () => {
    expect(detectPathTokens('a / b', undefined)).toHaveLength(0);
  });

  it('handles multiple paths on one line', () => {
    const tokens = detectPathTokens('/foo/a.ts and /bar/b.ts', undefined);
    expect(tokens).toHaveLength(2);
    expect(tokens[0].path).toBe('/foo/a.ts');
    expect(tokens[1].path).toBe('/bar/b.ts');
  });

  it('does not swallow trailing double-quote into path', () => {
    const tokens = detectPathTokens('"/foo/bar.ts"', undefined);
    expect(tokens).toHaveLength(1);
    expect(tokens[0].path).toBe('/foo/bar.ts');
  });

  it('does not swallow trailing single-quote into path', () => {
    const tokens = detectPathTokens("'/foo/bar.ts'", undefined);
    expect(tokens).toHaveLength(1);
    expect(tokens[0].path).toBe('/foo/bar.ts');
  });
});

describe('detectPathTokens — edge cases', () => {
  it('returns empty array for empty string', () => {
    expect(detectPathTokens('', undefined)).toHaveLength(0);
  });

  it('handles path at start of line', () => {
    const tokens = detectPathTokens('/foo/bar.ts: no such file', undefined);
    expect(tokens).toHaveLength(1);
    expect(tokens[0].path).toBe('/foo/bar.ts');
  });

  it('handles ANSI escape codes surrounding a real path', () => {
    // \x1b[31m is a colour code; the path follows it.
    const tokens = detectPathTokens('\x1b[31m/src/main.ts\x1b[0m', undefined);
    expect(tokens).toHaveLength(1);
    expect(tokens[0].path).toBe('/src/main.ts');
  });

  it('strips multiple trailing punctuation chars', () => {
    const tokens = detectPathTokens('/foo/bar.ts,)', undefined);
    expect(tokens).toHaveLength(1);
    expect(tokens[0].path).toBe('/foo/bar.ts');
  });

  it('does not match just a slash at word boundary', () => {
    // " / " — isolated slash
    expect(detectPathTokens(' / ', undefined)).toHaveLength(0);
  });
});
