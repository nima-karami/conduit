import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { emptySnapshot } from '../../server/compose';
import { runServer } from '../../server/main';
import { createServices } from '../../server/services';

vi.mock('../../server/services', () => ({ createServices: vi.fn() }));

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.clearAllMocks();
});

async function start(args: string[]) {
  const dir = await mkdtemp(path.join(tmpdir(), 'pkgfix-main-'));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  vi.mocked(createServices, { partial: true }).mockReturnValue({
    core: {
      start: async () => ({ state: 'ready', hcVersion: 'test' }),
      beginStopping: async () => {},
      killSessions: async () => 0,
      persist: async () => {},
      idleState: async () => ({ liveTerminals: 0, pendingTimers: false, busyTokens: false }),
      snapshot: emptySnapshot,
    },
    dispatch: async () => ({ result: {} }),
    connected: () => {},
    disconnected: () => {},
    close: async () => {},
  });
  const server = await runServer(['--user-data', dir, ...args]);
  cleanups.push(() => server.close?.() ?? Promise.resolve());
  return vi.mocked(createServices).mock.calls.at(-1)?.[0];
}

describe('server packaged MCP wiring', () => {
  it('uses the write-once shim generation for install entries and session launch dependencies', async () => {
    const shimDir = path.join('/profile with spaces', 'runtime', 'shim-2');
    const previous = {
      execPath: path.join('/installed app', 'Conduit.exe'),
      shimPath: path.join('/installed app', 'resources', 'conduit-mcp', 'conduit-mcp-shim.cjs'),
    };
    const options = await start([
      '--shim-dir',
      shimDir,
      '--previous-exe',
      previous.execPath,
      '--previous-shim',
      previous.shimPath,
    ]);
    expect(options).toMatchObject({
      shim: {
        execPath: path.join(shimDir, 'node.exe'),
        shimPath: path.join(shimDir, 'conduit-mcp-shim.cjs'),
      },
      packaged: true,
      previousShims: [previous],
    });
  });

  it('keeps the repository shim and disables startup install for unpackaged starts', async () => {
    const options = await start([]);
    expect(options).toMatchObject({
      shim: {
        execPath: process.execPath,
        shimPath: path.resolve(__dirname, '../../../resources/conduit-mcp/conduit-mcp-shim.cjs'),
      },
      packaged: false,
      previousShims: [],
    });
  });
});
