/**
 * hunk-staging — Lane E of spec 2026-08-27-review-supercharge. Real-app only: the whole feature
 * is `git diff` → selectHunks → `git apply` on the host, which the mock shell cannot fake.
 *
 * Fixtures, all committed then edited in the worktree:
 *   two.txt    LF, two separated edits → two git hunks (the headline case)
 *   crlf.txt   CRLF line endings, one edit
 *   noeof.txt  no trailing newline, one edit
 *   staged.txt one edit, ALREADY STAGED → the All-scope "blocked" case
 *   peek.txt   two lines deleted → the editor change peek
 *
 * Flow: stage hunk 2 of two.txt under Unstaged scope → discard on the CRLF and no-EOF fixtures
 * → the blocked buttons under All → a conflict → the editor peek.
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assert, closeApp, openSession, runScenario } from './harness.mjs';

const SCOPE_SEL = '[role="radiogroup"][aria-label="Scope"] [role="radio"]';

const numbered = (n, edits = {}, eol = '\n') =>
  Array.from({ length: n }, (_, i) => edits[i + 1] ?? `l${i + 1}`).join(eol) + eol;

/** Wait until the Scope control reports `name` as the selected option. */
const waitForScope = (page, name) =>
  page.waitForFunction(
    ([sel, want]) =>
      document.querySelector(`${sel}[aria-checked="true"]`)?.getAttribute('aria-label') === want,
    [SCOPE_SEL, name],
    { timeout: 15000 },
  );

/** Wait until one card has a real diff, not the "Loading diff…" placeholder. */
const waitForCard = (page, path) =>
  page.waitForFunction(
    (p) => {
      const card = document.querySelector(`.review .rcard[data-path="${p}"]`);
      return !!card && !card.querySelector('.rcard__notice--loading');
    },
    path,
    { timeout: 15000 },
  );

const waitForHunkCount = (page, path, want) =>
  page.waitForFunction(
    ([p, n]) => document.querySelectorAll(`.review .rcard[data-path="${p}"] .rhunk`).length === n,
    [path, want],
    { timeout: 15000 },
  );

