import { describe, expect, it, vi } from 'vitest';
import { killTree, killTreeSync, type TreeKillDeps } from '../../electron/process-tree';

function deps(over: Partial<TreeKillDeps> = {}) {
  const execFile = vi.fn((_f: string, _a: string[], _o: unknown, cb: (e: Error | null) => void) =>
    cb(null),
  );
  const execFileSync = vi.fn();
  const kill = vi.fn();
  const d = {
    platform: 'win32',
    systemRoot: 'C:\\Windows',
    execFile,
    execFileSync,
    kill,
    ...over,
  } as unknown as TreeKillDeps;
  return { d, execFile, execFileSync, kill };
}

describe('killTree', () => {
  it('win32 runs taskkill by absolute path with /T /F', async () => {
    const { d, execFile } = deps();
    expect(await killTree(4242, d)).toBe(true);
    expect(execFile).toHaveBeenCalledWith(
      'C:\\Windows\\System32\\taskkill.exe',
      ['/PID', '4242', '/T', '/F'],
      expect.objectContaining({ windowsHide: true }),
      expect.any(Function),
    );
  });

  it('posix kills the negative pid', async () => {
    const { d, kill, execFile } = deps({ platform: 'linux' });
    expect(await killTree(77, d)).toBe(true);
    expect(kill).toHaveBeenCalledWith(-77, 'SIGKILL');
    expect(execFile).not.toHaveBeenCalled();
  });

  it('sync variant uses execFileSync', () => {
    const { d, execFileSync, execFile } = deps();
    expect(killTreeSync(9, d)).toBe(true);
    expect(execFileSync).toHaveBeenCalledWith(
      'C:\\Windows\\System32\\taskkill.exe',
      ['/PID', '9', '/T', '/F'],
      expect.objectContaining({ windowsHide: true }),
    );
    expect(execFile).not.toHaveBeenCalled();
    const posix = deps({ platform: 'darwin' });
    expect(killTreeSync(9, posix.d)).toBe(true);
    expect(posix.kill).toHaveBeenCalledWith(-9, 'SIGKILL');
  });

  it('an exec failure resolves false, never throws', async () => {
    const failing = deps({
      execFile: ((_f: string, _a: string[], _o: unknown, cb: (e: Error | null) => void) =>
        cb(new Error('not found'))) as unknown as TreeKillDeps['execFile'],
      execFileSync: (() => {
        throw new Error('exit 128');
      }) as unknown as TreeKillDeps['execFileSync'],
    });
    expect(await killTree(1, failing.d)).toBe(false);
    expect(killTreeSync(1, failing.d)).toBe(false);
    const throwing = deps({
      execFile: (() => {
        throw new Error('EACCES');
      }) as unknown as TreeKillDeps['execFile'],
    });
    expect(await killTree(1, throwing.d)).toBe(false);
    const gone = deps({
      platform: 'linux',
      kill: () => {
        throw new Error('ESRCH');
      },
    });
    expect(await killTree(1, gone.d)).toBe(false);
  });
});
