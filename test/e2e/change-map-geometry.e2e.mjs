/**
 * The editor's change map — what Monaco actually PAINTS on the overview ruler and the minimap
 * (spec 2026-08-31-review-fidelity §4: AC-T3.3, T3.4, T3.5, T3.8).
 *
 * Has to be e2e: the ruler and the minimap are `<canvas>`, so there is no DOM to assert and no
 * unit test can see them. Both are read back with `getImageData` in-page.
 *
 * The three defects it guards, all measured on `main` before the fix:
 *   - a 1200-line file with two one-line edits 900 apart painted ZERO marks (the LCS budget gated
 *     on the SPAN between the first and last change, so 500 lines apart was the cliff);
 *   - a single mark was a 6x6 device-px dot in the left half of a 14 px strip, outboard of a
 *     102 px minimap — the surface a user reads as "the scroll map" carried a 2 px sliver;
 *   - an untracked file emitted one whole-file marker and painted an unbroken green stripe down
 *     both surfaces, which locates nothing.
 *
 * GOTCHA (CLAUDE.md): the runner serves ./out — run `npm run build` first. Close via closeApp.
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { groupMatches, sampleCanvas, tokenRgb } from './canvas.mjs';
import { assert, closeApp, openSession, runScenario } from './harness.mjs';
import { contrast } from './row-color.mjs';

const seq = (n, f = (i) => `const v${i} = ${i};`) =>
  Array.from({ length: n }, (_, i) => f(i + 1)).join('\n');

/** AC-T3.3's fixture. Span 1981 → 3 928 324 cells, 1.8% under the 4 M budget: do not widen it
 *  without re-checking that, or it silently becomes a budget test instead of a geometry one. */
const SCATTERED_LINES = 2000;
const SCATTERED_AT = [10, 1000, 1990];

function buildRepo() {
  const root = mkdtempSync(join(tmpdir(), 'conduit-mapgeom-'));
  const w = (name, text) => writeFileSync(join(root, name), `${text}\n`);
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['config', 'user.email', 'geom@t'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'Geom'], { cwd: root });
  w('scattered.ts', seq(SCATTERED_LINES));
  execFileSync('git', ['add', '.'], { cwd: root });
  execFileSync('git', ['commit', '-qm', 'seed'], { cwd: root });

  const lines = seq(SCATTERED_LINES).split('\n');
  for (const n of SCATTERED_AT) lines[n - 1] = `const changed${n} = ${n * 2};`;
  w('scattered.ts', lines.join('\n'));
  w('brandnew.ts', seq(301));
  return root;
}

const P_LAYOUT = (suffix) => {
  const ed = window.monaco.editor
    .getEditors()
    .find((e) => e.getModel()?.uri.toString().endsWith(suffix));
  if (!ed) return { error: 'no editor' };
  const info = ed.getLayoutInfo();
  return {
    overviewRuler: info.overviewRuler,
    verticalScrollbarWidth: info.verticalScrollbarWidth,
    minimapWidth: info.minimap.minimapWidth,
    minimapLineHeight: info.minimap.minimapLineHeight,
    minimapHeightIsEditorHeight: info.minimap.minimapHeightIsEditorHeight,
    lineCount: ed.getModel().getLineCount(),
  };
};

const openInEditor = async (page, name) => {
  await page.locator('.rtab', { hasText: 'Files' }).click();
  const row = page.locator('.filerow', {
    has: page.locator('.filerow__name', { hasText: new RegExp(`^${name.replace('.', '\\.')}$`) }),
  });
  await row.first().waitFor({ state: 'attached', timeout: 25000 });
  await row.first().click();
  await page.waitForFunction(
    (s) => (window.monaco?.editor.getModels() ?? []).some((m) => m.uri.toString().endsWith(s)),
    name,
    { timeout: 25000 },
  );
};

const decorationCount = (suffix) => {
  const ed = window.monaco.editor
    .getEditors()
    .find((e) => e.getModel()?.uri.toString().endsWith(suffix));
  const model = ed?.getModel();
  if (!model) return null;
  const all = model
    .getAllDecorations()
    .filter((d) => (d.options.linesDecorationsClassName ?? '').includes('cdec'));
  return {
    total: all.length,
    withRuler: all.filter((d) => d.options.overviewRuler).length,
    withMinimap: all.filter((d) => d.options.minimap).length,
    starts: all.map((d) => d.range.startLineNumber),
  };
};

