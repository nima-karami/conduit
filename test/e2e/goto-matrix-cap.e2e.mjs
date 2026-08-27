/**
 * Go to Definition flow matrix — the index cap and the indexing window
 * (docs/specs/2026-08-21-goto-definition-flows.md rows 34 and 45).
 *
 * Isolated from the rest of the matrix on purpose: the only way to exercise the 5000-file cap
 * is to build a project that exceeds it, and the alphabetical truncation would then push every
 * OTHER row's fixture out of the index.
 *
 * Run: node test/e2e/run-smoke.mjs goto-matrix-cap
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
  waitForIndexStarted,
} from './goto-matrix.mjs';
import { openSession, runScenario } from './harness.mjs';

runScenario('goto-matrix-cap', async ({ app, page, log }) => {
  const base = mkdtempSync(join(tmpdir(), 'goto-fx-cap-'));
  const t0 = Date.now();
  const { root } = buildGotoFixture(base, { capFiller: true });
  log(`fixture (with cap filler) built in ${((Date.now() - t0) / 1000).toFixed(1)}s at ${root}`);

  await tapIndex(page);
  const sid = await openSession(page, { path: root });

  const m = createMatrix('cap', log);
  const f = (rel) => join(root, rel);

  // 45 — the pre-deadline window: with >5000 files the stream is still running while the
  // first navigation is asked for.
  await m.row(
    '45',
    { flow: 'navigation while indexing', trigger: 'f12', current: '✅', target: '✅' },
    async () => {
      // Everything expensive happens BEFORE the stream starts: indexing is deferred 1.5 s past
      // the session open and then finishes in a couple of seconds, so opening the file at that
      // point would consume the whole pre-deadline window this row exists to observe.
      await openDoc(app, page, sid, f('zzz-cap-consumer.ts'));
      await placeCursor(page, f('zzz-cap-consumer.ts'), 'markerR34BeyondCap', 1);
      await waitForIndexStarted(page);
      const { after } = await trigger(page, 'f12');
      const stillIndexing = await page.evaluate(() => window.__idx?.done !== true);
      // At the cursor, where the user is looking — and carrying the progress, not the
      // "isn't indexed" verdict only a COMPLETED index earns.
      const told = /^Still indexing this project \(\d+ of \d+ files\)\./.test(after.overlay);
      return {
        pass: told,
        inconclusive: !stillIndexing && !told,
        observed: `${stillIndexing ? 'index still streaming' : 'index completed before the nav ran'} · ${describe(after)}`,
      };
    },
  );

  await waitForIndexReady(page, log);

  await m.row(
    '34',
    { flow: 'file beyond the 5000-file cap', trigger: 'menu', current: '❌', target: '✅' },
    async () => {
      await clearTransients(page);
      await openDoc(app, page, sid, f('zzz-cap-consumer.ts'));
      await placeCursor(page, f('zzz-cap-consumer.ts'), 'markerR34BeyondCap', 1);
      const { after } = await trigger(page, 'menu');
      const indexed = await page.evaluate(() =>
        Object.keys(
          window.monaco.languages.typescript.typescriptDefaults.getExtraLibs() ?? {},
        ).filter((k) => k.endsWith('zzz-cap-target.ts')),
      );
      return {
        pass: landed(after, 'zzz-cap-target.ts', 'markerR34BeyondCap'),
        observed: `target ${indexed.length ? 'IS' : 'is NOT'} in extraLibs · ${describe(after)}`,
      };
    },
  );

  m.finish();
});
