import { describe, expect, it } from 'vitest';
import {
  detectPathTokens,
  detectUrlTokens,
  MAX_LOGICAL_LINE,
  MAX_PATH_TOKENS,
  MAX_TOKEN_LENGTH,
} from '../../webview/terminal-links';

// The detection module normalizes resolved paths to forward slashes internally.
// This test suite is platform-neutral and asserts on the forward-slash form.

describe('detectPathTokens — POSIX absolute paths', () => {
  it('matches a bare absolute POSIX path', () => {
    const tokens = detectPathTokens('/home/user/project/app.tsx', undefined);
    expect(tokens).toHaveLength(1);
    expect(tokens[0].raw).toBe('/home/user/project/app.tsx');
    expect(tokens[0].line).toBeUndefined();
  });

  it('matches with :line suffix', () => {
    const tokens = detectPathTokens('Error at /src/main.ts:109', undefined);
    expect(tokens).toHaveLength(1);
    expect(tokens[0].raw).toBe('/src/main.ts');
    expect(tokens[0].line).toBe(109);
    expect(tokens[0].col).toBeUndefined();
  });

  it('matches with :line:col suffix', () => {
    const tokens = detectPathTokens('see /src/main.ts:42:7', undefined);
    expect(tokens).toHaveLength(1);
    expect(tokens[0].raw).toBe('/src/main.ts');
    expect(tokens[0].line).toBe(42);
    expect(tokens[0].col).toBe(7);
  });

  it('strips trailing period', () => {
    const tokens = detectPathTokens('Look at /foo/bar.ts.', undefined);
    expect(tokens).toHaveLength(1);
    expect(tokens[0].raw).toBe('/foo/bar.ts');
  });

  it('strips trailing comma', () => {
    const tokens = detectPathTokens('/foo/bar.ts,', undefined);
    expect(tokens).toHaveLength(1);
    expect(tokens[0].raw).toBe('/foo/bar.ts');
  });

  it('strips trailing closing paren', () => {
    const tokens = detectPathTokens('(see /foo/bar.ts)', undefined);
    expect(tokens).toHaveLength(1);
    expect(tokens[0].raw).toBe('/foo/bar.ts');
  });

  it('strips trailing closing bracket', () => {
    const tokens = detectPathTokens('[/foo/bar.ts]', undefined);
    expect(tokens).toHaveLength(1);
    expect(tokens[0].raw).toBe('/foo/bar.ts');
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
    expect(tokens[0].raw).toMatch(/bar\.ts/);
  });

  it('matches C:/ style path (forward slashes)', () => {
    const tokens = detectPathTokens('D:/work/project/index.js', undefined);
    expect(tokens).toHaveLength(1);
    expect(tokens[0].raw).toMatch(/index\.js/);
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
    expect(tokens[0].raw).toBe('./src/app.tsx');
  });

  it('resolves ../ relative path against activeCwd', () => {
    const tokens = detectPathTokens('../other/file.ts', CWD);
    expect(tokens).toHaveLength(1);
    expect(tokens[0].raw).toBe('../other/file.ts');
  });

  it('skips relative paths when activeCwd is absent', () => {
    const tokens = detectPathTokens('./src/app.tsx', undefined);
    expect(tokens).toHaveLength(0);
  });

  it('resolves relative path with :line suffix', () => {
    const tokens = detectPathTokens('./src/app.tsx:42', CWD);
    expect(tokens).toHaveLength(1);
    expect(tokens[0].line).toBe(42);
    expect(tokens[0].raw).toBe('./src/app.tsx');
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
    expect(tokens[0].raw).toBe('src/core/theme/accent.ts');
  });

  it('matches a two-segment bare relative path', () => {
    const tokens = detectPathTokens('edit webview/app.tsx', CWD);
    expect(tokens).toHaveLength(1);
    expect(tokens[0].raw).toBe('webview/app.tsx');
  });

  it('carries a :line:col suffix on a bare relative path', () => {
    const tokens = detectPathTokens('src/main.ts:42:7', CWD);
    expect(tokens).toHaveLength(1);
    expect(tokens[0].raw).toBe('src/main.ts');
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
    expect(tokens.every((t) => !t.raw.includes('example.com'))).toBe(true);
  });

  it('strips trailing punctuation on a bare relative path', () => {
    const tokens = detectPathTokens('(see src/a.ts).', CWD);
    expect(tokens).toHaveLength(1);
    expect(tokens[0].raw).toBe('src/a.ts');
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
    expect(tokens[0].raw).toBe('/foo/a.ts');
    expect(tokens[1].raw).toBe('/bar/b.ts');
  });

  it('does not swallow trailing double-quote into path', () => {
    const tokens = detectPathTokens('"/foo/bar.ts"', undefined);
    expect(tokens).toHaveLength(1);
    expect(tokens[0].raw).toBe('/foo/bar.ts');
  });

  it('does not swallow trailing single-quote into path', () => {
    const tokens = detectPathTokens("'/foo/bar.ts'", undefined);
    expect(tokens).toHaveLength(1);
    expect(tokens[0].raw).toBe('/foo/bar.ts');
  });
});

