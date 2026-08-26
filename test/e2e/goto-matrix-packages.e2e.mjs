/**
 * Go to Definition flow matrix — everything beyond the index
 * (docs/specs/2026-08-21-goto-definition-flows.md rows 25–33, 36).
 *
 * These are the user's headline: `node_modules` is never indexed, nothing above the session
 * root is either, and there is no fallback resolver — so every row here is expected to fail
 * against the pre-fix build. The point of running them is the OBSERVED column: what the user
 * actually sees when the navigation cannot resolve.
 *
 * Run: node test/e2e/run-smoke.mjs goto-matrix-packages
 */

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildGotoFixture } from './fixtures/goto/build-fixture.mjs';
import {
  clearTransients,
  createMatrix,
  describe,
  landed,
  openDoc,
  placeCursor,
  tapIndex,
  trigger,
  waitForIndexReady,
} from './goto-matrix.mjs';
import { openSession, runScenario } from './harness.mjs';

runScenario('goto-matrix-packages', async ({ app, page, log }) => {
  const base = mkdtempSync(join(tmpdir(), 'goto-fx-pkg-'));
  const { root } = buildGotoFixture(base);
  log('fixture at', root);

  await tapIndex(page);
  const sid = await openSession(page, { path: root });
  await waitForIndexReady(page, log);

  const m = createMatrix('packages', log);
  const f = (rel) => join(root, rel);

  const nav = async (file, token, nth, kind) => {
    await clearTransients(page);
    await openDoc(app, page, sid, f(file));
    await placeCursor(page, f(file), token, nth);
    return (await trigger(page, kind)).after;
  };

  const row = (id, meta, file, token, kind, expectFile, marker) =>
    m.row(id, meta, async () => {
      const after = await nav(file, token, 1, kind);
      return { pass: landed(after, expectFile, marker), observed: describe(after) };
    });

  await row(
    '25',
    { flow: 'bare package with `types`', trigger: 'f12', current: '❌', target: '✅' },
    'src/pkg/uses-typed.ts',
    'markerR25TypedPkg',
    'f12',
    'typed-pkg/index.d.ts',
    'markerR25TypedPkg',
  );
  await row(
    '26',
    { flow: 'exports map, types condition', trigger: 'menu', current: '❌', target: '✅' },
    'src/pkg/uses-exports.ts',
    'markerR26ExportsMain',
    'menu',
    'exports-pkg/types/main.d.ts',
    'markerR26ExportsMain',
  );
  await row(
    '26b',
    { flow: 'typesVersions subpath', trigger: 'f12', current: '❌', target: '✅' },
    'src/pkg/uses-types-versions.ts',
    'markerR26TypesVersions',
    'f12',
    'exports-pkg/types/sub2.d.ts',
    'markerR26TypesVersions',
  );
  await row(
    '27',
    { flow: '@types/<pkg>', trigger: 'f12', current: '❌', target: '✅' },
    'src/pkg/uses-at-types.ts',
    'markerR27AtTypes',
    'f12',
    '@types/plain-pkg/index.d.ts',
    'markerR27AtTypes',
  );
  await row(
    '28',
    { flow: 'untyped JS package → JS entry', trigger: 'menu', current: '❌', target: '✅' },
    'src/pkg/uses-untyped.ts',
    'markerR28UntypedJs',
    'menu',
    'untyped-js-pkg/lib/entry.js',
    'markerR28UntypedJs',
  );
  await row(
    '29',
    { flow: 'subpath import', trigger: 'f12', current: '❌', target: '✅' },
    'src/pkg/uses-subpath.ts',
    'markerR29Subpath',
    'f12',
    'subpath-pkg/deep/thing.d.ts',
    'markerR29Subpath',
  );
  await row(
    '30',
    { flow: 'barrel chain INSIDE a package', trigger: 'f12', current: '❌', target: '✅' },
    'src/pkg/uses-pkg-barrel.ts',
    'markerR30PkgLeaf',
    'f12',
    'barrel-pkg/lib/x.d.ts',
    'markerR30PkgLeaf',
  );
  await row(
    '31',
    { flow: 'monorepo sibling via junction', trigger: 'menu', current: '❌', target: '✅' },
    'packages/app/src/uses-lib.ts',
    'markerR31MonoLib',
    'menu',
    'packages/lib/src/index.ts',
    'markerR31MonoLib',
  );
  await row(
    '32',
    {
      flow: 'sibling via package-level tsconfig paths',
      trigger: 'f12',
      current: '❌',
      target: '✅',
    },
    'packages/app/src/uses-lib-paths.ts',
    'markerR32MonoPaths',
    'f12',
    'packages/lib/src/second.ts',
    'markerR32MonoPaths',
  );
  await row(
    '33',
    { flow: '../shared/x above the session root', trigger: 'f12', current: '❌', target: '✅' },
    'src/first/uses-above.ts',
    'markerR33AboveRoot',
    'f12',
    'shared/x.ts',
    'markerR33AboveRoot',
  );
  await row(
    '36',
    { flow: 'nested node_modules (pnpm shape)', trigger: 'menu', current: '❌', target: '✅' },
    'src/nested/uses-nested.ts',
    'markerR36NestedPkg',
    'menu',
    'nested-only-pkg/index.d.ts',
    'markerR36NestedPkg',
  );

  m.finish();
});
