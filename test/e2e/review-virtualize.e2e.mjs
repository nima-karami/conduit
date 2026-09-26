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
import { assert, openReview, openSession, runScenario } from './harness.mjs';

const FILE_COUNT = 350;
/** Per repo, for the grouped case (spec 2026-09-23-mf-review §7.3). */
const GROUPED_FILE_COUNT = 600;

function makeRepo(dir, fileCount = FILE_COUNT) {
  mkdirSync(dir, { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 't@t'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 't'], { cwd: dir });
  writeFileSync(join(dir, 'seed.txt'), 'seed\n');
  execFileSync('git', ['add', '.'], { cwd: dir });
  execFileSync('git', ['commit', '-qm', 'init'], { cwd: dir });
  // A large changeset: many small untracked files (each shows as an added-file card).
  for (let i = 0; i < fileCount; i++) {
    const name = `f${String(i).padStart(4, '0')}.txt`;
    writeFileSync(join(dir, name), `line a in ${name}\nline b\nline c\n`);
  }
}

/** src/folder-key.ts `folderKey`: the form `data-root` carries. */
const folderKey = (p) => {
  const r = p.replace(/\\/g, '/').replace(/\/+$/, '');
  return /^[a-zA-Z]:\//.test(r) || r.startsWith('//') ? r.toLowerCase() : r;
};

const waitForTotal = (page, min) =>
  page
    .waitForFunction(
      (want) => {
        const sub = document.querySelector('.review__sub')?.textContent ?? '';
        const m = sub.match(/(\d+)\s+files?\b/);
        const n = m ? Number(m[1]) : 0;
        return n >= want ? n : false;
      },
      min,
      { timeout: 30000 },
    )
    .then((h) => h.jsonValue());

/**
 * Scroll the (windowed) navigator until the boundary between two groups is mounted, and return
 * the last row of `rootA` and the first of `rootB`.
 */
async function navBoundary(page, rootA, rootB) {
  await page.evaluate(() => {
    const nav = document.querySelector('.rightpane .review__nav');
    if (nav) nav.scrollTop = nav.scrollHeight / 2 - nav.clientHeight / 2;
  });
  for (let i = 0; i < 40; i++) {
    await page.waitForTimeout(300);
    const r = await page.evaluate(
      ([a, b]) => {
        const rows = [...document.querySelectorAll('.rightpane .review__navrow')];
        const iB = rows.findIndex((row) => row.dataset.root === b);
        if (iB < 0) return { state: 'down' };
        if (iB === 0) return { state: 'up' };
        if (rows[iB - 1].dataset.root !== a) return { state: 'odd' };
        return { state: 'found', lastA: rows[iB - 1].dataset.path, firstB: rows[iB].dataset.path };
      },
      [rootA, rootB],
    );
    if (r.state === 'found') return r;
    if (r.state === 'odd') throw new Error('the navigator rows are not grouped by repo');
    await page.evaluate(
      (dir) => {
        const nav = document.querySelector('.rightpane .review__nav');
        if (nav) nav.scrollTop += (dir * nav.clientHeight) / 2;
      },
      r.state === 'down' ? 1 : -1,
    );
  }
  throw new Error('the navigator never mounted the boundary between the two groups');
}

/**
 * The perf counters and the DOM, read in ONE evaluate once they agree. The counter is written in
 * a passive effect, and measurement keeps re-windowing for a while after the first mount, so two
 * separate reads can straddle a commit (seen: perf 13, .rcard 12). A counter that never agrees —
 * say, one that counts group headers — times out here and fails the equality assertion below.
 */
const settledPerf = async (page) => {
  await page
    .waitForFunction(
      () =>
        window.__conduitReviewPerf?.mountedCardCount === document.querySelectorAll('.rcard').length,
      null,
      { timeout: 5000 },
    )
    .catch(() => {});
  return page.evaluate(() => ({
    perf: window.__conduitReviewPerf,
    cards: document.querySelectorAll('.rcard').length,
  }));
};

