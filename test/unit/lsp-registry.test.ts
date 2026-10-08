import { describe, expect, it } from 'vitest';
import {
  CSHARP_SERVER,
  compileRootMarker,
  compileRootMarkers,
  compileWatchGlobs,
  GO_SERVER,
  LANGUAGE_SERVERS,
  languageInfo,
  serverSpecFor,
} from '../../src/lsp-registry';

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

  it('languageInfo(GO_SERVER) has moduleMarker go.mod', () => {
    expect(languageInfo(GO_SERVER)).toEqual({
      languageId: 'go',
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

describe('CSHARP_SERVER', () => {
  it('is served as csharp with a project marker required', () => {
    expect(serverSpecFor('csharp')).toBe(CSHARP_SERVER);
    expect(CSHARP_SERVER.requiresMarker).toBe(true);
    expect(GO_SERVER.requiresMarker).toBe(false);
    expect(GO_SERVER.watchIgnoreDirs).toEqual([]);
    expect(languageInfo(CSHARP_SERVER)).toEqual({
      languageId: 'csharp',
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
