import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { emptySnapshot } from '../../server/compose';
import { runServer } from '../../server/main';
import { prepareRuntime } from '../../server/runtime-dir/prepare';
import { createServices } from '../../server/services';

vi.mock('../../server/services', () => ({ createServices: vi.fn() }));

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.clearAllMocks();
});

async function start(args: string[], platform: NodeJS.Platform = 'win32') {
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
  const server = await runServer(['--user-data', dir, ...args], { platform });
  cleanups.push(() => server.close?.() ?? Promise.resolve());
  return vi.mocked(createServices).mock.calls.at(-1)?.[0];
}

describe('server packaged MCP wiring', () => {
  it.each(['win32', 'darwin'] as const)(
    'the %s MCP executable is the Node file preparation copied',
    async (platform) => {
      const root = await mkdtemp(path.join(tmpdir(), 'shim-copy-'));
      cleanups.push(() => rm(root, { recursive: true, force: true }));
      const resourcesDir = path.join(root, 'resources');
      const binary = platform === 'win32' ? 'node.exe' : 'node';
      for (const [file, content] of [
        [`runtime/${binary}`, 'pinned-node'],
        [`runtime/hc/${platform === 'win32' ? 'conduit-hc.exe' : 'conduit-hc'}`, 'pinned-hc'],
        ['runtime/server/supervise.js', 'supervise'],
        ['conduit-mcp/conduit-mcp-shim.cjs', 'shim'],
      ]) {
        const target = path.join(resourcesDir, file);
        await mkdir(path.dirname(target), { recursive: true });
        await writeFile(target, content);
      }
      const prepared = await prepareRuntime({
        resourcesDir,
        userData: path.join(root, 'profile'),
        appVersion: 'test',
        hcVersion: '0.1.16',
        shimVersion: 1,
        platform,
        run: async () => {},
      });
      const options = await start(['--shim-dir', prepared.shimDir], platform);
      expect(options?.shim.execPath).toBe(path.join(prepared.shimDir, binary));
      expect(await readFile(options?.shim.execPath ?? '', 'utf8')).toBe('pinned-node');
      expect(options?.platform).toBe(platform);
    },
  );

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
