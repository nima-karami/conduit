import { describe, expect, it } from 'vitest';
import { splitCommandLine } from '../../src/command-line';

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
