/**
 * Review diff syntax highlighting (real-app smoke). Every rendered diff row's text must be
 * tokenized by language into coloured `.hljs-*` spans — the app's primary code-review surface
 * (spec 2026-07-01-review-diff-syntax). Crosses the renderer/host boundary: the git band's Review
 * button + the per-file diffs stream from the host running git, which the preview mock can't do —
 * so highlighting on real diffs can only be proven against the built app.
 *
 * Flow: open a session on a temp repo with (a) a modified `.ts` file (keywords/strings/comments,
 * both +/- rows), (b) a modified unknown-extension file, and (c) a large `.ts` file (1200 added
 * lines) → open Review on the working tree → assert the `.ts` card's +/- rows carry `.hljs-*`
 * spans with ≥3 distinct token colours and keep their add/remove tint, their change-hue +/- glyph
 * and their edge accent; assert the unknown-ext card has ZERO `.hljs-*` spans; assert the large
 * card stays row-capped with a "Show all" control (windowing/perf intact with highlighting on).
 *
 * GOTCHA (CLAUDE.md): the runner serves ./out — run `npm run build` before this scenario.
 * Close via closeApp (quit-guard), not bare app.close().
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assert, closeApp, openSession, runScenario } from './harness.mjs';
import { contrast, installRowProbe, toHex } from './row-color.mjs';

const TS_V1 = ['const greeting = "hello world";', 'function old() {', '  return 1;', '}', ''].join(
  '\n',
);
const TS_V2 = [
  '// a friendly greeting',
  'const greeting = "hello there";',
  'function shiny(count: number): number {',
  '  return count * 2;',
  '}',
  '',
].join('\n');

function makeRepo(dir) {
  mkdirSync(dir, { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 't@t'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 't'], { cwd: dir });
  writeFileSync(join(dir, 'app.ts'), TS_V1);
  writeFileSync(join(dir, 'mystery.someext'), 'alpha\nbravo\ncharlie\n');
  execFileSync('git', ['add', '.'], { cwd: dir });
  execFileSync('git', ['commit', '-qm', 'init'], { cwd: dir });

  // Working-tree edits: app.ts gets +/- rows; the unknown-ext file changes too (plain rows).
  writeFileSync(join(dir, 'app.ts'), TS_V2);
  writeFileSync(join(dir, 'mystery.someext'), 'alpha\nBRAVO changed\ncharlie\ndelta\n');
  // A large .ts file: 1200 added lines → one card, row-capped with "Show all".
  const big = Array.from({ length: 1200 }, (_, i) => `const v${i}: number = ${i}; // row ${i}`);
  writeFileSync(join(dir, 'big.ts'), `${big.join('\n')}\n`);
}

runScenario('review-diff-syntax', async ({ app, page, log }) => {
  const root = mkdtempSync(join(tmpdir(), 'conduit-review-syntax-'));
  makeRepo(root);

  await openSession(page, { path: root.replace(/\\/g, '/') });

  await page.waitForSelector('.git-indicator__review', { state: 'visible', timeout: 20000 });
  await page.click('.git-indicator__review');
  await page.waitForSelector('.review', { state: 'visible', timeout: 10000 });

  // The app.ts card's diff must land (no spinner) before we inspect its rows.
  await page.waitForFunction(
    () => {
      const c = document.querySelector('.review .rcard[data-path="app.ts"]');
      return !!c && !/Loading diff/i.test(c.textContent ?? '') && !!c.querySelector('.rline');
    },
    null,
    { timeout: 15000 },
  );

  // ── 1. The .ts card shows tokenized spans with multiple distinct colours ──────────────────
  const ts = await page.evaluate(() => {
    const card = document.querySelector('.review .rcard[data-path="app.ts"]');
    const spans = Array.from(card.querySelectorAll('.rline__text span[class*="hljs-"]'));
    const colors = new Set(spans.map((s) => getComputedStyle(s).color));
    const classes = spans.map((s) => s.className);
    const addRow = card.querySelector('.rline--add');
    const delRow = card.querySelector('.rline--del');
    const addSign = addRow?.querySelector('.rline__sign');
    const delSign = delRow?.querySelector('.rline__sign');
    // Resolve the tokens live so this tracks the contract, not a hardcoded hex per theme.
    const token = (name) => {
      const probe = document.createElement('span');
      probe.style.color = `var(${name})`;
      document.body.appendChild(probe);
      const v = getComputedStyle(probe).color;
      probe.remove();
      return v;
    };
    const addHljs = addRow
      ? addRow.querySelectorAll('.rline__text span[class*="hljs-"]').length
      : 0;
    const delHljs = delRow
      ? delRow.querySelectorAll('.rline__text span[class*="hljs-"]').length
      : 0;
    return {
      spanCount: spans.length,
      distinctColors: colors.size,
      hasKeyword: classes.some((c) => c.includes('hljs-keyword')),
      hasString: classes.some((c) => c.includes('hljs-string')),
      addBg: addRow ? getComputedStyle(addRow).backgroundColor : null,
      delBg: delRow ? getComputedStyle(delRow).backgroundColor : null,
      addSignColor: addSign ? getComputedStyle(addSign).color : null,
      delSignColor: delSign ? getComputedStyle(delSign).color : null,
      addSignGlyph: addSign?.textContent ?? null,
      delSignGlyph: delSign?.textContent ?? null,
      markerToken: token('--diff-marker'),
      addToken: token('--diff-add'),
      delToken: token('--diff-remove'),
      addHljs,
      delHljs,
    };
  });
  log(`app.ts syntax: ${JSON.stringify(ts)}`);

  assert(ts.spanCount > 0, 'app.ts diff rows must contain .hljs-* token spans');
  assert(
    ts.distinctColors >= 3,
    `expected ≥3 distinct token colours on the .ts card; got ${ts.distinctColors}`,
  );
  assert(ts.hasKeyword && ts.hasString, 'expected both hljs-keyword and hljs-string tokens');
  assert(ts.addHljs > 0, 'the + row must carry token spans (not blanket-green plain text)');
  assert(ts.delHljs > 0, 'the - row must carry token spans');

  // ── 2. Add/remove tint + the change-carrying marker (spec 2026-08-31-review-fidelity §3) ────
  // REWRITTEN, deliberately. This used to assert the +/- glyph was the NEUTRAL --diff-marker on
  // both rows, on the stylesheet's stated grounds that "the marker carries add/remove rather
  // than the row hue". Measured, that was false: --diff-marker is a lavender grey in every
  // theme, so it carried add/remove by SHAPE only and the row's whole identity rested on a
  // 9-10% wash worth 1.07:1 on Neon. The glyph now carries the hue the claim always assumed.
  // The new contract, asserted below: the sign is the row's own change hue, at >= 4.5:1 against
  // the COMPOSITED row — and the neutral survives where it is still right, on a context row.
  // Per-theme composited pixels are `review-row-pixels`, which launches once per theme.
  const transparent = (c) => !c || c === 'rgba(0, 0, 0, 0)' || c === 'transparent';
  assert(!transparent(ts.addBg), `+ row must keep a visible tint background; got ${ts.addBg}`);
  assert(!transparent(ts.delBg), `- row must keep a visible tint background; got ${ts.delBg}`);
  assert(
    ts.addBg === ts.addToken,
    `+ row tint must be --diff-add (${ts.addToken}); got ${ts.addBg}`,
  );
  assert(
    ts.delBg === ts.delToken,
    `- row tint must be --diff-remove (${ts.delToken}); got ${ts.delBg}`,
  );
  assert(ts.addBg !== ts.delBg, 'add and remove rows must not share a tint');
  assert(
    !transparent(ts.markerToken),
    `--diff-marker must be a real colour token; got ${ts.markerToken}`,
  );
  assert(
    ts.addSignGlyph === '+' && ts.delSignGlyph === '-',
    `the glyph carries add/remove; got ${JSON.stringify([ts.addSignGlyph, ts.delSignGlyph])}`,
  );

  await installRowProbe(page);
  const sign = await page.evaluate(() => {
    const card = document.querySelector('.review .rcard[data-path="app.ts"]');
    const parse = (c) => {
      const m = /rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:[\s,/]+([\d.]+))?/.exec(c || '');
      return m ? { r: +m[1], g: +m[2], b: +m[3], a: m[4] === undefined ? 1 : +m[4] } : null;
    };
    return {
      ...window.__conduitRowProbe(card),
      addSign: parse(getComputedStyle(card.querySelector('.rline--add .rline__sign')).color),
      delSign: parse(getComputedStyle(card.querySelector('.rline--del .rline__sign')).color),
      ctxSign: getComputedStyle(card.querySelector('.rline--context .rline__sign')).color,
      addShadow: getComputedStyle(card.querySelector('.rline--add')).boxShadow,
      delShadow: getComputedStyle(card.querySelector('.rline--del')).boxShadow,
      wordAdd: getComputedStyle(
        card.querySelector('.rline--add .rline__word') ?? card.querySelector('.rline--add'),
      ).backgroundColor,
    };
  });
  log(
    `rows add=${toHex(sign.addRow)} del=${toHex(sign.delRow)} ctx=${toHex(sign.ctxRow)} | ` +
      `row CR add=${contrast(sign.addRow, sign.ctxRow)} del=${contrast(sign.delRow, sign.ctxRow)} | ` +
      `sign CR add=${contrast(sign.addSign, sign.addRow)} del=${contrast(sign.delSign, sign.delRow)}`,
  );

  assert(
    contrast(sign.addSign, sign.addRow) >= 4.5,
    `the + glyph must clear 4.5:1 on the composited add row ${JSON.stringify(sign.addRow)}; got ${contrast(sign.addSign, sign.addRow)}`,
  );
  assert(
    contrast(sign.delSign, sign.delRow) >= 4.5,
    `the − glyph must clear 4.5:1 on the composited del row ${JSON.stringify(sign.delRow)}; got ${contrast(sign.delSign, sign.delRow)}`,
  );
  assert(
    ts.addSignColor === sign.changeAdded && ts.delSignColor === sign.changeDeleted,
    `the glyphs must be --change-added/--change-deleted (one vocabulary with the editor gutter); got ${ts.addSignColor}/${ts.delSignColor}`,
  );
  assert(
    ts.addSignColor !== ts.markerToken && ts.delSignColor !== ts.markerToken,
    `the glyph must no longer be the neutral --diff-marker (${ts.markerToken})`,
  );
  assert(
    sign.ctxSign === ts.markerToken,
    `a context row's sign stays --diff-marker (${ts.markerToken}); got ${sign.ctxSign}`,
  );
  // Blockers Q1: an edge accent in the row's change hue. The 15% ceiling governs the FILL, so
  // this costs nothing against it, and it is the same 3px bar as the editor's .cdec gutter.
  assert(
    /inset/.test(sign.addShadow) && sign.addShadow.includes(sign.changeAdded),
    `the + row needs an inset edge accent in ${sign.changeAdded}; got ${sign.addShadow}`,
  );
  assert(
    /inset/.test(sign.delShadow) && sign.delShadow.includes(sign.changeDeleted),
    `the − row needs an inset edge accent in ${sign.changeDeleted}; got ${sign.delShadow}`,
  );
  assert(
    !transparent(sign.wordAdd) && !/^rgba?\(108, 193, 138/.test(sign.wordAdd),
    `word emphasis must come from a theme token, not the old hardcoded constant; got ${sign.wordAdd}`,
  );
  log('the +/- glyph carries the row hue at >= 4.5:1; the neutral survives on context rows ✓');

  // ── 3. Unknown extension → plain fallback (no .hljs-* spans, no error) ─────────────────────
  await page.waitForFunction(
    () => {
      const c = document.querySelector('.review .rcard[data-path="mystery.someext"]');
      return !!c && !/Loading diff/i.test(c.textContent ?? '') && !!c.querySelector('.rline');
    },
    null,
    { timeout: 12000 },
  );
  const unknownHljs = await page.evaluate(
    () =>
      document.querySelectorAll(
        '.review .rcard[data-path="mystery.someext"] .rline__text span[class*="hljs-"]',
      ).length,
  );
  log(`mystery.someext hljs spans: ${unknownHljs}`);
  assert(
    unknownHljs === 0,
    `unknown-ext rows must render plain (0 hljs spans); got ${unknownHljs}`,
  );

  // ── 4. Large .ts file stays row-capped with a "Show all" control (windowing/perf intact) ───
  await page.waitForFunction(
    () => {
      const c = document.querySelector('.review .rcard[data-path="big.ts"]');
      return !!c && !!c.querySelector('.rline');
    },
    null,
    { timeout: 15000 },
  );
  const big = await page.evaluate(() => {
    const card = document.querySelector('.review .rcard[data-path="big.ts"]');
    const rows = card.querySelectorAll('.rline').length;
    const showAll = card.querySelector('.rcard__showrest')?.textContent ?? '';
    return { rows, showAll, mounted: window.__conduitReviewPerf?.mountedCardCount ?? 0 };
  });
  log(`big.ts: ${JSON.stringify(big)}`);
  assert(big.rows > 0 && big.rows < 200, `big.ts must stay row-capped; rendered ${big.rows} rows`);
  assert(
    /show all/i.test(big.showAll),
    `big.ts must offer a "Show all" control; got ${big.showAll}`,
  );
  assert(big.mounted > 0, 'the windowing perf counter should report mounted cards');

  // Screenshots to OS temp (workspace hygiene) for the conductor's taste pass.
  const shotDir = join(process.env.TEMP || tmpdir(), 'claude-scratch');
  mkdirSync(shotDir, { recursive: true });
  const tsCard = page.locator('.review .rcard[data-path="app.ts"]');
  await tsCard.screenshot({ path: join(shotDir, 'review-diff-syntax-ts.png') }).catch(() => {});
  const unkCard = page.locator('.review .rcard[data-path="mystery.someext"]');
  await unkCard
    .screenshot({ path: join(shotDir, 'review-diff-syntax-unknown.png') })
    .catch(() => {});
  log(`screenshots saved under ${shotDir}`);

  log('PASS ✓ review-diff-syntax: .ts rows tokenized (≥3 colours, tint+sign kept), unknown plain');
  await closeApp(app, page);
});
