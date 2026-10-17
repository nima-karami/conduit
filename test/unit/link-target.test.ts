import { describe, expect, it, vi } from 'vitest';
import { classifyLinkUri, decodeFileUri, dispatchLinkUri } from '../../src/link-target';

describe('classifyLinkUri', () => {
  it.each([
    ['https://x', 'external'],
    ['HTTP://x', 'external'],
    ['mailto:a@b', 'ignore'],
    ['file:///G:/a.ts', 'file'],
    ['FILE:///w/a.ts', 'file'],
    ['G:/a.ts', 'file'],
    ['G:\\a.ts', 'file'],
    ['/a.ts', 'file'],
    ['javascript:alert(1)', 'ignore'],
    ['JAVASCRIPT:alert(1)', 'ignore'],
    [' javascript:alert(1)', 'ignore'],
    ['data:text/html,<b>x</b>', 'ignore'],
    ['vscode://file/x', 'ignore'],
    ['conduit-preview://t/x', 'ignore'],
    ['src/a.ts', 'ignore'],
    ['', 'ignore'],
    ['G:', 'ignore'],
    ['\\\\host\\x', 'ignore'],
    ['//host/x', 'ignore'],
    ['\\\\?\\UNC\\h\\s\\x', 'ignore'],
    ['\\\\.\\pipe\\x', 'ignore'],
    ['\\\\?\\G:\\root\\x', 'ignore'],
  ] as const)('%j → %s', (uri, want) => {
    expect(classifyLinkUri(uri)).toBe(want);
  });
});

describe('decodeFileUri', () => {
  it('a win32 file URI decodes once and takes #L42 as the line', () => {
    expect(decodeFileUri('file:///G:/w/a%20b.ts#L42', 'win32')).toEqual({
      path: 'G:/w/a b.ts',
      line: 42,
    });
  });

  it('a lower-case drive is upper-cased and #L3C7 gives line and column', () => {
    expect(decodeFileUri('file:///g:/w/a.ts#L3C7', 'win32')).toEqual({
      path: 'G:/w/a.ts',
      line: 3,
      col: 7,
    });
  });

  it('a posix :l:c suffix gives line and column', () => {
    expect(decodeFileUri('file:///w/a.ts:3:4', 'posix')).toEqual({
      path: '/w/a.ts',
      line: 3,
      col: 4,
    });
  });

  it('localhost is the empty authority, in any case', () => {
    expect(decodeFileUri('file://localhost/w/a.ts', 'posix')).toEqual({ path: '/w/a.ts' });
    expect(decodeFileUri('file://LOCALHOST/w/a.ts', 'posix')).toEqual({ path: '/w/a.ts' });
  });

  it('the single-slash form file:/abs is accepted', () => {
    expect(decodeFileUri('file:/w/a.ts', 'posix')).toEqual({ path: '/w/a.ts' });
  });

  it('a foreign host is refused (no UNC via file://host/)', () => {
    expect(decodeFileUri('file://evil/share/a', 'win32')).toBeNull();
    expect(decodeFileUri('file://evil/share/a', 'posix')).toBeNull();
    expect(decodeFileUri('file://127.0.0.1/w/a', 'posix')).toBeNull();
  });

  it('an encoded .. is decoded and normalised, never hidden (confinement refuses it)', () => {
    expect(decodeFileUri('file:///w/%2e%2e/etc/passwd', 'posix')).toEqual({ path: '/etc/passwd' });
    expect(decodeFileUri('file:///G:/w/%2E%2E/x', 'win32')).toEqual({ path: 'G:/x' });
  });

  it('a decoded NUL (or any C0 control) is refused', () => {
    expect(decodeFileUri('file:///w/a%00b', 'posix')).toBeNull();
    expect(decodeFileUri('file:///w/a%0Ab', 'posix')).toBeNull();
    expect(decodeFileUri('/w/a\u0000b', 'posix')).toBeNull();
  });

  it('decodes exactly once', () => {
    expect(decodeFileUri('file:///w/%252F', 'posix')).toEqual({ path: '/w/%2F' });
    expect(decodeFileUri('file:///w/%255C%255Chost', 'win32')).toEqual({ path: '/w/%5C%5Chost' });
  });

  it('malformed percent-encoding is refused', () => {
    expect(decodeFileUri('file:///w/%E0%A4%A', 'posix')).toBeNull();
  });

  it('a relative file URI is refused', () => {
    expect(decodeFileUri('file:relative', 'posix')).toBeNull();
    expect(decodeFileUri('file:relative/a.ts', 'win32')).toBeNull();
  });

  it.each([
    'file:////host/share/x',
    'file://///host/share/x',
    'file:///%5C%5Chost/x',
    'file:///%5c%5chost%5cx',
    'file:///%5C%5C%3F%5CUNC%5Ch%5Cs',
    'file:///%5C%5C.%5Cpipe%5Cx',
    'file:///%2F%2Fhost/x',
    'file:///G:/../../%2F%2Fhost/x',
    'file:///G:/w/%2F%2Fhost/x',
    '\\\\host\\x',
    '//host/x',
    '\\\\?\\G:\\root\\x',
    '//?/G:/root/x',
    '\\\\.\\x',
    '\\\\?\\UNC\\h\\s\\x',
  ])('UNC / device form %j is refused on both platforms', (uri) => {
    expect(decodeFileUri(uri, 'win32')).toBeNull();
    expect(decodeFileUri(uri, 'posix')).toBeNull();
  });

  it('a scheme-less win32 path keeps its case (confinement folds it) and is not decoded', () => {
    expect(decodeFileUri('G:\\ROOT\\x', 'win32')).toEqual({ path: 'G:/ROOT/x' });
    expect(decodeFileUri('/w/a%20b.ts', 'posix')).toEqual({ path: '/w/a%20b.ts' });
  });

  it('a scheme-less path takes a :l:c suffix', () => {
    expect(decodeFileUri('G:/w/a.ts:12', 'win32')).toEqual({ path: 'G:/w/a.ts', line: 12 });
  });

  it('a query is dropped and an unknown fragment ignored', () => {
    expect(decodeFileUri('file:///w/a.ts?x=1#top', 'posix')).toEqual({ path: '/w/a.ts' });
  });

  it('anything that is not a file URI or an absolute path is null', () => {
    expect(decodeFileUri('https://x/a.ts', 'posix')).toBeNull();
    expect(decodeFileUri('javascript:alert(1)', 'posix')).toBeNull();
    expect(decodeFileUri('src/a.ts', 'posix')).toBeNull();
    expect(decodeFileUri('', 'posix')).toBeNull();
  });
});

