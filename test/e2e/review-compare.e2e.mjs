/**
 * Compare-refs dialog (real-app smoke). Spec 2026-06-30-review-compare-dialog.
 *
 * Crosses the renderer/host boundary: refs (branches/remotes/tags) are enumerated host-side and
 * the comparison is computed by git:rangeDiff with host-validated refs, so it can only be proven
 * against the built app — not the preview mock.
 *
 * Asserts: the dialog opens from the git-band Compare ICON and from the picker's "Compare…" row;
 * comparing tag↔branch, remote↔local, and a pasted SHA renders the expected diff; the checked-out
 * branch is UNCHANGED (no-checkout guarantee, D); Swap flips the slots; identical endpoints disable
 * Compare; an unknown ref shows the error state with Retry.
 *
 * GOTCHA (CLAUDE.md): the runner serves ./out — run `npm run build` before this scenario.
 * Teardown uses closeApp (NEVER a bare app.close(), which hangs on the quit-guard).
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assert, closeApp, openSession, runScenario } from './harness.mjs';

function git(dir, ...args) {
  return execFileSync('git', args, { cwd: dir }).toString().trim();
}

function commit(dir, name, body, msg) {
  writeFileSync(join(dir, name), body);
  git(dir, 'add', '.');
  git(dir, 'commit', '-qm', msg);
  return git(dir, 'rev-parse', 'HEAD');
}

function makeRepo(dir) {
  // A separate "remote" repo with an unrelated main, fetched as origin/main.
  const remote = mkdtempSync(join(tmpdir(), 'conduit-compare-remote-'));
  git(remote, 'init', '-q', '-b', 'main');
  git(remote, 'config', 'user.email', 't@t');
  git(remote, 'config', 'user.name', 't');
  commit(remote, 'remote-only.txt', 'r1\nr2\n', 'remote work');

  mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 't@t');
  git(dir, 'config', 'user.name', 't');
  const initSha = commit(dir, 'seed.txt', 'seed\n', 'init seed');
  git(dir, 'tag', 'v1.0.0'); // v1.0.0 points at the seed commit
  // feature branch adds a file (main...feature shows feature-only.txt).
  git(dir, 'checkout', '-q', '-b', 'feature');
  commit(dir, 'feature-only.txt', 'a\nb\nc\n', 'add feature file');
  git(dir, 'checkout', '-q', 'main');
  // main advances past the tag so v1.0.0...main is a non-empty diff.
  commit(dir, 'main-only.txt', 'm1\nm2\n', 'main work');
  git(dir, 'remote', 'add', 'origin', remote);
  git(dir, 'fetch', '-q', 'origin');
  return { initSha };
}

const DIALOG = '.compare-dialog';
const COMPARE_BTN = '.compare-dialog__actions .btn--primary';
const baseInput = `${DIALOG} .compare-dialog__slots .cmp-field:nth-child(1) .cmp-combo__input`;
const targetInput = `${DIALOG} .compare-dialog__slots .cmp-field:nth-child(3) .cmp-combo__input`;

async function pick(page, input, text) {
  await page.click(input);
  await page.fill(input, text);
  await page.waitForSelector(`${DIALOG} .cmp-combo__menu .cmp-combo__row`, {
    state: 'visible',
    timeout: 5000,
  });
  await page.press(input, 'Enter');
}

async function openFromIcon(page) {
  await page.click('.git-indicator__compare');
  await page.waitForSelector(DIALOG, { state: 'visible', timeout: 8000 });
}

runScenario('review-compare', async ({ app, page, log }) => {
  const shot = join(tmpdir(), 'conduit-shot-compare-dialog.png');
  const root = mkdtempSync(join(tmpdir(), 'conduit-review-compare-'));
  const { initSha } = makeRepo(root);

  await openSession(page, { path: root.replace(/\\/g, '/') });
  await page.waitForSelector('.git-indicator__compare', { state: 'visible', timeout: 20000 });

  const headBefore = git(root, 'rev-parse', '--abbrev-ref', 'HEAD');
  assert(headBefore === 'main', `expected to start on main; got ${headBefore}`);

  // 1) Open from the git-band icon → compare tag v1.0.0 ↔ branch main.
  await openFromIcon(page);
  log('dialog open (git-band icon)');
  await pick(page, baseInput, 'v1.0.0');
  await pick(page, targetInput, 'main');
  await page.screenshot({ path: shot });
  log(`screenshot (compare dialog): ${shot}`);
  await page.waitForSelector(`${COMPARE_BTN}:not([disabled])`, { timeout: 5000 });
  await page.click(COMPARE_BTN);

  await page.waitForSelector('.review .rcard[data-path="main-only.txt"]', {
    state: 'visible',
    timeout: 15000,
  });
  log('tag↔branch (v1.0.0…main) renders main-only.txt ✓');

  // 2) Open from the "Compare…" row in the source picker → remote origin/main ↔ local main.
  await page.click('.gitband__source');
  await page.waitForSelector('.commit-picker', { state: 'visible', timeout: 10000 });
  await page.click('.commit-picker__compare-entry');
  await page.waitForSelector(DIALOG, { state: 'visible', timeout: 8000 });
  log('dialog open ("Compare…" row)');
  await pick(page, baseInput, 'origin/main');
  await pick(page, targetInput, 'main');
  await page.waitForSelector(`${COMPARE_BTN}:not([disabled])`, { timeout: 5000 });
  await page.click(COMPARE_BTN);
  await page.waitForSelector('.review .rcard', { state: 'visible', timeout: 15000 });
  log('remote↔local (origin/main…main) renders a diff ✓');

  // 3) Pasted SHA as base (the seed commit) ↔ main → main-only.txt.
  await openFromIcon(page);
  await pick(page, baseInput, initSha);
  await pick(page, targetInput, 'main');
  await page.waitForSelector(`${COMPARE_BTN}:not([disabled])`, { timeout: 5000 });
  await page.click(COMPARE_BTN);
  await page.waitForSelector('.review .rcard[data-path="main-only.txt"]', {
    state: 'visible',
    timeout: 15000,
  });
  log('pasted SHA ↔ main renders main-only.txt ✓');

  // No-checkout guarantee (D): nothing above touched the working branch.
  const headAfter = git(root, 'rev-parse', '--abbrev-ref', 'HEAD');
  assert(headAfter === 'main', `compare must not checkout; HEAD changed to ${headAfter}`);
  log('checked-out branch unchanged after all comparisons ✓');

  // 4) Swap flips Base/Target.
  await openFromIcon(page);
  await pick(page, baseInput, 'v1.0.0');
  await pick(page, targetInput, 'feature');
  await page.click('.compare-dialog__swap');
  const swapped = await page.evaluate(
    ({ b, t }) => ({
      base: document.querySelector(b)?.value,
      target: document.querySelector(t)?.value,
    }),
    { b: baseInput, t: targetInput },
  );
  assert(
    swapped.base === 'feature' && swapped.target === 'v1.0.0',
    `swap should flip slots; got ${JSON.stringify(swapped)}`,
  );
  log('Swap flips Base/Target ✓');

  // 5) Identical endpoints → Compare disabled.
  await pick(page, baseInput, 'main');
  await pick(page, targetInput, 'main');
  const disabled = await page.getAttribute(COMPARE_BTN, 'disabled');
  assert(disabled !== null, 'identical endpoints must disable Compare');
  log('identical endpoints disable Compare ✓');

  // 6) Unknown ref (a valid-shaped but nonexistent SHA) → error state with Retry.
  await page.fill(baseInput, '');
  await pick(page, baseInput, 'main');
  const bogus = 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef';
  await page.click(targetInput);
  await page.fill(targetInput, bogus);
  await page.waitForSelector(`${DIALOG} .cmp-combo__menu .cmp-combo__row`, {
    state: 'visible',
    timeout: 5000,
  });
  await page.press(targetInput, 'Enter');
  await page.waitForSelector(`${COMPARE_BTN}:not([disabled])`, { timeout: 5000 });
  await page.click(COMPARE_BTN);
  await page.waitForFunction(
    () =>
      /couldn't compare/i.test(
        document.querySelector('.review .emptystate__title')?.textContent ?? '',
      ),
    null,
    { timeout: 15000 },
  );
  await page.waitForSelector('.review .emptystate .btn--primary', {
    state: 'visible',
    timeout: 5000,
  });
  log('unknown ref shows the error state with Retry ✓');

  log(
    'PASS ✓ review-compare: dialog from icon+row, tag/remote/SHA compare, no-checkout, swap, identical, error',
  );
  await closeApp(app, page);
});
