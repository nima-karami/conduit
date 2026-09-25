import { describe, expect, it } from 'vitest';
import { launchArgsFor } from '../../src/launch-args';

const def = (command: string, args: string[] = []) => ({ command, args });

describe('launchArgsFor', () => {
  it('claude, C:\\x\\claude.cmd, /usr/bin/CLAUDE.EXE match', () => {
    for (const command of ['claude', 'C:\\x\\claude.cmd', '/usr/bin/CLAUDE.EXE']) {
      const r = launchArgsFor(def(command), ['/r'], {
        platform: 'linux',
        resolvedCommand: command,
      });
      expect(r.addDir, command).toBe(true);
      expect(r.args, command).toEqual(['--add-dir', '/r']);
    }
  });

  it('id my-claude with command codex → addDir false', () => {
    const r = launchArgsFor(def('codex', ['--x']), ['/r'], {
      platform: 'linux',
      resolvedCommand: 'codex',
    });
    expect(r).toEqual({ addDir: false, args: ['--x'], launchedRoots: [], skippedAddDirRoots: [] });
  });

  it('repeated --add-dir after def.args, roots order', () => {
    const r = launchArgsFor(def('claude', ['--resume']), ['/b', '/a'], {
      platform: 'linux',
      resolvedCommand: '/usr/bin/claude',
    });
    expect(r.args).toEqual(['--resume', '--add-dir', '/b', '--add-dir', '/a']);
    expect(r.launchedRoots).toEqual(['/b', '/a']);
    expect(r.skippedAddDirRoots).toEqual([]);
  });

  it('win32 + resolved .cmd + R&D → skipped and reported', () => {
    const r = launchArgsFor(def('claude'), ['C:\\ok', 'C:\\R&D'], {
      platform: 'win32',
      resolvedCommand: 'C:\\bin\\claude.CMD',
    });
    expect(r.args).toEqual(['--add-dir', 'C:\\ok']);
    expect(r.launchedRoots).toEqual(['C:\\ok']);
    expect(r.skippedAddDirRoots).toEqual(['C:\\R&D']);
  });

  it('win32 + resolved .bat + a!b → skipped', () => {
    const r = launchArgsFor(def('claude'), ['C:\\a!b'], {
      platform: 'win32',
      resolvedCommand: 'C:\\bin\\claude.bat',
    });
    expect(r.args).toEqual([]);
    expect(r.skippedAddDirRoots).toEqual(['C:\\a!b']);
  });

  it('win32 + resolved claude.exe + R&D → passed', () => {
    const r = launchArgsFor(def('claude'), ['C:\\R&D'], {
      platform: 'win32',
      resolvedCommand: 'C:\\bin\\claude.exe',
    });
    expect(r.args).toEqual(['--add-dir', 'C:\\R&D']);
    expect(r.skippedAddDirRoots).toEqual([]);
  });

  it('win32 + unresolved → guarded', () => {
    const r = launchArgsFor(def('claude'), ['C:\\R&D'], {
      platform: 'win32',
      resolvedCommand: undefined,
    });
    expect(r.args).toEqual([]);
    expect(r.skippedAddDirRoots).toEqual(['C:\\R&D']);
  });

  it('linux + R&D → passed', () => {
    const r = launchArgsFor(def('claude'), ['/R&D'], {
      platform: 'linux',
      resolvedCommand: undefined,
    });
    expect(r.args).toEqual(['--add-dir', '/R&D']);
    expect(r.skippedAddDirRoots).toEqual([]);
  });

  it('each of " % & | < > ^ ! trips the guard', () => {
    for (const ch of ['"', '%', '&', '|', '<', '>', '^', '!']) {
      const root = `C:\\a${ch}b`;
      const r = launchArgsFor(def('claude'), [root, 'C:\\plain'], {
        platform: 'win32',
        resolvedCommand: 'C:\\bin\\claude.cmd',
      });
      expect(r.skippedAddDirRoots, ch).toEqual([root]);
      expect(r.launchedRoots, ch).toEqual(['C:\\plain']);
    }
  });
});
