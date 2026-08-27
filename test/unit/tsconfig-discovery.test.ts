import { describe, expect, it } from 'vitest';
import { nodeModulesDirs, splitPackageSpecifier } from '../../src/module-paths';
import {
  findNearestTsconfig,
  loadTsconfigChain,
  TSCONFIG_CANDIDATES,
} from '../../src/tsconfig-discovery';
import { memFs } from './mem-fs';

const J = (o: unknown) => JSON.stringify(o);

describe('shared package-path helpers', () => {
  it('splits scoped and subpath specifiers', () => {
    expect(splitPackageSpecifier('zod')).toEqual({ pkg: 'zod', subpath: '.' });
    expect(splitPackageSpecifier('date-fns/format')).toEqual({
      pkg: 'date-fns',
      subpath: './format',
    });
    expect(splitPackageSpecifier('@scope/pkg')).toEqual({ pkg: '@scope/pkg', subpath: '.' });
    expect(splitPackageSpecifier('@scope/pkg/sub/deep')).toEqual({
      pkg: '@scope/pkg',
      subpath: './sub/deep',
    });
    expect(splitPackageSpecifier('./relative')).toBeNull();
    expect(splitPackageSpecifier('g:/abs/path')).toBeNull();
  });

  it('lists node_modules dirs from the importing file upward — row 36', () => {
    expect(nodeModulesDirs('g:/p/apps/web/src')).toEqual([
      'g:/p/apps/web/src/node_modules',
      'g:/p/apps/web/node_modules',
      'g:/p/apps/node_modules',
      'g:/p/node_modules',
      'g:/node_modules',
    ]);
  });

  it('does not nest a node_modules inside a node_modules dir', () => {
    expect(nodeModulesDirs('g:/p/node_modules/pkg/lib')).toEqual([
      'g:/p/node_modules/pkg/lib/node_modules',
      'g:/p/node_modules/pkg/node_modules',
      'g:/p/node_modules',
      'g:/node_modules',
    ]);
  });
});

describe('findNearestTsconfig', () => {
  it('prefers the closest config to the importing file', () => {
    const fs = memFs({
      'g:/p/tsconfig.json': J({}),
      'g:/p/apps/web/tsconfig.json': J({}),
      'g:/p/apps/web/src/a.ts': '',
    });
    expect(findNearestTsconfig('g:/p/apps/web/src/a.ts', 'g:/p', fs)).toBe(
      'g:/p/apps/web/tsconfig.json',
    );
  });

  it('honours the candidate precedence order within one directory — row 19', () => {
    const fs = memFs({
      'g:/p/tsconfig.app.json': J({}),
      'g:/p/jsconfig.json': J({}),
      'g:/p/src/a.ts': '',
    });
    expect(TSCONFIG_CANDIDATES).toEqual([
      'tsconfig.json',
      'tsconfig.app.json',
      'tsconfig.base.json',
      'jsconfig.json',
    ]);
    expect(findNearestTsconfig('g:/p/src/a.ts', 'g:/p', fs)).toBe('g:/p/tsconfig.app.json');
  });

  it('finds a nested jsconfig before the root tsconfig — row 19b', () => {
    const fs = memFs({
      'g:/p/tsconfig.json': J({}),
      'g:/p/jsproj/jsconfig.json': J({}),
      'g:/p/jsproj/consumer.js': '',
    });
    expect(findNearestTsconfig('g:/p/jsproj/consumer.js', 'g:/p', fs)).toBe(
      'g:/p/jsproj/jsconfig.json',
    );
  });

  it('stops at the boundary and reports nothing rather than climbing to the drive', () => {
    const fs = memFs({ 'g:/tsconfig.json': J({}), 'g:/p/src/a.ts': '' });
    expect(findNearestTsconfig('g:/p/src/a.ts', 'g:/p', fs)).toBeNull();
  });

  it('tolerates a boundary spelled with a different drive case', () => {
    const fs = memFs({ 'g:/p/tsconfig.json': J({}), 'g:/p/src/a.ts': '' });
    expect(findNearestTsconfig('g:/p/src/a.ts', 'G:/p', fs)).toBe('g:/p/tsconfig.json');
  });
});