describe('detectPathTokens — edge cases', () => {
  it('returns empty array for empty string', () => {
    expect(detectPathTokens('', undefined)).toHaveLength(0);
  });

  it('handles path at start of line', () => {
    const tokens = detectPathTokens('/foo/bar.ts: no such file', undefined);
    expect(tokens).toHaveLength(1);
    expect(tokens[0].raw).toBe('/foo/bar.ts');
  });

  it('handles ANSI escape codes surrounding a real path', () => {
    // \x1b[31m is a colour code; the path follows it.
    const tokens = detectPathTokens('\x1b[31m/src/main.ts\x1b[0m', undefined);
    expect(tokens).toHaveLength(1);
    expect(tokens[0].raw).toBe('/src/main.ts');
  });

  it('strips multiple trailing punctuation chars', () => {
    const tokens = detectPathTokens('/foo/bar.ts,)', undefined);
    expect(tokens).toHaveLength(1);
    expect(tokens[0].raw).toBe('/foo/bar.ts');
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

// Spec 2026-10-16-terminal-path-links §2.2 / §3.1 — one case per matrix row the detector owns.
describe('detectPathTokens — v2 matrix', () => {
  const CWD = '/w';
  const one = (line: string, cwd: string | undefined = CWD) => {
    const tokens = detectPathTokens(line, cwd);
    expect(tokens).toHaveLength(1);
    const t = tokens[0];
    return { ...t, span: line.slice(t.start, t.end) };
  };

  it('rows 1, 6, 7: plain, :l and :l:c keep today', () => {
    expect(one('src/index.ts')).toMatchObject({ alts: ['src/index.ts'], raw: 'src/index.ts' });
    expect(one('at src/index.ts:42')).toMatchObject({
      alts: ['src/index.ts'],
      line: 42,
      span: 'src/index.ts:42',
    });
    expect(one('src/index.ts:42:7: error')).toMatchObject({
      line: 42,
      col: 7,
      span: 'src/index.ts:42:7',
    });
    expect(one('(at src/index.ts:42:7)')).toMatchObject({
      alts: ['src/index.ts'],
      line: 42,
      col: 7,
    });
  });

  it('row 8: tsc/MSBuild (l,c) and (l)', () => {
    expect(one('src/index.ts(42,7): error TS2322')).toMatchObject({
      alts: ['src/index.ts'],
      line: 42,
      col: 7,
      span: 'src/index.ts(42,7)',
    });
    expect(one('src/index.ts(42)')).toMatchObject({
      alts: ['src/index.ts'],
      line: 42,
      col: undefined,
    });
  });

  it('row 9: #L42 and #L42-L50', () => {
    expect(one('src/index.ts#L42')).toMatchObject({
      alts: ['src/index.ts'],
      line: 42,
      span: 'src/index.ts#L42',
    });
    expect(one('see src/index.ts#L42-L50.')).toMatchObject({
      alts: ['src/index.ts'],
      line: 42,
      span: 'src/index.ts#L42-L50',
    });
  });

  it('row 10: :42-50 keeps line 42', () => {
    expect(one('src/index.ts:42-50')).toMatchObject({ alts: ['src/index.ts'], line: 42 });
  });

  it('row 11: " line 42" and Python `File "x.py", line 42`', () => {
    expect(one('src/index.ts line 42')).toMatchObject({
      alts: ['src/index.ts'],
      line: 42,
      span: 'src/index.ts',
    });
    expect(one('  File "x.py", line 42, in <module>')).toMatchObject({
      alts: ['x.py'],
      line: 42,
      span: 'x.py',
    });
  });

  it('row 24: backticks stripped', () => {
    expect(one('edit `src/index.ts` now')).toMatchObject({
      alts: ['src/index.ts'],
      span: 'src/index.ts',
    });
    expect(one('`src/index.ts:42`')).toMatchObject({
      alts: ['src/index.ts'],
      line: 42,
      span: 'src/index.ts:42',
    });
  });

  it('row 25: quoted paths keep today', () => {
    expect(one('"src/index.ts"')).toMatchObject({ alts: ['src/index.ts'], span: 'src/index.ts' });
    expect(one("'src/index.ts'")).toMatchObject({ alts: ['src/index.ts'], span: 'src/index.ts' });
  });

  it('rows 26–28: paren wrapper, tool header and markdown link target', () => {
    expect(one('(src/index.ts)')).toMatchObject({ alts: ['src/index.ts'], span: 'src/index.ts' });
    expect(one('● Update(src/index.ts)')).toMatchObject({
      alts: ['src/index.ts'],
      span: 'src/index.ts',
    });
    expect(one('Read(./src/x.ts)')).toMatchObject({ alts: ['./src/x.ts'], span: './src/x.ts' });
    expect(one('Write(index.ts)')).toMatchObject({ alts: ['index.ts'], span: 'index.ts' });
    expect(one('Update(src/index.ts:42)')).toMatchObject({ alts: ['src/index.ts'], line: 42 });
    expect(one('[index](src/index.ts)')).toMatchObject({
      alts: ['src/index.ts'],
      span: 'src/index.ts',
    });
  });

  it('row 29: a Next.js route group stays whole, the post-paren tail is alts[1]', () => {
    expect(one('app/(group)/page.tsx')).toMatchObject({
      alts: ['app/(group)/page.tsx', 'page.tsx'],
      span: 'app/(group)/page.tsx',
    });
  });

  it('row 30: Codex shapes keep today', () => {
    expect(one('⎿ Read src/index.ts (120 lines)')).toMatchObject({ alts: ['src/index.ts'] });
    expect(one('• Edited src/index.ts (+3 -1)')).toMatchObject({ alts: ['src/index.ts'] });
  });

  it('row 31: trailing sentence punctuation trimmed', () => {
    expect(one('See src/index.ts.')).toMatchObject({
      alts: ['src/index.ts'],
      span: 'src/index.ts',
    });
    expect(one('src/index.ts, and')).toMatchObject({ alts: ['src/index.ts'] });
  });

  it('row 32: Unicode ellipsis kept for host elision', () => {
    expect(one('…/src/index.ts')).toMatchObject({ alts: ['…/src/index.ts'] });
  });

  it('rows 34–36: elided absolute and a mid-segment truncation', () => {
    expect(one('G:\\work\\…\\src\\index.ts', undefined)).toMatchObject({
      alts: ['G:/work/…/src/index.ts'],
    });
    expect(one('G:/work/repoB/.../index.ts', undefined)).toMatchObject({
      alts: ['G:/work/repoB/.../index.ts'],
    });
    expect(one('…rc/util/a.ts')).toMatchObject({ alts: ['…rc/util/a.ts'] });
  });

  it('row 38: an unquoted span with spaces gives no token for the joined text', () => {
    const tokens = detectPathTokens('repoA/src/my file.ts', CWD);
    expect(tokens.map((t) => t.raw)).not.toContain('repoA/src/my file.ts');
  });

  it('row 39: a quoted span with spaces is tried whole', () => {
    expect(one('"repoA/src/my file.ts"')).toMatchObject({
      alts: ['repoA/src/my file.ts'],
      span: 'repoA/src/my file.ts',
    });
    expect(one("open 'C:\\Program Files\\x\\y.ts' now", undefined)).toMatchObject({
      alts: ['C:/Program Files/x/y.ts'],
    });
  });

  it('row 39: apostrophes in prose are not quotes', () => {
    const tokens = detectPathTokens("don't edit src/a.ts or it's bad", CWD);
    expect(tokens.map((t) => t.raw)).toEqual(['src/a.ts']);
  });

  it('row 41: bare filename keeps today', () => {
    expect(one('index.ts')).toMatchObject({ alts: ['index.ts'] });
  });

  it('row 43: known extensionless names and dotfiles', () => {
    for (const name of [
      'README',
      'Makefile',
      'Dockerfile',
      '.env',
      '.env.local',
      '.gitignore',
      'LICENSE',
    ]) {
      expect(one(`see ${name} here`)).toMatchObject({ alts: [name], span: name });
    }
    expect(detectPathTokens('use .map here', CWD)).toHaveLength(0);
  });

  it('row 44: extensions from the language registry', () => {
    for (const name of ['foo.mts', 'x.lua', 'y.tf', 'z.csv', 'log.log']) {
      expect(one(`see ${name}`)).toMatchObject({ alts: [name] });
    }
    expect(detectPathTokens('call obj.foo here', CWD)).toHaveLength(0);
    expect(detectPathTokens('version 1.2', CWD)).toHaveLength(0);
  });

  it('row 45: a relative dir with a trailing slash', () => {
    expect(one('cd src/')).toMatchObject({ alts: ['src/'], span: 'src/' });
    expect(one('in webview/ and')).toMatchObject({ alts: ['webview/'] });
    expect(one('src/core/')).toMatchObject({ alts: ['src/core/'] });
    expect(detectPathTokens('a / b', CWD)).toHaveLength(0);
  });

  it('row 46: a bare dir name stays unlinked', () => {
    expect(detectPathTokens('repoA', CWD)).toHaveLength(0);
  });

  it('row 47: absolute dir keeps today', () => {
    expect(one('G:\\work\\repoA', undefined)).toMatchObject({ alts: ['G:/work/repoA'] });
    expect(one('G:\\work\\repoA\\', undefined)).toMatchObject({ alts: ['G:/work/repoA/'] });
  });

  it('row 48: a relative backslash path', () => {
    expect(one('src\\index.ts')).toMatchObject({ alts: ['src/index.ts'], span: 'src\\index.ts' });
  });

  it('row 49: diff-header a/ b/ prefixes stripped only on diff-header lines', () => {
    const git = detectPathTokens('diff --git a/src/x.ts b/src/x.ts', CWD);
    expect(git.map((t) => t.alts)).toEqual([['src/x.ts'], ['src/x.ts']]);
    expect(git.map((t) => t.start)).toEqual([13, 24]);
    expect(one('--- a/src/x.ts')).toMatchObject({ alts: ['src/x.ts'], span: 'src/x.ts' });
    expect(one('+++ b/src/x.ts')).toMatchObject({ alts: ['src/x.ts'] });
    expect(one('see a/src/x.ts')).toMatchObject({ alts: ['a/src/x.ts'] });
  });

  it('row 50: a scoped package path keeps today', () => {
    expect(one('@scope/pkg/index.ts')).toMatchObject({ alts: ['@scope/pkg/index.ts'] });
  });

  it('row 51: a URL wins — every path token lies inside the URL span the pane drops it for', () => {
    const line = 'http://localhost:3000/src/index.ts';
    const [url] = detectUrlTokens(line);
    expect(url.raw).toBe(line);
    for (const t of detectPathTokens(line, CWD)) {
      expect(t.start >= url.start && t.end <= url.end).toBe(true);
    }
  });

  it('~ paths need no cwd', () => {
    expect(one('~/foo/bar.ts', undefined)).toMatchObject({ alts: ['~/foo/bar.ts'] });
  });

  it('limits: the first 10 tokens by start; a token over 1024 chars is skipped', () => {
    const line = Array.from({ length: 11 }, (_, i) => `src/f${i}.ts`).join(' ');
    const tokens = detectPathTokens(line, CWD);
    expect(tokens).toHaveLength(MAX_PATH_TOKENS);
    expect(tokens[9].raw).toBe('src/f9.ts');
    const long = `src/${'a'.repeat(MAX_TOKEN_LENGTH - 6)}.ts`;
    expect(long.length).toBe(MAX_TOKEN_LENGTH + 1);
    expect(detectPathTokens(`${long} src/ok.ts`, CWD).map((t) => t.raw)).toEqual(['src/ok.ts']);
    expect(detectPathTokens(`src/a.ts ${'x'.repeat(MAX_LOGICAL_LINE)}`, CWD)).toHaveLength(0);
  });

  it('every token has raw === alts[0]', () => {
    const tokens = detectPathTokens('a/b.ts app/(g)/p.tsx Update(c/d.ts)', CWD);
    expect(tokens).toHaveLength(3);
    for (const t of tokens) expect(t.raw).toBe(t.alts[0]);
  });
});

// Plan T9.1 (v1 rows 18, 37, 40).
describe('detectPathTokens — v1 rows', () => {
  const CWD = '/w';
  const first = (line: string, cwd: string | undefined = CWD) => {
    const t = detectPathTokens(line, cwd)[0];
    return { ...t, span: line.slice(t.start, t.end) };
  };

  it('row 40: an extensionless absolute token extends over the next space-separated word', () => {
    const line = 'C:/Program Files/x/y.ts';
    expect(first(line)).toMatchObject({
      raw: 'C:/Program Files/x/y.ts',
      alts: ['C:/Program Files/x/y.ts', 'C:/Program'],
      altEnds: [23, 10],
      start: 0,
      span: line,
    });
  });

  it('row 40: up to 3 words, longest first (4 alts = MAX_ALTS)', () => {
    expect(first('/w/a b c d e/x.ts').alts).toEqual(['/w/a b c d', '/w/a b c', '/w/a b', '/w/a']);
  });

  it('row 40: backslashes fold; a :l suffix after the last word is the line', () => {
    expect(first('at C:\\Program Files\\x\\y.ts now').alts).toEqual([
      'C:/Program Files/x/y.ts now',
      'C:/Program Files/x/y.ts',
      'C:/Program',
    ]);
    const t = first('C:/Program Files/x/y.ts:12');
    expect(t).toMatchObject({ line: 12, span: 'C:/Program Files/x/y.ts:12' });
    expect(t.altEnds).toEqual([26, 10]);
  });

  it('row 40: sentence punctuation ends the extension', () => {
    expect(first('see /w/my dir, then more')).toMatchObject({
      alts: ['/w/my dir', '/w/my'],
      altEnds: [13, 9],
    });
  });

  it('row 40: a token whose last segment has an extension is not extended', () => {
    const t = first('error in /src/main.ts at line 3');
    expect(t.alts).toEqual(['/src/main.ts']);
    expect(t.altEnds).toBeUndefined();
    expect(first('/w/repoA/ next').alts).toEqual(['/w/repoA/']);
  });

  it('row 40: the following words stay their own tokens (the pane drops the overlap)', () => {
    expect(detectPathTokens('C:/Program Files/x/y.ts', CWD).map((t) => t.raw)).toEqual([
      'C:/Program Files/x/y.ts',
      'Files/x/y.ts',
    ]);
  });

  it('row 18: a backslash UNC path is detected, forward-slashed', () => {
    expect(first('open \\\\server\\share\\x.ts now', undefined)).toMatchObject({
      raw: '//server/share/x.ts',
      alts: ['//server/share/x.ts'],
      span: '\\\\server\\share\\x.ts',
    });
  });

  it('row 18: device forms are never detected', () => {
    for (const line of ['\\\\?\\C:\\x\\y.ts', '\\\\.\\pipe\\x', '//./pipe/x', '//?/C:/x/y.ts']) {
      expect(detectPathTokens(line, undefined)).toEqual([]);
    }
  });

  it('row 37: a tail-truncated last segment is one token', () => {
    expect(first('see src/util/a… for')).toMatchObject({ raw: 'src/util/a…', span: 'src/util/a…' });
  });
});
