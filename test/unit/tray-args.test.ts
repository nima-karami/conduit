import { describe, expect, it } from 'vitest';
import { seamEnabled, splitSupervisorArgs } from '../../server/tray/args';

describe('splitSupervisorArgs', () => {
  it('strips every tray flag with its value and keeps the rest in order', () => {
    const { tray, rest } = splitSupervisorArgs([
      '--user-data',
      '/u',
      '--tray',
      '/rt/tray/conduit-tray.exe',
      '--app-exe',
      '/app/electron.exe',
      '--app-arg',
      '/app/main',
      '--app-arg',
      '--e2e',
      '--app-cwd',
      '/work',
      '--hc',
      '/rt/hc.exe',
    ]);
    expect(rest).toEqual(['--user-data', '/u', '--hc', '/rt/hc.exe']);
    expect(tray).toEqual({
      source: '/rt/tray/conduit-tray.exe',
      app: { exe: '/app/electron.exe', args: ['/app/main', '--e2e'], cwd: '/work' },
    });
  });

  it('an --app-arg value of --e2e never reaches the server args', () => {
    const { rest } = splitSupervisorArgs([
      '--tray',
      't',
      '--app-arg',
      '--e2e',
      '--user-data',
      '/u',
    ]);
    expect(rest).not.toContain('--e2e');
    expect(seamEnabled(rest)).toBe(false);
  });

  it('accepts the --flag=value form', () => {
    const { tray, rest } = splitSupervisorArgs([
      '--tray=/t.exe',
      '--app-exe=/a',
      '--app-cwd=/c',
      '--x',
    ]);
    expect(tray).toEqual({ source: '/t.exe', app: { exe: '/a', args: [], cwd: '/c' } });
    expect(rest).toEqual(['--x']);
  });

  it('no --tray means no tray, but app flags are still stripped', () => {
    const { tray, rest } = splitSupervisorArgs(['--app-exe', '/a', '--user-data', '/u']);
    expect(tray).toBeNull();
    expect(rest).toEqual(['--user-data', '/u']);
  });

  it('app is null without both --app-exe and --app-cwd', () => {
    expect(splitSupervisorArgs(['--tray', '/t']).tray).toEqual({ source: '/t', app: null });
    expect(splitSupervisorArgs(['--tray', '/t', '--app-exe', '/a']).tray?.app).toBeNull();
  });

  it('a trailing flag without a value is stripped and ignored', () => {
    const { tray, rest } = splitSupervisorArgs(['--user-data', '/u', '--tray']);
    expect(tray).toBeNull();
    expect(rest).toEqual(['--user-data', '/u']);
  });
});

describe('seamEnabled', () => {
  it('needs --e2e and no --shim-dir', () => {
    expect(seamEnabled(['--e2e'])).toBe(true);
    expect(seamEnabled(['--e2e', '--shim-dir', '/s'])).toBe(false);
    expect(seamEnabled([])).toBe(false);
  });
});
