/**
 * Generator for the Go to Definition flow-map fixture workspace
 * (docs/specs/2026-08-21-goto-definition-flows.md § Verification).
 *
 * The workspace is WRITTEN, never checked in: it carries a `node_modules` tree and a junction,
 * both of which a committed fixture would push through .gitignore, biome and gitleaks. Callers
 * hand it a throwaway directory (the harness convention: `mkdtempSync(join(tmpdir(), …))`).
 *
 * Layout — the session root is `<base>/repo`, and `<base>/shared` sits deliberately ABOVE it so
 * row 33 (`../shared/x`) has somewhere outside the root to point at.
 *
 * Every navigation target carries a UNIQUE marker identifier (`markerR07ChainDeep`, …) so an
 * e2e asserts the landed file AND line by content rather than by guessing a line number.
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** How many filler sources the opt-in cap fixture writes. Must exceed `INDEX_FILE_CAP` (5000)
 *  so the alphabetically-last target falls off the end of the index. */
const CAP_FILLER_COUNT = 5100;

/** Bytes of filler in the oversized source (row 17). `readFile`'s cap is 2 MB. */
const HUGE_FILE_BYTES = 2.4 * 1024 * 1024;

function write(root, rel, content) {
  const abs = join(root, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content, 'utf8');
  return abs;
}

