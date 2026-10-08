import { describe, expect, it } from 'vitest';
import type { SearchContext } from '../../src/lsp-binary';
import {
  CLANGD_SERVER,
  CSHARP_SERVER,
  compileRootMarker,
  compileRootMarkers,
  compileWatchGlobs,
  GO_SERVER,
  LANGUAGE_SERVERS,
  type LanguageServerSpec,
  languageInfo,
  PYTHON_SERVER,
  primaryLanguageId,
  RUST_SERVER,
  serverSpecFor,
} from '../../src/lsp-registry';

describe('server weight', () => {
  it('indexers are heavy; Go and Python are light', () => {
    expect(
      Object.fromEntries(LANGUAGE_SERVERS.map((s) => [primaryLanguageId(s), s.weight])),
    ).toEqual({ go: 'light', python: 'light', csharp: 'heavy', rust: 'heavy', cpp: 'heavy' });
  });
});

describe('GO_SERVER.childEnv', () => {
  it('childEnv prepends toolDir and sets GOTOOLCHAIN=local', () => {
    const env = GO_SERVER.childEnv({ PATH: '/usr/bin', HOME: '/h' }, '/usr/local/go/bin', 'linux');
    expect(env.PATH).toBe('/usr/local/go/bin:/usr/bin');
    expect(env.GOTOOLCHAIN).toBe('local');
    expect(env.HOME).toBe('/h');
  });

  it('childEnv keeps a user GOTOOLCHAIN', () => {
    expect(GO_SERVER.childEnv({ GOTOOLCHAIN: 'go1.24.0' }, null, 'linux').GOTOOLCHAIN).toBe(
      'go1.24.0',
    );
    expect(GO_SERVER.childEnv({ GoToolchain: 'auto' }, null, 'win32').GoToolchain).toBe('auto');
  });

  it('childEnv drops non-absolute PATH entries', () => {
    const env = GO_SERVER.childEnv({ Path: '.;bin;C:\\x' }, 'C:\\Go\\bin', 'win32');
    expect(env.Path).toBe('C:\\Go\\bin;C:\\x');
    expect(env.PATH).toBeUndefined();
    expect(GO_SERVER.childEnv({ PATH: '.:bin:/x' }, null, 'linux').PATH).toBe('/x');
  });

  it('childEnv never mutates base', () => {
    const base = Object.freeze({ PATH: '.:/x' });
    GO_SERVER.childEnv(base, '/go/bin', 'linux');
    expect(base).toEqual({ PATH: '.:/x' });
  });
});

