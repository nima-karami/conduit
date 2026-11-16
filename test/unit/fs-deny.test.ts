import { describe, expect, it } from 'vitest';
import { isDenied } from '../../src/network/fs-deny';

// The deny-list is B's own, fixed and applied before any read (spec 5.3). Windows spellings are
// matched case-insensitively and separator-blind, POSIX paths exactly as given.

describe('isDenied', () => {
  it('refuses every deny-list entry', () => {
    const denied = [
      '/home/u/.ssh/id_rsa',
      '/home/u/proj/a/.gnupg/x',
      '/home/u/proj/.claude/settings.json',
      '/home/u/.claude.json',
      '/home/u/.codex/auth.json',
      '/home/u/proj/.cursor/x',
      '/home/u/.config/opencode/x',
      '/home/u/proj/.env',
      '/home/u/proj/.env.local',
      '/home/u/proj/.git/config',
      '/home/u/proj/.git',
      '/home/u/proj/sub/.git/objects/info/alternates',
      'C:\\Users\\u\\AppData\\Roaming\\Microsoft\\Credentials\\x',
    ];
    for (const p of denied) expect(isDenied(p), p).toBe(true);
  });

  it('leaves ordinary files and near-miss names alone', () => {
    const allowed = [
      '/home/u/proj/readme.md',
      '/home/u/proj/sshd.md',
      '/home/u/proj/my.env.md',
      '/home/u/proj/config/opencode.json',
      'C:\\Users\\u\\proj\\notes.txt',
    ];
    for (const p of allowed) expect(isDenied(p), p).toBe(false);
  });

  it('matches Windows spellings case-insensitively', () => {
    expect(isDenied('C:\\Users\\U\\APPDATA\\roaming\\microsoft\\CREDENTIALS\\x')).toBe(true);
    expect(isDenied('C:/Users/u/.SSH/id')).toBe(true);
  });

  it('matches POSIX names exactly', () => {
    expect(isDenied('/home/u/proj/.SSH/id')).toBe(false);
  });
});
