import { describe, expect, it } from 'vitest';
import {
  BASE_COMPILER_OPTIONS,
  joinPosix,
  mergeCompilerOptions,
  normalizePosix,
  parseTsconfig,
  stripJsonc,
  TS_JSX,
  TS_MODULE_KIND,
  TS_MODULE_RESOLUTION,
  TS_SCRIPT_TARGET,
  toCompilerOptions,
  toTsconfigDTO,
} from '../../src/tsconfig-map';

const toUri = (p: string) => `file:///${p.replace(/^\/+/, '')}`;

describe('stripJsonc', () => {
  it('drops line and block comments', () => {
    expect(stripJsonc('{ // hi\n "a": 1 /* there */ }')).toContain('"a": 1');
    expect(JSON.parse(stripJsonc('{ // hi\n "a": 1 /* there */ }'))).toEqual({ a: 1 });
  });

  it('drops trailing commas', () => {
    expect(JSON.parse(stripJsonc('{ "a": [1, 2,], }'))).toEqual({ a: [1, 2] });
  });

  // A Windows path or a URL in a string is not a comment.
  it('leaves // inside string literals alone', () => {
    expect(JSON.parse(stripJsonc('{ "u": "https://x.dev/a" }'))).toEqual({ u: 'https://x.dev/a' });
    expect(JSON.parse(stripJsonc('{ "e": "a\\"// b" }'))).toEqual({ e: 'a"// b' });
  });
});

describe('parseTsconfig', () => {
  it('returns null instead of throwing on malformed input', () => {
    expect(parseTsconfig('{ nope')).toBeNull();
    expect(parseTsconfig('')).toBeNull();
  });

  it('parses a real-world config with comments', () => {
    expect(
      parseTsconfig('{\n // c\n "extends": "./base.json",\n "compilerOptions": {}\n}'),
    ).toEqual({ extends: './base.json', compilerOptions: {} });
  });
});

describe('normalizePosix / joinPosix', () => {
  it('collapses . and .. and normalizes separators', () => {
    expect(normalizePosix('G:\\a\\b\\..\\c')).toBe('G:/a/b/../c'.replace('/b/..', ''));
    expect(normalizePosix('/a/./b/../c')).toBe('/a/c');
  });

  it('resolves a relative path against a directory', () => {
    expect(joinPosix('G:/repo', './src')).toBe('G:/repo/src');
    expect(joinPosix('G:/repo/tools', '../src')).toBe('G:/repo/src');
  });

  it('leaves an already-absolute path alone', () => {
    expect(joinPosix('G:/repo', 'D:/other')).toBe('D:/other');
    expect(joinPosix('/repo', '/other')).toBe('/other');
  });
});

describe('mergeCompilerOptions', () => {
  it('lets the nearest config win over what it extends', () => {
    const merged = mergeCompilerOptions([
      { compilerOptions: { strict: true, target: 'es2022' } },
      { compilerOptions: { strict: false, jsx: 'react-jsx' } },
    ]);
    expect(merged).toEqual({ strict: true, target: 'es2022', jsx: 'react-jsx' });
  });
});

describe('toTsconfigDTO', () => {
  it('keeps only the options monaco honours', () => {
    const dto = toTsconfigDTO(
      { target: 'ES2022', strict: true, noEmit: true, outDir: 'out', lib: ['DOM'] },
      'G:/repo',
    );
    expect(dto).toEqual({ target: 'ES2022', strict: true });
  });

  it('resolves baseUrl against the config directory', () => {
    expect(toTsconfigDTO({ baseUrl: './src' }, 'G:/repo').baseUrl).toBe('G:/repo/src');
  });

  // paths without baseUrl is legal since TS 4.4 and resolves against the config's own dir.
  // Dropping the default here is how every alias in a modern config silently stops resolving.
  it('defaults baseUrl to the config dir when paths are present without one', () => {
    const dto = toTsconfigDTO({ paths: { '@/*': ['./src/*'] } }, 'G:/repo');
    expect(dto.baseUrl).toBe('G:/repo');
    expect(dto.paths).toEqual({ '@/*': ['./src/*'] });
  });

  it('ignores malformed paths entries', () => {
    expect(toTsconfigDTO({ paths: { '@/*': 'nope', 'ok/*': ['x'] } }, 'G:/r').paths).toEqual({
      'ok/*': ['x'],
    });
  });
});

describe('toCompilerOptions', () => {
  it('falls back to the baseline when there is no tsconfig', () => {
    expect(toCompilerOptions(undefined, toUri)).toEqual(BASE_COMPILER_OPTIONS);
  });

  it('maps the string enums onto the values the bundled TypeScript uses', () => {
    const out = toCompilerOptions(
      { target: 'ES2022', module: 'NodeNext', moduleResolution: 'Bundler', jsx: 'react-jsx' },
      toUri,
    );
    expect(out.target).toBe(TS_SCRIPT_TARGET.es2022);
    expect(out.module).toBe(TS_MODULE_KIND.nodenext);
    expect(out.moduleResolution).toBe(TS_MODULE_RESOLUTION.bundler);
    expect(out.jsx).toBe(TS_JSX['react-jsx']);
  });

  it('keeps the baseline value for an unknown enum string', () => {
    const out = toCompilerOptions({ target: 'es9999' }, toUri);
    expect(out.target).toBe(BASE_COMPILER_OPTIONS.target);
  });

  // The worker addresses files by URI, so a raw OS path baseUrl points at a directory that,
  // as far as it's concerned, does not exist — and every alias fails to resolve.
  it('rewrites baseUrl into the worker file-name space', () => {
    const out = toCompilerOptions({ baseUrl: 'G:/repo/src', paths: { '@/*': ['*'] } }, toUri);
    expect(out.baseUrl).toBe('file:///G:/repo/src');
    expect(out.paths).toEqual({ '@/*': ['*'] });
  });

  it('never lets a project turn off allowNonTsExtensions', () => {
    expect(toCompilerOptions({ allowJs: false }, toUri).allowNonTsExtensions).toBe(true);
    expect(toCompilerOptions({ allowJs: false }, toUri).allowJs).toBe(false);
  });
});
