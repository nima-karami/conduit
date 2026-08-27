/**
 * Go to Definition flow matrix — feedback and outcome honesty
 * (docs/specs/2026-08-21-goto-definition-flows.md rows 37–41).
 *
 * The wrapper infers success from "did the editor move" and says nothing once the index is
 * complete, so Monaco's own message is the only thing the user sees — and for anything that
 * merely isn't indexed, that message ("No definition found for 'zod'") is factually wrong.
 * These rows assert the spec's classified outcome instead.
 *
 * Run: node test/e2e/run-smoke.mjs goto-matrix-feedback
 */

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildGotoFixture } from './fixtures/goto/build-fixture.mjs';
import {
  clearTransients,
  createMatrix,
  describe,
  observe,
  openDoc,
  placeCursor,
  readNavMenu,
  tapIndex,
  trigger,
  waitForIndexReady,
} from './goto-matrix.mjs';
import { openSession, runScenario } from './harness.mjs';

const MONACO_NO_DEF = /no definition found/i;

runScenario('goto-matrix-feedback', async ({ app, page, log }) => {
  const base = mkdtempSync(join(tmpdir(), 'goto-fx-fb-'));
  const { root } = buildGotoFixture(base);
  log('fixture at', root);

  await tapIndex(page);
  const sid = await openSession(page, { path: root });
  await waitForIndexReady(page, log);

  const m = createMatrix('feedback', log);
  const f = (rel) => join(root, rel);

  await m.row(
    '37',
    { flow: 'zero results, index complete', trigger: 'f12', current: '❌', target: '✅' },
    async () => {
      await clearTransients(page);
      await openDoc(app, page, sid, f('src/feedback/uses-missing.ts'));
      await placeCursor(page, f('src/feedback/uses-missing.ts'), 'markerR37Missing', 1);
      const { before, after } = await trigger(page, 'f12');
      // Honest = Conduit classified it, at the cursor. Monaco's own wording is the failure
      // mode, not the fix — and the baseline's real symptom was the caret silently landing
      // on the import clause, so holding position is half the assertion.
      const honest = !!after.overlay && !MONACO_NO_DEF.test(after.overlay);
      const held = after.path === before.path && after.line === before.line;
      return {
        pass: honest && held,
        observed: `${held ? 'caret held' : 'CARET JUMPED to the import clause'} · ${describe(after)}`,
      };
    },
  );

  await m.row(
    '38',
    {
      flow: 'nav racing a concurrent model re-seed',
      trigger: 'f12',
      current: '🔇',
      target: '✅',
    },
    async () => {
      await clearTransients(page);
      await openDoc(app, page, sid, f('src/first/rel-target.ts'));
      await openDoc(app, page, sid, f('src/first/rel-consumer.ts'));
      await placeCursor(page, f('src/first/rel-consumer.ts'), 'markerR02RelTarget', 1);
      const before = await observe(page);
      // Re-seed the model in the SAME tick the navigation starts in. A tab switch loses this
      // race against a local file every time (the baseline's INCONCLUSIVE); an edit does not,
      // and a version bump is the only way our own worker call can go stale.
      await page.evaluate(() => {
        const eds = window.monaco.editor.getEditors();
        const ed = eds[eds.length - 1];
        const model = ed.getModel();
        const v0 = model.getVersionId();
        void ed.getAction('conduit.goToDefinition')?.run();
        const last = model.getLineCount();
        model.applyEdits([
          { range: new window.monaco.Range(last, 1, last, 1), text: '\n// r38 re-seed\n' },
        ]);
        window.__r38 = { v0, v1: model.getVersionId() };
      });
      await page.waitForTimeout(4000);
      const after = await observe(page);
      const bump = await page.evaluate(() => window.__r38);
      const spoke = after.toasts.length > before.toasts.length || !!after.overlay;
      const arrived = after.path?.endsWith('rel-target.ts') && after.lineText.includes('markerR02');
      return {
        pass: bump.v1 > bump.v0 && (arrived || spoke),
        observed: `model v${bump.v0}->v${bump.v1}; ${arrived ? 'landed' : spoke ? 'reported' : 'SILENT'} · ${describe(after)}`,
      };
    },
  );

  await m.row(
    '40',
    { flow: 'right-click on a string literal', trigger: 'menu', current: '❌', target: '✅' },
    async () => {
      await clearTransients(page);
      await openDoc(app, page, sid, f('src/feedback/no-symbol.ts'));
      await placeCursor(page, f('src/feedback/no-symbol.ts'), 'just a string', 0);
      const { after } = await trigger(page, 'menu');
      const honest = !!after.overlay && !MONACO_NO_DEF.test(after.overlay);
      return { pass: honest, observed: describe(after) };
    },
  );

  await m.row(
    '40b',
    { flow: 'F12 on a keyword', trigger: 'f12', current: '❌', target: '✅' },
    async () => {
      await clearTransients(page);
      await openDoc(app, page, sid, f('src/feedback/no-symbol.ts'));
      await placeCursor(page, f('src/feedback/no-symbol.ts'), 'const', 0);
      const { after } = await trigger(page, 'f12');
      const honest = !!after.overlay && !MONACO_NO_DEF.test(after.overlay);
      return { pass: honest, observed: describe(after) };
    },
  );

  await m.row(
    '41',
    { flow: 'non-TS file (.py)', trigger: 'menu', current: '✅', target: '✅' },
    async () => {
      await clearTransients(page);
      await openDoc(app, page, sid, f('src/feedback/thing.py'));
      await placeCursor(page, f('src/feedback/thing.py'), 'marker_r41_python', 0);
      const menu = await readNavMenu(page);
      const navRows = menu.rows.filter((r) => /^(Go to|Peek|Find All)/.test(r.label));
      const allDisabled = navRows.length > 0 && navRows.every((r) => r.disabled);
      return {
        pass: allDisabled,
        observed: `${navRows.length} nav row(s), ${navRows.filter((r) => r.disabled).length} disabled`,
      };
    },
  );

  m.finish();
});
