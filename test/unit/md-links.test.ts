import { describe, expect, it } from 'vitest';
import { isMdPath, resolveMdLink } from '../../webview/md-links';

// On Windows, path.sep is '\' and path.resolve produces backslash paths.
// We test with both Windows-style doc paths to verify normalisation.

const WIN_DOC = 'C:\\Users\\alice\\docs\\guide.md';
const POSIX_DOC = '/home/alice/docs/guide.md';

/**
 * Resolve a relative href against `doc` and assert it classified as a relative file
 * whose resolved path matches both the expected leaf name and an expected containing
 * directory. Returns the result so callers can make additional assertions.
 */
function expectRelativeFile(href: string, doc: string, match: { file: RegExp; dir: RegExp }) {
  const r = resolveMdLink(href, doc);
  expect(r.kind).toBe('relative-file');
  expect(r.resolvedPath).toMatch(match.file);
  expect(r.resolvedPath).toMatch(match.dir);
  return r;
}

describe('resolveMdLink — anchor links', () => {
  it('classifies #fragment as anchor', () => {
    const r = resolveMdLink('#introduction', WIN_DOC);
    expect(r.kind).toBe('anchor');
    expect(r.fragment).toBe('introduction');
    expect(r.resolvedPath).toBeUndefined();
  });

  it('handles bare # (empty fragment)', () => {
    const r = resolveMdLink('#', WIN_DOC);
    expect(r.kind).toBe('anchor');
    expect(r.fragment).toBe('');
  });
});

describe('resolveMdLink — external links', () => {
  it('classifies https:// as external', () => {
    expect(resolveMdLink('https://example.com', WIN_DOC).kind).toBe('external');
  });

  it('classifies http:// as external', () => {
    expect(resolveMdLink('http://example.com/path?q=1#h', WIN_DOC).kind).toBe('external');
  });

  it('external does not produce resolvedPath', () => {
    const r = resolveMdLink('https://example.com', WIN_DOC);
    expect(r.resolvedPath).toBeUndefined();
  });
});

describe('resolveMdLink — other schemes', () => {
  it('classifies mailto: as other', () => {
    expect(resolveMdLink('mailto:user@example.com', WIN_DOC).kind).toBe('other');
  });

  it('classifies javascript: as other', () => {
    expect(resolveMdLink('javascript:alert(1)', WIN_DOC).kind).toBe('other');
  });

  it('classifies data: as other', () => {
    expect(resolveMdLink('data:text/html,<h1>x</h1>', WIN_DOC).kind).toBe('other');
  });

  it('classifies tel: as other', () => {
    expect(resolveMdLink('tel:+15551234', WIN_DOC).kind).toBe('other');
  });

  it('classifies file: as other (security — we use our own resolution)', () => {
    expect(resolveMdLink('file:///etc/passwd', WIN_DOC).kind).toBe('other');
  });
});

describe('resolveMdLink — null / empty href', () => {
  it('returns other for empty string', () => {
    expect(resolveMdLink('', WIN_DOC).kind).toBe('other');
  });

  it('returns other for null', () => {
    expect(resolveMdLink(null, WIN_DOC).kind).toBe('other');
  });

  it('returns other for undefined', () => {
    expect(resolveMdLink(undefined, WIN_DOC).kind).toBe('other');
  });

  it('returns other for whitespace', () => {
    expect(resolveMdLink('   ', WIN_DOC).kind).toBe('other');
  });
});

