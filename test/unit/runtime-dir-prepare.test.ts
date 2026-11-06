import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  promises,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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
  put(join(resourcesDir, 'runtime', 'hc', 'hc.exe'), 'hc-bytes');
  put(join(resourcesDir, 'runtime', 'tray', 'conduit-tray.exe'), 'tray-bytes');
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
  it('copies each runtime dir through <dir>.tmp and a rename, never into the final path', async () => {
    const { fs, calls } = recordingFs();
    const prepared = await prepareRuntime(options(fs));

    expect(prepared).toEqual({
      nodeExe: runtime('0.52.0', 'node.exe'),
      superviseJs: runtime('0.52.0', 'server', 'supervise.js'),
      mainJs: runtime('0.52.0', 'server', 'main.js'),
      hcExe: runtime('hc', '0.1.16', 'hc.exe'),
      trayExe: runtime('0.52.0', 'tray', 'conduit-tray.exe'),
      shimDir: runtime('shim'),
    });
    expect(readFileSync(prepared.nodeExe, 'utf8')).toBe('node-bytes');
    expect(readFileSync(prepared.mainJs, 'utf8')).toBe('main-js');
    expect(readFileSync(prepared.superviseJs, 'utf8')).toBe('supervise-js');
    expect(readFileSync(prepared.hcExe, 'utf8')).toBe('hc-bytes');
    expect(readFileSync(prepared.trayExe, 'utf8')).toBe('tray-bytes');
    expect(readFileSync(runtime('hc', '0.1.16', 'conpty', 'conpty.dll'), 'utf8')).toBe(
      'conpty-bytes',
    );
    expect(readFileSync(join(prepared.shimDir, 'node.exe'), 'utf8')).toBe('node-bytes');
    expect(readFileSync(join(prepared.shimDir, 'conduit-mcp-shim.cjs'), 'utf8')).toBe('shim-v1');

    const targets = [runtime('0.52.0'), runtime('hc', '0.1.16'), runtime('shim')];
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
    put(runtime('hc', '0.1.16.tmp', 'half-copied'), 'junk');
    await prepareRuntime(options(recordingFs().fs));

    expect(existsSync(runtime('0.52.0.tmp'))).toBe(false);
    expect(existsSync(runtime('0.52.0', 'half-copied'))).toBe(false);
    expect(existsSync(runtime('hc', '0.1.16', 'half-copied'))).toBe(false);
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
