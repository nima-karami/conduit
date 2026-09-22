import { describe, expect, it } from 'vitest';
import {
  compileWatchGlobs,
  GO_SERVER,
  isRootMarker,
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
    expect(isRootMarker(GO_SERVER, 'x/go.mod')).toBe(true);
    expect(isRootMarker(GO_SERVER, 'x\\go.mod')).toBe(true);
    expect(isRootMarker(GO_SERVER, 'go.work')).toBe(true);
    expect(isRootMarker(GO_SERVER, 'go.sum')).toBe(false);
    expect(isRootMarker(GO_SERVER, 'x/main.go')).toBe(false);
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
      expect(() => compileWatchGlobs(spec.watchGlobs)).not.toThrow();
  });
});
