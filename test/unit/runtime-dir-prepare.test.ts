import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  promises,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CURRENT_SHIM_GENERATION,
  prepareRuntime,
  type RuntimeFs,
} from '../../server/runtime-dir/prepare';

let base: string;
let resourcesDir: string;
let userData: string;

function put(path: string, content: string) {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, content);
}

/** The installed layout electron-builder's extraResources produce (package.json `build.win`). */
function seedResources() {
  put(join(resourcesDir, 'runtime', 'node.exe'), 'node-bytes');
  put(join(resourcesDir, 'runtime', 'server', 'main.js'), 'main-js');
  put(join(resourcesDir, 'runtime', 'server', 'supervise.js'), 'supervise-js');
  put(join(resourcesDir, 'runtime', 'hc', 'conduit-hc.exe'), 'hc-bytes');
  put(join(resourcesDir, 'runtime', 'hc', 'conpty', 'conpty.dll'), 'conpty-bytes');
  put(join(resourcesDir, 'conduit-mcp', 'conduit-mcp-shim.cjs'), 'shim-v1');
}

interface Call {
  op: keyof RuntimeFs;
  args: string[];
}

function recordingFs(overrides: Partial<RuntimeFs> = {}): { fs: RuntimeFs; calls: Call[] } {
  const calls: Call[] = [];
  const real: RuntimeFs = {
    access: (p) => promises.access(p),
    mkdir: (p, o) => promises.mkdir(p, o),
    rm: (p, o) => promises.rm(p, o),
    cp: (s, d, o) => promises.cp(s, d, o),
    rename: (f, t) => promises.rename(f, t),
  };
  const wrap =
    <K extends keyof RuntimeFs>(op: K) =>
    (...args: Parameters<RuntimeFs[K]>) => {
      const strings: unknown[] = args;
      calls.push({ op, args: strings.filter((a): a is string => typeof a === 'string') });
      const impl = (overrides[op] ?? real[op]) as (...a: Parameters<RuntimeFs[K]>) => unknown;
      return impl(...args);
    };
  return {
    calls,
    fs: {
      access: wrap('access'),
      mkdir: wrap('mkdir'),
      rm: wrap('rm'),
      cp: wrap('cp'),
      rename: wrap('rename'),
    } as RuntimeFs,
  };
}

const options = (fs: RuntimeFs, appVersion = '0.52.0') => ({
  resourcesDir,
  userData,
  appVersion,
  hcVersion: '0.1.16',
  shimVersion: CURRENT_SHIM_GENERATION,
  platform: 'win32' as const,
  fs,
});

const runtime = (...parts: string[]) => join(userData, 'runtime', ...parts);

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'runtime-dir-'));
  resourcesDir = join(base, 'resources');
  userData = join(base, 'userData');
  seedResources();
});
afterEach(() => rmSync(base, { recursive: true, force: true }));

