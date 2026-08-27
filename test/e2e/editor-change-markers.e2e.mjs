/**
 * Editor change decorations (real-app smoke). Crosses the renderer/host boundary: `git:headBlob`
 * runs `rev-parse` and `show HEAD:<rel>` on the host, and the renderer diffs that blob against
 * the live Monaco model. The preview mock answers `notRepo`, so only the built app proves it.
 *
 * Flow: temp repo with a committed file → modify it (an insertion, a replacement, a deletion)
 * plus one untracked file → open the tracked file → assert gutter DOM + decoration options
 * (ruler and minimap colours; the ruler is a canvas and has no assertable DOM) → Alt+F5
 * announcement → screenshot → open the untracked file → whole-file added.
 *
 * The change PEEK is Lane E and is deliberately not asserted here.
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { assert, closeApp, openSession, runScenario } from './harness.mjs';

const line = (n) => `const v${n} = ${n};`;
const committed = Array.from({ length: 14 }, (_, i) => line(i + 1)).join('\n');

/** Lines 4-5 removed; line 8 rewritten; two lines inserted after line 11. */
const modified = [
  line(1),
  line(2),
  line(3),
  line(6),
  line(7),
  'const v8 = 800;',
  line(9),
  line(10),
  line(11),
  'const inserted1 = 1;',
  'const inserted2 = 2;',
  line(12),
  line(13),
  line(14),
].join('\n');

/** Read every change decoration Monaco holds for the model whose uri ends with `suffix`. */
const readDecorations = (suffix) => {
  const eds = window.monaco.editor.getEditors?.() ?? [];
  const ed = eds.find((e) => e.getModel()?.uri.toString().endsWith(suffix));
  const model = ed?.getModel();
  if (!model) return null;
  return model
    .getAllDecorations()
    .filter((d) => (d.options.linesDecorationsClassName ?? '').includes('cdec'))
    .map((d) => ({
      cls: d.options.linesDecorationsClassName,
      start: d.range.startLineNumber,
      end: d.range.endLineNumber,
      hover: d.options.hoverMessage?.value ?? '',
      ruler: d.options.overviewRuler?.color ?? '',
      minimap: d.options.minimap?.color ?? '',
    }));
};

const openInEditor = async (page, name) => {
  const row = page.locator('.filerow', {
    has: page.locator('.filerow__name', { hasText: new RegExp(`^${name.replace('.', '\\.')}$`) }),
  });
  await row.first().waitFor({ state: 'attached', timeout: 20000 });
  await row.first().click();
  await page.waitForFunction(
    (suffix) =>
      (window.monaco?.editor.getModels() ?? []).some((m) => m.uri.toString().endsWith(suffix)),
    name,
    { timeout: 20000 },
  );
};

runScenario('editor-change-markers', async ({ app, page, log }) => {
  const root = mkdtempSync(join(tmpdir(), 'conduit-marks-'));
  mkdirSync(root, { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['config', 'user.email', 'marks@t'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'Marks Author'], { cwd: root });
  writeFileSync(join(root, 'tracked.ts'), `${committed}\n`);
  execFileSync('git', ['add', '.'], { cwd: root });
  execFileSync('git', ['commit', '-qm', 'seed'], { cwd: root });
  writeFileSync(join(root, 'tracked.ts'), `${modified}\n`);
  writeFileSync(join(root, 'brandnew.ts'), 'const fresh = true;\nconst alsoFresh = 1;\n');

  await openSession(page, { path: root.replace(/\\/g, '/') });
  await page.locator('.rtab', { hasText: 'Files' }).click();
  await openInEditor(page, 'tracked.ts');
  log('tracked file opened in the editor ✓');

  // Gutter DOM — the three shapes the accessibility contract relies on (§10). `attached`, not
  // `visible`: the smoke runner launches the window hidden.
  for (const kind of ['added', 'modified', 'deleted']) {
    await page
      .locator(`.margin-view-overlays .cdec--${kind}`)
      .first()
      .waitFor({ state: 'attached', timeout: 15000 });
  }
  log('gutter shows added, modified and deleted marks ✓');

  const decos = await page.evaluate(readDecorations, 'tracked.ts');
  assert(
    Array.isArray(decos) && decos.length >= 3,
    `expected >=3 change decorations, got ${decos?.length}`,
  );
  const kinds = new Set(decos.map((d) => d.cls));
  for (const cls of ['cdec cdec--added', 'cdec cdec--modified', 'cdec cdec--deleted']) {
    assert(kinds.has(cls), `missing a "${cls}" decoration; got ${[...kinds].join(', ')}`);
  }
  assert(
    decos.every((d) => d.ruler !== '' && d.minimap !== ''),
    'every change decoration must carry an overview-ruler and a minimap colour',
  );
  assert(
    decos.every((d) => /^(Added|Modified|Deleted) \d+ lines?$/.test(d.hover)),
    `hover text must state kind + line count, got ${JSON.stringify(decos.map((d) => d.hover))}`,
  );
  log(`${decos.length} decorations, all with ruler + minimap marks and tooltips ✓`);

  // Alt+F5 announces through the polite live region.
  await page.evaluate(() => {
    const eds = window.monaco.editor.getEditors?.() ?? [];
    const ed = eds.find((e) => e.getModel()?.uri.toString().endsWith('tracked.ts')) ?? eds[0];
    ed?.focus();
    ed?.setPosition({ lineNumber: 1, column: 1 });
  });
  await page.keyboard.press('Alt+F5');
  await page.waitForFunction(
    () => /Change \d+ of \d+/.test(document.querySelector('.viewer__announce')?.textContent ?? ''),
    null,
    { timeout: 10000 },
  );
  const announced = (await page.locator('.viewer__announce').first().textContent())?.trim() ?? '';
  log(`live region announced: "${announced}"`);

  const shotDir = join(process.env.TEMP || tmpdir(), 'claude-scratch');
  mkdirSync(shotDir, { recursive: true });
  await page.screenshot({ path: join(shotDir, 'editor-change-markers.png') }).catch(() => {});
  // A run that has to file evidence points this at its own directory; unset in a normal run.
  const evidence = process.env.CONDUIT_MARKERS_SHOT;
  if (evidence) {
    mkdirSync(dirname(evidence), { recursive: true });
    await page.screenshot({ path: evidence }).catch(() => {});
  }

  // An untracked file reads as one whole-file addition.
  await page.locator('.rtab', { hasText: 'Files' }).click();
  await openInEditor(page, 'brandnew.ts');
  await page.waitForFunction(
    () => {
      const eds = window.monaco.editor.getEditors?.() ?? [];
      const ed = eds.find((e) => e.getModel()?.uri.toString().endsWith('brandnew.ts'));
      const model = ed?.getModel();
      if (!model) return false;
      const d = model
        .getAllDecorations()
        .filter((x) => (x.options.linesDecorationsClassName ?? '').includes('cdec'));
      return d.length === 1 && d[0].options.linesDecorationsClassName.includes('cdec--added');
    },
    null,
    { timeout: 15000 },
  );
  const fresh = await page.evaluate(readDecorations, 'brandnew.ts');
  assert(fresh.length === 1, `untracked file should have ONE marker, got ${fresh.length}`);
  assert(fresh[0].start === 1, `untracked marker should start at line 1, got ${fresh[0].start}`);
  log('untracked file marked as one whole-file addition ✓');

  await closeApp(app, page);
});