describe('resolveMdLink — relative file paths (Windows doc path)', () => {
  it('resolves ./sibling.md', () => {
    // Resolved path should sit inside the same directory as the doc.
    expectRelativeFile('./sibling.md', WIN_DOC, { file: /sibling\.md$/i, dir: /docs/i });
  });

  it('resolves ../parent.md (../ traversal)', () => {
    const r = resolveMdLink('../parent.md', WIN_DOC);
    expect(r.kind).toBe('relative-file');
    // Should resolve one directory up from "docs"
    expect(r.resolvedPath).not.toContain('docs');
    expect(r.resolvedPath).toMatch(/parent\.md$/i);
  });

  it('resolves bare sibling.md', () => {
    const r = resolveMdLink('sibling.md', WIN_DOC);
    expect(r.kind).toBe('relative-file');
    expect(r.resolvedPath).toMatch(/sibling\.md$/i);
  });

  it('resolves subdirectory/child.md', () => {
    expectRelativeFile('subdirectory/child.md', WIN_DOC, {
      file: /child\.md$/i,
      dir: /subdirectory/,
    });
  });

  it('preserves no fragment when absent', () => {
    const r = resolveMdLink('./other.md', WIN_DOC);
    expect(r.fragment).toBe('');
  });

  it('strips fragment from resolved path, keeps fragment value', () => {
    const r = resolveMdLink('./other.md#section-1', WIN_DOC);
    expect(r.kind).toBe('relative-file');
    expect(r.resolvedPath).not.toContain('#');
    expect(r.fragment).toBe('section-1');
  });

  it('decodes %20 url-encoded spaces in href', () => {
    const r = resolveMdLink('./my%20doc.md', WIN_DOC);
    expect(r.kind).toBe('relative-file');
    expect(r.resolvedPath).toMatch(/my doc\.md$/i);
  });

  it('decodes %20 space in fragment', () => {
    const r = resolveMdLink('./doc.md#my%20heading', WIN_DOC);
    // Fragment is split before decode; resolve path does not include fragment
    expect(r.fragment).toBe('my%20heading'); // fragment left as-is (caller decodes if needed)
    expect(r.resolvedPath).not.toContain('%20');
  });
});

describe('resolveMdLink — relative file paths (POSIX doc path)', () => {
  it('resolves ./sibling.md from posix path', () => {
    const r = resolveMdLink('./sibling.md', POSIX_DOC);
    expect(r.kind).toBe('relative-file');
    expect(r.resolvedPath).toContain('sibling.md');
  });

  it('resolves ../up.md from posix path', () => {
    const r = resolveMdLink('../up.md', POSIX_DOC);
    expect(r.kind).toBe('relative-file');
    // One dir up from /home/alice/docs = /home/alice
    expect(r.resolvedPath).toContain('up.md');
    expect(r.resolvedPath).not.toContain('docs');
  });
});

describe('resolveMdLink — absolute Windows paths', () => {
  it('classifies C:\\path\\file.md as absolute-file', () => {
    const r = resolveMdLink('C:\\Users\\alice\\notes.md', WIN_DOC);
    expect(r.kind).toBe('absolute-file');
    expect(r.resolvedPath).toMatch(/notes\.md$/i);
  });

  it('classifies C:/path/file.md (forward slashes) as absolute-file', () => {
    const r = resolveMdLink('C:/Users/alice/notes.md', WIN_DOC);
    expect(r.kind).toBe('absolute-file');
    expect(r.resolvedPath).toMatch(/notes\.md$/i);
  });
});

describe('resolveMdLink — absolute POSIX paths', () => {
  it('classifies /absolute/path.md as absolute-file', () => {
    const r = resolveMdLink('/absolute/path.md', POSIX_DOC);
    expect(r.kind).toBe('absolute-file');
    expect(r.resolvedPath).toMatch(/path\.md$/i);
  });
});

describe('resolveMdLink — backslash doc paths', () => {
  it('handles doc path with backslash separators', () => {
    // Should resolve inside C:\projects\conduit\docs\.
    expectRelativeFile('./other.md', 'C:\\projects\\conduit\\docs\\README.md', {
      file: /other\.md$/i,
      dir: /conduit/i,
    });
  });

  it('handles multi-level traversal with backslash doc', () => {
    const r = resolveMdLink('../../root.md', 'C:\\a\\b\\c\\doc.md');
    expect(r.kind).toBe('relative-file');
    // C:\a\b\c\.. = C:\a\b, then C:\a\b\.. = C:\a
    expect(r.resolvedPath).toMatch(/root\.md$/i);
  });
});

describe('isMdPath', () => {
  it('returns true for .md files', () => {
    expect(isMdPath('README.md')).toBe(true);
    expect(isMdPath('C:\\docs\\guide.md')).toBe(true);
    expect(isMdPath('/home/alice/notes.MD')).toBe(true);
  });

  it('returns false for non-md files', () => {
    expect(isMdPath('index.ts')).toBe(false);
    expect(isMdPath('image.png')).toBe(false);
    expect(isMdPath('script.js')).toBe(false);
  });
});
