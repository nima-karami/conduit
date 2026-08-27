import { describe, expect, it } from 'vitest';
import type { FsShim } from '../../src/module-paths';
import {
  applyTypesVersions,
  EXPORT_CONDITIONS,
  isSafeResolvedPath,
  probeFile,
  RESOLVE_EXTENSIONS,
  resolveModule,
  selectExportsTarget,
  typesPackageName,
} from '../../src/module-resolver';
import { memFs } from './mem-fs';

const J = (o: unknown) => JSON.stringify(o);
const at = (tree: Record<string, string | null>, specifier: string, fromFile = 'g:/p/src/a.ts') =>
  resolveModule({ fromFile, specifier, root: 'g:/p' }, memFs(tree));

describe('helpers', () => {
  it('maps a package to its @types name — row 27', () => {
    expect(typesPackageName('lodash')).toBe('@types/lodash');
    expect(typesPackageName('@scope/pkg')).toBe('@types/scope__pkg');
  });

  it('rejects device and UNC paths', () => {
    expect(isSafeResolvedPath('g:/p/a.ts')).toBe(true);
    expect(isSafeResolvedPath('/home/u/a.ts')).toBe(true);
    expect(isSafeResolvedPath('//server/share/a.ts')).toBe(false);
    expect(isSafeResolvedPath('\\\\?\\C:\\a.ts')).toBe(false);
  });

  it('probes declarations before runtime files', () => {
    expect(RESOLVE_EXTENSIONS[0]).toBe('.d.ts');
    const fs = memFs({ 'g:/p/x.d.ts': '', 'g:/p/x.js': '' });
    expect(probeFile('g:/p/x', fs)).toBe('g:/p/x.d.ts');
  });

  it('tries the types condition before any runtime one', () => {
    expect(EXPORT_CONDITIONS[0]).toBe('types');
    expect(selectExportsTarget({ '.': { import: './e.js', types: './e.d.ts' } }, '.')).toBe(
      './e.d.ts',
    );
  });

  it('takes the first array entry that is a string', () => {
    expect(selectExportsTarget({ '.': [{ types: './a.d.ts' }, './b.js'] }, '.')).toBe('./a.d.ts');
  });

  it('maps typesVersions patterns and leaves an unmatched subpath alone', () => {
    expect(applyTypesVersions({ '*': { '*': ['ts5/*'] } }, './deep/x')).toBe('ts5/deep/x');
    expect(applyTypesVersions({ '>=4': { only: ['./o.d.ts'] } }, './other')).toBeNull();
    expect(applyTypesVersions(undefined, './x')).toBeNull();
  });
});

describe('relative specifiers', () => {
  it('probes extensions and index like TS — rows 2/3/5', () => {
    const tree = { 'g:/p/src/b.ts': '', 'g:/p/src/c/index.tsx': '', 'g:/p/src/a.ts': '' };
    expect(at(tree, './b')).toMatchObject({ ok: true, entry: 'g:/p/src/b.ts', via: 'relative' });
    expect(at(tree, './c')).toMatchObject({ ok: true, entry: 'g:/p/src/c/index.tsx' });
  });

  it('maps an ESM .js specifier back to its .ts source', () => {
    expect(at({ 'g:/p/src/b.ts': '', 'g:/p/src/a.ts': '' }, './b.js')).toMatchObject({
      entry: 'g:/p/src/b.ts',
    });
  });

  it('resolves ABOVE the session root — row 33', () => {
    const r = at({ 'g:/shared/x.ts': '', 'g:/p/src/a.ts': '' }, '../../../shared/x');
    expect(r).toMatchObject({ ok: true, entry: 'g:/shared/x.ts' });
  });

  it('reports not-found instead of guessing', () => {
    expect(at({ 'g:/p/src/a.ts': '' }, './nope')).toEqual({ ok: false, reason: 'not-found' });
  });
});