function json(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

/** Repeat a cheap declaration until the file passes `bytes`, then append the real target. */
function hugeSource(bytes, tail) {
  const parts = [];
  let size = 0;
  for (let i = 0; size < bytes; i++) {
    const s = `export const filler${i} = ${i};\n`;
    parts.push(s);
    size += s.length;
  }
  parts.push(tail);
  return parts.join('');
}

function writeTsconfigs(root) {
  // Root config owns `paths` (row 18). `paths` is a whole-key override in TS, so it can only
  // live in ONE config of the chain — the other rows each get a knob of their own.
  write(
    root,
    'tsconfig.json',
    json({
      extends: './tsconfig.base.json',
      compilerOptions: { paths: { '@/*': ['src/*'] } },
      references: [{ path: './tsconfig.ref.json' }],
      include: ['src', 'packages', '.storybook'],
    }),
  );
  // Relative extends (row 21) contributing `baseUrl` (row 20).
  write(
    root,
    'tsconfig.base.json',
    json({
      extends: '@tsconfig/fixture',
      compilerOptions: {
        baseUrl: '.',
        module: 'ESNext',
        moduleResolution: 'Bundler',
        jsx: 'react-jsx',
        strict: true,
      },
    }),
  );
  // Package-form extends (row 22). Its knob is `target`: nothing else in the chain sets one,
  // and the default is ES2020 — so an ES2022-only lib symbol resolves iff this file was read.
  write(root, 'node_modules/@tsconfig/fixture/package.json', json({ name: '@tsconfig/fixture' }));
  write(
    root,
    'node_modules/@tsconfig/fixture/tsconfig.json',
    json({ compilerOptions: { target: 'ES2022' } }),
  );
  // A second root-level config with a DIFFERENT alias (row 19).
  write(
    root,
    'tsconfig.app.json',
    json({
      extends: './tsconfig.base.json',
      compilerOptions: { paths: { '#app/*': ['src/app/*'] } },
      include: ['src/app'],
    }),
  );
  // A referenced project contributing its own alias (row 23).
  write(
    root,
    'tsconfig.ref.json',
    json({
      extends: './tsconfig.base.json',
      compilerOptions: { composite: true, paths: { '~ref/*': ['src/ref/*'] } },
      include: ['src/ref'],
    }),
  );
  // jsconfig discovery (row 19b) — scoped to its own directory so it can't shadow the root.
  write(
    root,
    'jsproj/jsconfig.json',
    json({ compilerOptions: { baseUrl: '.', paths: { '~js/*': ['lib/*'] } } }),
  );
  write(root, 'jsproj/lib/target.js', 'export const markerR19bJsconfigAlias = 19;\n');
  write(
    root,
    'jsproj/consumer.js',
    "import { markerR19bJsconfigAlias } from '~js/target';\nexport const useJsconfig = markerR19bJsconfigAlias;\n",
  );
}

function writeFirstParty(root) {
  // 1 — same file.
  write(
    root,
    'src/first/same-file.ts',
    [
      'export function markerR01SameFile(): number {',
      '  return 1;',
      '}',
      'export const useSameFile = markerR01SameFile();',
      '',
    ].join('\n'),
  );

  // 2 — relative sibling. Doubles as row 42/44's target (it is opened from the tree first).
  write(root, 'src/first/rel-target.ts', 'export const markerR02RelTarget = 2;\n');
  write(
    root,
    'src/first/rel-consumer.ts',
    "import { markerR02RelTarget } from './rel-target';\nexport const useRel = markerR02RelTarget;\n",
  );

  // 3 — extension omitted, three siblings; TS must prefer the .ts.
  write(root, 'src/first/ext/pick.ts', 'export const markerR03ExtTs = 3;\n');
  write(root, 'src/first/ext/pick.tsx', 'export const markerR03ExtTsx = 3;\n');
  write(root, 'src/first/ext/pick.js', 'export const markerR03ExtJs = 3;\n');
  write(
    root,
    'src/first/ext-consumer.ts',
    "import { markerR03ExtTs } from './ext/pick';\nexport const useExt = markerR03ExtTs;\n",
  );

  // 4 — .mts with TS-only syntax (an interface). The worker maps .mts to ScriptKind.JS today,
  // which makes the declaration unparseable and the navigation land nowhere.
  write(
    root,
    'src/first/mts-target.mts',
    'export interface MarkerR04MtsIface {\n  value: number;\n}\n',
  );
  write(
    root,
    'src/first/mts-consumer.ts',
    "import type { MarkerR04MtsIface } from './mts-target.mjs';\nexport const useMts: MarkerR04MtsIface = { value: 4 };\n",
  );

  // 5 — directory import.
  write(root, 'src/first/dirmod/index.ts', 'export const markerR05DirIndex = 5;\n');
  write(
    root,
    'src/first/dir-consumer.ts',
    "import { markerR05DirIndex } from './dirmod';\nexport const useDir = markerR05DirIndex;\n",
  );

  // 6 — barrel: must land in the leaf, not the barrel.
  write(root, 'src/first/barrel/leaf.ts', 'export const markerR06BarrelLeaf = 6;\n');
  write(root, 'src/first/barrel/index.ts', "export { markerR06BarrelLeaf } from './leaf';\n");
  write(
    root,
    'src/first/barrel-consumer.ts',
    "import { markerR06BarrelLeaf } from './barrel';\nexport const useBarrel = markerR06BarrelLeaf;\n",
  );

  // 7 — `export *` chain, three levels.
  write(root, 'src/first/chain/c.ts', 'export const markerR07ChainDeep = 7;\n');
  write(root, 'src/first/chain/b.ts', "export * from './c';\n");
  write(root, 'src/first/chain/a.ts', "export * from './b';\n");
  write(
    root,
    'src/first/chain-consumer.ts',
    "import { markerR07ChainDeep } from './chain/a';\nexport const useChain = markerR07ChainDeep;\n",
  );

  // 8 — rename re-export.
  write(root, 'src/first/rename/origin.ts', 'export const markerR08RenameOrigin = 8;\n');
  write(
    root,
    'src/first/rename/index.ts',
    "export { markerR08RenameOrigin as markerR08RenameAlias } from './origin';\n",
  );
  write(
    root,
    'src/first/rename-consumer.ts',
    "import { markerR08RenameAlias } from './rename';\nexport const useRename = markerR08RenameAlias;\n",
  );

  // 9 — default export.
  write(
    root,
    'src/first/default-export.ts',
    'export default function markerR09DefaultFn(): number {\n  return 9;\n}\n',
  );
  write(
    root,
    'src/first/default-consumer.ts',
    "import markerR09Local from './default-export';\nexport const useDefault = markerR09Local();\n",
  );

  // 10 — `import type` through a barrel.
  write(
    root,
    'src/first/types/type-decl.ts',
    'export interface MarkerR10TypeOnly {\n  value: number;\n}\n',
  );
  write(
    root,
    'src/first/types/barrel.ts',
    "export type { MarkerR10TypeOnly } from './type-decl';\n",
  );
  write(
    root,
    'src/first/type-consumer.ts',
    "import type { MarkerR10TypeOnly } from './types/barrel';\nexport const useType: MarkerR10TypeOnly = { value: 10 };\n",
  );

  // 11 — JSX component.
  write(
    root,
    'src/first/comp/marker-widget.tsx',
    'export function MarkerR11Widget() {\n  return <div>widget</div>;\n}\n',
  );
  write(
    root,
    'src/first/comp/use-widget.tsx',
    [
      "import { MarkerR11Widget } from './marker-widget';",
      'export function UseWidget() {',
      '  return <MarkerR11Widget />;',
      '}',
      '',
    ].join('\n'),
  );

  // 12 — two declarations of one name → multiple results → peek.
  write(
    root,
    'src/first/multi-decl.ts',
    [
      'export interface MarkerR12Multi {',
      '  first: number;',
      '}',
      'export interface MarkerR12Multi {',
      '  second: number;',
      '}',
      'export const useMulti: MarkerR12Multi = { first: 1, second: 2 };',
      '',
    ].join('\n'),
  );

  // 13 — cursor already on the declaration → references peek.
  write(
    root,
    'src/first/self-decl.ts',
    'export const markerR13SelfDecl = 13;\nexport const useSelfDecl = markerR13SelfDecl + 1;\n',
  );

  // 14 — ambient `declare global` in a project .d.ts.
  write(
    root,
    'src/first/globals.d.ts',
    'declare global {\n  const markerR14AmbientGlobal: string;\n}\nexport {};\n',
  );
  write(root, 'src/first/uses-global.ts', 'export const useGlobal = markerR14AmbientGlobal;\n');

  // 15 — a declaration under a dot-directory that is NOT tool state.
  write(
    root,
    '.storybook/types.ts',
    'declare global {\n  const markerR15StorybookGlobal: number;\n}\nexport {};\n',
  );
  write(
    root,
    'src/first/uses-storybook.ts',
    'export const useStorybook = markerR15StorybookGlobal;\n',
  );

  // 16 / 44 — dirty-tab target. The e2e inserts lines above the declaration, so the mirror
  // model's line number differs from the on-disk one.
  write(
    root,
    'src/first/dirty-target.ts',
    'export const markerR16DirtyTarget = 16;\nexport const dirtyTail = 1;\n',
  );
  write(
    root,
    'src/first/dirty-consumer.ts',
    "import { markerR16DirtyTarget } from './dirty-target';\nexport const useDirty = markerR16DirtyTarget;\n",
  );

  // 17 — over the 2 MB read cap, with the target past the truncation point.
  write(
    root,
    'src/first/huge.ts',
    hugeSource(HUGE_FILE_BYTES, 'export const markerR17HugeTail = 17;\n'),
  );
  write(
    root,
    'src/first/huge-consumer.ts',
    "import { markerR17HugeTail } from './huge';\nexport const useHuge = markerR17HugeTail;\n",
  );

  // 43 — a directory whose name carries `#`, and one carrying a space.
  write(root, 'c#/mod.ts', 'export const markerR43HashDir = 43;\n');
  write(
    root,
    'src/first/uses-hash.ts',
    "import { markerR43HashDir } from '../../c#/mod';\nexport const useHash = markerR43HashDir;\n",
  );
  write(root, 'with space/mod.ts', 'export const markerR43bSpaceDir = 43;\n');
  write(
    root,
    'src/first/uses-space.ts',
    "import { markerR43bSpaceDir } from '../../with space/mod';\nexport const useSpace = markerR43bSpaceDir;\n",
  );
}

function writeConfigConsumers(root) {
  // 18 — root tsconfig `paths`.
  write(root, 'src/lib/foo.ts', 'export const markerR18RootAlias = 18;\n');
  write(
    root,
    'src/config/uses-root-alias.ts',
    "import { markerR18RootAlias } from '@/lib/foo';\nexport const useRootAlias = markerR18RootAlias;\n",
  );

  // 19 — alias from tsconfig.app.json (never read today).
  write(root, 'src/app/appalias.ts', 'export const markerR19AppAlias = 19;\n');
  write(
    root,
    'src/app/uses-app-alias.ts',
    "import { markerR19AppAlias } from '#app/appalias';\nexport const useAppAlias = markerR19AppAlias;\n",
  );

  // 20 / 21 — non-relative import through the inherited `baseUrl`.
  write(root, 'src/baseurl/target.ts', 'export const markerR20BaseUrl = 20;\n');
  write(
    root,
    'src/config/uses-baseurl.ts',
    "import { markerR20BaseUrl } from 'src/baseurl/target';\nexport const useBaseUrl = markerR20BaseUrl;\n",
  );

  // 22 — an ES2022-only lib symbol; resolves only if the PACKAGE-form extends was followed.
  write(
    root,
    'src/config/uses-es2022.ts',
    'const list = [1, 2, 3];\nexport const useEs2022 = list.at(0);\n',
  );

  // 23 — alias contributed by a referenced project.
  write(root, 'src/ref/reftarget.ts', 'export const markerR23RefAlias = 23;\n');
  write(
    root,
    'src/ref/uses-ref-alias.ts',
    "import { markerR23RefAlias } from '~ref/reftarget';\nexport const useRefAlias = markerR23RefAlias;\n",
  );
}

/** node_modules packages for rows 25–30 and 36, plus the untyped/@types pair for 27–28. */
function writePackages(root) {
  const pkg = (rel, value) => write(root, `node_modules/${rel}/package.json`, json(value));

  // 25 — plain `types`.
  pkg('typed-pkg', { name: 'typed-pkg', version: '1.0.0', main: 'index.js', types: 'index.d.ts' });
  write(
    root,
    'node_modules/typed-pkg/index.d.ts',
    'export declare const markerR25TypedPkg: number;\n',
  );
  write(root, 'node_modules/typed-pkg/index.js', 'export const markerR25TypedPkg = 25;\n');
  write(
    root,
    'src/pkg/uses-typed.ts',
    "import { markerR25TypedPkg } from 'typed-pkg';\nexport const useTyped = markerR25TypedPkg;\n",
  );

  // 26 — `exports` map with a types condition, plus `typesVersions` for a subpath.
  pkg('exports-pkg', {
    name: 'exports-pkg',
    version: '1.0.0',
    exports: {
      '.': { types: './types/main.d.ts', default: './main.js' },
      './sub2': { types: './types/sub2.d.ts', default: './sub2.js' },
    },
    typesVersions: { '*': { sub2: ['./types/sub2.d.ts'] } },
  });
  write(
    root,
    'node_modules/exports-pkg/types/main.d.ts',
    'export declare const markerR26ExportsMain: number;\n',
  );
  write(
    root,
    'node_modules/exports-pkg/types/sub2.d.ts',
    'export declare const markerR26TypesVersions: number;\n',
  );
  write(root, 'node_modules/exports-pkg/main.js', 'export const markerR26ExportsMain = 26;\n');
  write(root, 'node_modules/exports-pkg/sub2.js', 'export const markerR26TypesVersions = 26;\n');
  write(
    root,
    'src/pkg/uses-exports.ts',
    "import { markerR26ExportsMain } from 'exports-pkg';\nexport const useExports = markerR26ExportsMain;\n",
  );
  write(
    root,
    'src/pkg/uses-types-versions.ts',
    "import { markerR26TypesVersions } from 'exports-pkg/sub2';\nexport const useTypesVersions = markerR26TypesVersions;\n",
  );

  // 27 — untyped package whose types live in `@types/<pkg>`.
  pkg('plain-pkg', { name: 'plain-pkg', version: '1.0.0', main: 'index.js' });
  write(root, 'node_modules/plain-pkg/index.js', 'export const markerR27PlainRuntime = 27;\n');
  pkg('@types/plain-pkg', { name: '@types/plain-pkg', version: '1.0.0', types: 'index.d.ts' });
  write(
    root,
    'node_modules/@types/plain-pkg/index.d.ts',
    'export declare const markerR27AtTypes: number;\n',
  );
  write(
    root,
    'src/pkg/uses-at-types.ts',
    "import { markerR27AtTypes } from 'plain-pkg';\nexport const useAtTypes = markerR27AtTypes;\n",
  );

  // 28 — untyped JS package: the landing target is the JS entry itself.
  pkg('untyped-js-pkg', { name: 'untyped-js-pkg', version: '1.0.0', main: 'lib/entry.js' });
  write(
    root,
    'node_modules/untyped-js-pkg/lib/entry.js',
    'export const markerR28UntypedJs = 28;\n',
  );
  write(
    root,
    'src/pkg/uses-untyped.ts',
    "import { markerR28UntypedJs } from 'untyped-js-pkg';\nexport const useUntyped = markerR28UntypedJs;\n",
  );

  // 29 — classic subpath (no exports map).
  pkg('subpath-pkg', { name: 'subpath-pkg', version: '1.0.0', types: 'index.d.ts' });
  write(
    root,
    'node_modules/subpath-pkg/index.d.ts',
    'export declare const markerR29Root: number;\n',
  );
  write(
    root,
    'node_modules/subpath-pkg/deep/thing.d.ts',
    'export declare const markerR29Subpath: number;\n',
  );
  write(
    root,
    'src/pkg/uses-subpath.ts',
    "import { markerR29Subpath } from 'subpath-pkg/deep/thing';\nexport const useSubpath = markerR29Subpath;\n",
  );

  // 30 — barrel chain INSIDE a package: index.d.ts re-exports ./lib/x.d.ts.
  pkg('barrel-pkg', { name: 'barrel-pkg', version: '1.0.0', types: 'index.d.ts' });
  write(
    root,
    'node_modules/barrel-pkg/index.d.ts',
    "export { markerR30PkgLeaf } from './lib/x';\n",
  );
  write(
    root,
    'node_modules/barrel-pkg/lib/x.d.ts',
    'export declare const markerR30PkgLeaf: number;\n',
  );
  write(
    root,
    'src/pkg/uses-pkg-barrel.ts',
    "import { markerR30PkgLeaf } from 'barrel-pkg';\nexport const usePkgBarrel = markerR30PkgLeaf;\n",
  );

  // 36 — a package visible only from a NESTED node_modules (pnpm / non-hoisted shape).
  write(
    root,
    'src/nested/node_modules/nested-only-pkg/package.json',
    json({ name: 'nested-only-pkg', version: '1.0.0', types: 'index.d.ts' }),
  );
  write(
    root,
    'src/nested/node_modules/nested-only-pkg/index.d.ts',
    'export declare const markerR36NestedPkg: number;\n',
  );
  write(
    root,
    'src/nested/uses-nested.ts',
    "import { markerR36NestedPkg } from 'nested-only-pkg';\nexport const useNested = markerR36NestedPkg;\n",
  );
}

/** Rows 31–32: a workspace with a junction from app/node_modules to the sibling package. */
function writeMonorepo(root) {
  write(
    root,
    'packages/lib/package.json',
    json({ name: '@acme/lib', version: '1.0.0', main: 'src/index.ts', types: 'src/index.ts' }),
  );
  write(root, 'packages/lib/src/index.ts', 'export const markerR31MonoLib = 31;\n');
  write(root, 'packages/lib/src/second.ts', 'export const markerR32MonoPaths = 32;\n');
  write(
    root,
    'packages/app/package.json',
    json({ name: '@acme/app', version: '1.0.0', dependencies: { '@acme/lib': '1.0.0' } }),
  );
  write(
    root,
    'packages/app/tsconfig.json',
    json({
      extends: '../../tsconfig.base.json',
      compilerOptions: { baseUrl: '.', paths: { '@acme/lib2/*': ['../lib/src/*'] } },
    }),
  );
  write(
    root,
    'packages/app/src/uses-lib.ts',
    "import { markerR31MonoLib } from '@acme/lib';\nexport const useMonoLib = markerR31MonoLib;\n",
  );
  write(
    root,
    'packages/app/src/uses-lib-paths.ts',
    "import { markerR32MonoPaths } from '@acme/lib2/second';\nexport const useMonoPaths = markerR32MonoPaths;\n",
  );

  // The workspace link itself. A junction (not a symlink) — that is what npm/pnpm create on
  // Windows, and it is what `realpath` has to see through.
  const linkDir = join(root, 'packages/app/node_modules/@acme');
  mkdirSync(linkDir, { recursive: true });
  symlinkSync(join(root, 'packages/lib'), join(linkDir, 'lib'), 'junction');
}

function writeFeedback(root) {
  // 35 — the consumer ships with the index; the e2e creates the target mid-run.
  write(
    root,
    'src/late/late-consumer.ts',
    "import { markerR35LateFile } from './late-target';\nexport const useLate = markerR35LateFile;\n",
  );

  // 37 — a specifier that resolves to nothing anywhere.
  write(
    root,
    'src/feedback/uses-missing.ts',
    "import { markerR37Missing } from 'no-such-package-anywhere';\nexport const useMissing = markerR37Missing;\n",
  );

  // 39 — the first TS file a session opens, used before the providers can have registered.
  write(root, 'src/feedback/first-open.ts', "export const firstOpen = 'r39';\n");

  // 40 — whitespace / keyword / string-literal positions.
  write(
    root,
    'src/feedback/no-symbol.ts',
    ['const plainString = "just a string literal";', 'export { plainString };', ''].join('\n'),
  );

  // 41 — a file the TS worker has no business answering for.
  write(root, 'src/feedback/thing.py', 'def marker_r41_python():\n    return 41\n');
}

/** Row 34: enough filler to push the alphabetically-last target past `INDEX_FILE_CAP`. */
function writeCapFiller(root) {
  for (let i = 0; i < CAP_FILLER_COUNT; i++) {
    write(
      root,
      `aaa-cap-filler/f${String(i).padStart(5, '0')}.ts`,
      `export const cap${i} = ${i};\n`,
    );
  }
  write(root, 'zzz-cap-target.ts', 'export const markerR34BeyondCap = 34;\n');
  write(
    root,
    'zzz-cap-consumer.ts',
    "import { markerR34BeyondCap } from './zzz-cap-target';\nexport const useCap = markerR34BeyondCap;\n",
  );
}

/** A second project root (row 24): a different tsconfig, opened as a second session. */
function writeSecondRoot(base) {
  const other = join(base, 'other');
  write(
    other,
    'tsconfig.json',
    json({ compilerOptions: { baseUrl: '.', paths: { '$other/*': ['lib/*'] } } }),
  );
  write(other, '.gitignore', 'node_modules/\n');
  write(other, 'lib/other-target.ts', 'export const markerR24OtherRoot = 24;\n');
  write(
    other,
    'src/uses-other-alias.ts',
    "import { markerR24OtherRoot } from '$other/other-target';\nexport const useOther = markerR24OtherRoot;\n",
  );
  gitInit(other);
  return other;
}

function gitInit(dir) {
  const run = (args) => execFileSync('git', args, { cwd: dir, stdio: 'ignore', windowsHide: true });
  run(['init', '-q']);
  run(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'add', '-A']);
  run([
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.invalid',
    'commit',
    '-q',
    '-m',
    'fixture',
  ]);
}

