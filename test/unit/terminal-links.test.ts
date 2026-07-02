import { describe, expect, it } from 'vitest';
import { detectPathTokens, detectUrlTokens } from '../../webview/terminal-links';

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

describe('detectPathTokens — bare project-relative paths (with separator)', () => {
  const CWD = '/project';

  it('matches a bare repo-relative path and resolves against cwd', () => {
    const tokens = detectPathTokens('see src/core/theme/accent.ts here', CWD);
    expect(tokens).toHaveLength(1);
    expect(tokens[0].path).toBe('/project/src/core/theme/accent.ts');
  });

  it('matches a two-segment bare relative path', () => {
    const tokens = detectPathTokens('edit webview/app.tsx', CWD);
    expect(tokens).toHaveLength(1);
    expect(tokens[0].path).toBe('/project/webview/app.tsx');
  });

  it('carries a :line:col suffix on a bare relative path', () => {
    const tokens = detectPathTokens('src/main.ts:42:7', CWD);
    expect(tokens).toHaveLength(1);
    expect(tokens[0].path).toBe('/project/src/main.ts');
    expect(tokens[0].line).toBe(42);
    expect(tokens[0].col).toBe(7);
  });

  it('is skipped when activeCwd is absent (relative needs a base)', () => {
    expect(detectPathTokens('src/core/accent.ts', undefined)).toHaveLength(0);
  });

  it('exposes the cleaned matched text as `raw` (what the host resolver searches with)', () => {
    const tokens = detectPathTokens('see src/core/theme/accent.ts here', CWD);
    expect(tokens[0].raw).toBe('src/core/theme/accent.ts');
  });
});

