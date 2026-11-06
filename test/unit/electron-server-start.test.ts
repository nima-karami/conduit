import { readFileSync } from 'node:fs';
import path from 'node:path';
import { runInNewContext } from 'node:vm';
import { transformSync } from 'esbuild';
import { describe, expect, it, vi } from 'vitest';
import { supervisorArgs, supervisorEnv } from '../../electron/hc-cli';
import type { ServerLifecycleDeps } from '../../electron/server-lifecycle';
import { SHIM_LEAF } from '../../src/conduit-mcp/install-entries';

// Run the production startup boundary without loading Electron's native UI and global app setup.
const source = readFileSync(path.resolve(__dirname, '../../electron/main.ts'), 'utf8');
const start = source.match(/^ {2}async function startServer\([\s\S]*?^ {2}\}/m)?.[0];
if (!start) throw new Error('missing production startServer');
const startupCode = transformSync(start, { loader: 'ts', target: 'es2022' }).code;

async function harness(packaged: boolean, e2e = false, env: Record<string, string> = {}) {
  let lifecycleDeps: ServerLifecycleDeps | undefined;
  const layout = {
    nodeExe: '/runtime/version/node.exe',
    superviseJs: '/runtime/version/server/supervise.js',
    hcExe: '/runtime/hc/hc.exe',
    hcVersion: 'test',
    coreCwd: '/runtime/hc',
  };
  const prepareRuntime = vi.fn(async () => ({ ...layout, shimDir: '/runtime/shim-2' }));
  const spawn = vi.fn(() => ({ on: vi.fn(), unref: vi.fn() }));
  const dependencies = {
    app: { isPackaged: packaged, getAppPath: () => '/app' },
    aboutInfo: { version: 'test' },
    userData: () => '/profile',
    process: { execPath: '/installed/Conduit.exe', resourcesPath: '/installed/resources', env },
    prepareRuntime,
    CURRENT_SHIM_GENERATION: 2,
    HC_PINNED_VERSION: 'test',
    SHIM_LEAF,
    runtimeLayout: () => layout,
    names: { runtimeRoot: '/runtime' },
    collectRuntimeGarbage: async () => ({ removed: [], inUse: [] }),
    fs: { promises: {} },
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    e2e,
    path,
    SERVER_EXHAUSTED_FILE: 'server-exhausted.json',
    createServerLifecycle: (deps: ServerLifecycleDeps) => {
      lifecycleDeps = deps;
      return { onState: () => {}, onConnected: () => {}, start: async () => {} };
    },
    hc: {},
    hcEvents: {},
    hcEnv: {},
    execHc: vi.fn(),
    appLog: vi.fn(),
    supervisorArgs,
    supervisorEnv,
    spawn,
  };
  await runInNewContext(`${startupCode}\nstartServer();`, dependencies);
  if (!lifecycleDeps) throw new Error('startup did not construct lifecycle');
  return { deps: lifecycleDeps, prepareRuntime, spawn };
}

describe('Electron server startup', () => {
  it('uses the version override only for e2e lifecycle comparisons', async () => {
    const env = { CONDUIT_E2E_APP_VERSION: '9.8.7' };
    expect((await harness(false, true, env)).deps.appVersion).toBe('9.8.7');
    expect((await harness(false, true, env)).deps.serverArgs).toContain('--e2e-app-version');
    expect((await harness(false, false, env)).deps.appVersion).toBe('test');
    expect((await harness(false, false, env)).deps.serverArgs).not.toContain('--e2e-app-version');
    expect((await harness(true, true, env)).deps.appVersion).toBe('test');
  });
  it('passes the prepared shim generation and installed v0.51 paths only for packaged starts', async () => {
    const h = await harness(true);
    expect(h.deps.serverArgs).toEqual([
      '--shim-dir',
      '/runtime/shim-2',
      '--previous-exe',
      '/installed/Conduit.exe',
      '--previous-shim',
      path.join('/installed/resources', 'conduit-mcp', 'conduit-mcp-shim.cjs'),
    ]);
    expect(h.prepareRuntime).toHaveBeenCalledTimes(1);
    const dev = await harness(false);
    expect(dev.deps.serverArgs).toEqual([]);
    expect(dev.prepareRuntime).not.toHaveBeenCalled();
  });

  it('preserves the e2e flag alongside packaged shim arguments', async () => {
    const h = await harness(true, true);
    expect(h.deps.serverArgs).toContain('--e2e');
    expect(h.deps.serverArgs).toContain('--shim-dir');
  });

  it('spawns the fallback supervisor with the exact argv supplied by the lifecycle', async () => {
    const h = await harness(false);
    const argv = ['/supervise.js', '--user-data', '/some other profile', '--future-flag'];
    h.deps.spawnDetachedSupervisor(argv);
    expect(h.spawn.mock.calls[0]).toEqual([
      '/runtime/version/node.exe',
      argv,
      expect.objectContaining({ detached: true, windowsHide: true }),
    ]);
  });

  it('refuses to launch a bare Node process when supervisor argv is absent', async () => {
    const h = await harness(false);
    expect(() => h.deps.spawnDetachedSupervisor()).toThrow('Missing supervisor argv');
    expect(h.spawn).not.toHaveBeenCalled();
  });
});
