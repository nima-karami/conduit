import { describe, expect, it, vi } from 'vitest';
import {
  findBinary,
  type HostPlatform,
  pathDirs,
  resolveServerBinary,
  type SearchContext,
} from '../../src/lsp-binary';
import { GO_FIXED_DIRS, GO_SERVER } from '../../src/lsp-registry';

type ExecFile = SearchContext['execFile'];
type Ctx = SearchContext & { execFile: ReturnType<typeof vi.fn<ExecFile>> };

function ctx(
  over: Partial<Omit<SearchContext, 'execFile'>> & { files?: string[]; execFile?: ExecFile } = {},
): Ctx {
  const files = new Set(over.files ?? []);
  return {
    env: {},
    platform: 'win32' as HostPlatform,
    homedir: 'C:\\Users\\n',
    tmpdir: 'C:\\Temp',
    isFile: async (p) => files.has(p),
    realpath: async (p) => `real:${p}`,
    ...over,
    execFile: vi.fn<ExecFile>(over.execFile ?? (async () => '')),
  };
}

describe('pathDirs', () => {
  it('relative and empty PATH entries are skipped', () => {
    expect(pathDirs({ env: { PATH: '/usr/bin::bin:./x: /opt/b ' }, platform: 'linux' })).toEqual([
      '/usr/bin',
      '/opt/b',
    ]);
    expect(pathDirs({ env: { Path: '.;bin;C:\\x;;\\\\srv\\s' }, platform: 'win32' })).toEqual([
      'C:\\x',
      '\\\\srv\\s',
    ]);
  });

  it('win32 reads Path case-insensitively', () => {
    expect(pathDirs({ env: { Path: 'C:\\a' }, platform: 'win32' })).toEqual(['C:\\a']);
    expect(pathDirs({ env: { Path: '/a' }, platform: 'linux' })).toEqual([]);
  });
});

describe('findBinary', () => {
  it('win32 candidate is name.exe only', async () => {
    const c = ctx({ files: ['C:\\a\\gopls.cmd', 'C:\\a\\gopls', 'C:\\b\\gopls.exe'] });
    expect(await findBinary('gopls', ['C:\\a', 'C:\\b'], c)).toBe('real:C:\\b\\gopls.exe');
  });

  it("first regular file wins and is realpath'd", async () => {
    const c = ctx({ platform: 'linux', files: ['/b/gopls', '/c/gopls'] });
    expect(await findBinary('gopls', ['/a', '/b', '/c'], c)).toBe('real:/b/gopls');
    expect(await findBinary('gopls', ['/a'], c)).toBeNull();
  });
});

describe('resolveServerBinary (Go)', () => {
  it('search order is PATH, GOBIN, GOPATH entries, go env GOPATH, ~/go/bin', async () => {
    const probed: string[] = [];
    const c = ctx({
      platform: 'linux',
      homedir: '/home/n',
      env: { PATH: '/p', GOBIN: '/gobin', GOPATH: '/gp1:/gp2' },
      files: ['/p/go'],
      execFile: vi.fn(async () => '/envgp\n'),
    });
    c.isFile = async (p) => {
      probed.push(p);
      return p === '/p/go';
    };
    expect(await resolveServerBinary(GO_SERVER, c)).toBeNull();
    expect(probed.filter((p) => p.endsWith('/gopls'))).toEqual([
      '/p/gopls',
      '/gobin/gopls',
      '/gp1/bin/gopls',
      '/gp2/bin/gopls',
      '/envgp/bin/gopls',
      '/home/n/go/bin/gopls',
    ]);
  });

  it('go env runs in tmpdir with GOTOOLCHAIN=local and 5 s timeout', async () => {
    const c = ctx({
      env: { Path: 'C:\\Go\\bin' },
      files: ['C:\\Go\\bin\\go.exe', 'C:\\Users\\n\\go\\bin\\gopls.exe'],
      realpath: async (p) => p,
      execFile: vi.fn(async () => ''),
    });
    expect(await resolveServerBinary(GO_SERVER, c)).toEqual({
      binary: 'C:\\Users\\n\\go\\bin\\gopls.exe',
      toolDir: 'C:\\Go\\bin',
    });
    expect(c.execFile).toHaveBeenCalledWith(
      'C:\\Go\\bin\\go.exe',
      ['env', 'GOPATH'],
      expect.objectContaining({ cwd: 'C:\\Temp', timeout: 5000 }),
    );
    expect(c.execFile.mock.calls[0]?.[2].env.GOTOOLCHAIN).toBe('local');
  });

  it('go env failure is not fatal', async () => {
    const c = ctx({
      env: { Path: 'C:\\Go\\bin' },
      files: ['C:\\Go\\bin\\go.exe', 'C:\\Users\\n\\go\\bin\\gopls.exe'],
      realpath: async (p) => p,
      execFile: vi.fn(async () => {
        throw new Error('timeout');
      }),
    });
    expect((await resolveServerBinary(GO_SERVER, c))?.binary).toBe(
      'C:\\Users\\n\\go\\bin\\gopls.exe',
    );
  });

  it('finds go in GO_FIXED_DIRS when PATH lacks it', async () => {
    const c = ctx({
      env: { Path: 'C:\\Windows' },
      files: ['C:\\Program Files\\Go\\bin\\go.exe'],
      realpath: async (p) => p,
    });
    expect(await GO_SERVER.resolveToolDir(c)).toBe(GO_FIXED_DIRS.win32[0]);
    expect(GO_FIXED_DIRS.win32[0]).toBe('C:\\Program Files\\Go\\bin');
    expect(await GO_SERVER.resolveToolDir(ctx({ env: {}, files: [] }))).toBeNull();
  });
});
