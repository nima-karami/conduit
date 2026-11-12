import { describe, expect, it } from 'vitest';
import {
  defaultShellAgent,
  e2ePlatformSupported,
  isShellPromptLine,
  parseSttySize,
  revealLabel,
  uriPathKey,
  windowsOnlySkipMessage,
} from '../e2e/platform.mjs';

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

describe('windowsOnlySkipMessage', () => {
  it('is null on win32 so the scenario runs', () => {
    expect(windowsOnlySkipMessage('attention', 'cmd.exe shell sessions', 'win32')).toBeNull();
  });

  it('names the scenario and the Windows-only reason elsewhere', () => {
    expect(windowsOnlySkipMessage('attention', 'cmd.exe shell sessions', 'linux')).toBe(
      '[attention] SKIP — Windows-only: cmd.exe shell sessions',
    );
    expect(windowsOnlySkipMessage('paste', 'ConPTY bracketed paste', 'darwin')).toBe(
      '[paste] SKIP — Windows-only: ConPTY bracketed paste',
    );
  });
});

describe('uriPathKey', () => {
  it('normalises separators and prefixes a missing slash on every platform', () => {
    expect(uriPathKey('src\\a.ts', 'linux')).toBe('/src/a.ts');
    expect(uriPathKey('/src/a.ts', 'linux')).toBe('/src/a.ts');
    expect(uriPathKey('C:\\Repo\\A.ts', 'win32')).toBe('/c:/repo/a.ts');
  });

  it('lowercases only on win32, where paths are case-insensitive', () => {
    expect(uriPathKey('/Home/Me/Main.go', 'linux')).toBe('/Home/Me/Main.go');
    expect(uriPathKey('/Home/Me/Main.go', 'win32')).toBe('/home/me/main.go');
  });
});

describe('shellPromptPattern / isShellPromptLine', () => {
  it('matches cmd.exe prompts only on win32', () => {
    expect(isShellPromptLine('C:\\repo>', 'win32')).toBe(true);
    expect(isShellPromptLine('C:\\repo> ', 'win32')).toBe(true);
    expect(isShellPromptLine('user@host:~$ ', 'win32')).toBe(false);
  });

  it('matches $ and # prompts on POSIX', () => {
    expect(isShellPromptLine('user@host:~/repo$ ', 'linux')).toBe(true);
    expect(isShellPromptLine('root# ', 'linux')).toBe(true);
    expect(isShellPromptLine('C:\\repo>', 'linux')).toBe(false);
    expect(isShellPromptLine('build output', 'linux')).toBe(false);
  });
});

describe('revealLabel', () => {
  it('matches the product wording per platform', () => {
    expect(revealLabel('win32')).toBe('Reveal in Explorer');
    expect(revealLabel('darwin')).toBe('Reveal in Finder');
    expect(revealLabel('linux')).toBe('Show in Files');
  });
});
