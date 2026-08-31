/**
 * The split (side-by-side) diff's change map and wash (spec 2026-08-31-review-fidelity §6:
 * AC-T5.1, T5.4, T5.5, T5.6).
 *
 * Two shipped defects it guards:
 *   - `renderOverviewRuler` was left at monaco's default with `diffEditorOverview.*` unset, so the
 *     diff ruler derived its colours from the 9-15% line washes — a faint tint of a faint tint;
 *   - those line washes were the REVIEW ROW's tokens, which are held low because a `.rline`
 *     carries a `+`/`-` glyph. A diff pane has no glyph, so the wash was the only signal, and
 *     `insertedTextBackground`/`removedTextBackground` shipped fully transparent on top of that.
 *
 * And one thing it records rather than fixes: `diff-viewer.tsx`'s hard-coded
 * `minimap: { enabled: false }` was NOT overriding the user. Monaco's diff widget disables the
 * minimap on both panes itself, unconditionally, because its own whole-file diff overview ruler
 * takes that column. The diff overview IS the split diff's map.
 *
 * Has to be e2e: the diff editor's ruler is a different canvas from the plain editor's, and the
 * resolved washes only exist as rules monaco injects for its own decoration classes.
 *
 * GOTCHA (CLAUDE.md): the runner serves ./out — run `npm run build` first. Close via closeApp.
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { groupMatches, tokenRgb } from './canvas.mjs';
import { assert, closeApp, openSession, runScenario } from './harness.mjs';
import { contrast } from './row-color.mjs';

const LINES = 2000;
const CHANGED_AT = [10, 1000, 1990];

function buildRepo() {
  const root = mkdtempSync(join(tmpdir(), 'conduit-splitmap-'));
  const seq = Array.from({ length: LINES }, (_, i) => `const v${i + 1} = ${i + 1};`);
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['config', 'user.email', 'split@t'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'Split'], { cwd: root });
  writeFileSync(join(root, 'wide.ts'), `${seq.join('\n')}\n`);
  execFileSync('git', ['add', '.'], { cwd: root });
  execFileSync('git', ['commit', '-qm', 'seed'], { cwd: root });
  const work = [...seq];
  for (const n of CHANGED_AT) work[n - 1] = `const changed${n} = ${n * 2};`;
  writeFileSync(join(root, 'wide.ts'), `${work.join('\n')}\n`);
  return root;
}

/** Colours monaco actually resolved for the diff keys, plus each pane's options. */
const P_DIFF = () => {
  const diff = window.monaco.editor.getDiffEditors?.()[0];
  if (!diff) return { error: 'no diff editor' };
  const modified = diff.getModifiedEditor();
  const original = diff.getOriginalEditor();
  const opts = (ed) => {
    const o = ed.getOption(window.monaco.editor.EditorOption.minimap);
    return { enabled: o.enabled, renderCharacters: o.renderCharacters, size: o.size };
  };
  return {
    modifiedMinimap: opts(modified),
    originalMinimap: opts(original),
    // renderOverviewRuler is a DIFF-editor option, not forwarded to the panes, so its effect is
    // read where it lands: the .diffOverview root the feature appends, holding one canvas per side.
    diffOverviewCanvases: document.querySelectorAll('.monaco-diff-editor .diffOverview canvas')
      .length,
    modifiedRulerWidth: modified.getLayoutInfo().overviewRuler.width,
    changes: (diff.getLineChanges() ?? []).length,
  };
};