describe('tsconfig aliases', () => {
  it('resolves an alias declared in tsconfig.app.json — rows 19/32', () => {
    const r = at(
      {
        'g:/p/tsconfig.app.json': J({
          compilerOptions: { baseUrl: '.', paths: { '@/*': ['src/*'] } },
        }),
        'g:/p/src/lib/deep.ts': '',
        'g:/p/src/a.ts': '',
      },
      '@/lib/deep',
    );
    expect(r).toMatchObject({ ok: true, entry: 'g:/p/src/lib/deep.ts', via: 'alias' });
  });

  it('merges aliases from sibling configs in one directory — row 19', () => {
    const tree = {
      'g:/p/tsconfig.json': J({ compilerOptions: { paths: { '@/*': ['./src/*'] } } }),
      'g:/p/tsconfig.app.json': J({ compilerOptions: { paths: { '#app/*': ['./src/app/*'] } } }),
      'g:/p/src/lib.ts': '',
      'g:/p/src/app/thing.ts': '',
      'g:/p/src/a.ts': '',
    };
    expect(at(tree, '@/lib')).toMatchObject({ entry: 'g:/p/src/lib.ts' });
    expect(at(tree, '#app/thing')).toMatchObject({ entry: 'g:/p/src/app/thing.ts' });
  });

  it('resolves a non-relative import through baseUrl — row 20', () => {
    const r = at(
      {
        'g:/p/tsconfig.json': J({ compilerOptions: { baseUrl: './src' } }),
        'g:/p/src/util/x.ts': '',
        'g:/p/src/a.ts': '',
      },
      'util/x',
    );
    expect(r).toMatchObject({ ok: true, entry: 'g:/p/src/util/x.ts', via: 'baseUrl' });
  });

  it('prefers the nearest package-level config over the root one — rows 19/24/32', () => {
    const r = at(
      {
        'g:/p/tsconfig.json': J({
          compilerOptions: { baseUrl: '.', paths: { '@/*': ['wrong/*'] } },
        }),
        'g:/p/apps/web/tsconfig.json': J({
          compilerOptions: { baseUrl: '.', paths: { '@/*': ['src/*'] } },
        }),
        'g:/p/apps/web/src/ok.ts': '',
        'g:/p/apps/web/src/a.ts': '',
        'g:/p/wrong/ok.ts': '',
      },
      '@/ok',
      'g:/p/apps/web/src/a.ts',
    );
    expect(r).toMatchObject({ entry: 'g:/p/apps/web/src/ok.ts' });
  });

  it('takes the longest literal prefix when two patterns match', () => {
    const r = at(
      {
        'g:/p/tsconfig.json': J({
          compilerOptions: { paths: { '@/*': ['./wide/*'], '@/deep/*': ['./narrow/*'] } },
        }),
        'g:/p/wide/deep/x.ts': '',
        'g:/p/narrow/x.ts': '',
        'g:/p/src/a.ts': '',
      },
      '@/deep/x',
    );
    expect(r).toMatchObject({ entry: 'g:/p/narrow/x.ts' });
  });
});

