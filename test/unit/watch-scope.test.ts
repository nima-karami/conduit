import { describe, expect, it } from 'vitest';
import { isBroadWatchRoot } from '../../src/watch-scope';

describe('isBroadWatchRoot', () => {
  it('the home directory, in any spelling', () => {
    const home = 'C:\\Users\\karam';
    for (const d of ['C:\\Users\\karam', 'c:/users/karam/', 'C:/Users/Karam'])
      expect(isBroadWatchRoot(d, home)).toBe(true);
    expect(isBroadWatchRoot('/home/runner', '/home/runner/')).toBe(true);
  });

  it('a posix home is case-sensitive, like every posix folder key', () => {
    expect(isBroadWatchRoot('/home/Runner', '/home/runner')).toBe(false);
  });

  it('filesystem roots: posix, drive, UNC share, long-path drive', () => {
    for (const d of [
      '/',
      'C:\\',
      'd:',
      'D:/',
      '\\\\server\\share',
      '\\\\server\\share\\',
      '\\\\?\\C:\\',
    ])
      expect(isBroadWatchRoot(d, undefined)).toBe(true);
  });

  it('a project inside home, a folder above it, or a UNC subfolder is a normal watch', () => {
    const home = 'C:\\Users\\karam';
    for (const d of [
      'C:\\Users\\karam\\src\\app',
      'C:\\Users',
      'C:\\Users\\karamx',
      '\\\\server\\share\\repo',
      '/home',
    ])
      expect(isBroadWatchRoot(d, home)).toBe(false);
  });
});
