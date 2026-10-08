import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type BoundedChild, type BoundedSpawn, execFileBounded } from '../../electron/exec-bounded';
import type { TreeKillDeps } from '../../electron/process-tree';

function harness(platform: NodeJS.Platform = 'win32') {
  const stdout = new PassThrough();
  const child = Object.assign(new EventEmitter(), { pid: 777, stdout }) as BoundedChild &
    EventEmitter;
  const spawn = vi.fn<BoundedSpawn>(() => child);
  const tree = {
    platform,
    systemRoot: 'C:\\Windows',
    execFile: vi.fn((_f: string, _a: string[], _o: unknown, cb: (e: Error | null) => void) =>
      cb(null),
    ),
    execFileSync: vi.fn(),
    kill: vi.fn(),
  } as unknown as TreeKillDeps;
  const run = execFileBounded(
    '/bin/rust-analyzer',
    ['--version'],
    { cwd: '/tmp', env: { PATH: '/bin' }, timeout: 5_000 },
    { spawn, tree },
  );
  let state: 'pending' | 'resolved' | 'rejected' = 'pending';
  run.then(
    () => {
      state = 'resolved';
    },
    () => {
      state = 'rejected';
    },
  );
  return { child, stdout, spawn, tree, run, state: () => state };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('execFileBounded', () => {
  it('resolves stdout when the process closes with 0; no shell, hidden, cwd + env passed', async () => {
    const h = harness();
    h.stdout.write('rust-analyzer 1.98.1\n');
    h.child.emit('exit', 0, null);
    h.child.emit('close', 0, null);
    await expect(h.run).resolves.toBe('rust-analyzer 1.98.1\n');
    expect(h.spawn).toHaveBeenCalledWith('/bin/rust-analyzer', ['--version'], {
      cwd: '/tmp',
      env: { PATH: '/bin' },
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
      detached: false,
    });
  });

  it('a non-zero exit settles at exit even while a grandchild holds the pipe open', async () => {
    const h = harness();
    h.child.emit('exit', 1, null);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.state()).toBe('rejected');
  });

  it('a hang kills the whole tree by pid at the timeout and settles without waiting for close', async () => {
    const h = harness();
    await vi.advanceTimersByTimeAsync(4_999);
    expect(h.state()).toBe('pending');
    await vi.advanceTimersByTimeAsync(1);
    expect(h.state()).toBe('rejected');
    expect(h.tree.execFile).toHaveBeenCalledWith(
      'C:\\Windows\\System32\\taskkill.exe',
      ['/PID', '777', '/T', '/F'],
      expect.anything(),
      expect.any(Function),
    );
  });

  it('a spawn error rejects', async () => {
    const h = harness();
    h.child.emit('error', new Error('ENOENT'));
    await expect(h.run).rejects.toThrow('ENOENT');
  });

  it('posix probes are spawned detached so the group kill reaches every child', () => {
    const h = harness('linux');
    expect(h.spawn.mock.calls[0]?.[2]).toMatchObject({ detached: true });
    h.child.emit('close', 0, null);
  });
});