runScenario('review-virtualize', async ({ page, log }) => {
  const root = mkdtempSync(join(tmpdir(), 'conduit-review-virt-'));
  makeRepo(root);

  await openSession(page, { path: root.replace(/\\/g, '/') });

  await openReview(page);
  await page.waitForSelector('.review', { state: 'visible', timeout: 10000 });

  // Wait for the host's change list to land (the header reports the count).
  const total = await waitForTotal(page, FILE_COUNT);
  log(`change list loaded: ${total} files changed`);

  // Let the window settle (measurement passes) and read the perf counters + DOM.
  await page.waitForFunction(() => (window.__conduitReviewPerf?.mountedCardCount ?? 0) > 0, null, {
    timeout: 10000,
  });
  const { perf, cards: domCards } = await settledPerf(page);
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

  // The navigator windows the same way: mounted rows stay far below the full changeset. Its
  // window is sized by a ResizeObserver, which a hidden window runs on its throttled (~1 s)
  // frames — under load the first read came back 0 before it had measured.
  await page
    .waitForFunction(
      () => document.querySelectorAll('.rightpane .review__navrow').length > 0,
      null,
      {
        timeout: 10000,
      },
    )
    .catch(() => {});
  const navRows = await page.evaluate(
    () => document.querySelectorAll('.rightpane .review__navrow').length,
  );
  log(`mounted .review__navrow=${navRows}`);
  assert(
    navRows > 0 && navRows < total / 3,
    `navigator rows (${navRows}) must be windowed — mounted, but far fewer than ${total}`,
  );

  const single = await page.evaluate(() => ({
    chip: document.querySelectorAll('.review__chip').length,
    groups: document.querySelectorAll('.review__group').length,
  }));
  assert(
    single.chip === 0 && single.groups === 0,
    `a single-repo Review has no repo chip or group headers; got ${JSON.stringify(single)}`,
  );

  // ── Grouped: a plain home folder holding two repos (spec 2026-09-23-mf-review §7.3) ─────────
  const home = mkdtempSync(join(tmpdir(), 'conduit-review-virt-grouped-'));
  const repoA = join(home, 'repo-a');
  const repoB = join(home, 'repo-b');
  makeRepo(repoA, GROUPED_FILE_COUNT);
  makeRepo(repoB, GROUPED_FILE_COUNT);
  const keyA = folderKey(repoA);
  const keyB = folderKey(repoB);

  await openSession(page, { path: home.replace(/\\/g, '/') });
  await openReview(page);
  await page.waitForFunction(
    (a) => document.querySelector('.review__group')?.getAttribute('data-root') === a,
    keyA,
    { timeout: 30000 },
  );
  const groupedTotal = await waitForTotal(page, GROUPED_FILE_COUNT * 2);
  log(`grouped change list loaded: ${groupedTotal} files in 2 repos`);
  await page.waitForFunction(() => (window.__conduitReviewPerf?.mountedCardCount ?? 0) > 0, null, {
    timeout: 10000,
  });
  const { perf: gPerf, cards: gCards } = await settledPerf(page);
  log(`grouped: mounted .rcard=${gCards} perf.mounted=${gPerf.mountedCardCount}`);
  assert(gCards > 0, 'at least one grouped card mounts');
  assert(
    gCards < groupedTotal / 3,
    `grouped mounted cards (${gCards}) must be far fewer than total (${groupedTotal})`,
  );
  assert(
    gPerf.mountedCardCount === gCards,
    `perf mounted count (${gPerf.mountedCardCount}) must count cards only (.rcard=${gCards})`,
  );
  await page
    .waitForFunction(
      () => document.querySelectorAll('.rightpane .review__navrow').length > 0,
      null,
      {
        timeout: 10000,
      },
    )
    .catch(() => {});
  const gNavRows = await page.evaluate(
    () => document.querySelectorAll('.rightpane .review__navrow').length,
  );
  log(`grouped: mounted .review__navrow=${gNavRows}`);
  assert(
    gNavRows > 0 && gNavRows < groupedTotal / 3,
    `grouped navigator rows (${gNavRows}) must be windowed below ${groupedTotal}`,
  );

  // `J` from the last file of repo-a lands on the first file of repo-b.
  const { lastA, firstB } = await navBoundary(page, keyA, keyB);
  log(`group boundary: ${lastA} (repo-a) → ${firstB} (repo-b)`);
  await page
    .locator(
      `.rightpane .review__navrow[data-root="${keyA}"][data-path="${lastA}"] .review__navbtn`,
    )
    .click();
  await page.waitForFunction(
    ([a, p]) => {
      const row = document.querySelector('.rightpane .review__navrow--active');
      return row?.getAttribute('data-root') === a && row.getAttribute('data-path') === p;
    },
    [keyA, lastA],
    { timeout: 10000 },
  );
  const lastCard = `.rcard[data-root="${keyA}"][data-path="${lastA}"] .rcard__toggle`;
  await page.waitForSelector(lastCard, { state: 'attached', timeout: 10000 });
  await page.focus(lastCard);
  await page.keyboard.press('J');
  const ring = await page
    .waitForFunction(
      ([b, p]) => {
        const c = document
          .querySelector('.review__scroll [aria-current="true"]')
          ?.closest('.rcard');
        return c?.getAttribute('data-root') === b && c.getAttribute('data-path') === p
          ? true
          : null;
      },
      [keyB, firstB],
      { timeout: 10000 },
    )
    .then(
      () => true,
      () => false,
    );
  const at = await page.evaluate(() => {
    const c = document.querySelector('.review__scroll [aria-current="true"]')?.closest('.rcard');
    return c ? `${c.getAttribute('data-root')}|${c.getAttribute('data-path')}` : null;
  });
  assert(ring, `J across the group boundary must land on ${keyB}|${firstB}; ring is on ${at}`);
  log('grouped: bounded cards + rows; J crosses from repo-a’s last file to repo-b’s first ✓');

  log('PASS ✓ review-virtualize: large changeset mounts ≪ N cards with full-length scroll');
});
