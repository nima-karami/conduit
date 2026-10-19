/**
 * Review renders Git LFS images (real-app smoke).
 *
 * In an LFS repo `git show <rev>:<path>` returns the pointer text, so every committed side of an
 * image diff decoded to "Could not render image." The blob reads are host-side, so only the built
 * app proves the fix: the working-tree Review (HEAD side from git) and a commit-range compare (both
 * sides from git) must each put a decoded <img> on screen.
 *
 * Skips when git-lfs is not installed. Teardown uses closeApp (never a bare app.close()).
 */

import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assert, closeApp, openReview, openSession, REPO, runScenario } from './harness.mjs';

const FIXTURE_PNG = join(REPO, 'test', 'e2e', 'fixtures', 'sample.png');
// A second valid 1×1 PNG, byte-different from the fixture, for the "modified" side.
const PNG_V2 = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da6360000002000154a24f8b0000000049454e44ae426082',
  'hex',
);

function git(dir, ...args) {
  return execFileSync('git', args, { cwd: dir }).toString().trim();
}

function lfsPresent() {
  try {
    execFileSync('git', ['lfs', 'version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function makeRepo(dir) {
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 't@t');
  git(dir, 'config', 'user.name', 't');
  git(dir, 'lfs', 'install', '--local');
  git(dir, 'lfs', 'track', '*.png');
  copyFileSync(FIXTURE_PNG, join(dir, 'modified.png'));
  git(dir, 'add', '.');
  git(dir, 'commit', '-qm', 'seed lfs image');
  git(dir, 'tag', 'v1');
  copyFileSync(FIXTURE_PNG, join(dir, 'added.png'));
  git(dir, 'add', '.');
  git(dir, 'commit', '-qm', 'add lfs image');
  // Sanity: the repo really stores pointers, or this scenario proves nothing.
  const raw = git(dir, 'show', 'HEAD:added.png');
  assert(raw.startsWith('version https://git-lfs'), 'fixture repo must store LFS pointers');
  writeFileSync(join(dir, 'modified.png'), PNG_V2);
}

/** Every <img> in the card decoded to real pixels, and none fell back to the error notice. */
async function cardImagesDecode(page, rel, want) {
  const card = `.review .rcard[data-path="${rel}"]`;
  await page.waitForSelector(card, { state: 'visible', timeout: 15000 });
  await page.locator(card).scrollIntoViewIfNeeded();
  return page
    .waitForFunction(
      ({ sel, n }) => {
        const el = document.querySelector(sel);
        if (!el || /Could not render image/.test(el.textContent ?? '')) return false;
        const imgs = Array.from(el.querySelectorAll('img.imgstage__img'));
        return imgs.length === n && imgs.every((i) => i.complete && i.naturalWidth > 0);
      },
      { sel: card, n: want },
      { timeout: 15000 },
    )
    .then(() => true)
    .catch(async () => {
      const text = await page.locator(card).innerText();
      throw new Error(`${rel}: images did not decode; card text: ${text.slice(0, 300)}`);
    });
}

runScenario('image-diff-lfs', async ({ app, page, log }) => {
  if (!lfsPresent()) {
    log('SKIP — git-lfs not installed');
    await closeApp(app, page);
    return;
  }
  const root = mkdtempSync(join(tmpdir(), 'conduit-lfs-review-'));
  makeRepo(root);

  await openSession(page, { path: root.replace(/\\/g, '/') });
  await openReview(page);
  await page.waitForSelector('.review', { state: 'visible', timeout: 10000 });

  // 1) Working tree vs HEAD: the HEAD side is an LFS blob read by the host.
  await cardImagesDecode(page, 'modified.png', 2);
  log('working-tree review: modified LFS image renders both sides ✓');

  // 2) Commit range v1…main: both sides come from git.
  await page.click('.review__source');
  await page.waitForSelector('.commit-picker', { state: 'visible', timeout: 8000 });
  await page
    .locator('.commit-picker__list .commit-picker__row', { hasText: 'Compare refs…' })
    .click();
  const dialog = '.compare-dialog';
  await page.waitForSelector(dialog, { state: 'visible', timeout: 8000 });
  for (const [nth, ref] of [
    [1, 'v1'],
    [3, 'main'],
  ]) {
    const input = `${dialog} .compare-dialog__slots .cmp-field:nth-child(${nth}) .cmp-combo__input`;
    await page.click(input);
    await page.fill(input, ref);
    await page.waitForSelector('.cmp-combo__menu .cmp-combo__row', {
      state: 'visible',
      timeout: 5000,
    });
    await page.press(input, 'Enter');
  }
  const compare = `${dialog} .compare-dialog__actions .btn--primary`;
  await page.waitForSelector(`${compare}:not([disabled])`, { timeout: 5000 });
  await page.click(compare);
  await cardImagesDecode(page, 'added.png', 1);
  const shot = join(tmpdir(), 'conduit-shot-lfs-review.png');
  await page.screenshot({ path: shot });
  log(`commit-range review: added LFS image renders ✓ (screenshot: ${shot})`);

  log('PASS ✓ image-diff-lfs');
  await closeApp(app, page);
  // After closeApp: the session's shell holds the repo as its cwd until then.
  rmSync(root, { recursive: true, force: true, maxRetries: 5 });
});
