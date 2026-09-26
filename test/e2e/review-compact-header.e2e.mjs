/**
 * review-compact-header — F1 (spec 2026-09-07-overlay-layers §2.4, §7): at the window minimum
 * width the Review header and bottom action bar must stay operable — the overflow button
 * hit-testable, Stage all fully inside the bar, the source label kept at a 72px floor, the
 * scope segment moved into the `…` menu as checkable rows — and the bar `…` menu opens above
 * the bar instead of over it (T4.2). Real-app: the compact/expanded split is driven by a
 * ResizeObserver on the live `.review__head` box, which the preview mock cannot produce.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assert, openSession, runScenario, waitForRepoGit } from './harness.mjs';

const git = (dir, ...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8' }).trim();

function makeRepo(dir) {
  mkdirSync(dir, { recursive: true });
  const base = {
    'alpha.ts': `${Array.from({ length: 10 }, (_, i) => `const a${i} = ${i};`).join('\n')}\n`,
    'beta.ts': 'export const beta = 1;\n',
    'gamma.md': '# Gamma\n\nold line\n',
    'delete-me.txt': 'remove this file\n',
  };
  git(dir, 'init', '-q');
  for (const [f, c] of Object.entries(base)) writeFileSync(join(dir, f), c);
  git(dir, 'add', '.');
  git(dir, '-c', 'user.email=e2e@conduit.test', '-c', 'user.name=e2e', 'commit', '-qm', 'base');
  writeFileSync(join(dir, 'alpha.ts'), 'export const alpha = 2;\n');
  writeFileSync(join(dir, 'gamma.md'), '# Gamma\n\nnew line\n');
  writeFileSync(join(dir, 'newfile.tsx'), 'export const New = () => null;\n');
  unlinkSync(join(dir, 'delete-me.txt'));
}

const rect = (page, sel) =>
  page.evaluate((s) => {
    const el = document.querySelector(s);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width };
  }, sel);

const overflowMeasure = (page, sel) =>
  page.evaluate((s) => {
    const el = document.querySelector(s);
    if (!el) return null;
    return { scrollWidth: el.scrollWidth, clientWidth: el.clientWidth };
  }, sel);

runScenario('review-compact-header', async ({ page, log }) => {
  const root = mkdtempSync(join(tmpdir(), 'conduit-review-compact-'));
  makeRepo(root);

  await openSession(page, { path: root.replace(/\\/g, '/') });
  await waitForRepoGit(page);
  await page.click('.topbar__logo');

  await page.setViewportSize({ width: 900, height: 700 });
  await page.keyboard.press('Control+Shift+R');
  await page.waitForSelector('.rightpane', { state: 'visible', timeout: 15000 });
  await page.waitForFunction(
    () => document.querySelectorAll('.rightpane .review__navrow').length > 0,
    null,
    { timeout: 15000 },
  );
  // Let the head's ResizeObserver settle before measuring.
  await page.waitForTimeout(200);
  assert(
    (await page.locator('.review__chip').count()) === 0,
    'a single-repo Review has no repo chip',
  );

  const head = await overflowMeasure(page, '.review__head');
  assert(!!head, '.review__head must be present');
  log(`head scrollWidth=${head.scrollWidth} clientWidth=${head.clientWidth}`);
  assert(
    head.scrollWidth <= head.clientWidth,
    `.review__head must not overflow: scrollWidth ${head.scrollWidth} > clientWidth ${head.clientWidth}`,
  );

  const bar = await overflowMeasure(page, '.review__actionbar');
  assert(!!bar, '.review__actionbar must be present');
  log(`actionbar scrollWidth=${bar.scrollWidth} clientWidth=${bar.clientWidth}`);
  assert(
    bar.scrollWidth <= bar.clientWidth,
    `.review__actionbar must not overflow: scrollWidth ${bar.scrollWidth} > clientWidth ${bar.clientWidth}`,
  );

  const moreCentre = await page.evaluate(() => {
    const el = document.querySelector('.review__more');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return hit === el || !!hit?.closest('.review__more');
  });
  log(`.review__more hit-testable at its centre: ${moreCentre}`);
  assert(moreCentre === true, '.review__more must be hit-testable at its own centre');

  const stageallRect = await rect(page, '.review__stageall');
  const barRect = await rect(page, '.review__actionbar');
  assert(!!stageallRect && !!barRect, '.review__stageall and .review__actionbar must be present');
  log(`stageall=${JSON.stringify(stageallRect)} bar=${JSON.stringify(barRect)}`);
  assert(
    stageallRect.left >= barRect.left - 0.5 && stageallRect.right <= barRect.right + 0.5,
    'Stage all must be fully inside the bar',
  );

  // The handoff button goes icon-only here (§2.4): its label is sr-only, so the icon is the only
  // thing left to draw. Without one the button is a blank pill — visible, clickable, meaningless.
  const send = await page.evaluate(() => {
    const el = document.querySelector('.review__send');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return {
      width: r.width,
      svgCount: el.querySelectorAll('svg').length,
      visibleText: el.innerText.trim(),
      accessibleName: el.getAttribute('aria-label') ?? el.getAttribute('title') ?? '',
      hits: hit === el || !!hit?.closest('.review__send'),
    };
  });
  assert(!!send, '.review__send must be present');
  log(`send=${JSON.stringify(send)}`);
  assert(send.svgCount >= 1, 'the handoff button must render an icon once its label is sr-only');
  assert(send.width >= 24, `the handoff button must not collapse — width ${send.width}`);
  assert(send.hits === true, 'the handoff button must be hit-testable at its centre');
  assert(
    send.accessibleName.length > 0,
    'the handoff button must keep an accessible name when compact',
  );

  const sourceInfo = await page.evaluate(() => {
    const el = document.querySelector('.review__source');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const label = el.querySelector('.gh__reffilter-label');
    return {
      width: r.width,
      text: label?.textContent?.trim() ?? '',
      labelWidth: label?.getBoundingClientRect().width ?? 0,
    };
  });
  log(
    `source width=${sourceInfo?.width} label="${sourceInfo?.text}" labelWidth=${sourceInfo?.labelWidth}`,
  );
  assert(!!sourceInfo, '.review__source must be present');
  assert(
    sourceInfo.width >= 72,
    `.review__source width must be at least 72px, was ${sourceInfo.width}`,
  );
  assert(sourceInfo.text.length > 0, '.review__source label text must be non-empty');
  assert(sourceInfo.labelWidth > 0, '.review__source label must be visible (non-zero width)');

  const scopeVisible = await page.evaluate(() => {
    const el = document.querySelector('.review__scope');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return getComputedStyle(el).display !== 'none' && r.width > 0;
  });
  log(`.review__scope visible at 900px: ${scopeVisible}`);
  assert(scopeVisible === false, '.review__scope must be hidden at a compact header width');

  // ── overflow menu: three checkable scope rows ────────────────────────────────────────────
  await page.click('.review__more');
  await page.waitForSelector('.ctxmenu', { state: 'visible', timeout: 5000 });
  const SCOPE_LABELS = ['All', 'Staged', 'Unstaged'];
  const allCheckable = await page.evaluate(() =>
    [...document.querySelectorAll('.ctxmenu [role="menuitemcheckbox"]')].map((el) => ({
      label: el.textContent?.trim() ?? '',
      checked: el.getAttribute('aria-checked'),
    })),
  );
  const scopeRows = allCheckable.filter((r) => SCOPE_LABELS.includes(r.label));
  log(`scope rows: ${JSON.stringify(scopeRows)} (all checkable: ${JSON.stringify(allCheckable)})`);
  assert(scopeRows.length === 3, `expected 3 scope rows, got ${scopeRows.length}`);
  const labels = scopeRows.map((r) => r.label);
  for (const want of SCOPE_LABELS) {
    assert(
      labels.includes(want),
      `scope rows must include "${want}", got ${JSON.stringify(labels)}`,
    );
  }
  const checkedCount = scopeRows.filter((r) => r.checked === 'true').length;
  assert(checkedCount === 1, `exactly one scope row must be checked, got ${checkedCount}`);

  // Pick Staged, reopen, confirm it stuck.
  const staged = page.getByRole('menuitemcheckbox', { name: 'Staged', exact: true });
  await staged.click();
  await page.waitForSelector('.ctxmenu', { state: 'detached', timeout: 5000 });
  await page.click('.review__more');
  await page.waitForSelector('.ctxmenu', { state: 'visible', timeout: 5000 });
  const stagedChecked = await page.evaluate(() => {
    const rows = [...document.querySelectorAll('.ctxmenu [role="menuitemcheckbox"]')];
    const row = rows.find((el) => el.textContent?.trim() === 'Staged');
    return row?.getAttribute('aria-checked');
  });
  log(`Staged checked after reselect: ${stagedChecked}`);
  assert(
    stagedChecked === 'true',
    'reopening the menu after picking Staged must show Staged checked',
  );
  // Back to All — nothing is actually staged in this fixture, and the bar (with Stage all /
  // the bar `…` menu) only renders while `files.length > 0`.
  await page.getByRole('menuitemcheckbox', { name: 'All', exact: true }).click();
  await page.waitForSelector('.ctxmenu', { state: 'detached', timeout: 5000 });
  await page.waitForFunction(
    () => document.querySelectorAll('.rightpane .review__navrow').length > 0,
    null,
    { timeout: 8000 },
  );

  // ── widen: scope segment comes back, scope rows leave the menu ──────────────────────────
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.waitForTimeout(200);
  const scopeVisibleWide = await page.evaluate(() => {
    const el = document.querySelector('.review__scope');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return getComputedStyle(el).display !== 'none' && r.width > 0;
  });
  log(`.review__scope visible at 1440px: ${scopeVisibleWide}`);
  assert(scopeVisibleWide === true, '.review__scope must be visible again at a wide header');

  await page.click('.review__more');
  await page.waitForSelector('.ctxmenu', { state: 'visible', timeout: 5000 });
  const scopeRowsWide = await page.evaluate(
    (wanted) =>
      [...document.querySelectorAll('.ctxmenu [role="menuitemcheckbox"]')].filter((el) =>
        wanted.includes(el.textContent?.trim() ?? ''),
      ).length,
    SCOPE_LABELS,
  );
  log(`scope rows at 1440px: ${scopeRowsWide}`);
  assert(scopeRowsWide === 0, 'the overflow menu must not carry scope rows at a wide header');
  await page.keyboard.press('Escape');
  await page.waitForSelector('.ctxmenu', { state: 'detached', timeout: 5000 });

  // ── bar `…` menu opens ABOVE the bar (T4.2) ──────────────────────────────────────────────
  await page.click('.review__barmore');
  await page.waitForSelector('.ctxmenu', { state: 'visible', timeout: 5000 });
  const barMenuInfo = await page.evaluate(() => {
    const menu = document.querySelector('.ctxmenu');
    const bar = document.querySelector('.review__actionbar');
    if (!menu || !bar) return null;
    const mr = menu.getBoundingClientRect();
    const br = bar.getBoundingClientRect();
    return { menuBottom: mr.bottom, barTop: br.top, menuHeight: mr.height };
  });
  log(
    `bar menu bottom=${barMenuInfo?.menuBottom} bar top=${barMenuInfo?.barTop} menu height=${barMenuInfo?.menuHeight}`,
  );
  assert(!!barMenuInfo, '.ctxmenu and .review__actionbar must be present');
  assert(
    barMenuInfo.menuBottom <= barMenuInfo.barTop + 0.5,
    `bar overflow menu (height ${barMenuInfo.menuHeight}) must open above the bar (bottom ${barMenuInfo.menuBottom} vs bar top ${barMenuInfo.barTop})`,
  );
  await page.keyboard.press('Escape');
  await page.waitForSelector('.ctxmenu', { state: 'detached', timeout: 5000 });

  // ── multi-repo: the repo chip goes glyph-only in a compact header (spec 2026-09-23-mf-review §7.3)
  const home = mkdtempSync(join(tmpdir(), 'conduit-review-compact-multi-'));
  makeRepo(join(home, 'app'));
  makeRepo(join(home, 'lib'));
  await openSession(page, { path: home.replace(/\\/g, '/') });
  await page.click('.topbar__logo');
  await page.setViewportSize({ width: 900, height: 700 });
  if (!(await page.isVisible('.review'))) await page.keyboard.press('Control+Shift+R');
  await page.waitForSelector('.review__chip', { state: 'visible', timeout: 20000 });
  // `compact` comes from a ResizeObserver, which the hidden e2e window delivers late (measured
  // ~1s after the chip appeared). Wait for it to settle; the assertions below still decide.
  await page
    .waitForFunction(() => !document.querySelector('.review__chip .gh__reffilter-label'), null, {
      timeout: 5000,
    })
    .catch(() => {});

  const chip = await page.evaluate(() => {
    const el = document.querySelector('.review__chip');
    const headEl = document.querySelector('.review__head');
    if (!el || !headEl) return null;
    const r = el.getBoundingClientRect();
    const h = headEl.getBoundingClientRect();
    return {
      headWidth: h.width,
      headScroll: headEl.scrollWidth,
      headClient: headEl.clientWidth,
      hasLabel: !!el.querySelector('.gh__reffilter-label'),
      ariaLabel: el.getAttribute('aria-label') ?? '',
      inside: r.left >= h.left - 0.5 && r.right <= h.right + 0.5,
    };
  });
  log(`multi-repo chip=${JSON.stringify(chip)}`);
  assert(!!chip, '.review__chip and .review__head must be present in a multi-repo session');
  assert(chip.headWidth <= 480, `the header must be compact (<=480px) here; was ${chip.headWidth}`);
  assert(!chip.hasLabel, 'the compact chip must be glyph-only (no .gh__reffilter-label)');
  assert(
    chip.ariaLabel.startsWith('Review repo:'),
    `the compact chip must keep its accessible name; aria-label was "${chip.ariaLabel}"`,
  );
  assert(chip.inside, 'the compact chip must sit inside .review__head');
  assert(
    chip.headScroll <= chip.headClient,
    `.review__head must not overflow with the chip: scrollWidth ${chip.headScroll} > clientWidth ${chip.headClient}`,
  );

  log('PASS ✓ compact header + scope rows + bar menu above + glyph-only repo chip');
});
