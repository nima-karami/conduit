/**
 * review-scope — Review's staged / unstaged scoping (spec 2026-08-27-review-supercharge §2
 * Lane D, §7). Real-app: the whole feature is a `readDiff` base/side pair crossing the IPC
 * boundary into `git show HEAD:<rel>` vs `git show :<rel>`, which no mock shell can produce.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assert, openSession, runScenario } from './harness.mjs';

const git = (dir, ...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8' }).trim();

const STAGED_MARK = 'MARK_STAGED_SIDE';
const UNSTAGED_MARK = 'MARK_UNSTAGED_SIDE';

const SCOPE_SEL = '[role="radiogroup"][aria-label="Scope"] [role="radio"]';

/** Paths of the cards currently rendered, in order. */
const cardPaths = (page) =>
  page.evaluate(() =>
    Array.from(document.querySelectorAll('.review .rcard'), (c) => c.getAttribute('data-path')),
  );

/** Whole text of one card, for marker-presence checks. */
const cardText = (page, path) =>
  page.evaluate(
    (p) => document.querySelector(`.review .rcard[data-path="${p}"]`)?.textContent ?? '',
    path,
  );

const selectedScope = (page) =>
  page.evaluate(
    (sel) =>
      document.querySelector(`${sel}[aria-checked="true"]`)?.getAttribute('aria-label') ?? '',
    SCOPE_SEL,
  );

/** Wait until the Scope control reports `name` as the selected option. */
const waitForScope = (page, name) =>
  page.waitForFunction(
    ([sel, want]) =>
      document.querySelector(`${sel}[aria-checked="true"]`)?.getAttribute('aria-label') === want,
    [SCOPE_SEL, name],
    { timeout: 15000 },
  );

/** The card for `path` exists and has a real diff, not the "Loading diff…" placeholder. */
const waitForCard = (page, path) =>
  page.waitForFunction(
    (p) => {
      const card = document.querySelector(`.review .rcard[data-path="${p}"]`);
      return !!card && !card.querySelector('.rcard__notice--loading');
    },
    path,
    { timeout: 15000 },
  );

/** Wait until the rendered card set matches `paths` exactly (order-insensitive). */
const waitForCards = (page, paths) =>
  page.waitForFunction(
    (want) => {
      const have = Array.from(document.querySelectorAll('.review .rcard'), (c) =>
        c.getAttribute('data-path'),
      );
      return have.length === want.length && want.every((p) => have.includes(p));
    },
    paths,
    { timeout: 15000 },
  );

