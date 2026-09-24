import { describe, expect, it } from 'vitest';
import { formatCommandLine, splitCommandLine } from '../../src/command-line';

const FIXTURES = [
  '',
  'a b',
  'C:\\a b\\',
  'say "hi"',
  "it's",
  'plain',
  'x&y',
  'tab\there',
  'a\\\\"b',
];

describe('formatCommandLine', () => {
  it('leaf drops .exe/.cmd/.bat any case', () => {
    expect(formatCommandLine({ command: 'C:\\x\\claude.CMD', args: [] }, 'win32')).toBe('claude');
    expect(formatCommandLine({ command: 'C:\\x\\Codex.exe', args: [] }, 'win32')).toBe('Codex');
    expect(formatCommandLine({ command: '/usr/bin/aider.bat', args: [] }, 'linux')).toBe('aider');
    expect(formatCommandLine({ command: 'pwsh', args: [] }, 'win32')).toBe('pwsh');
  });

  it('win32 path with a space quoted', () => {
    expect(
      formatCommandLine({ command: 'claude.exe', args: ['--add-dir', 'D:\\a b\\c'] }, 'win32'),
    ).toBe('claude --add-dir "D:\\a b\\c"');
  });

  it('win32 trailing backslash before closing quote doubled', () => {
    expect(formatCommandLine({ command: 'x', args: ['C:\\a b\\'] }, 'win32')).toBe(
      'x "C:\\a b\\\\"',
    );
    expect(formatCommandLine({ command: 'x', args: ['say "hi"'] }, 'win32')).toBe(
      'x "say \\"hi\\""',
    );
    expect(formatCommandLine({ command: 'x', args: ['C:\\plain\\'] }, 'win32')).toBe(
      'x C:\\plain\\',
    );
  });

  it("posix quote with '\\''", () => {
    expect(formatCommandLine({ command: '/bin/x', args: ["it's", 'ok', ''] }, 'linux')).toBe(
      "x 'it'\\''s' ok ''",
    );
  });

  it('round trip with splitCommandLine for each platform over the fixture list', () => {
    for (const p of ['win32', 'linux', 'darwin'] as const) {
      const line = formatCommandLine({ command: 'x', args: FIXTURES }, p);
      expect(line.startsWith('x ')).toBe(true);
      expect(splitCommandLine(line.slice(2), p), p).toEqual(FIXTURES);
    }
  });

  it('no args → leaf only', () => {
    expect(formatCommandLine({ command: '/opt/bin/claude', args: [] }, 'linux')).toBe('claude');
  });
});

describe('splitCommandLine', () => {
  it('win32 keeps backslashes: C:\\tools\\aider.exe --x', () => {
    expect(splitCommandLine('C:\\tools\\aider.exe --x', 'win32')).toEqual([
      'C:\\tools\\aider.exe',
      '--x',
    ]);
  });

  it('win32 quotes group: "C:\\a b\\c.exe" -m', () => {
    expect(splitCommandLine('"C:\\a b\\c.exe" -m', 'win32')).toEqual(['C:\\a b\\c.exe', '-m']);
  });

  it('win32 2n backslashes before a quote', () => {
    expect(splitCommandLine('a\\\\"b c"', 'win32')).toEqual(['a\\b c']);
  });

  it('win32 2n+1 → literal quote', () => {
    expect(splitCommandLine('a\\"b', 'win32')).toEqual(['a"b']);
  });

  it('win32 "" is an empty argument', () => {
    expect(splitCommandLine('x "" y', 'win32')).toEqual(['x', '', 'y']);
  });

  it('posix single quotes literal', () => {
    expect(splitCommandLine("'a\\b c'", 'linux')).toEqual(['a\\b c']);
  });

  it('posix double quotes group, backslash escapes quote', () => {
    expect(splitCommandLine('"say \\"hi\\"" \\$x "a\\b"', 'linux')).toEqual([
      'say "hi"',
      '$x',
      'a\\b',
    ]);
  });

  it('posix backslash escapes a space outside quotes', () => {
    expect(splitCommandLine('a\\ b c', 'darwin')).toEqual(['a b', 'c']);
  });

  it('tabs and runs of spaces separate', () => {
    for (const p of ['win32', 'linux'] as const) {
      expect(splitCommandLine('  a \t  b\t', p), p).toEqual(['a', 'b']);
    }
  });

  it('empty → []', () => {
    expect(splitCommandLine('', 'win32')).toEqual([]);
    expect(splitCommandLine('   ', 'linux')).toEqual([]);
  });
});