runScenario('change-map-geometry', async ({ app, page, log }) => {
  const root = buildRepo();
  await openSession(page, { path: root.replace(/\\/g, '/') });

  // ── AC-T3.1 + AC-T3.3: three scattered changes in a 2000-line file ─────────────────────────
  await openInEditor(page, 'scattered.ts');
  await page.waitForFunction(
    (s) => {
      const ed = window.monaco.editor
        .getEditors()
        .find((e) => e.getModel()?.uri.toString().endsWith(s));
      const model = ed?.getModel();
      if (!model) return false;
      return (
        model
          .getAllDecorations()
          .filter((d) => (d.options.linesDecorationsClassName ?? '').includes('cdec')).length === 3
      );
    },
    'scattered.ts',
    { timeout: 30000 },
  );
  const decos = await page.evaluate(decorationCount, 'scattered.ts');
  log(`scattered.ts decorations: ${JSON.stringify(decos)}`);
  assert(
    decos.total === 3 && decos.withRuler === 3 && decos.withMinimap === 3,
    `a 2000-line file with 3 scattered edits (span ${SCATTERED_AT[2] - SCATTERED_AT[0] + 1}) must map all 3; got ${JSON.stringify(decos)}`,
  );

  const layout = await page.evaluate(P_LAYOUT, 'scattered.ts');
  log(`layout: ${JSON.stringify(layout)}`);
  assert(
    layout.overviewRuler.width === 20,
    `the overview ruler must be 20 CSS px so its left lane is floor(19/2)=9; got ${layout.overviewRuler.width}`,
  );

  const changeHues = await page.evaluate(() =>
    ['--change-modified', '--change-added', '--change-deleted'].map((name) => {
      const probe = document.createElement('span');
      probe.style.color = `var(${name})`;
      document.body.appendChild(probe);
      const v = getComputedStyle(probe).color;
      probe.remove();
      return v
        .match(/[\d.]+/g)
        .slice(0, 3)
        .map(Number);
    }),
  );
  const changeColor = changeHues[0];
  const ruler = await page.evaluate(sampleCanvas, { selector: '.decorationsOverviewRuler' });
  log(`overview ruler: ${JSON.stringify(ruler)}`);
  assert(!ruler.error, `overview ruler canvas missing: ${ruler.error}`);
  // Hue, not an exact string: monaco paints an Inline decoration's line highlight at 50% alpha,
  // and the canvas round-trips that with a channel of rounding, so the same token arrives as
  // `217,154,82,255` on the ruler and `217,153,82,128` on the minimap.
  const isChange = (g) => groupMatches(g, changeColor);
  const mark = ruler.groups.find(isChange);
  assert(
    mark,
    `expected a --change-modified (${changeColor}) group on the ruler; got ${JSON.stringify(ruler.groups.map((g) => g.color))}`,
  );
  const cssPerDevice = ruler.cssWidth / ruler.deviceWidth;
  const markCssWidth = mark.widthDevicePx * cssPerDevice;
  log(
    `ruler mark: x ${mark.xFrom}-${mark.xTo} (${mark.widthDevicePx} device px = ${markCssWidth.toFixed(2)} CSS px), runs ${JSON.stringify(mark.runs)}`,
  );
  assert(
    mark.runs.length === 3,
    `expected 3 findable marks at 3 distinct heights; got ${mark.runs.length} (${JSON.stringify(mark.runs)})`,
  );
  assert(
    markCssWidth >= 9,
    `each ruler mark must be >= 9 CSS px wide (1.5x the 6 px it was); got ${markCssWidth.toFixed(2)}`,
  );
  // Monaco paints its cursor band across BOTH lanes and over the top two canvas rows, which is
  // where a mark for line 10 of 2001 lands — so that mark's presence is what matters there and
  // its height is measured on the runs the cursor band does not overlap. Excluding those rows is
  // not a loosened bar: a lane change that shrank the marks would still fail on the other two.
  const cssPerRow = ruler.cssHeight / ruler.deviceHeight;
  assert(
    mark.runs.some(([a]) => a <= 6),
    `the change at line 10 must paint near the top of the ruler; runs ${JSON.stringify(mark.runs)}`,
  );
  const clear = mark.runs.filter(([a]) => a > 2);
  assert(
    clear.length >= 2 && clear.every(([a, b]) => (b - a + 1) * cssPerRow >= 6),
    `every unobstructed ruler mark must keep monaco's 6 px MIN_DECORATION_HEIGHT; got ${JSON.stringify(clear)}`,
  );

  // AC-T3.8, on the surface it actually paints on: with the minimap up monaco fills the ruler
  // opaque in --code-base, so the sampled background IS the mark's backdrop.
  const rulerContrast = contrast(
    mark.color.split(',').slice(0, 3).map(Number),
    ruler.background.split(',').slice(0, 3).map(Number),
  );
  log(`ruler mark ${mark.color} on ${ruler.background}: ${rulerContrast}:1`);
  assert(
    rulerContrast >= 3,
    `a ruler mark must clear WCAG's 3:1 non-text floor on the ruler plate; got ${rulerContrast}`,
  );

  // The minimap is the SECONDARY echo. Blockers Q2 reversed `minimap.size: 'fit'`, so the minimap
  // keeps its own scale and therefore SCROLLS (`minimapHeightIsEditorHeight` is false, and 2001
  // lines at 3 px need 6003 px in a 727 px canvas) — whole-file coverage is the RULER's job.
  // `MinimapPosition.Inline` is what makes the echo legible: monaco's Gutter rail is a hardcoded
  // 2 px sliver, while Inline takes the line-highlight path and fills from the minimap gutter to
  // the canvas edge at 50% alpha, so it reads as a band without hiding the code shape under it.
  // Each mark is checked by scrolling it into view.
  for (const line of SCATTERED_AT) {
    await page.evaluate(
      ({ s, l }) => {
        const ed = window.monaco.editor
          .getEditors()
          .find((e) => e.getModel()?.uri.toString().endsWith(s));
        ed.revealLineInCenter(l);
      },
      { s: 'scattered.ts', l: line },
    );
    await page.waitForTimeout(400);
    const mm = await page.evaluate(sampleCanvas, { selector: '.minimap-decorations-layer' });
    const hit = mm.groups.find(isChange);
    const cssW = hit ? hit.widthDevicePx * (mm.cssWidth / mm.deviceWidth) : 0;
    log(
      `minimap at line ${line}: ${hit ? `${hit.widthDevicePx}x${hit.runs[0][1] - hit.runs[0][0] + 1} device px (${cssW.toFixed(1)} CSS wide), alpha ${hit.color.split(',')[3]}, runs ${JSON.stringify(hit.runs)}` : 'NO MARK'}`,
    );
    assert(hit, `the minimap must echo the change at line ${line} when it is in view`);
    assert(
      hit.widthDevicePx > 2,
      `MinimapPosition.Inline must beat Gutter's 2 px sliver; got ${hit.widthDevicePx} device px`,
    );
    // Translucent, so the code silhouette the minimap exists to show still reads through it.
    assert(
      Number(hit.color.split(',')[3]) < 255,
      `the minimap band must stay translucent over the code shape; got alpha ${hit.color.split(',')[3]}`,
    );
    assert(
      hit.runs.length === 1 && hit.runs[0][1] - hit.runs[0][0] + 1 === layout.minimapLineHeight,
      `the band must cover exactly the changed line (${layout.minimapLineHeight} px); got ${JSON.stringify(hit.runs)}`,
    );
  }
  await page.evaluate((s) => {
    const ed = window.monaco.editor
      .getEditors()
      .find((e) => e.getModel()?.uri.toString().endsWith(s));
    ed.setScrollTop(0);
  }, 'scattered.ts');
  await page.waitForTimeout(300);

  // ── AC-T3.4: the error lane survives the wider change lane ─────────────────────────────────
  // The marker is injected rather than provoked from the TS service: this asserts LANE
  // OCCLUSION, and a real type error would make the fixture depend on the worker's timing.
  await page.evaluate((s) => {
    const ed = window.monaco.editor
      .getEditors()
      .find((e) => e.getModel()?.uri.toString().endsWith(s));
    window.monaco.editor.setModelMarkers(ed.getModel(), 'e2e', [
      {
        severity: window.monaco.MarkerSeverity.Error,
        message: 'lane guard',
        startLineNumber: 500,
        startColumn: 1,
        endLineNumber: 500,
        endColumn: 5,
      },
    ]);
  }, 'scattered.ts');
  await page.waitForTimeout(600);
  const withError = await page.evaluate(sampleCanvas, { selector: '.decorationsOverviewRuler' });
  const errorGroups = withError.groups.filter(
    (g) => g.pixels >= 3 && g.color !== mark.color && g.xFrom > mark.xTo,
  );
  log(`ruler with an error marker: ${JSON.stringify(withError.groups)}`);
  assert(
    errorGroups.length >= 1,
    `an error marker must still paint its own lane to the right of the change lane; got ${JSON.stringify(withError.groups.map((g) => `${g.color}@${g.xFrom}-${g.xTo}`))}`,
  );
  const errorCss = Math.max(...errorGroups.map((g) => g.widthDevicePx)) * cssPerDevice;
  assert(errorCss >= 4, `the error lane must stay >= 4 CSS px wide; got ${errorCss.toFixed(2)}`);
  log(
    `error lane ${errorCss.toFixed(2)} CSS px wide beside a ${markCssWidth.toFixed(2)} px change lane ✓`,
  );

  // ── AC-T3.5: an untracked file paints gutter bars and NO map ───────────────────────────────
  await openInEditor(page, 'brandnew.ts');
  await page.waitForFunction(
    (s) => {
      const ed = window.monaco.editor
        .getEditors()
        .find((e) => e.getModel()?.uri.toString().endsWith(s));
      const model = ed?.getModel();
      if (!model) return false;
      return (
        model
          .getAllDecorations()
          .filter((d) => (d.options.linesDecorationsClassName ?? '').includes('cdec')).length === 1
      );
    },
    'brandnew.ts',
    { timeout: 25000 },
  );
  const fresh = await page.evaluate(decorationCount, 'brandnew.ts');
  log(`brandnew.ts decorations: ${JSON.stringify(fresh)}`);
  assert(
    fresh.total === 1 && fresh.withRuler === 0 && fresh.withMinimap === 0,
    `an untracked file keeps its gutter bars but maps nothing; got ${JSON.stringify(fresh)}`,
  );
  await page
    .locator('.margin-view-overlays .cdec--added')
    .first()
    .waitFor({ state: 'attached', timeout: 10000 });
  const freshRuler = await page.evaluate(sampleCanvas, { selector: '.decorationsOverviewRuler' });
  const freshMinimap = await page.evaluate(sampleCanvas, {
    selector: '.minimap-decorations-layer',
  });
  log(`untracked ruler groups: ${JSON.stringify(freshRuler.groups)}`);
  log(`untracked minimap groups: ${JSON.stringify(freshMinimap.groups)}`);
  // Not "no groups": the ruler always carries its 1 px border column and monaco's own cursor
  // band. What must be absent is any pixel in a CHANGE hue — before the fix this was an unbroken
  // 4344 px green stripe down the whole ruler.
  const isAnyChange = (g) => changeHues.some((hue) => groupMatches(g, hue));
  assert(
    !freshRuler.groups.some(isAnyChange),
    `an untracked file must paint no ruler marks; got ${JSON.stringify(freshRuler.groups.filter(isAnyChange))}`,
  );
  assert(
    !freshMinimap.groups.some(isAnyChange),
    `an untracked file must paint no minimap marks; got ${JSON.stringify(freshMinimap.groups.filter(isAnyChange))}`,
  );

  const shotDir = join(process.env.TEMP || tmpdir(), 'claude-scratch', 'rf');
  mkdirSync(shotDir, { recursive: true });
  await page.screenshot({ path: join(shotDir, 'change-map-geometry.png') }).catch(() => {});

  log('PASS ✓ change-map-geometry: 3 marks, a legible lane, errors intact, untracked maps nothing');
  await closeApp(app, page);
});
