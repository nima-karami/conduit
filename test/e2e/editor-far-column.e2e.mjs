/**
 * A symbol far along a long line: the caret Monaco paints sits on the glyph it belongs to, and a
 * real Ctrl+click on it navigates.
 *
 * Monaco measures its font once, synchronously, and caches the reading for the whole window. The
 * editor font is a web font, so the first reading was taken against the fallback (Consolas,
 * 7.15 px at 13 px vs JetBrains Mono's 7.8) and every caret, selection and hit-test coordinate
 * then drifted ~0.65 px per column — 50+ px by column 80. The same drift made the e2e pointer
 * helper land on the wrong token past the first few columns; `pointOn` now reads the painted glyph.
 *
 * Run: `npm run build`, then `node test/e2e/run-smoke.mjs editor-far-column`.
 */

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  glyphAt,
  observe,
  openViaTree,
  placeCursor,
  pointOn,
  tapIndex,
  waitForIndexReady,
} from './goto-matrix.mjs';
import { assert, openSession, runScenario } from './harness.mjs';

const PAD = 'x'.repeat(120);

function makeFixture() {
  const root = mkdtempSync(join(tmpdir(), 'conduit-farcol-'));
  writeFileSync(
    join(root, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: { strict: true, module: 'esnext', target: 'es2022' },
      include: ['*.ts'],
    }),
  );
  writeFileSync(
    join(root, 'a.ts'),
    [
      "import { farTarget, nearDecoy } from './target';",
      '',
      `export const padded = ['${PAD}', nearDecoy(), farTarget()];`,
      '',
    ].join('\n'),
  );
  writeFileSync(
    join(root, 'target.ts'),
    [
      'export function nearDecoy(): number {',
      '  return 0;',
      '}',
      '',
      'export function farTarget(): number {',
      '  return 1;',
      '}',
      '',
    ].join('\n'),
  );
  return root.replace(/\\/g, '/');
}

runScenario('editor-far-column', async ({ page, log }) => {
  const root = makeFixture();
  const a = `${root}/a.ts`;
  await tapIndex(page);
  await openSession(page, { path: root });
  await waitForIndexReady(page, log);
  await openViaTree(page, root, ['a.ts']);
  await page.evaluate(() => document.fonts.ready);
  // A web font's `loadingdone` and any re-layout it triggers land after `ready` resolves.
  await page.waitForTimeout(300);

  await placeCursor(page, a, 'farTarget()');
  const caretAt = await page.evaluate(() =>
    window.monaco.editor
      .getEditors()
      .find((e) => e.hasTextFocus())
      .getPosition(),
  );
  const glyph = await glyphAt(page, a, caretAt);
  const caret = await page.evaluate(
    () =>
      window.monaco.editor
        .getEditors()
        .find((e) => e.hasTextFocus())
        .getDomNode()
        .querySelector('.cursors-layer .cursor')
        .getBoundingClientRect().left,
  );
  assert(
    caretAt.column > 120 && Math.abs(caret - glyph.left) < 2,
    `the caret at column ${caretAt.column} is painted at x=${caret.toFixed(1)} but its glyph is at x=${glyph.left.toFixed(1)} — Monaco is laying out with a stale font measurement`,
  );
  log(`caret on its glyph at column ${caretAt.column} (Δ ${(caret - glyph.left).toFixed(2)} px) ✓`);

  const point = await pointOn(page, a, 'farTarget()');
  assert(point.column > 120, `pointOn should target a far column, got ${point.column}`);
  await page.keyboard.down('Control');
  await page.mouse.move(point.x, point.y);
  await page.waitForTimeout(250);
  await page.mouse.click(point.x, point.y);
  await page.keyboard.up('Control');
  let after = await observe(page);
  for (let i = 0; i < 40 && !/target\.ts$/.test(after.path ?? ''); i++) {
    await page.waitForTimeout(150);
    after = await observe(page);
  }
  assert(
    /target\.ts$/.test(after.path ?? '') && after.line === 5,
    `a real Ctrl+click on farTarget (column ${point.column}) should land on target.ts:5, got ${JSON.stringify(after)}`,
  );
  log(`real Ctrl+click at column ${point.column} → target.ts:5 ✓`);
});