runScenario('review-scope', async ({ page, log }) => {
  const shot = join(tmpdir(), 'conduit-shot-review-scope.png');
  const root = mkdtempSync(join(tmpdir(), 'conduit-review-scope-'));

  // Three shapes the scopes have to tell apart: staged only, unstaged only, and one file
  // changed on BOTH sides with a distinct marker per side.
  const body = Array.from({ length: 6 }, (_, i) => `const b${i} = ${i};`).join('\n');
  for (const f of ['staged-only.ts', 'unstaged-only.ts', 'both.ts'])
    writeFileSync(join(root, f), `${body}\n`);
  git(root, 'init', '-q');
  git(root, 'config', 'user.email', 'e2e@conduit.test');
  git(root, 'config', 'user.name', 'e2e');
  git(root, 'config', 'commit.gpgsign', 'false');
  git(root, 'add', '.');
  git(root, 'commit', '-qm', 'base');

  writeFileSync(join(root, 'staged-only.ts'), `${body}\nconst stagedOnly = 1;\n`);
  git(root, 'add', 'staged-only.ts');
  writeFileSync(join(root, 'unstaged-only.ts'), `${body}\nconst unstagedOnly = 1;\n`);
  // both.ts: the staged marker goes into the index, then the unstaged marker on top of it.
  const stagedBody = `${body}\nconst markA = '${STAGED_MARK}';\n`;
  writeFileSync(join(root, 'both.ts'), stagedBody);
  git(root, 'add', 'both.ts');
  writeFileSync(join(root, 'both.ts'), `${stagedBody}const markB = '${UNSTAGED_MARK}';\n`);

  await openSession(page, { path: root.replace(/\\/g, '/') });
  await page.waitForSelector('.git-indicator__review', { state: 'visible', timeout: 20000 });
  await page.click('.git-indicator__review');
  await page.waitForSelector('.review .rcard', { state: 'visible', timeout: 15000 });

  // ── (1) All: today's deduped list — every path once, both markers on both.ts ──────────
  assert((await selectedScope(page)) === 'All', 'a fresh Review must open on All');
  await waitForCards(page, ['staged-only.ts', 'unstaged-only.ts', 'both.ts']);
  await waitForCard(page, 'both.ts');
  const all = await cardPaths(page);
  log(`All: ${JSON.stringify(all)}`);
  assert(
    all.filter((p) => p === 'both.ts').length === 1,
    'a both-sided path must appear ONCE under All',
  );
  const allBoth = await cardText(page, 'both.ts');
  assert(
    allBoth.includes(STAGED_MARK) && allBoth.includes(UNSTAGED_MARK),
    'All (HEAD→worktree) must show both sides of both.ts',
  );

  // ── (2) Staged: HEAD→index ────────────────────────────────────────────────────────────
  await page.getByRole('radio', { name: 'Staged', exact: true }).click();
  await waitForScope(page, 'Staged');
  await waitForCards(page, ['staged-only.ts', 'both.ts']);
  await waitForCard(page, 'both.ts');
  log(`Staged: ${JSON.stringify(await cardPaths(page))}`);
  const stagedBoth = await cardText(page, 'both.ts');
  assert(
    stagedBoth.includes(STAGED_MARK) && !stagedBoth.includes(UNSTAGED_MARK),
    'Staged must show only the HEAD→index hunks of both.ts',
  );
  await page.screenshot({ path: shot });
  log(`screenshot: ${shot}`);

  // ── (3) Unstaged: index→worktree ──────────────────────────────────────────────────────
  await page.getByRole('radio', { name: 'Unstaged', exact: true }).click();
  await waitForScope(page, 'Unstaged');
  await waitForCards(page, ['unstaged-only.ts', 'both.ts']);
  await waitForCard(page, 'both.ts');
  log(`Unstaged: ${JSON.stringify(await cardPaths(page))}`);
  const unstagedBoth = await cardText(page, 'both.ts');
  assert(
    unstagedBoth.includes(UNSTAGED_MARK) && !unstagedBoth.includes(STAGED_MARK),
    'Unstaged must show only the index→worktree hunks of both.ts',
  );

  // ── (4) Arrow keys move the selection inside the radiogroup, wrapping ─────────────────
  await page.getByRole('radio', { name: 'Unstaged', exact: true }).focus();
  await page.keyboard.press('ArrowRight');
  await waitForScope(page, 'All');
  await page.keyboard.press('ArrowLeft');
  await waitForScope(page, 'Unstaged');
  log('arrow keys wrap All ⇄ Unstaged inside the radiogroup ✓');

  // ── (5) The Changes panel's section headers open Review pre-scoped ────────────────────
  await page.evaluate(() => {
    Array.from(document.querySelectorAll('.rtab'))
      .find((el) => el.textContent?.trim().startsWith('Changes'))
      ?.click();
  });
  await page.waitForSelector('.changes__sectionreview', { state: 'visible', timeout: 15000 });
  await page.click('[aria-label="Review staged changes"]');
  await waitForScope(page, 'Staged');
  log('"Review staged changes" opened Review on the Staged scope ✓');

  await page.click('[aria-label="Review unstaged changes"]');
  await waitForScope(page, 'Unstaged');
  log('"Review unstaged changes" opened Review on the Unstaged scope ✓');

  log('PASS ✓ review-scope: All / Staged / Unstaged baselines, keyboard, pre-scoped entry points');
});
