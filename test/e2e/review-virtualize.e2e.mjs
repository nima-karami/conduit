/**
 * Review Changes virtualization load test (real-app smoke). With a large changeset, opening
 * the Review tab must mount only the cards near the viewport — not every file — and the
 * scrollbar must still span the whole changeset (spec 2026-06-27-review-virtualization.md).
 *
 * Crosses the renderer/host boundary: the git band's Review button only renders once the host
 * has produced GitInfo, and the change list + per-card diffs stream from the host — so the
 * windowing can only be proven against the real built app, not the preview mock.
 *
 * GOTCHA (CLAUDE.md): the runner serves ./out — run `npm run build` before this scenario.
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assert, openSession, runScenario } from './harness.mjs';

const FILE_COUNT = 350;

function makeRepo(dir) {
  mkdirSync(dir, { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 't@t'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 't'], { cwd: dir });
  writeFileSync(join(dir, 'seed.txt'), 'seed\n');
  execFileSync('git', ['add', '.'], { cwd: dir });
  execFileSync('git', ['commit', '-qm', 'init'], { cwd: dir });
  // A large changeset: many small untracked files (each shows as an added-file card).
  for (let i = 0; i < FILE_COUNT; i++) {
    const name = `f${String(i).padStart(4, '0')}.txt`;
    writeFileSync(join(dir, name), `line a in ${name}\nline b\nline c\n`);
  }
}

runScenario('review-virtualize', async ({ page, log }) => {
  const root = mkdtempSync(join(tmpdir(), 'conduit-review-virt-'));
  makeRepo(root);

  await openSession(page, { path: root.replace(/\\/g, '/') });

  await page.waitForSelector('.git-indicator__review', { state: 'visible', timeout: 20000 });
  await page.click('.git-indicator__review');
  await page.waitForSelector('.review', { state: 'visible', timeout: 10000 });

  // Wait for the host's change list to land (the header reports the count).
  const total = await page
    .waitForFunction(
      (min) => {
        const sub = document.querySelector('.review__sub')?.textContent ?? '';
        const m = sub.match(/(\d+)\s+files?\s+changed/);
        const n = m ? Number(m[1]) : 0;
        return n >= min ? n : false;
      },
      FILE_COUNT,
      { timeout: 30000 },
    )
    .then((h) => h.jsonValue());
  log(`change list loaded: ${total} files changed`);

  // Let the window settle (measurement passes) and read the perf counters + DOM.
  await page.waitForFunction(() => (window.__conduitReviewPerf?.mountedCardCount ?? 0) > 0, null, {
    timeout: 10000,
  });
  const perf = await page.evaluate(() => window.__conduitReviewPerf);
  const domCards = await page.evaluate(() => document.querySelectorAll('.rcard').length);
  const scrollHeight = await page.evaluate(
    () => document.querySelector('.review__scroll')?.scrollHeight ?? 0,
  );

  log(
    `mounted .rcard=${domCards} perf.mounted=${perf.mountedCardCount} ` +
      `requested=${perf.requestedDiffCount} total=${total} ` +
      `totalHeight=${perf.lastWindow.totalHeight} scrollHeight=${scrollHeight}`,
  );

  // The load-bearing assertion: mounted cards are FAR fewer than the full changeset.
  assert(domCards > 0, 'at least one card mounts');
  assert(
    domCards < total / 3,
    `mounted cards (${domCards}) must be far fewer than total (${total}) — windowing is off if not`,
  );
  assert(
    perf.mountedCardCount === domCards,
    `perf mounted count (${perf.mountedCardCount}) should match DOM (.rcard=${domCards})`,
  );

  // Only windowed cards request their diff (not all N up front).
  assert(
    perf.requestedDiffCount < total / 2,
    `requested diffs (${perf.requestedDiffCount}) must be far fewer than total (${total})`,
  );

  // The scrollbar reflects the whole changeset, not just the mounted cards.
  assert(
    perf.lastWindow.totalHeight > total * 100,
    `totalHeight (${perf.lastWindow.totalHeight}) should span all ${total} files`,
  );
  assert(
    scrollHeight > total * 100,
    `scroll height (${scrollHeight}) should reflect all ${total} files`,
  );

  log('PASS ✓ review-virtualize: large changeset mounts ≪ N cards with full-length scroll');
});
