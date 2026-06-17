import { describe, expect, it } from 'vitest';
import { formatPathForTerminal, TERMINAL_PATH_MIME } from '../../webview/terminal-drop';

describe('formatPathForTerminal', () => {
  it('normalizes to backslashes on Windows and adds a trailing space', () => {
    expect(formatPathForTerminal('C:\\proj/src/app.ts', true)).toBe('C:\\proj\\src\\app.ts ');
  });

  it('normalizes to forward slashes off Windows', () => {
    expect(formatPathForTerminal('/home/me/app.ts', false)).toBe('/home/me/app.ts ');
    expect(formatPathForTerminal('C:\\proj\\a.ts', false)).toBe('C:/proj/a.ts ');
  });

  it('double-quotes a path containing whitespace', () => {
    expect(formatPathForTerminal('C:\\my games/a.ts', true)).toBe('"C:\\my games\\a.ts" ');
    expect(formatPathForTerminal('/home/my files/a.ts', false)).toBe('"/home/my files/a.ts" ');
  });

  it('exposes a stable drag MIME type', () => {
    expect(TERMINAL_PATH_MIME).toBe('application/x-conduit-path');
  });
});
