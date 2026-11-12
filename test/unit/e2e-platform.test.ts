import { describe, expect, it } from 'vitest';
import { defaultShellAgent, e2ePlatformSupported, parseSttySize } from '../e2e/platform.mjs';

describe('e2ePlatformSupported', () => {
  it('runs the suite on Windows and Linux, SKIPs elsewhere', () => {
    expect(e2ePlatformSupported('win32')).toBe(true);
    expect(e2ePlatformSupported('linux')).toBe(true);
    expect(e2ePlatformSupported('darwin')).toBe(false);
  });
});

describe('defaultShellAgent', () => {
  it('is cmd on Windows and bash elsewhere', () => {
    expect(defaultShellAgent('win32')).toBe('shell:cmd');
    expect(defaultShellAgent('linux')).toBe('shell:bash');
  });
});

describe('parseSttySize', () => {
  it('reads "<rows> <cols>" with CRLF or LF and surrounding noise', () => {
    expect(parseSttySize('echo PROBE\r\nPROBE\r\n50 132\r\nuser@host:~$ ')).toEqual({
      rows: 50,
      cols: 132,
    });
    expect(parseSttySize('24 80\n')).toEqual({ rows: 24, cols: 80 });
  });

  it('returns null when no size line is present', () => {
    expect(parseSttySize('PROBE\r\nuser@host:~$ ')).toBeNull();
    expect(parseSttySize('')).toBeNull();
  });
});