/**
 * Materialise the fixture workspace.
 *
 * @param {string} base            A throwaway directory the caller owns.
 * @param {{ capFiller?: boolean, secondRoot?: boolean }} [opts]
 * @returns {{ root: string, base: string, shared: string, other: string | null }}
 *   `root` is the path to open as the session.
 */
export function buildGotoFixture(base, opts = {}) {
  const root = join(base, 'repo');
  const shared = join(base, 'shared');

  // 33 — ABOVE the session root, so nothing under `root` can ever index it.
  write(shared, 'x.ts', 'export const markerR33AboveRoot = 33;\n');

  write(root, '.gitignore', 'node_modules/\n');
  write(root, 'package.json', json({ name: 'goto-fixture', version: '1.0.0', private: true }));
  writeTsconfigs(root);
  writeFirstParty(root);
  writeConfigConsumers(root);
  writePackages(root);
  writeMonorepo(root);
  writeFeedback(root);

  // 33's consumer sits three levels below the root so the specifier has to climb out of it.
  write(
    root,
    'src/first/uses-above.ts',
    "import { markerR33AboveRoot } from '../../../shared/x';\nexport const useAbove = markerR33AboveRoot;\n",
  );

  if (opts.capFiller) writeCapFiller(root);
  gitInit(root);

  const other = opts.secondRoot ? writeSecondRoot(base) : null;
  return { root, base, shared, other };
}
