/**
 * New Session dialog: "Browse…" is pinned above the recents (real-app smoke).
 *
 * As the last row inside the scrolling `.repolist` it was unreachable without scrolling once a
 * user had a handful of recent repos — the thing this asserts is that it is NOT in that list and
 * that scrolling the list to the bottom leaves it exactly where it was.
 *
 * Standalone launch (not the shared `runScenario`) because the recents have to be seeded into
 * `repos.json` BEFORE the host reads it at startup, and `runScenario` owns its user-data dir.
 * Still the shared harness's hidden launch + quit-guard-aware close.
 *
 * exit 0 pass/SKIP · 1 assertion failed · 2 infra error
 */

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assert, launchApp, makeLog, shutdownApp } from './harness.mjs';

const log = makeLog('new-session-browse-pinned');

if (process.platform !== 'win32') {
  console.log('[new-session-browse-pinned] SKIP — suite is Windows-only');
  process.exit(0);
}

const fwd = (p) => p.replace(/\\/g, '/');
const userDataDir = mkdtempSync(join(tmpdir(), 'conduit-ud-'));

// The host prunes recents whose directory is gone, so every seeded row needs a real folder.
// Enough of them that the list overflows the dialog's bounded height — that overflow IS the bug.
const seeded = Array.from({ length: 14 }, (_, i) => {
  const path = mkdtempSync(join(tmpdir(), `conduit-recent-${i}-`));
  return { path: fwd(path), name: `recent-${i}`, lastOpened: 100 - i };
});
writeFileSync(join(userDataDir, 'repos.json'), JSON.stringify({ version: 1, repos: seeded }));

let launched = null;
let code = 0;
try {
  launched = await launchApp({ userDataDir });
  const { page } = launched;

  await page.locator('[aria-label="New session"]').first().click();
  await page.waitForSelector('.modal .repolist .repo', { state: 'visible', timeout: 15000 });

  const geom = () =>
    page.evaluate(() => {
      const list = document.querySelector('.repolist');
      const browse = document.querySelector('.repo--browse');
      const first = document.querySelector('.repolist .repo');
      if (!list || !browse || !first) {
        throw new Error('dialog is missing the list, Browse or a recent row');
      }
      const box = (el) => {
        const r = el.getBoundingClientRect();
        return { top: r.top, left: r.left, height: r.height };
      };
      return {
        browse: box(browse),
        first: box(first),
        browseInList: !!document.querySelector('.repolist .repo--browse'),
        scrollTop: list.scrollTop,
        overflow: list.scrollHeight - list.clientHeight,
      };
    });

  const before = await geom();
  log('before scroll:', JSON.stringify(before));

  assert(!before.browseInList, 'Browse must not be a row of the scrolling recents list');
  assert(
    before.browse.top + before.browse.height <= before.first.top + 1,
    `Browse must sit above the first recent (browse ${before.browse.top}, first ${before.first.top})`,
  );
  assert(
    before.overflow > 0,
    `the seeded recents must overflow the list, or the scroll assertion proves nothing (overflow ${before.overflow}px)`,
  );

  await page.evaluate(() => {
    const list = document.querySelector('.repolist');
    list.scrollTop = list.scrollHeight;
  });

  const after = await geom();
  log('after scroll:', JSON.stringify(after));

  assert(after.scrollTop > 0, 'the recents list should have actually scrolled');
  assert(
    after.browse.top === before.browse.top && after.browse.left === before.browse.left,
    `Browse must not move when the recents scroll (was ${before.browse.top}, now ${after.browse.top})`,
  );

  log('PASS ✓');
} catch (e) {
  const isAssertion = e?.name === 'AssertionError';
  if (isAssertion) {
    log('FAIL ✗', e.message);
    code = 1;
  } else {
    console.error('[new-session-browse-pinned] ERROR:', e?.message || e);
    if (e?.stack) console.error(e.stack);
    code = 2;
  }
}

try {
  await shutdownApp(launched?.app, launched?.page);
} catch {
  /* already gone */
}
process.exit(code);
