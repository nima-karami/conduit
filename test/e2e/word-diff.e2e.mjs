/**
 * Word-level diff emphasis (real-app smoke). A one-token edit on a line should highlight ONLY the
 * changed token (`.rline__word`) on both the del and add rows, while the rest of the line keeps its
 * syntax colours + the add/del tint. Crosses the host boundary (diff streams from git), so it can
 * only be proven against the built app.
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assert, closeApp, openSession, runScenario } from './harness.mjs';

runScenario('word-diff', async ({ app, page, log }) => {
  const root = mkdtempSync(join(tmpdir(), 'conduit-word-diff-'));
  mkdirSync(root, { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['config', 'user.email', 't@t'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 't'], { cwd: root });
  writeFileSync(join(root, 'app.ts'), 'const timeout = 3000;\nconst name = "alice";\n');
  execFileSync('git', ['add', '.'], { cwd: root });
  execFileSync('git', ['commit', '-qm', 'init'], { cwd: root });
  // One token changes per line: 3000 -> 5000, "alice" -> "bob".
  writeFileSync(join(root, 'app.ts'), 'const timeout = 5000;\nconst name = "bob";\n');

  await openSession(page, { path: root.replace(/\\/g, '/') });
  await page.waitForSelector('.git-indicator__review', { state: 'visible', timeout: 20000 });
  await page.click('.git-indicator__review');
  await page.waitForSelector('.review', { state: 'visible', timeout: 10000 });
  await page.waitForFunction(
    () => {
      const c = document.querySelector('.review .rcard[data-path="app.ts"]');
      return !!c && !/Loading diff/i.test(c.textContent ?? '') && !!c.querySelector('.rline');
    },
    null,
    { timeout: 15000 },
  );

  const probe = await page.evaluate(() => {
    const card = document.querySelector('.review .rcard[data-path="app.ts"]');
    const words = Array.from(card.querySelectorAll('.rline__word')).map((w) => w.textContent);
    const delRow = card.querySelector('.rline--del');
    const addRow = card.querySelector('.rline--add');
    return {
      words,
      delHasWord: !!delRow?.querySelector('.rline__word'),
      addHasWord: !!addRow?.querySelector('.rline__word'),
      delText: delRow?.querySelector('.rline__text')?.textContent ?? '',
      addText: addRow?.querySelector('.rline__text')?.textContent ?? '',
    };
  });
  log(`word-diff emphasis words: ${JSON.stringify(probe.words)}`);

  assert(probe.delHasWord, 'the removed row should emphasize the changed token');
  assert(probe.addHasWord, 'the added row should emphasize the changed token');
  // The emphasis must be the CHANGED token only — not the whole (shared) line prefix.
  assert(
    probe.words.some((w) => /3000/.test(w)) && probe.words.some((w) => /5000/.test(w)),
    `expected 3000/5000 emphasized, got ${JSON.stringify(probe.words)}`,
  );
  assert(
    !probe.words.some((w) => /timeout|const/.test(w)),
    `shared tokens must NOT be emphasized, got ${JSON.stringify(probe.words)}`,
  );
  log('word-diff emphasizes only the changed token on both rows ✓');

  const shotDir = join(process.env.TEMP || tmpdir(), 'claude-scratch');
  mkdirSync(shotDir, { recursive: true });
  await page
    .locator('.review .rcard[data-path="app.ts"]')
    .screenshot({ path: join(shotDir, 'word-diff.png') })
    .catch(() => {});

  await closeApp(app, page);
});