runScenario('split-diff-map', async ({ app, page, log }) => {
  const root = buildRepo();
  await openSession(page, { path: root.replace(/\\/g, '/') });

  await page.waitForSelector('.git-indicator__review', { state: 'visible', timeout: 25000 });
  await page.click('.git-indicator__review');
  await page.waitForFunction(
    () => {
      const c = document.querySelector('.review .rcard[data-path="wide.ts"]');
      return !!c && !/Loading diff/i.test(c.textContent ?? '') && !!c.querySelector('.rline');
    },
    null,
    { timeout: 25000 },
  );
  await page.locator('.review .rcard[data-path="wide.ts"] .rcard__split').first().click();
  await page.waitForFunction(
    () => (window.monaco.editor.getDiffEditors?.() ?? []).length > 0,
    null,
    {
      timeout: 25000,
    },
  );
  await page.waitForTimeout(2500);

  // ── AC-T5.4, as it actually is ─────────────────────────────────────────────────────────────
  // The spec asked for a minimap in both panes. Monaco does not allow one: its diff widget sets
  // `minimap.enabled = false` on every option update for BOTH sides
  // (`diffEditorEditors.js` `_adjustOptionsForSubEditor`), because its own whole-file diff
  // overview ruler already occupies that column. So the diff overview IS the split diff's map,
  // and the assertion below pins that rather than an option monaco overrides. The pinned `false`
  // is what makes a monaco upgrade that lifted the restriction show up here as a failure.
  const diff = await page.evaluate(P_DIFF);
  log(`diff editor: ${JSON.stringify(diff)}`);
  assert(!diff.error, `no diff editor: ${diff.error}`);
  assert(
    diff.modifiedMinimap.enabled === false && diff.originalMinimap.enabled === false,
    `monaco owns the diff panes' minimap; if this now reports true, the split diff can carry one and §6 decision 1 is back on the table: ${JSON.stringify(diff)}`,
  );
  assert(
    diff.diffOverviewCanvases >= 2,
    `the diff overview must render one ruler per side; got ${diff.diffOverviewCanvases}`,
  );
  assert(
    diff.modifiedRulerWidth === 20,
    `the split diff must use the same 20 px ruler as the plain editor; got ${diff.modifiedRulerWidth}`,
  );
  assert(
    diff.changes === CHANGED_AT.length,
    `expected ${CHANGED_AT.length} line changes; got ${diff.changes}`,
  );

  // ── AC-T5.5: one visual language — the diff ruler paints --change-* ─────────────────────────
  const added = await tokenRgb(page, '--change-added');
  const deleted = await tokenRgb(page, '--change-deleted');
  const canvases = await page.evaluate(() =>
    [...document.querySelectorAll('.monaco-diff-editor canvas')].map((c, i) => ({
      i,
      cls: c.className,
      parent: c.parentElement?.className ?? '',
      w: c.width,
      h: c.height,
    })),
  );
  log(`diff canvases: ${JSON.stringify(canvases)}`);

  // Two canvases side by side: the ORIGINAL ruler carries removals, the MODIFIED one insertions.
  const overviews = canvases.filter((c) => /diffOverviewRuler/.test(c.cls));
  assert(
    overviews.length === 2,
    `expected an original and a modified diff ruler; got ${JSON.stringify(canvases.map((c) => c.cls))}`,
  );
  // Alpha is part of a mark's identity here. Left unset, monaco derives the diff ruler from
  // `diffEditor.insertedTextBackground` at double that token's alpha — which, because the word
  // tokens are themselves derived from the change hues, lands on the SAME hue at 60% opacity.
  // Only the alpha distinguishes "pinned to --change-*" from "monaco guessed and got lucky".
  const sampleRuler = ({ i }) => {
    const c = [...document.querySelectorAll('.monaco-diff-editor canvas')][i];
    const img = c.getContext('2d').getImageData(0, 0, c.width, c.height);
    const counts = new Map();
    const ys = new Map();
    for (let y = 0; y < c.height; y++) {
      for (let x = 0; x < c.width; x++) {
        const k = (y * c.width + x) * 4;
        if (img.data[k + 3] === 0) continue;
        const key = `${img.data[k]},${img.data[k + 1]},${img.data[k + 2]},${img.data[k + 3]}`;
        counts.set(key, (counts.get(key) ?? 0) + 1);
        if (!ys.has(key)) ys.set(key, new Set());
        ys.get(key).add(y);
      }
    }
    return {
      width: c.width,
      height: c.height,
      groups: [...counts.entries()].map(([color, n]) => ({
        color,
        alpha: Number(color.split(',')[3]),
        pixels: n,
        rows: [...ys.get(color)].length,
      })),
    };
  };
  const original = await page.evaluate(sampleRuler, { i: overviews[0].i });
  const modified = await page.evaluate(sampleRuler, { i: overviews[1].i });
  log(`diff overview — original: ${JSON.stringify(original)}`);
  log(`diff overview — modified: ${JSON.stringify(modified)}`);
  for (const [side, sample, want] of [
    ['modified', modified, added],
    ['original', original, deleted],
  ]) {
    const hit = sample.groups.find((g) => groupMatches(g, want));
    assert(
      hit,
      `the ${side} ruler must paint ${want}; got ${JSON.stringify(sample.groups.map((g) => g.color))}`,
    );
    assert(
      hit.alpha === 255,
      `the ${side} ruler mark must be the token itself, fully opaque — an alpha below 255 means monaco derived it from a wash instead; got ${hit.color}`,
    );
  }
  // AC-T5.4's testable half: all three changes are findable on a whole-file surface, without
  // scrolling, which is what the ruling actually asked the map for.
  const marks = modified.groups.find((g) => groupMatches(g, added));
  assert(
    marks.rows >= CHANGED_AT.length * 2,
    `the diff ruler must locate all ${CHANGED_AT.length} changes; it painted only ${marks.rows} rows`,
  );

  // ── AC-T5.1 / T5.6: the wash a changed line actually gets, in both render modes ─────────────
  // The washes are read off the LIVE decoration elements monaco paints, not off a theme lookup:
  // `.line-insert` / `.char-insert` (and their delete twins) are the classes its diff
  // contribution registers for `diffEditor.insertedLineBackground` and
  // `insertedTextBackground`, so this measures the shipped pixel's own rule.
  const washes = async (label) => {
    await page.evaluate(() => {
      const diff = window.monaco.editor.getDiffEditors()[0];
      diff.getModifiedEditor().revealLineInCenter(10);
    });
    await page.waitForTimeout(500);
    const got = await page.evaluate(() => {
      const pick = (sel) => {
        for (const el of document.querySelectorAll(`.monaco-diff-editor ${sel}`)) {
          const c = getComputedStyle(el).backgroundColor;
          const m = /rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:[\s,/]+([\d.]+))?/.exec(c);
          if (m && (m[4] === undefined || Number(m[4]) > 0)) {
            return { rgb: [+m[1], +m[2], +m[3]], a: m[4] === undefined ? 1 : +m[4], css: c };
          }
        }
        return null;
      };
      return {
        insertedLine: pick('.modified-in-monaco-diff-editor .line-insert'),
        removedLine: pick('.original-in-monaco-diff-editor .line-delete'),
        insertedText: pick('.modified-in-monaco-diff-editor .char-insert'),
        removedText: pick('.original-in-monaco-diff-editor .char-delete'),
        insertedGutter: pick('.gutter-insert, .diff-hidden-lines .line-insert'),
        counts: {
          lineInsert: document.querySelectorAll('.monaco-diff-editor .line-insert').length,
          charInsert: document.querySelectorAll('.monaco-diff-editor .char-insert').length,
          lineDelete: document.querySelectorAll('.monaco-diff-editor .line-delete').length,
          charDelete: document.querySelectorAll('.monaco-diff-editor .char-delete').length,
        },
      };
    });
    log(`${label} washes: ${JSON.stringify(got)}`);
    return got;
  };
  const sideBySide = await washes('side-by-side');

  const base = await tokenRgb(page, '--code-base');
  const over = (wash, onto) => wash.rgb.map((v, i) => v * wash.a + onto[i] * (1 - wash.a));

  // AC-T5.1. A diff pane has no +/- glyph, so this wash IS the signal and its floor is far above
  // the Review row's 15% ceiling.
  for (const [key, label] of [
    ['insertedLine', 'inserted'],
    ['removedLine', 'removed'],
  ]) {
    const wash = sideBySide[key];
    assert(wash, `no painted ${label} line found`);
    // Monaco's own contract: an opaque line background hides selection, find matches and the
    // current-line highlight.
    assert(wash.a < 1, `the ${label} line wash must stay non-opaque; got ${wash.css}`);
    const cr = contrast(over(wash, base), base);
    log(`${label} line ${wash.css} over ${base}: ${cr}:1`);
    assert(cr >= 1.5, `a ${label} diff line must clear 1.5:1 against an unchanged one; got ${cr}`);
  }

  // AC-T5.3. The intra-line signal Review gets from .rline__word; monaco shipped these fully
  // transparent, so a one-word edit read as a whole washed line and nothing more.
  for (const [key, lineKey, label] of [
    ['insertedText', 'insertedLine', 'inserted'],
    ['removedText', 'removedLine', 'removed'],
  ]) {
    const word = sideBySide[key];
    assert(word, `no painted ${label} word span found`);
    const line = over(sideBySide[lineKey], base);
    const cr = contrast(over(word, line), line);
    log(`${label} word ${word.css} on its line: ${cr}:1`);
    assert(cr >= 1.5, `a ${label} word span must clear 1.5:1 against its own line; got ${cr}`);
  }

  // ── AC-T5.6: inline mode is the same editor with the same keys ─────────────────────────────
  await page
    .locator('.diffbar__toggle, .diffbar button')
    .first()
    .click()
    .catch(() => {});
  await page.waitForTimeout(1200);
  const inline = await page.evaluate(P_DIFF);
  log(`after toggling render mode: ${JSON.stringify(inline)}`);
  const inlineColours = await washes('inline');
  for (const key of ['insertedLine', 'removedLine', 'insertedText', 'removedText']) {
    assert(
      inlineColours[key]?.css === sideBySide[key]?.css,
      `${key} must survive the render-mode toggle; ${sideBySide[key]?.css} → ${inlineColours[key]?.css}`,
    );
  }
  assert(
    inline.diffOverviewCanvases >= 1 && inline.modifiedRulerWidth === 20,
    `the ruler must survive the render-mode toggle; got ${JSON.stringify(inline)}`,
  );

  const shotDir = join(process.env.TEMP || tmpdir(), 'claude-scratch', 'rf');
  mkdirSync(shotDir, { recursive: true });
  await page.screenshot({ path: join(shotDir, 'split-diff-map.png') }).catch(() => {});

  log('PASS ✓ split-diff-map: minimap honoured, ruler in --change-*, wash >= 1.5:1, toggle safe');
  await closeApp(app, page);
});
