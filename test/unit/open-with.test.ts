import { describe, expect, it } from 'vitest';
import { openWithCommand } from '../../src/open-with';

describe('openWithCommand', () => {
  it('builds the Windows OpenAs_RunDLL chooser command', () => {
    expect(openWithCommand('win32', 'C:\\a\\b.txt')).toEqual({
      command: 'rundll32.exe',
      args: ['shell32.dll,OpenAs_RunDLL', 'C:\\a\\b.txt'],
    });
  });

  it('passes the path through as a single argv entry (no shell interpolation)', () => {
    const cmd = openWithCommand('win32', 'C:\\with space\\a & b.txt');
    expect(cmd?.args[1]).toBe('C:\\with space\\a & b.txt');
  });

  it('returns null off-Windows so the caller falls back to the default app', () => {
    expect(openWithCommand('darwin', '/tmp/a.txt')).toBeNull();
    expect(openWithCommand('linux', '/tmp/a.txt')).toBeNull();
  });
});