describe('bare specifiers', () => {
  const pkg = (dir: string, json: unknown, files: Record<string, string> = {}) => ({
    [`${dir}/package.json`]: J(json),
    ...Object.fromEntries(Object.entries(files).map(([k, v]) => [`${dir}/${k}`, v])),
  });

  it('lands on a types entry — row 25', () => {
    const r = at(
      {
        'g:/p/src/a.ts': '',
        ...pkg('g:/p/node_modules/zod', { types: './index.d.ts' }, { 'index.d.ts': '' }),
      },
      'zod',
    );
    expect(r).toMatchObject({
      ok: true,
      entry: 'g:/p/node_modules/zod/index.d.ts',
      packageDir: 'g:/p/node_modules/zod',
      via: 'node_modules',
    });
  });

  it('accepts the legacy `typings` key', () => {
    const r = at(
      {
        'g:/p/src/a.ts': '',
        ...pkg('g:/p/node_modules/old', { typings: 'types/main.d.ts' }, { 'types/main.d.ts': '' }),
      },
      'old',
    );
    expect(r).toMatchObject({ entry: 'g:/p/node_modules/old/types/main.d.ts' });
  });

  it('honours an exports map with a types condition — row 26', () => {
    const r = at(
      {
        'g:/p/src/a.ts': '',
        ...pkg(
          'g:/p/node_modules/mod',
          { exports: { '.': { types: './dist/index.d.ts', import: './dist/index.js' } } },
          { 'dist/index.d.ts': '', 'dist/index.js': '' },
        ),
      },
      'mod',
    );
    expect(r).toMatchObject({ entry: 'g:/p/node_modules/mod/dist/index.d.ts' });
  });

  it('handles the string form and a nested condition object', () => {
    const r = at(
      {
        'g:/p/src/a.ts': '',
        ...pkg(
          'g:/p/node_modules/mod',
          {
            exports: { '.': { node: { types: './n.d.ts', default: './n.js' }, default: './d.js' } },
          },
          { 'n.d.ts': '', 'n.js': '', 'd.js': '' },
        ),
      },
      'mod',
    );
    expect(r).toMatchObject({ entry: 'g:/p/node_modules/mod/n.d.ts' });
  });

  it('resolves a subpath through exports — row 29', () => {
    const r = at(
      {
        'g:/p/src/a.ts': '',
        ...pkg(
          'g:/p/node_modules/date-fns',
          { exports: { './format': { types: './format/index.d.ts' } } },
          { 'format/index.d.ts': '' },
        ),
      },
      'date-fns/format',
    );
    expect(r).toMatchObject({ entry: 'g:/p/node_modules/date-fns/format/index.d.ts' });
  });

  it('resolves a classic subpath with no exports map — row 29', () => {
    const r = at(
      {
        'g:/p/src/a.ts': '',
        ...pkg(
          'g:/p/node_modules/sub',
          { types: './index.d.ts' },
          { 'index.d.ts': '', 'deep/thing.d.ts': '' },
        ),
      },
      'sub/deep/thing',
    );
    expect(r).toMatchObject({ entry: 'g:/p/node_modules/sub/deep/thing.d.ts' });
  });

  it('resolves a wildcard exports subpath', () => {
    const r = at(
      {
        'g:/p/src/a.ts': '',
        ...pkg(
          'g:/p/node_modules/w',
          { exports: { './*': './lib/*.d.ts' } },
          { 'lib/thing.d.ts': '' },
        ),
      },
      'w/thing',
    );
    expect(r).toMatchObject({ entry: 'g:/p/node_modules/w/lib/thing.d.ts' });
  });

  it('applies typesVersions — row 26', () => {
    const r = at(
      {
        'g:/p/src/a.ts': '',
        ...pkg(
          'g:/p/node_modules/tv',
          { types: './index.d.ts', typesVersions: { '*': { '*': ['ts4.5/*'] } } },
          { 'ts4.5/index.d.ts': '', 'index.d.ts': '' },
        ),
      },
      'tv',
    );
    expect(r).toMatchObject({ entry: 'g:/p/node_modules/tv/ts4.5/index.d.ts' });
  });

  it('applies typesVersions to a subpath the exports map does not cover', () => {
    const r = at(
      {
        'g:/p/src/a.ts': '',
        ...pkg(
          'g:/p/node_modules/tv2',
          { typesVersions: { '*': { sub: ['./types/sub.d.ts'] } } },
          { 'types/sub.d.ts': '' },
        ),
      },
      'tv2/sub',
    );
    expect(r).toMatchObject({ entry: 'g:/p/node_modules/tv2/types/sub.d.ts' });
  });

  it('falls back to @types — row 27', () => {
    const r = at(
      {
        'g:/p/src/a.ts': '',
        ...pkg('g:/p/node_modules/lodash', { main: './index.js' }, { 'index.js': '' }),
        ...pkg('g:/p/node_modules/@types/lodash', { types: './index.d.ts' }, { 'index.d.ts': '' }),
      },
      'lodash',
    );
    expect(r).toMatchObject({ entry: 'g:/p/node_modules/@types/lodash/index.d.ts' });
  });

  it('never diverts a package that ships its OWN types to the @types stub', () => {
    const r = at(
      {
        'g:/p/src/a.ts': '',
        ...pkg('g:/p/node_modules/dual', { types: './own.d.ts' }, { 'own.d.ts': '' }),
        ...pkg('g:/p/node_modules/@types/dual', { types: './stub.d.ts' }, { 'stub.d.ts': '' }),
      },
      'dual',
    );
    expect(r).toMatchObject({ entry: 'g:/p/node_modules/dual/own.d.ts' });
  });

  it('resolves a package that exists ONLY as an @types stub', () => {
    const r = at(
      {
        'g:/p/src/a.ts': '',
        ...pkg('g:/p/node_modules/@types/node', { types: './index.d.ts' }, { 'index.d.ts': '' }),
      },
      'node',
    );
    expect(r).toMatchObject({ entry: 'g:/p/node_modules/@types/node/index.d.ts' });
  });

  it('maps a scoped package to its mangled @types name', () => {
    const r = at(
      {
        'g:/p/src/a.ts': '',
        ...pkg('g:/p/node_modules/@scope/pkg', { main: './i.js' }, { 'i.js': '' }),
        ...pkg('g:/p/node_modules/@types/scope__pkg', { types: './i.d.ts' }, { 'i.d.ts': '' }),
      },
      '@scope/pkg',
    );
    expect(r).toMatchObject({ entry: 'g:/p/node_modules/@types/scope__pkg/i.d.ts' });
  });

  it('lands on the JS entry for an untyped package — row 28', () => {
    const r = at(
      {
        'g:/p/src/a.ts': '',
        ...pkg('g:/p/node_modules/plain', { main: 'lib/main.js' }, { 'lib/main.js': '' }),
      },
      'plain',
    );
    expect(r).toMatchObject({ entry: 'g:/p/node_modules/plain/lib/main.js' });
  });

  it('falls back to index.js with no main at all', () => {
    const r = at(
      { 'g:/p/src/a.ts': '', ...pkg('g:/p/node_modules/bare', {}, { 'index.js': '' }) },
      'bare',
    );
    expect(r).toMatchObject({ entry: 'g:/p/node_modules/bare/index.js' });
  });

  it('prefers the NEAREST node_modules — pnpm / nested hoisting, row 36', () => {
    const r = at(
      {
        'g:/p/apps/web/src/a.ts': '',
        ...pkg('g:/p/node_modules/dep', { types: './root.d.ts' }, { 'root.d.ts': '' }),
        ...pkg('g:/p/apps/web/node_modules/dep', { types: './near.d.ts' }, { 'near.d.ts': '' }),
      },
      'dep',
      'g:/p/apps/web/src/a.ts',
    );
    expect(r).toMatchObject({ entry: 'g:/p/apps/web/node_modules/dep/near.d.ts' });
  });

  it('realpaths a junction/symlinked workspace package — row 31', () => {
    const tree = {
      'g:/p/src/a.ts': '',
      'g:/p/node_modules/@ws/ui/package.json': J({ types: './src/index.ts' }),
      'g:/p/node_modules/@ws/ui/src/index.ts': '',
    };
    const base = memFs(tree);
    const fs: FsShim = {
      ...base,
      realpath: (p) => p.replace('g:/p/node_modules/@ws/ui', 'g:/p/packages/ui'),
    };
    const r = resolveModule({ fromFile: 'g:/p/src/a.ts', specifier: '@ws/ui', root: 'g:/p' }, fs);
    expect(r).toMatchObject({
      ok: true,
      entry: 'g:/p/packages/ui/src/index.ts',
      packageDir: 'g:/p/packages/ui',
    });
  });

  it('refuses a resolution that realpaths onto a UNC share', () => {
    const base = memFs({
      'g:/p/src/a.ts': '',
      'g:/p/node_modules/unc/package.json': J({ types: './i.d.ts' }),
      'g:/p/node_modules/unc/i.d.ts': '',
    });
    const fs: FsShim = { ...base, realpath: () => '//server/share/i.d.ts' };
    expect(
      resolveModule({ fromFile: 'g:/p/src/a.ts', specifier: 'unc', root: 'g:/p' }, fs),
    ).toEqual({ ok: false, reason: 'unsafe-path' });
  });

  it('reports no-entry for a package with nothing usable', () => {
    const r = at({ 'g:/p/src/a.ts': '', 'g:/p/node_modules/empty/package.json': J({}) }, 'empty');
    expect(r).toEqual({ ok: false, reason: 'no-entry' });
  });

  it('does not keep walking past a package that exists but cannot answer', () => {
    const r = at(
      {
        'g:/p/apps/web/src/a.ts': '',
        'g:/p/apps/web/node_modules/dep/package.json': J({}),
        ...pkg('g:/p/node_modules/dep', { types: './root.d.ts' }, { 'root.d.ts': '' }),
      },
      'dep',
      'g:/p/apps/web/src/a.ts',
    );
    expect(r).toEqual({ ok: false, reason: 'no-entry' });
  });

  it('declines builtin and non-file schemes', () => {
    expect(at({ 'g:/p/src/a.ts': '' }, 'node:fs')).toEqual({ ok: false, reason: 'unsupported' });
    expect(at({ 'g:/p/src/a.ts': '' }, 'https://x/y.js')).toEqual({
      ok: false,
      reason: 'unsupported',
    });
  });

  it('reports not-found when nothing anywhere holds the package', () => {
    expect(at({ 'g:/p/src/a.ts': '' }, 'no-such-package-anywhere')).toEqual({
      ok: false,
      reason: 'not-found',
    });
  });
});
