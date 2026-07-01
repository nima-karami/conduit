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
 * spans with ≥3 distinct token colours and keep their add/remove tint + coloured sign; assert the
 * unknown-ext card has ZERO `.hljs-*` spans; assert the large card stays row-capped with a
 * "Show all" control (windowing/perf intact with highlighting on).
 *
 * GOTCHA (CLAUDE.md): the runner serves ./out — run `npm run build` before this scenario.
 * Close via closeApp (quit-guard), not bare app.close().
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assert, closeApp, openSession, runScenario } from './harness.mjs';

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

  // ── 2. Add/remove tint + coloured sign survive under token colours (spec D3) ───────────────
  const transparent = (c) => !c || c === 'rgba(0, 0, 0, 0)' || c === 'transparent';
  assert(!transparent(ts.addBg), `+ row must keep a visible tint background; got ${ts.addBg}`);
  assert(!transparent(ts.delBg), `- row must keep a visible tint background; got ${ts.delBg}`);
  // --green #6cc18a → rgb(108, 193, 138); --red #e0726f → rgb(224, 114, 111).
  assert(
    (ts.addSignColor ?? '').includes('108, 193, 138'),
    `+ sign should stay green; got ${ts.addSignColor}`,
  );
  assert(
    (ts.delSignColor ?? '').includes('224, 114, 111'),
    `- sign should stay red; got ${ts.delSignColor}`,
  );

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
