/**
 * Go to Definition flow matrix — configuration discovery
 * (docs/specs/2026-08-21-goto-definition-flows.md rows 18–24).
 *
 * Each row gets a knob of its own, because `paths` is a whole-key override in TS and so can
 * only live in one config of a chain:
 *   18  `paths` in <root>/tsconfig.json          → `@/lib/foo`
 *   19  `paths` in tsconfig.app.json / jsconfig  → `#app/…`, `~js/…`
 *   20  `baseUrl` inherited from tsconfig.base   → a non-relative `src/…` import
 *   21  the relative `extends` that carries it
 *   22  `target: ES2022` from a PACKAGE-form extends → an ES2022-only lib symbol
 *   23  `paths` from a referenced project        → `~ref/…`
 *   24  a second session with a different tsconfig in the same window
 *
 * Run: node test/e2e/run-smoke.mjs goto-matrix-config
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

runScenario('goto-matrix-config', async ({ app, page, log }) => {
  const base = mkdtempSync(join(tmpdir(), 'goto-fx-cfg-'));
  const { root, other } = buildGotoFixture(base, { secondRoot: true });
  log('fixture at', root, '· second root at', other);

  await tapIndex(page);
  const sid = await openSession(page, { path: root });
  await waitForIndexReady(page, log);

  const m = createMatrix('config', log);
  const f = (rel) => join(root, rel);

  const nav = async (file, token, nth, kind) => {
    await clearTransients(page);
    await openDoc(app, page, sid, f(file));
    await placeCursor(page, f(file), token, nth);
    return (await trigger(page, kind)).after;
  };

  await m.row(
    '18',
    { flow: 'paths alias in <root>/tsconfig.json', trigger: 'f12', current: '✅', target: '✅' },
    async () => {
      const after = await nav('src/config/uses-root-alias.ts', 'markerR18RootAlias', 1, 'f12');
      return {
        pass: landed(after, 'src/lib/foo.ts', 'markerR18RootAlias'),
        observed: describe(after),
      };
    },
  );

  await m.row(
    '19',
    { flow: 'alias from tsconfig.app.json', trigger: 'menu', current: '❌', target: '✅' },
    async () => {
      const after = await nav('src/app/uses-app-alias.ts', 'markerR19AppAlias', 1, 'menu');
      return {
        pass: landed(after, 'src/app/appalias.ts', 'markerR19AppAlias'),
        observed: describe(after),
      };
    },
  );

  await m.row(
    '19b',
    { flow: 'alias from a nested jsconfig.json', trigger: 'f12', current: '❌', target: '✅' },
    async () => {
      const after = await nav('jsproj/consumer.js', 'markerR19bJsconfigAlias', 1, 'f12');
      return {
        pass: landed(after, 'jsproj/lib/target.js', 'markerR19bJsconfigAlias'),
        observed: describe(after),
      };
    },
  );

  await m.row(
    '20',
    { flow: 'baseUrl non-relative import', trigger: 'f12', current: '✅', target: '✅' },
    async () => {
      const after = await nav('src/config/uses-baseurl.ts', 'markerR20BaseUrl', 1, 'f12');
      return {
        pass: landed(after, 'src/baseurl/target.ts', 'markerR20BaseUrl'),
        observed: describe(after),
      };
    },
  );

  // 21 shares the baseUrl probe: the option is declared ONLY in tsconfig.base.json, so a
  // resolution through it is proof the relative extends chain was followed.
  await m.row(
    '21',
    { flow: 'extends "./tsconfig.base.json"', trigger: 'menu', current: '✅', target: '✅' },
    async () => {
      const after = await nav('src/config/uses-baseurl.ts', 'markerR20BaseUrl', 1, 'menu');
      return {
        pass: landed(after, 'src/baseurl/target.ts', 'markerR20BaseUrl'),
        observed: `via inherited baseUrl · ${describe(after)}`,
      };
    },
  );

  await m.row(
    '22',
    { flow: 'extends "@tsconfig/fixture" (package)', trigger: 'f12', current: '❌', target: '✅' },
    async () => {
      const after = await nav('src/config/uses-es2022.ts', '.at(', 0, 'f12');
      // The package config's only knob is `target: ES2022`; `Array.prototype.at` exists in no
      // earlier lib, so landing in an es2022 lib file is proof the package extends was read.
      const ok = /lib\.es2022/i.test(after.path ?? '') && /\bat\b/.test(after.lineText);
      return { pass: ok, observed: describe(after) };
    },
  );

  await m.row(
    '23',
    { flow: 'paths from a referenced project', trigger: 'f12', current: '❌', target: '⚠️' },
    async () => {
      const after = await nav('src/ref/uses-ref-alias.ts', 'markerR23RefAlias', 1, 'f12');
      return {
        pass: landed(after, 'src/ref/reftarget.ts', 'markerR23RefAlias'),
        observed: describe(after),
      };
    },
  );

  await m.row(
    '24',
    {
      flow: 'two roots, different tsconfigs, one window',
      trigger: 'f12',
      current: '⚠️',
      target: '✅',
    },
    async () => {
      const sid2 = await openSession(page, { path: other });
      await page.waitForFunction(
        (r) => window.__idx?.done === true && window.__idx?.root === r,
        other.replace(/\\/g, '/'),
        { timeout: 120000 },
      );
      // The SECOND root's own alias must work…
      await clearTransients(page);
      await openDoc(app, page, sid2, join(other, 'src/uses-other-alias.ts'));
      await placeCursor(page, join(other, 'src/uses-other-alias.ts'), 'markerR24OtherRoot', 1);
      const second = (await trigger(page, 'f12')).after;
      const secondOk = landed(second, 'lib/other-target.ts', 'markerR24OtherRoot');
      // …and the FIRST root's must still work afterwards.
      const back = await nav('src/config/uses-root-alias.ts', 'markerR18RootAlias', 1, 'f12');
      const firstOk = landed(back, 'src/lib/foo.ts', 'markerR18RootAlias');
      return {
        pass: secondOk && firstOk,
        observed: `root2 alias ${secondOk ? 'ok' : 'BROKEN'} (${describe(second)}); root1 alias after ${firstOk ? 'ok' : 'BROKEN'} (${describe(back)})`,
      };
    },
  );

  m.finish();
});