describe('dispatchLinkUri', () => {
  const sinks = (hasBridge: boolean) => ({
    openFile: vi.fn(),
    openExternal: vi.fn(() => hasBridge),
    windowOpen: vi.fn(),
  });

  it.each(['javascript:alert(1)', 'data:text/html,x', 'vscode://file/x', 'src/a.ts', '//host/x'])(
    '%j reaches no sink, with or without the bridge (no window.open fallback)',
    (uri) => {
      for (const bridge of [true, false]) {
        const s = sinks(bridge);
        expect(dispatchLinkUri(uri, s)).toBe('ignore');
        expect(s.openFile).not.toHaveBeenCalled();
        expect(s.openExternal).not.toHaveBeenCalled();
        expect(s.windowOpen).not.toHaveBeenCalled();
      }
    },
  );

  it('a file URI goes to openFile only, never openExternal or window.open', () => {
    for (const bridge of [true, false]) {
      const s = sinks(bridge);
      expect(dispatchLinkUri('file:///w/a.ts', s)).toBe('file');
      expect(s.openFile).toHaveBeenCalledWith('file:///w/a.ts');
      expect(s.openExternal).not.toHaveBeenCalled();
      expect(s.windowOpen).not.toHaveBeenCalled();
    }
  });

  it('an external URI goes to the host, and to window.open only without the bridge', () => {
    const withBridge = sinks(true);
    dispatchLinkUri('https://x', withBridge);
    expect(withBridge.openExternal).toHaveBeenCalledWith('https://x');
    expect(withBridge.windowOpen).not.toHaveBeenCalled();
    const without = sinks(false);
    dispatchLinkUri('https://x', without);
    expect(without.windowOpen).toHaveBeenCalledWith('https://x');
    expect(without.openFile).not.toHaveBeenCalled();
  });

  // T8.4 security r1 H1: an OSC 8 label can hide its target, so a hidden mailto: never leaves;
  // a printed one is never linkified, so no path dispatches mailto at all (v1 review r3 SF-2).
  it('a mailto: reaches no sink from any path', () => {
    for (const bridge of [true, false]) {
      const s = sinks(bridge);
      expect(dispatchLinkUri('mailto:a@b', s)).toBe('ignore');
      expect(dispatchLinkUri('MAILTO:a@b', s)).toBe('ignore');
      expect(s.openFile).not.toHaveBeenCalled();
      expect(s.openExternal).not.toHaveBeenCalled();
      expect(s.windowOpen).not.toHaveBeenCalled();
    }
  });
});
