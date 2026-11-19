import { spawn, spawnSync } from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ app: {} }));

import { relaunchBinary, waiterArgv } from '../../electron/relaunch';

describe('relaunchBinary', () => {
  it('prefers the AppImage file over the mounted executable', () => {
    expect(relaunchBinary({ APPIMAGE: '/home/u/Conduit.AppImage' }, '/tmp/.mount_x/conduit')).toBe(
      '/home/u/Conduit.AppImage',
    );
  });

  it('uses the executable when not an AppImage', () => {
    expect(relaunchBinary({}, '/opt/Conduit/conduit')).toBe('/opt/Conduit/conduit');
    expect(relaunchBinary({ APPIMAGE: '' }, '/opt/Conduit/conduit')).toBe('/opt/Conduit/conduit');
  });
});

describe('waiterArgv', () => {
  it('rejects a pid that would break the script', () => {
    expect(() => waiterArgv(0, '/bin/x', [])).toThrow();
    expect(() => waiterArgv(1.5, '/bin/x', [])).toThrow();
  });

  it('waits for the pid to exit, then execs the binary with args verbatim', () => {
    const sleeper = spawnSync('/bin/sh', ['-c', 'echo $$'], { encoding: 'utf8' });
    const deadPid = Number(sleeper.stdout.trim());
    const args = ['--flag', 'two words', '$HOME', '"q"'];
    const result = spawnSync(
      '/bin/sh',
      waiterArgv(deadPid, '/bin/sh', ['-c', 'printf "%s|" "$@"', 'argv0', ...args]),
      { encoding: 'utf8', timeout: 5000 },
    );
    expect(result.status).toBe(0);
    expect(result.stdout).toBe(`${args.join('|')}|`);
  });
});

describe('waiterArgv with a live pid', () => {
  it('does not exec until the pid has exited', async () => {
    const holder = spawn('/bin/sh', ['-c', 'read _'], { stdio: ['pipe', 'ignore', 'ignore'] });
    if (holder.pid === undefined) throw new Error('holder did not start');
    const waiter = spawn('/bin/sh', waiterArgv(holder.pid, '/bin/sh', ['-c', 'echo ran']), {
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    let out = '';
    waiter.stdout.on('data', (chunk) => (out += chunk));
    await new Promise((r) => setTimeout(r, 300));
    expect(out).toBe('');
    holder.stdin.end();
    await new Promise((r) => waiter.on('exit', r));
    expect(out).toBe('ran\n');
  });
});
