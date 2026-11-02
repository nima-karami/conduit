import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { emptySnapshot } from '../../server/compose';
import type { ShellCore } from '../../server/lifecycle/shell';
import { runServer } from '../../server/main';

const directories: string[] = [];
const closes: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of closes.splice(0)) await close();
  for (const dir of directories.splice(0)) await rm(dir, { recursive: true, force: true });
});
async function profile() {
  const scratch = path.join(tmpdir(), 'Codex-scratch');
  await mkdir(scratch, { recursive: true });
  const dir = await mkdtemp(path.join(scratch, 'w3-entry-'));
  directories.push(dir);
  return dir;
}
function core(): ShellCore {
  return {
    start: vi.fn<ShellCore['start']>(() => new Promise(() => {})),
    beginStopping: vi.fn(async () => {}),
    killSessions: vi.fn(async () => 0),
    persist: vi.fn(async () => {}),
    snapshot: emptySnapshot,
    idleState: vi.fn(async () => ({ liveTerminals: 0, pendingTimers: false, busyTokens: false })),
  };
}

describe('server entry wiring', () => {
  it('binds the lock before invoking startup and exits a second instance with zero', async () => {
    const dir = await profile();
    const firstCore = core();
    const first = await runServer(['--user-data', dir], { core: firstCore });
    expect(first.transport).toBeDefined();
    if (!first.transport) throw new Error('missing transport');
    closes.push(() => first.close?.() ?? Promise.resolve());
    const secondCore = core();
    const second = await runServer(['--user-data', dir], { core: secondCore });
    expect(second.code).toBe(0);
    expect(secondCore.start).not.toHaveBeenCalled();
    expect(firstCore.start).toHaveBeenCalledTimes(1);
  });

  it('routes --stop-all through the live server without using the direct fallback', async () => {
    const dir = await profile();
    const x = core();
    vi.mocked(x.killSessions).mockResolvedValue(5);
    const exit = vi.fn();
    const server = await runServer(['--user-data', dir], { core: x, exit });
    expect(server.transport).toBeDefined();
    closes.push(() => server.close?.() ?? Promise.resolve());
    const directFallback = vi.fn(async () => 10);
    const stopped = await runServer(['--user-data', dir, '--stop-all'], { directFallback });
    expect(stopped.code).toBe(0);
    expect(directFallback).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(3));
  });

  it('rejects launches without the explicit profile required for instance isolation', async () => {
    await expect(runServer([])).rejects.toThrow('--user-data');
  });
});
