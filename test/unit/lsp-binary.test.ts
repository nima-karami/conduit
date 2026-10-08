import { describe, expect, it, vi } from 'vitest';
import {
  findBinary,
  type HostPlatform,
  pathDirs,
  resolveServerBinary,
  type SearchContext,
  VERSION_PROBE_TIMEOUT_MS,
} from '../../src/lsp-binary';
import {
  CSHARP_SERVER,
  GO_FIXED_DIRS,
  GO_SERVER,
  type LanguageServerSpec,
} from '../../src/lsp-registry';

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
    expect(await findBinary('gopls', ['C:\\a', 'C:\\b'], c)).toEqual({
      path: 'C:\\b\\gopls.exe',
      realPath: 'real:C:\\b\\gopls.exe',
    });
  });

  it('first regular file wins, with its realpath alongside', async () => {
    const c = ctx({ platform: 'linux', files: ['/b/gopls', '/c/gopls'] });
    expect(await findBinary('gopls', ['/a', '/b', '/c'], c)).toEqual({
      path: '/b/gopls',
      realPath: 'real:/b/gopls',
    });
    expect(await findBinary('gopls', ['/a'], c)).toBeNull();
  });
});

const probeSpec = (over: Partial<LanguageServerSpec> = {}): LanguageServerSpec => ({
  ...CSHARP_SERVER,
  languageIds: ['x'],
  binary: 'xls',
  resolveToolDir: async () => 'C:\\tool',
  extraSearchDirs: async () => [],
  childEnv: (base, toolDir) => ({ ...base, TOOL: toolDir ?? '' }),
  ...over,
});

describe('resolveServerBinary — generic fields', () => {
  it('spawn path is the non-realpath', async () => {
    const c = ctx({ env: { Path: 'C:\\b' }, files: ['C:\\b\\xls.exe'] });
    expect(await resolveServerBinary(probeSpec(), c)).toEqual({
      binary: 'C:\\b\\xls.exe',
      toolDir: 'C:\\tool',
    });
  });

  it('altBinaries searched in order after binary', async () => {
    const probed: string[] = [];
    const c = ctx({ env: { Path: 'C:\\a;C:\\b' } });
    c.isFile = async (p) => {
      probed.push(p);
      return p === 'C:\\b\\alt2.exe' || p === 'C:\\a\\alt3.exe';
    };
    const spec = probeSpec({ altBinaries: ['alt2', 'alt3'] });
    expect((await resolveServerBinary(spec, c))?.binary).toBe('C:\\b\\alt2.exe');
    expect(probed).toEqual([
      'C:\\a\\xls.exe',
      'C:\\b\\xls.exe',
      'C:\\a\\alt2.exe',
      'C:\\b\\alt2.exe',
    ]);
  });

  it('versionProbe runs in tmpdir with the child env', async () => {
    const c = ctx({ env: { Path: 'C:\\b' }, files: ['C:\\b\\xls.exe'] });
    const spec = probeSpec({ versionProbe: ['--version'] });
    expect((await resolveServerBinary(spec, c))?.binary).toBe('C:\\b\\xls.exe');
    expect(c.execFile).toHaveBeenCalledWith('C:\\b\\xls.exe', ['--version'], {
      cwd: 'C:\\Temp',
      env: { Path: 'C:\\b', TOOL: 'C:\\tool' },
      timeout: VERSION_PROBE_TIMEOUT_MS,
    });
    expect(VERSION_PROBE_TIMEOUT_MS).toBe(5_000);
  });

  it('versionProbe failure → null', async () => {
    const c = ctx({
      env: { Path: 'C:\\b' },
      files: ['C:\\b\\xls.exe'],
      execFile: async () => {
        throw new Error('exit 1');
      },
    });
    expect(await resolveServerBinary(probeSpec({ versionProbe: ['--version'] }), c)).toBeNull();
  });

  it('no versionProbe → no execFile', async () => {
    const c = ctx({ env: { Path: 'C:\\b' }, files: ['C:\\b\\xls.exe'] });
    await resolveServerBinary(probeSpec(), c);
    expect(c.execFile).not.toHaveBeenCalled();
  });

  it('Go toolDir is dirname(realPath)', async () => {
    const c = ctx({
      platform: 'linux',
      env: { PATH: '/usr/bin' },
      files: ['/usr/bin/go'],
      realpath: async (p) => (p === '/usr/bin/go' ? '/usr/lib/go/bin/go' : p),
    });
    expect(await GO_SERVER.resolveToolDir(c)).toBe('/usr/lib/go/bin');
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

describe('CSHARP_SERVER resolution', () => {
  it('toolDir is the realpath dir of the PATH dotnet, so DOTNET_ROOT survives a symlink', async () => {
    const c = ctx({
      platform: 'linux',
      homedir: '/home/n',
      env: { PATH: '/usr/bin' },
      files: ['/usr/bin/dotnet'],
      realpath: async (p) => (p === '/usr/bin/dotnet' ? '/usr/lib/dotnet/dotnet' : p),
    });
    expect(await CSHARP_SERVER.resolveToolDir(c)).toBe('/usr/lib/dotnet');
  });

  it('falls back to the fixed dotnet dirs, then ~/.dotnet', async () => {
    const fixed = ctx({
      env: { Path: 'C:\\Windows' },
      files: ['C:\\Program Files\\dotnet\\dotnet.exe'],
      realpath: async (p) => p,
    });
    expect(await CSHARP_SERVER.resolveToolDir(fixed)).toBe('C:\\Program Files\\dotnet');
    const home = ctx({
      platform: 'darwin',
      homedir: '/Users/n',
      env: {},
      files: ['/Users/n/.dotnet/dotnet'],
      realpath: async (p) => p,
    });
    expect(await CSHARP_SERVER.resolveToolDir(home)).toBe('/Users/n/.dotnet');
    expect(await CSHARP_SERVER.resolveToolDir(ctx({ env: {}, files: [] }))).toBeNull();
  });

  it('finds csharp-ls in ~/.dotnet/tools, or under DOTNET_CLI_HOME when set', async () => {
    const c = ctx({
      env: { Path: 'C:\\Windows' },
      files: ['C:\\Users\\n\\.dotnet\\tools\\csharp-ls.exe'],
      realpath: async (p) => p,
    });
    expect(await resolveServerBinary(CSHARP_SERVER, c)).toEqual({
      binary: 'C:\\Users\\n\\.dotnet\\tools\\csharp-ls.exe',
      toolDir: null,
    });
    expect(
      await CSHARP_SERVER.extraSearchDirs(
        ctx({ platform: 'linux', homedir: '/home/n', env: { DOTNET_CLI_HOME: '/cli' } }),
        null,
      ),
    ).toEqual(['/cli/.dotnet/tools']);
    expect(
      await CSHARP_SERVER.extraSearchDirs(
        ctx({ platform: 'linux', homedir: '/home/n', env: { DOTNET_CLI_HOME: 'rel' } }),
        null,
      ),
    ).toEqual([]);
    expect(
      await CSHARP_SERVER.extraSearchDirs(ctx({ platform: 'linux', homedir: '/home/n' }), null),
    ).toEqual(['/home/n/.dotnet/tools']);
  });
});