describe('loadTsconfigChain', () => {
  it('makes paths absolute against baseUrl', () => {
    const fs = memFs({
      'g:/p/tsconfig.json': J({
        compilerOptions: { baseUrl: './src', paths: { '@/*': ['lib/*'] } },
      }),
    });
    const cfg = loadTsconfigChain('g:/p/tsconfig.json', fs);
    expect(cfg?.baseUrl).toBe('g:/p/src');
    expect(cfg?.paths['@/*']).toEqual(['g:/p/src/lib/*']);
    expect(cfg?.configDir).toBe('g:/p');
  });

  it('anchors paths on the config dir when baseUrl is absent (TS ≥ 4.4)', () => {
    const fs = memFs({
      'g:/p/tsconfig.json': J({ compilerOptions: { paths: { '~/*': ['./src/*'] } } }),
    });
    expect(loadTsconfigChain('g:/p/tsconfig.json', fs)?.paths['~/*']).toEqual(['g:/p/src/*']);
  });

  it('follows a relative extends, nearest-wins — row 21', () => {
    const fs = memFs({
      'g:/p/tsconfig.base.json': J({
        compilerOptions: { baseUrl: '.', paths: { '@base/*': ['b/*'] } },
      }),
      'g:/p/tsconfig.json': J({
        extends: './tsconfig.base.json',
        compilerOptions: { paths: { '@app/*': ['a/*'] } },
      }),
    });
    const cfg = loadTsconfigChain('g:/p/tsconfig.json', fs);
    expect(Object.keys(cfg?.paths ?? {}).sort()).toEqual(['@app/*', '@base/*']);
  });

  it('inherits a baseUrl declared only by the extended config — row 20', () => {
    const fs = memFs({
      'g:/p/tsconfig.base.json': J({ compilerOptions: { baseUrl: '.' } }),
      'g:/p/tsconfig.json': J({ extends: './tsconfig.base.json' }),
    });
    expect(loadTsconfigChain('g:/p/tsconfig.json', fs)?.baseUrl).toBe('g:/p');
  });

  it('resolves a PACKAGE-form extends through node_modules — row 22', () => {
    const fs = memFs({
      'g:/p/node_modules/@tsconfig/node20/tsconfig.json': J({
        compilerOptions: { target: 'es2022', paths: { '#pkg/*': ['./x/*'] } },
      }),
      'g:/p/tsconfig.json': J({ extends: '@tsconfig/node20' }),
    });
    const cfg = loadTsconfigChain('g:/p/tsconfig.json', fs);
    expect(cfg?.paths['#pkg/*']).toEqual(['g:/p/node_modules/@tsconfig/node20/x/*']);
  });

  it('resolves a package extends that names a file explicitly', () => {
    const fs = memFs({
      'g:/p/node_modules/shared/tsconfig.strict.json': J({
        compilerOptions: { paths: { 's/*': ['./s/*'] } },
      }),
      'g:/p/tsconfig.json': J({ extends: 'shared/tsconfig.strict.json' }),
    });
    expect(loadTsconfigChain('g:/p/tsconfig.json', fs)?.paths['s/*']).toEqual([
      'g:/p/node_modules/shared/s/*',
    ]);
  });

  it('ignores a package extends that is not installed', () => {
    const fs = memFs({ 'g:/p/tsconfig.json': J({ extends: '@tsconfig/missing' }) });
    expect(loadTsconfigChain('g:/p/tsconfig.json', fs)).toEqual({
      paths: {},
      baseUrl: null,
      configDir: 'g:/p',
    });
  });

  it('lets project references contribute their paths, at lower precedence — row 23', () => {
    const fs = memFs({
      'g:/p/packages/ui/tsconfig.json': J({ compilerOptions: { paths: { '@ui/*': ['./src/*'] } } }),
      'g:/p/tsconfig.json': J({
        references: [{ path: './packages/ui' }],
        compilerOptions: { paths: { '@app/*': ['./src/*'] } },
      }),
    });
    const cfg = loadTsconfigChain('g:/p/tsconfig.json', fs);
    expect(cfg?.paths['@ui/*']).toEqual(['g:/p/packages/ui/src/*']);
    expect(cfg?.paths['@app/*']).toEqual(['g:/p/src/*']);
  });

  it('accepts a reference that names the config file directly', () => {
    const fs = memFs({
      'g:/p/tsconfig.ref.json': J({ compilerOptions: { paths: { '~ref/*': ['./src/ref/*'] } } }),
      'g:/p/tsconfig.json': J({ references: [{ path: './tsconfig.ref.json' }] }),
    });
    expect(loadTsconfigChain('g:/p/tsconfig.json', fs)?.paths['~ref/*']).toEqual([
      'g:/p/src/ref/*',
    ]);
  });

  it("a reference cannot override the nearest config's own alias", () => {
    const fs = memFs({
      'g:/p/packages/ui/tsconfig.json': J({ compilerOptions: { paths: { '@x/*': ['./ui/*'] } } }),
      'g:/p/tsconfig.json': J({
        references: [{ path: './packages/ui' }],
        compilerOptions: { paths: { '@x/*': ['./mine/*'] } },
      }),
    });
    expect(loadTsconfigChain('g:/p/tsconfig.json', fs)?.paths['@x/*']).toEqual(['g:/p/mine/*']);
  });

  it('does not follow references of references', () => {
    const fs = memFs({
      'g:/p/b/tsconfig.json': J({ compilerOptions: { paths: { '@deep/*': ['./d/*'] } } }),
      'g:/p/a/tsconfig.json': J({
        references: [{ path: '../b' }],
        compilerOptions: { paths: { '@a/*': ['./s/*'] } },
      }),
      'g:/p/tsconfig.json': J({ references: [{ path: './a' }] }),
    });
    const cfg = loadTsconfigChain('g:/p/tsconfig.json', fs);
    expect(cfg?.paths['@a/*']).toEqual(['g:/p/a/s/*']);
    expect(cfg?.paths['@deep/*']).toBeUndefined();
  });

  it('survives a circular extends and a malformed config without hanging or throwing', () => {
    const fs = memFs({
      'g:/p/a.json': J({ extends: './b.json' }),
      'g:/p/b.json': J({ extends: './a.json' }),
      'g:/p/bad.json': '{ this is not json',
    });
    expect(() => loadTsconfigChain('g:/p/a.json', fs)).not.toThrow();
    expect(loadTsconfigChain('g:/p/bad.json', fs)).toBeNull();
    expect(loadTsconfigChain('g:/p/missing.json', fs)).toBeNull();
  });

  it('tolerates JSONC (comments + trailing commas)', () => {
    const fs = memFs({
      'g:/p/tsconfig.json': '{\n // c\n "compilerOptions": { "paths": { "a/*": ["./a/*"] }, },\n}',
    });
    expect(loadTsconfigChain('g:/p/tsconfig.json', fs)?.paths['a/*']).toEqual(['g:/p/a/*']);
  });
});