runScenario('hunk-staging', async ({ app, page, log }) => {
  const root = mkdtempSync(join(tmpdir(), 'conduit-hunkstage-'));
  const git = (...a) => execFileSync('git', a, { cwd: root, encoding: 'utf8' });

  git('init', '-q');
  git('config', 'user.email', 'e2e@conduit.test');
  git('config', 'user.name', 'e2e');
  git('config', 'commit.gpgsign', 'false');
  git('config', 'core.autocrlf', 'false');

  writeFileSync(join(root, 'two.txt'), numbered(30));
  writeFileSync(join(root, 'crlf.txt'), numbered(12, {}, '\r\n'));
  writeFileSync(join(root, 'noeof.txt'), 'alpha\nbeta\ngamma');
  writeFileSync(join(root, 'staged.txt'), numbered(14));
  writeFileSync(join(root, 'peek.txt'), numbered(20));
  git('add', '.');
  git('commit', '-qm', 'seed');

  writeFileSync(join(root, 'two.txt'), numbered(30, { 3: 'HUNK-A', 25: 'HUNK-B' }));
  writeFileSync(join(root, 'crlf.txt'), numbered(12, { 6: 'CRLF-EDIT' }, '\r\n'));
  writeFileSync(join(root, 'noeof.txt'), 'alpha\nbeta\nGAMMA');
  writeFileSync(join(root, 'staged.txt'), numbered(14, { 5: 'STAGED-EDIT' }));
  git('add', 'staged.txt');
  // peek.txt loses lines 8-9 — a pure deletion, which is what the peek quotes.
  writeFileSync(
    join(root, 'peek.txt'),
    numbered(20)
      .split('\n')
      .filter((l) => l !== 'l8' && l !== 'l9')
      .join('\n'),
  );

  const cached = () => git('diff', '--cached', '-U3');
  const worktreeDirty = (f) => git('diff', '--', f).trim() !== '';

  await openSession(page, { path: root.replace(/\\/g, '/') });
  await page.waitForSelector('.git-indicator__review', { state: 'visible', timeout: 20000 });
  await page.click('.git-indicator__review');
  await page.waitForSelector('.review .rcard', { state: 'visible', timeout: 20000 });
  log('review open ✓');

  const hunks = (name) => page.locator(`.review .rcard[data-path="${name}"] .rhunk`);
  /** One hunk's action button. Hovered before the click: Playwright hit-tests where the mouse
   *  IS, so a click without a move can land on whatever the pointer was over. */
  const act = async (name, i, label) => {
    const btn = hunks(name)
      .nth(i)
      .locator('.rhunk__act', { hasText: new RegExp(`^${label}$`) });
    await btn.waitFor({ state: 'attached', timeout: 15000 });
    await btn.hover();
    return btn;
  };

  // ---- (1) Unstaged scope, stage the SECOND of two hunks -------------------------------
  await page.getByRole('radio', { name: 'Unstaged', exact: true }).click();
  await waitForScope(page, 'Unstaged');
  await waitForCard(page, 'two.txt');
  await waitForHunkCount(page, 'two.txt', 2);
  log('two.txt shows two hunks ✓');

  await (await act('two.txt', 1, 'Stage')).click();
  await waitForHunkCount(page, 'two.txt', 1);
  const staged = cached();
  assert(staged.includes('HUNK-B'), 'the staged diff must contain the hunk that was staged');
  assert(!staged.includes('HUNK-A'), `only hunk 2 may be staged; got:\n${staged}`);
  const remaining = await hunks('two.txt').first().textContent();
  assert(
    (remaining ?? '').length > 0 && !(remaining ?? '').includes('HUNK-B'),
    'the card must now show the OTHER hunk',
  );
  log('staged exactly hunk 2; the card kept hunk 1 ✓');

  // ---- (2) Discard, on the CRLF and the no-EOF fixtures ---------------------------------
  for (const file of ['crlf.txt', 'noeof.txt']) {
    await waitForCard(page, file);
    await (await act(file, 0, 'Discard')).click();
    await page.waitForSelector('.confirm', { state: 'visible', timeout: 10000 });
    const msg = (await page.textContent('.confirm__msg')) ?? '';
    assert(
      msg.includes('reverted to the index'),
      `confirm copy should name the index; got "${msg}"`,
    );
    await page.locator('.confirm .btn--danger').click();
    await page.waitForFunction(
      (f) => !document.querySelector(`.review .rcard[data-path="${f}"] .rhunk`),
      file,
      { timeout: 15000 },
    );
    assert(!worktreeDirty(file), `${file} must equal the index after a discard`);
    log(`${file} discarded and back to the index ✓`);
  }
  const crlfBytes = readFileSync(join(root, 'crlf.txt'), 'utf8');
  assert(crlfBytes.includes('\r\n'), 'discarding must not rewrite CRLF line endings');
  const noeofBytes = readFileSync(join(root, 'noeof.txt'), 'utf8');
  assert(!noeofBytes.endsWith('\n'), 'discarding must not add a trailing newline');
  log('line endings survived the round trip ✓');

  // ---- (3) All scope: a file with a staged side is blocked ------------------------------
  await page.getByRole('radio', { name: 'All', exact: true }).click();
  await waitForScope(page, 'All');
  await waitForCard(page, 'staged.txt');
  await page.waitForSelector('.review .rcard[data-path="staged.txt"] .rhunk__act', {
    state: 'attached',
    timeout: 15000,
  });
  const blocked = await page.evaluate(() => {
    const btns = [
      ...document.querySelectorAll('.review .rcard[data-path="staged.txt"] .rhunk__act'),
    ];
    return btns.map((b) => ({ text: b.textContent?.trim(), disabled: b.disabled, title: b.title }));
  });
  assert(blocked.length >= 2, `expected the staged file's hunk buttons, got ${blocked.length}`);
  assert(
    blocked.every((b) => b.disabled),
    `every hunk button must be disabled for a file with a staged side; got ${JSON.stringify(blocked)}`,
  );
  assert(
    blocked.some((b) => b.title === 'Switch to Unstaged scope to stage hunks'),
    `the tooltip must name the scope to switch to; got ${JSON.stringify(blocked)}`,
  );
  log('All scope + staged side → disabled with the tooltip ✓');

  // ---- (4) Conflict: the file moves after the diff loaded -------------------------------
  // The scope switch comes FIRST: it clears the per-path request guard, so the card refetches
  // and is genuinely up to date. The rewrite after it is what the card cannot know about — a
  // plain refresh never re-reads a cached diff, which is precisely the stale case §2 Lane E
  // describes.
  await page.getByRole('radio', { name: 'Unstaged', exact: true }).click();
  await waitForScope(page, 'Unstaged');
  await waitForCard(page, 'two.txt');
  await waitForHunkCount(page, 'two.txt', 1);
  const before = cached();
  writeFileSync(join(root, 'two.txt'), 'entirely different content\n');
  await (await act('two.txt', 0, 'Stage')).click();
  await page.waitForFunction(
    () =>
      [...document.querySelectorAll('.toast')].some((t) =>
        (t.textContent ?? '').includes('changed since this diff was loaded'),
      ),
    null,
    { timeout: 15000 },
  );
  assert(cached() === before, 'a conflicted op must stage nothing');
  log('conflict toasted and staged nothing ✓');

  // ---- (5) The editor peek --------------------------------------------------------------
  await page.locator('.rtab', { hasText: 'Files' }).click();
  const row = page.locator('.filerow', {
    has: page.locator('.filerow__name', { hasText: /^peek\.txt$/ }),
  });
  await row.first().waitFor({ state: 'attached', timeout: 20000 });
  await row.first().click();
  await page.waitForFunction(
    () =>
      (window.monaco?.editor.getModels() ?? []).some((m) => m.uri.toString().endsWith('peek.txt')),
    null,
    { timeout: 20000 },
  );
  const marker = page.locator('.margin-view-overlays .cdec--deleted').first();
  await marker.waitFor({ state: 'attached', timeout: 20000 });
  // A gutter decoration can be a hairline, so drive the mouse at its own box rather than
  // relying on Playwright's actionability check for a 3px-wide target.
  const box = await marker.boundingBox();
  assert(box !== null, 'the deleted-line gutter marker must have a box to click');
  await page.mouse.click(box.x + Math.max(box.width / 2, 2), box.y + Math.max(box.height / 2, 2));

  const peek = page.locator('.peek[role="dialog"]');
  await peek.waitFor({ state: 'attached', timeout: 15000 });
  const peekLines = await page.locator('.peek .rline--del').count();
  assert(peekLines === 2, `the peek should quote both removed lines, got ${peekLines}`);
  const peekLabel = await page.getAttribute('.peek[role="dialog"]', 'aria-label');
  assert(/^Change \d+ of \d+$/.test(peekLabel ?? ''), `peek aria-label was "${peekLabel}"`);
  const peekActs = await page.evaluate(() =>
    [...document.querySelectorAll('.peek .peek__act')].map((b) => ({
      text: b.textContent?.trim(),
      disabled: b.disabled,
    })),
  );
  assert(
    peekActs.some((b) => b.text === 'Stage' && !b.disabled) &&
      peekActs.some((b) => b.text === 'Discard' && !b.disabled),
    `the peek must offer an enabled Stage and Discard; got ${JSON.stringify(peekActs)}`,
  );
  log(`peek open: "${peekLabel}" with ${peekLines} removed lines and both actions ✓`);

  const shotDir = process.env.CONDUIT_E2E_SHOT_DIR || join(tmpdir(), 'claude-scratch');
  mkdirSync(shotDir, { recursive: true });
  const shot = join(shotDir, 'lane-e-peek.png');
  await page.screenshot({ path: shot }).catch(() => {});
  log(`screenshot: ${shot}`);

  await page.keyboard.press('Escape');
  await peek.waitFor({ state: 'detached', timeout: 10000 });
  const focusReturned = await page.evaluate(
    () => document.activeElement?.closest('.viewer__monaco') !== null,
  );
  assert(focusReturned, 'Esc must return focus to the editor');
  log('peek closed and focus returned to the editor ✓');

  await closeApp(app, page);
  // The fixture repo is ours; leaving one behind per run fills the temp dir.
  rmSync(root, { recursive: true, force: true });
  log('PASS ✓ hunk-staging: stage one hunk, discard, blocked scope, conflict, editor peek');
});
