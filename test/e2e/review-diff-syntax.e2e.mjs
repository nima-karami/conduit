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
 * spans with ≥3 distinct token colours and keep their add/remove tint + legible marker; assert the
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

  // ── 2. Add/remove tint + legible marker survive under token colours (spec D3) ──────────────
  // The revamp's token contract moved the +/- markers OFF the add/remove hues: --syn-string is
  // green and so is --diff-add, so the row wash is held at 9-15% and "the marker carries the
  // meaning rather than the hue … which only works if the marker is legible, so --diff-marker
  // is a real token at 4.5:1". So the row tint must still be the add/remove hue (and the two
  // must differ), while the marker is the neutral --diff-marker on BOTH rows and the glyph is
  // what distinguishes them.
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
    ts.addSignColor === ts.markerToken,
    `+ marker must use --diff-marker (${ts.markerToken}); got ${ts.addSignColor}`,
  );
  assert(
    ts.delSignColor === ts.markerToken,
    `- marker must use --diff-marker (${ts.markerToken}); got ${ts.delSignColor}`,
  );
  assert(
    ts.addSignGlyph === '+' && ts.delSignGlyph === '-',
    `the glyph carries add/remove; got ${JSON.stringify([ts.addSignGlyph, ts.delSignGlyph])}`,
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