describe('detectPathTokens — bare filenames (v1, extension-gated)', () => {
  const CWD = '/project';

  it('matches a bare filename with an allowlisted extension; raw is the filename', () => {
    const tokens = detectPathTokens('failed in accent.ts today', CWD);
    expect(tokens).toHaveLength(1);
    expect(tokens[0].raw).toBe('accent.ts');
  });

  it('matches README.md / package.json', () => {
    expect(detectPathTokens('edit README.md', CWD)[0]?.raw).toBe('README.md');
    expect(detectPathTokens('see package.json', CWD)[0]?.raw).toBe('package.json');
  });

  it('does NOT match a method call or non-allowlisted extension', () => {
    expect(detectPathTokens('call obj.foo here', CWD)).toHaveLength(0);
    expect(detectPathTokens('version 1.2', CWD)).toHaveLength(0);
  });

  it('does NOT match a bare domain (extension not allowlisted)', () => {
    const tokens = detectPathTokens('visit example.com today', CWD);
    expect(tokens).toHaveLength(0);
  });

  it('matches multiple bare filenames on a line', () => {
    const tokens = detectPathTokens('accent.ts and theme.css', CWD);
    expect(tokens.map((t) => t.raw)).toEqual(['accent.ts', 'theme.css']);
  });

  it('carries a :line:col suffix on a bare filename', () => {
    const tokens = detectPathTokens('accent.ts:42:7', CWD);
    expect(tokens[0].raw).toBe('accent.ts');
    expect(tokens[0].line).toBe(42);
    expect(tokens[0].col).toBe(7);
  });

  it('does not grab the host/path of a URL as a bare relative path', () => {
    const tokens = detectPathTokens('clone https://example.com/a/b please', CWD);
    expect(tokens.every((t) => !t.path.includes('example.com'))).toBe(true);
  });

  it('strips trailing punctuation on a bare relative path', () => {
    const tokens = detectPathTokens('(see src/a.ts).', CWD);
    expect(tokens).toHaveLength(1);
    expect(tokens[0].path).toBe('/project/src/a.ts');
  });

  it('reports a span that covers exactly the matched path', () => {
    const line = 'open webview/app.tsx now';
    const tokens = detectPathTokens(line, CWD);
    expect(tokens).toHaveLength(1);
    expect(line.slice(tokens[0].start, tokens[0].end)).toBe('webview/app.tsx');
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

describe('detectUrlTokens', () => {
  it('matches a bare http URL', () => {
    const tokens = detectUrlTokens('server up at http://localhost:5173/ ready');
    expect(tokens).toHaveLength(1);
    expect(tokens[0].raw).toBe('http://localhost:5173/');
  });

  it('matches an https URL', () => {
    const tokens = detectUrlTokens('See https://example.com for details');
    expect(tokens).toHaveLength(1);
    expect(tokens[0].raw).toBe('https://example.com');
  });

  it('matches a file:// URL', () => {
    const tokens = detectUrlTokens('open file:///c:/tmp/report.html now');
    expect(tokens).toHaveLength(1);
    expect(tokens[0].raw).toBe('file:///c:/tmp/report.html');
  });

  it('keeps a query string and fragment', () => {
    const tokens = detectUrlTokens('go to https://a.com/p?x=1&y=2#frag now');
    expect(tokens).toHaveLength(1);
    expect(tokens[0].raw).toBe('https://a.com/p?x=1&y=2#frag');
  });

  it('does not swallow a trailing period', () => {
    const tokens = detectUrlTokens('Visit https://example.com/page.');
    expect(tokens).toHaveLength(1);
    expect(tokens[0].raw).toBe('https://example.com/page');
  });

  it('does not swallow trailing sentence punctuation (comma)', () => {
    const tokens = detectUrlTokens('https://example.com, then continue');
    expect(tokens).toHaveLength(1);
    expect(tokens[0].raw).toBe('https://example.com');
  });

  it('unwraps a URL inside parentheses', () => {
    const tokens = detectUrlTokens('(see https://example.com/x)');
    expect(tokens).toHaveLength(1);
    expect(tokens[0].raw).toBe('https://example.com/x');
  });

  it('keeps balanced parens that belong to the URL', () => {
    const tokens = detectUrlTokens('https://en.wikipedia.org/wiki/Foo_(bar) done');
    expect(tokens).toHaveLength(1);
    expect(tokens[0].raw).toBe('https://en.wikipedia.org/wiki/Foo_(bar)');
  });

  it('unwraps a URL in parens whose path also has balanced parens', () => {
    const tokens = detectUrlTokens('(https://en.wikipedia.org/wiki/Foo_(bar))');
    expect(tokens).toHaveLength(1);
    expect(tokens[0].raw).toBe('https://en.wikipedia.org/wiki/Foo_(bar)');
  });

  it('unwraps a URL inside square brackets', () => {
    const tokens = detectUrlTokens('[https://example.com/x]');
    expect(tokens).toHaveLength(1);
    expect(tokens[0].raw).toBe('https://example.com/x');
  });

  it('unwraps a URL inside angle brackets', () => {
    const tokens = detectUrlTokens('ref <https://example.com/x> here');
    expect(tokens).toHaveLength(1);
    expect(tokens[0].raw).toBe('https://example.com/x');
  });

  it('unwraps a double-quoted URL', () => {
    const tokens = detectUrlTokens('"https://example.com/x"');
    expect(tokens).toHaveLength(1);
    expect(tokens[0].raw).toBe('https://example.com/x');
  });

  it('reports a span that covers exactly the matched URL', () => {
    const line = 'go to https://a.com/p?x=1 now';
    const tokens = detectUrlTokens(line);
    expect(tokens).toHaveLength(1);
    expect(line.slice(tokens[0].start, tokens[0].end)).toBe('https://a.com/p?x=1');
  });

  it('matches multiple URLs on one line', () => {
    const tokens = detectUrlTokens('http://a.com and https://b.com/x');
    expect(tokens.map((t) => t.raw)).toEqual(['http://a.com', 'https://b.com/x']);
  });

  it('does not match inside a longer word', () => {
    expect(detectUrlTokens('xhttps://example.com')).toHaveLength(0);
  });

  it('does not match a bare filesystem path (no scheme)', () => {
    expect(detectUrlTokens('/src/main.ts and ./x/y.ts')).toHaveLength(0);
  });

  it('does not match a non-http(s)/file scheme', () => {
    expect(detectUrlTokens('ftp://example.com/x')).toHaveLength(0);
  });
});

describe('detectPathTokens — abbreviated paths (... elision)', () => {
  // The token must be captured WITH the `...` so the host resolver can suffix-search the
  // tail. The renderer keeps `raw` verbatim; resolution happens host-side (path-resolve).
  it('captures a drive-absolute elided path', () => {
    const tokens = detectPathTokens('see C://my-games/.../sampleFile.tsx for details', 'C:/proj');
    expect(tokens.map((t) => t.raw)).toContain('C://my-games/.../sampleFile.tsx');
  });

  it('captures a POSIX-absolute elided path', () => {
    const tokens = detectPathTokens('open /home/.../theme/accent.ts now', undefined);
    expect(tokens.map((t) => t.raw)).toContain('/home/.../theme/accent.ts');
  });

  it('captures a leading-elision path', () => {
    const tokens = detectPathTokens('edit .../webview/app.tsx please', 'C:/proj');
    expect(tokens.map((t) => t.raw)).toContain('.../webview/app.tsx');
  });
});