describe('prepareRuntime', () => {
  it('publishes the renamed engine beside an immutable legacy runtime', async () => {
    const legacy = runtime('hc', '0.1.16', 'hc.exe');
    put(legacy, 'live-legacy-engine');
    put(join(resourcesDir, 'runtime', 'hc', 'conduit-hc.exe'), 'renamed-engine');
    const { fs, calls } = recordingFs();
    const prepared = await prepareRuntime(options(fs));
    expect(prepared.hcExe).toBe(runtime('conduit-hc', '0.1.16', 'conduit-hc.exe'));
    expect(readFileSync(prepared.hcExe, 'utf8')).toBe('renamed-engine');
    expect(readFileSync(legacy, 'utf8')).toBe('live-legacy-engine');
    expect(calls.filter((c) => c.args.some((p) => p.startsWith(runtime('hc'))))).toEqual([]);
  });
  it('copies macOS binaries, including the shim node, preserving executable modes', async () => {
    put(join(resourcesDir, 'runtime', 'node'), 'mac-node');
    put(join(resourcesDir, 'runtime', 'hc', 'conduit-hc'), 'mac-hc');
    chmodSync(join(resourcesDir, 'runtime', 'node'), 0o755);
    chmodSync(join(resourcesDir, 'runtime', 'hc', 'conduit-hc'), 0o755);
    const prepared = await prepareRuntime({
      ...options(recordingFs().fs),
      platform: 'darwin',
      run: async () => {},
    });
    expect(prepared.nodeExe).toBe(runtime('0.52.0', 'node'));
    expect(prepared.hcExe).toBe(runtime('conduit-hc', '0.1.16', 'conduit-hc'));
    for (const file of [prepared.nodeExe, prepared.hcExe, join(prepared.shimDir, 'node')]) {
      expect(readFileSync(file, 'utf8')).toBe(file === prepared.hcExe ? 'mac-hc' : 'mac-node');
      if (process.platform !== 'win32') expect(statSync(file).mode & 0o777).toBe(0o755);
    }
  });
  it('removes quarantine from each complete staged macOS tree before publishing it', async () => {
    put(join(resourcesDir, 'runtime', 'node'), 'mac-node');
    put(join(resourcesDir, 'runtime', 'hc', 'conduit-hc'), 'mac-hc');
    const cleared: string[] = [];
    const run = vi.fn(async (file: string, args: string[]) => {
      expect(file).toBe('xattr');
      expect(args.slice(0, 2)).toEqual(['-dr', 'com.apple.quarantine']);
      const staging = args[2];
      expect(existsSync(staging)).toBe(true);
      expect(existsSync(staging.slice(0, -4))).toBe(false);
      const node = staging === runtime('conduit-hc', '0.1.16.tmp') ? 'conduit-hc' : 'node';
      expect(readFileSync(join(staging, node), 'utf8')).toBe(
        node === 'conduit-hc' ? 'mac-hc' : 'mac-node',
      );
      put(join(staging, 'quarantine-cleared'), 'cleared');
      cleared.push(staging);
    });
    const opts = { ...options(recordingFs().fs), platform: 'darwin' as const, run };
    const prepared = await prepareRuntime(opts);
    expect(cleared).toEqual([
      runtime('conduit-hc', '0.1.16.tmp'),
      runtime('0.52.0.tmp'),
      runtime('shim.tmp'),
    ]);
    for (const dir of [runtime('conduit-hc', '0.1.16'), runtime('0.52.0'), prepared.shimDir]) {
      expect(readFileSync(join(dir, 'quarantine-cleared'), 'utf8')).toBe('cleared');
    }
    run.mockClear();
    await prepareRuntime(opts);
    expect(run).not.toHaveBeenCalled();
  });

  it('logs quarantine removal failures and still publishes the copied macOS runtime', async () => {
    put(join(resourcesDir, 'runtime', 'node'), 'mac-node');
    put(join(resourcesDir, 'runtime', 'hc', 'conduit-hc'), 'mac-hc');
    const warn = vi.fn();
    const prepared = await prepareRuntime({
      ...options(recordingFs().fs),
      platform: 'darwin',
      run: async () => {
        throw new Error('permission denied');
      },
      warn,
    });
    expect(readFileSync(prepared.nodeExe, 'utf8')).toBe('mac-node');
    expect(readFileSync(prepared.hcExe, 'utf8')).toBe('mac-hc');
    expect(readFileSync(join(prepared.shimDir, 'node'), 'utf8')).toBe('mac-node');
    expect(warn).toHaveBeenCalledTimes(3);
    for (const dir of [
      runtime('conduit-hc', '0.1.16.tmp'),
      runtime('0.52.0.tmp'),
      runtime('shim.tmp'),
    ]) {
      expect(warn).toHaveBeenCalledWith(expect.stringContaining(dir));
    }
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('permission denied'));
  });

  it.each(['win32', 'linux'] as const)('does not run xattr on %s', async (platform) => {
    put(join(resourcesDir, 'runtime', 'node'), 'posix-node');
    const run = vi.fn(async () => {});
    await prepareRuntime({ ...options(recordingFs().fs), platform, run });
    expect(run).not.toHaveBeenCalled();
  });
  it('copies each runtime dir through <dir>.tmp and a rename, never into the final path', async () => {
    const { fs, calls } = recordingFs();
    const prepared = await prepareRuntime(options(fs));

    expect(prepared).toEqual({
      nodeExe: runtime('0.52.0', 'node.exe'),
      superviseJs: runtime('0.52.0', 'server', 'supervise.js'),
      mainJs: runtime('0.52.0', 'server', 'main.js'),
      hcExe: runtime('conduit-hc', '0.1.16', 'conduit-hc.exe'),
      shimDir: runtime('shim'),
    });
    expect(readFileSync(prepared.nodeExe, 'utf8')).toBe('node-bytes');
    expect(readFileSync(prepared.mainJs, 'utf8')).toBe('main-js');
    expect(readFileSync(prepared.superviseJs, 'utf8')).toBe('supervise-js');
    expect(readFileSync(prepared.hcExe, 'utf8')).toBe('hc-bytes');
    expect(readFileSync(runtime('conduit-hc', '0.1.16', 'conpty', 'conpty.dll'), 'utf8')).toBe(
      'conpty-bytes',
    );
    expect(readFileSync(join(prepared.shimDir, 'node.exe'), 'utf8')).toBe('node-bytes');
    expect(readFileSync(join(prepared.shimDir, 'conduit-mcp-shim.cjs'), 'utf8')).toBe('shim-v1');

    const targets = [runtime('0.52.0'), runtime('conduit-hc', '0.1.16'), runtime('shim')];
    for (const target of targets) {
      expect(calls).toContainEqual({ op: 'rename', args: [`${target}.tmp`, target] });
      expect(existsSync(`${target}.tmp`)).toBe(false);
    }
    const copyDestinations = calls.filter((c) => c.op === 'cp').map((c) => c.args[1]);
    expect(copyDestinations.length).toBeGreaterThan(0);
    for (const destination of copyDestinations) {
      expect(targets.some((t) => destination.startsWith(`${t}.tmp`))).toBe(true);
    }
  });

  it('reuses a complete dir as it is', async () => {
    put(runtime('0.52.0', 'node.exe'), 'already-here');
    put(runtime('0.52.0', 'server', 'main.js'), 'already-main');
    const { fs, calls } = recordingFs();
    await prepareRuntime(options(fs));

    expect(readFileSync(runtime('0.52.0', 'node.exe'), 'utf8')).toBe('already-here');
    expect(readFileSync(runtime('0.52.0', 'server', 'main.js'), 'utf8')).toBe('already-main');
    expect(calls.some((c) => c.op === 'rename' && c.args[1] === runtime('0.52.0'))).toBe(false);
  });

  it('removes a leftover .tmp before copying, so a half copy is never kept', async () => {
    put(runtime('0.52.0.tmp', 'half-copied'), 'junk');
    put(runtime('conduit-hc', '0.1.16.tmp', 'half-copied'), 'junk');
    await prepareRuntime(options(recordingFs().fs));

    expect(existsSync(runtime('0.52.0.tmp'))).toBe(false);
    expect(existsSync(runtime('0.52.0', 'half-copied'))).toBe(false);
    expect(existsSync(runtime('conduit-hc', '0.1.16', 'half-copied'))).toBe(false);
    expect(readFileSync(runtime('0.52.0', 'node.exe'), 'utf8')).toBe('node-bytes');
  });

  it('writes the shim dir once and never overwrites it, even for a newer app version', async () => {
    await prepareRuntime(options(recordingFs().fs, '0.52.0'));
    writeFileSync(join(resourcesDir, 'conduit-mcp', 'conduit-mcp-shim.cjs'), 'shim-v2');
    writeFileSync(join(resourcesDir, 'runtime', 'node.exe'), 'node-bytes-2');

    const { fs, calls } = recordingFs();
    const prepared = await prepareRuntime(options(fs, '0.53.0'));

    expect(readFileSync(join(prepared.shimDir, 'conduit-mcp-shim.cjs'), 'utf8')).toBe('shim-v1');
    expect(readFileSync(join(prepared.shimDir, 'node.exe'), 'utf8')).toBe('node-bytes');
    expect(
      calls.some((c) => c.args.some((a) => a.startsWith(runtime('shim'))) && c.op !== 'access'),
    ).toBe(false);
    expect(readFileSync(prepared.nodeExe, 'utf8')).toBe('node-bytes-2');
  });

  it('puts a later shim generation in its own dir (D2b)', async () => {
    const prepared = await prepareRuntime({ ...options(recordingFs().fs), shimVersion: 2 });
    expect(prepared.shimDir).toBe(runtime('shim-2'));
    expect(existsSync(join(prepared.shimDir, 'conduit-mcp-shim.cjs'))).toBe(true);
  });

  it('leaves no final dir and no .tmp when a copy fails', async () => {
    const { fs } = recordingFs({
      cp: async (source, destination, o) => {
        if (source.endsWith('server')) throw new Error('disk full');
        await promises.cp(source, destination, o);
      },
    });
    await expect(prepareRuntime(options(fs))).rejects.toThrow('disk full');

    expect(existsSync(runtime('0.52.0'))).toBe(false);
    expect(existsSync(runtime('0.52.0.tmp'))).toBe(false);
  });
});