describe('registry', () => {
  it('serverSpecFor("gomod") is null', () => {
    expect(serverSpecFor('gomod')).toBeNull();
    expect(serverSpecFor('go')).toBe(GO_SERVER);
  });

  it('serverSpecFor matches any id', () => {
    const cfam: LanguageServerSpec = { ...GO_SERVER, languageIds: ['cpp', 'c'] };
    expect(serverSpecFor('c', [GO_SERVER, cfam])).toBe(cfam);
    expect(serverSpecFor('cpp', [GO_SERVER, cfam])).toBe(cfam);
    expect(primaryLanguageId(cfam)).toBe('cpp');
  });

  it('languageIds unique across LANGUAGE_SERVERS', () => {
    const ids = LANGUAGE_SERVERS.flatMap((s) => s.languageIds);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('languageInfo(GO_SERVER) has moduleMarker go.mod', () => {
    expect(languageInfo(GO_SERVER)).toEqual({
      languageId: 'go',
      languageIds: ['go'],
      displayName: 'Go',
      binary: 'gopls',
      installHint: 'go install golang.org/x/tools/gopls@latest',
      moduleMarker: 'go.mod',
    });
  });

  it('isRootMarker true for x/go.mod and go.work', () => {
    expect(compileRootMarkers(GO_SERVER)('x/go.mod')).toBe(true);
    expect(compileRootMarkers(GO_SERVER)('x\\go.mod')).toBe(true);
    expect(compileRootMarkers(GO_SERVER)('go.work')).toBe(true);
    expect(compileRootMarkers(GO_SERVER)('go.sum')).toBe(false);
    expect(compileRootMarkers(GO_SERVER)('x/main.go')).toBe(false);
  });
});

describe('compileWatchGlobs', () => {
  it('compileWatchGlobs(GO_SERVER.watchGlobs) matches a/b.go, go.mod, x/go.sum, go.work and rejects a.ts, go.mod.bak', () => {
    const m = compileWatchGlobs(GO_SERVER.watchGlobs);
    for (const rel of ['a/b.go', 'a\\b.go', 'go.mod', 'x/go.sum', 'go.work'])
      expect(m(rel)).toBe(true);
    for (const rel of ['a.ts', 'go.mod.bak', 'a/go', '.go', 'x/go.works'])
      expect(m(rel)).toBe(false);
  });

  it('a custom matcher shape is honoured', () => {
    const m = compileWatchGlobs(['**/*.rs', '**/Cargo.toml']);
    expect(m('src/lib.rs')).toBe(true);
    expect(m('Cargo.toml')).toBe(true);
    expect(m('main.go')).toBe(false);
  });

  it('compileWatchGlobs throws on an unsupported glob shape (src/**/x.go)', () => {
    expect(() => compileWatchGlobs(['src/**/x.go'])).toThrow(/unsupported/);
    expect(() => compileWatchGlobs(['**/*.{go,mod}'])).toThrow(/unsupported/);
    expect(() => compileWatchGlobs(['*.go'])).toThrow(/unsupported/);
  });

  it('every LANGUAGE_SERVERS entry compiles its globs', () => {
    for (const spec of LANGUAGE_SERVERS)
      expect(() => compileWatchGlobs(spec.watchGlobs, spec.watchIgnoreDirs)).not.toThrow();
  });

  it('ignored dirs reject any path under them and keep the rest', () => {
    const m = compileWatchGlobs(CSHARP_SERVER.watchGlobs, ['bin', 'obj']);
    expect(m('src/App/obj/x.props')).toBe(false);
    expect(m('src\\App\\obj\\Debug\\App.g.cs')).toBe(false);
    expect(m('bin/Debug/App.csproj')).toBe(false);
    expect(m('src/App/Program.cs')).toBe(true);
    expect(m('src/objects/A.cs')).toBe(true);
    expect(m('obj.cs')).toBe(true);
  });

  it('ignored dirs match in any case', () => {
    const m = compileWatchGlobs(CSHARP_SERVER.watchGlobs, ['bin', 'obj']);
    expect(m('src/App/OBJ/x.props')).toBe(false);
    expect(m('Bin\\Debug\\App.csproj')).toBe(false);
  });

  it('extension globs match in any case, like pattern markers; basename globs stay exact', () => {
    const m = compileWatchGlobs(CSHARP_SERVER.watchGlobs);
    expect(m('src/Program.CS')).toBe(true);
    expect(m('App.CsProj')).toBe(true);
    expect(m('.CS')).toBe(false);
    expect(compileWatchGlobs(GO_SERVER.watchGlobs)('GO.MOD')).toBe(false);
  });
});

describe('root markers', () => {
  it('every LANGUAGE_SERVERS marker compiles', () => {
    for (const spec of LANGUAGE_SERVERS)
      for (const m of [...spec.rootMarkers.workspace, ...spec.rootMarkers.module])
        expect(() => compileRootMarker(m)).not.toThrow();
  });

  it('an unsupported marker shape throws', () => {
    for (const m of ['**/*.sln', '*.{sln,slnx}', 'src/go.mod', '*', '*.', 'a*.sln', '?.sln'])
      expect(() => compileRootMarker(m), m).toThrow(/unsupported root marker/);
  });

  it('a pattern marker matches case-insensitively and needs a stem', () => {
    const sln = compileRootMarker('*.sln');
    expect(sln('Foo.sln')).toBe(true);
    expect(sln('App.SLN')).toBe(true);
    expect(sln('.sln')).toBe(false);
    expect(sln('Foo.sln.bak')).toBe(false);
    expect(sln('Foosln')).toBe(false);
  });

  it('an exact marker stays case-sensitive', () => {
    expect(compileRootMarker('go.mod')('go.mod')).toBe(true);
    expect(compileRootMarker('go.mod')('GO.MOD')).toBe(false);
  });

  it('compileRootMarkers rejects a bad marker when compiled, not on the first event', () => {
    expect(() =>
      compileRootMarkers({ rootMarkers: { workspace: ['go.work'], module: ['**/go.mod'] } }),
    ).toThrow(/unsupported root marker/);
  });

  it('isRootMarker matches C# pattern markers', () => {
    expect(compileRootMarkers(CSHARP_SERVER)('Foo.sln')).toBe(true);
    expect(compileRootMarkers(CSHARP_SERVER)('src/App/App.csproj')).toBe(true);
    expect(compileRootMarkers(CSHARP_SERVER)('x\\All.slnx')).toBe(true);
    expect(compileRootMarkers(CSHARP_SERVER)('Foo.sln.bak')).toBe(false);
    expect(compileRootMarkers(CSHARP_SERVER)('Program.cs')).toBe(false);
  });
});

describe('Python, Rust and C/C++ (spec 2026-10-08-language-coverage §2.5)', () => {
  const ctx = (over: Partial<SearchContext> = {}): SearchContext => ({
    env: {},
    platform: 'linux',
    homedir: '/home/n',
    tmpdir: '/tmp',
    isFile: async () => false,
    realpath: async (p) => p,
    execFile: async () => '',
    ...over,
  });

  it('every new watch glob and marker compiles', () => {
    for (const spec of [PYTHON_SERVER, RUST_SERVER, CLANGD_SERVER]) {
      expect(LANGUAGE_SERVERS).toContain(spec);
      expect(() => compileWatchGlobs(spec.watchGlobs, spec.watchIgnoreDirs)).not.toThrow();
      expect(() => compileRootMarkers(spec)).not.toThrow();
    }
    expect(compileWatchGlobs(CLANGD_SERVER.watchGlobs)('src/a.hpp')).toBe(true);
    expect(
      compileWatchGlobs(PYTHON_SERVER.watchGlobs, PYTHON_SERVER.watchIgnoreDirs)('.venv/x.py'),
    ).toBe(false);
  });

  it('serverSpecFor routes every served id', () => {
    expect(serverSpecFor('c')).toBe(CLANGD_SERVER);
    expect(serverSpecFor('cpp')).toBe(CLANGD_SERVER);
    expect(serverSpecFor('python')).toBe(PYTHON_SERVER);
    expect(serverSpecFor('rust')).toBe(RUST_SERVER);
    expect(primaryLanguageId(CLANGD_SERVER)).toBe('cpp');
    expect(serverSpecFor('objective-c')).toBeNull();
  });

  it('the spec values are taken as written', () => {
    expect(PYTHON_SERVER).toMatchObject({
      binary: 'basedpyright-langserver',
      altBinaries: ['pyright-langserver'],
      args: ['--stdio'],
      requiresMarker: false,
    });
    expect(PYTHON_SERVER.initializationOptions).toBeUndefined();
    expect(RUST_SERVER).toMatchObject({
      binary: 'rust-analyzer',
      args: [],
      requiresMarker: true,
      versionProbe: ['--version'],
      watchIgnoreDirs: ['target'],
    });
    expect(CLANGD_SERVER).toMatchObject({
      displayName: 'C/C++',
      binary: 'clangd',
      args: ['--background-index', '-j=2', '--header-insertion=never'],
      requiresMarker: false,
      watchIgnoreDirs: ['CMakeFiles'],
    });
    expect(CLANGD_SERVER.versionProbe).toBeUndefined();
  });

  it('Python settings answer both sections with the same object', () => {
    const a = PYTHON_SERVER.settings?.['basedpyright.analysis'];
    expect(a).toEqual({ typeCheckingMode: 'off', diagnosticMode: 'openFilesOnly' });
    expect(PYTHON_SERVER.settings?.['python.analysis']).toBe(a);
  });

  it('Python searches ~/.local/bin and runs with a copy of the host env', async () => {
    expect(await PYTHON_SERVER.extraSearchDirs(ctx(), null)).toEqual(['/home/n/.local/bin']);
    expect(await PYTHON_SERVER.extraSearchDirs(ctx({ homedir: '' }), null)).toEqual([]);
    expect(await PYTHON_SERVER.resolveToolDir(ctx())).toBeNull();
    const base = Object.freeze({ PATH: '/x', HOME: '/h' });
    const env = PYTHON_SERVER.childEnv(base, null, 'linux');
    expect(env).toEqual(base);
    expect(env).not.toBe(base);
    // basedpyright runs `python` from PATH with the repo as cwd.
    expect(PYTHON_SERVER.childEnv({ PATH: '.:venv/bin:/x' }, null, 'linux').PATH).toBe('/x');
    expect(CLANGD_SERVER.childEnv({ Path: '.;C:\\x' }, null, 'win32').Path).toBe('C:\\x');
  });

  it('Rust initializationOptions deep-equals {checkOnSave:false}, and settings agree', () => {
    expect(RUST_SERVER.initializationOptions).toEqual({ checkOnSave: false });
    expect(RUST_SERVER.settings?.['rust-analyzer']).toEqual({ checkOnSave: false });
  });

  it('Rust childEnv prepends toolDir and sets RUSTUP_AUTO_INSTALL=0 only when unset', () => {
    const base = Object.freeze({ PATH: '/usr/bin' });
    const env = RUST_SERVER.childEnv(base, '/home/n/.cargo/bin', 'linux');
    expect(env.PATH).toBe('/home/n/.cargo/bin:/usr/bin');
    expect(env.RUSTUP_AUTO_INSTALL).toBe('0');
    expect(base).toEqual({ PATH: '/usr/bin' });
    expect(
      RUST_SERVER.childEnv({ RUSTUP_AUTO_INSTALL: '1' }, null, 'linux').RUSTUP_AUTO_INSTALL,
    ).toBe('1');
    const win = RUST_SERVER.childEnv({ Path: 'C:\\x', rustup_auto_install: '1' }, null, 'win32');
    expect(win.rustup_auto_install).toBe('1');
    expect(win.RUSTUP_AUTO_INSTALL).toBeUndefined();
    expect(win.Path).toBe('C:\\x');
  });

  it('Rust searches CARGO_HOME/bin then ~/.cargo/bin, absolute only', async () => {
    expect(await RUST_SERVER.extraSearchDirs(ctx({ env: { CARGO_HOME: '/c' } }), null)).toEqual([
      '/c/bin',
      '/home/n/.cargo/bin',
    ]);
    expect(await RUST_SERVER.extraSearchDirs(ctx({ env: { CARGO_HOME: 'rel' } }), null)).toEqual([
      '/home/n/.cargo/bin',
    ]);
  });

  it('Rust toolDir is the dir of cargo as found, not its realpath (argv0 dispatch)', async () => {
    const c = ctx({
      env: { PATH: '/usr/bin' },
      isFile: async (p) => p === '/usr/bin/cargo',
      realpath: async (p) => (p === '/usr/bin/cargo' ? '/usr/lib/rustup/bin/rustup' : p),
    });
    expect(await RUST_SERVER.resolveToolDir(c)).toBe('/usr/bin');
    const home = ctx({ isFile: async (p) => p === '/home/n/.cargo/bin/cargo' });
    expect(await RUST_SERVER.resolveToolDir(home)).toBe('/home/n/.cargo/bin');
    expect(await RUST_SERVER.resolveToolDir(ctx())).toBeNull();
  });

  it('clangd win32 search dir derives from ProgramFiles and is absent when unset', async () => {
    const win = (env: Record<string, string>) => ctx({ platform: 'win32', homedir: 'C:\\u', env });
    expect(await CLANGD_SERVER.extraSearchDirs(win({ ProgramFiles: 'D:\\PF' }), null)).toEqual([
      'D:\\PF\\LLVM\\bin',
    ]);
    expect(await CLANGD_SERVER.extraSearchDirs(win({ PROGRAMFILES: 'D:\\PF' }), null)).toEqual([
      'D:\\PF\\LLVM\\bin',
    ]);
    expect(await CLANGD_SERVER.extraSearchDirs(win({}), null)).toEqual([]);
    expect(await CLANGD_SERVER.extraSearchDirs(win({ ProgramFiles: 'rel' }), null)).toEqual([]);
    expect(await CLANGD_SERVER.extraSearchDirs(ctx({ platform: 'darwin' }), null)).toEqual([
      '/opt/homebrew/opt/llvm/bin',
      '/usr/local/opt/llvm/bin',
      '/Library/Developer/CommandLineTools/usr/bin',
    ]);
    expect(await CLANGD_SERVER.extraSearchDirs(ctx(), null)).toEqual([]);
    expect(await CLANGD_SERVER.resolveToolDir(ctx())).toBeNull();
  });
});

describe('CSHARP_SERVER', () => {
  it('is served as csharp with a project marker required', () => {
    expect(serverSpecFor('csharp')).toBe(CSHARP_SERVER);
    expect(CSHARP_SERVER.requiresMarker).toBe(true);
    expect(GO_SERVER.requiresMarker).toBe(false);
    expect(GO_SERVER.watchIgnoreDirs).toEqual([]);
    expect(languageInfo(CSHARP_SERVER)).toEqual({
      languageId: 'csharp',
      languageIds: ['csharp'],
      displayName: 'C#',
      binary: 'csharp-ls',
      installHint: 'dotnet tool install --global csharp-ls',
      moduleMarker: '*.csproj',
    });
  });

  it('childEnv prepends toolDir, sets DOTNET_ROOT to it and opts out of telemetry', () => {
    const env = CSHARP_SERVER.childEnv(
      { PATH: '/usr/bin', HOME: '/h' },
      '/usr/lib/dotnet',
      'linux',
    );
    expect(env.PATH).toBe('/usr/lib/dotnet:/usr/bin');
    expect(env.DOTNET_ROOT).toBe('/usr/lib/dotnet');
    expect(env.DOTNET_CLI_TELEMETRY_OPTOUT).toBe('1');
    expect(env.HOME).toBe('/h');
  });

  it('childEnv keeps a user DOTNET_ROOT and telemetry choice (case-insensitive on win32)', () => {
    const env = CSHARP_SERVER.childEnv(
      { Path: 'C:\\x', dotnet_root: 'D:\\dn', Dotnet_Cli_Telemetry_Optout: '0' },
      'C:\\Program Files\\dotnet',
      'win32',
    );
    expect(env.dotnet_root).toBe('D:\\dn');
    expect(env.DOTNET_ROOT).toBeUndefined();
    expect(env.Dotnet_Cli_Telemetry_Optout).toBe('0');
    expect(env.Path).toBe('C:\\Program Files\\dotnet;C:\\x');
  });

  it('childEnv with no toolDir sets no DOTNET_ROOT', () => {
    const env = CSHARP_SERVER.childEnv({ PATH: '/x' }, null, 'linux');
    expect(env.DOTNET_ROOT).toBeUndefined();
    expect(env.PATH).toBe('/x');
  });

  it('childEnv never mutates base', () => {
    const base = Object.freeze({ PATH: '/x' });
    CSHARP_SERVER.childEnv(base, '/dn', 'linux');
    expect(base).toEqual({ PATH: '/x' });
  });
});
