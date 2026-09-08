/**
 * overlay-modals (spec docs/specs/2026-09-07-overlay-layers.md, plan
 * docs/plans/2026-09-07-overlay-layers.plan.md T2.0) — real-app proof that every modal backdrop
 * portals to `document.body` through `ModalLayer` and that the single overlay stack (T1.3)
 * actually governs z-order, Escape, and popover displacement across the nine migrated dialogs.
 *
 * Findings covered (numbering matches the spec's table):
 *   1. Explorer name-collision confirm (`ConflictDialog`) is centred on the WINDOW, not clipped
 *      inside `.right`'s own stacking context.
 *   3. A confirm opened over the Timed-message dialog paints above it (z-order) and owns Escape
 *      first (closing the confirm leaves the timed dialog open). At the base commit this is
 *      RED for a sharper reason than just z-order: `ConfirmDialog` registers its OWN
 *      `window.addEventListener('keydown', …)` in a `useEffect` fired synchronously off the
 *      very Escape keydown that opened it, and that listener is live before the SAME native
 *      event finishes bubbling to `window` — so the confirm both opens and immediately
 *      self-closes on one keypress. The migrated code (T2.1/T2.3) removes every dialog's own
 *      window listener in favour of the store's single capture-phase one, which fixes this.
 *   5. The Mermaid fullscreen viewer's backdrop fills the real viewport, not `.center`'s box.
 *   6. A Review navigator row's Discard confirm is a real top-level modal, not embedded in the
 *      pane's clipped stacking context.
 *   7. (Displacement) Pushing a modal (Settings) dismisses an already-open `ContextMenu`
 *      (audit N7) — this is the same `pushOverlay` behaviour the spec's arch "Delete component?"
 *      row names, exercised here via the explorer's row menu + Mod+, instead: the arch canvas has
 *      no confirm on component/port/edge delete in the current tree (`removeNode`/`removePort`/
 *      `removeEdge` apply immediately; the file's only `setConfirm` call is the unrelated
 *      interface-delete flow) — see the run's report for detail, this is not a bug this plan
 *      introduces or is scoped to fix.
 *
 * Windows only, real app — see CLAUDE.md (run alone on a quiet machine).
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assert, openSession, runScenario } from './harness.mjs';

const git = (dir, ...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8' }).trim();

/** A `.filerow` located by its exact absolute `data-path`. The tree's `node.path` is
 *  forward-slash-normalized (same convention `openSession`'s `openRepo` post uses), so a
 *  Windows `path.join` result is normalized first; CSS.escape then handles the remaining
 *  colon (`C:`) an attribute selector built by hand would need escaped too. */
async function rowByPath(page, absPath) {
  const norm = absPath.replace(/\\/g, '/');
  const esc = await page.evaluate((p) => CSS.escape(p), norm);
  return page.locator(`.filerow[data-path="${esc}"]`);
}

/** Seat real DOM focus on the tree's roving row so the keyboard shortcuts below reach
 *  `onTreeKeyDown` — a click alone lands focus on whatever was focusable at mousedown time,
 *  not yet the freshly-roving row (same precedent as explorer-keyboard-multiselect.e2e.mjs). */
async function seatTreeFocus(page) {
  await page.locator('.filerow[tabindex="0"]').first().focus();
}

function backdropGeometry(page, selector) {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return {
      rect: { x: r.x, y: r.y, w: r.width, h: r.height },
      parentIsBody: el.parentElement === document.body,
      zIndex: getComputedStyle(el).zIndex,
    };
  }, selector);
}

const closeTo = (a, b, tol) => Math.abs(a - b) <= tol;

runScenario('overlay-modals', async ({ page, log }) => {
  // ── Session A: a plain fixture tree for the explorer-conflict, mermaid and timed-message
  // findings. Same root serves all three — none of them touches the others' fixture files. ──
  const rootA = mkdtempSync(join(tmpdir(), 'conduit-overlay-modals-'));
  mkdirSync(join(rootA, 'a'), { recursive: true });
  mkdirSync(join(rootA, 'b'), { recursive: true });
  writeFileSync(join(rootA, 'a', 'x.txt'), 'from a\n');
  writeFileSync(join(rootA, 'b', 'x.txt'), 'from b\n');
  writeFileSync(
    join(rootA, 'diagram.md'),
    '# diagram\n\n```mermaid\nflowchart TD\n  a --> b\n```\n',
  );

  const sidA = await openSession(page, { path: rootA });
  log('session A open (explorer/mermaid/timed-message fixtures) ✓');

  // ── (3) Timed-message dialog vs. its own discard confirm: z-order + Escape-to-top ──────────
  await page.evaluate(
    (id) =>
      window.agentDeck.post({
        type: 'timer:set',
        schedule: {
          sessionId: id,
          message: 'overlay-modals-check',
          trigger: { kind: 'in', delayMs: 30 * 60_000 },
        },
      }),
    sidA,
  );
  await page.locator('.term-timer').first().waitFor({ state: 'visible', timeout: 10000 });
  await page.locator('.term-timer__open').first().click();
  await page.locator('.tmdlg').first().waitFor({ state: 'visible', timeout: 10000 });
  // Dirty the composer (default 'Continue' matches its own seed, so Escape would close with no
  // confirm) — requestClose only asks when the message differs from what it was seeded with.
  await page.locator('.tmdlg__input').click();
  await page.keyboard.type(', please');
  await page.keyboard.press('Escape');
  await page.locator('.confirm').first().waitFor({ state: 'visible', timeout: 5000 });

  const backdrops3 = await page.evaluate(() =>
    Array.from(document.querySelectorAll('.modal__backdrop')).map((el) => ({
      z: getComputedStyle(el).zIndex,
      parentIsBody: el.parentElement === document.body,
      hasTmdlg: !!el.querySelector('.tmdlg'),
      hasConfirm: !!el.querySelector('.confirm'),
    })),
  );
  assert(
    backdrops3.length === 2,
    `(3) expected 2 .modal__backdrop (tmdlg + confirm), got ${backdrops3.length}`,
  );
  assert(
    backdrops3.every((b) => b.parentIsBody),
    `(3) both backdrops must be direct children of body: ${JSON.stringify(backdrops3)}`,
  );
  const tmdlgBackdrop = backdrops3.find((b) => b.hasTmdlg);
  const confirmBackdrop = backdrops3.find((b) => b.hasConfirm);
  assert(tmdlgBackdrop && confirmBackdrop, `(3) could not identify both backdrops by content`);
  const [tz, cz] = [Number(tmdlgBackdrop.z), Number(confirmBackdrop.z)];
  assert(
    Number.isFinite(tz) && Number.isFinite(cz),
    `(3) z-index must be numeric, got tmdlg=${tmdlgBackdrop.z} confirm=${confirmBackdrop.z}`,
  );
  assert(
    cz > tz,
    `(3) the confirm (z=${cz}) must paint above the timed dialog (z=${tz}) — measured ${JSON.stringify(backdrops3)}`,
  );
  const cancelHit = await page.evaluate(() => {
    const btn = document.querySelector('.confirm .confirm__actions button');
    if (!btn) return null;
    const r = btn.getBoundingClientRect();
    const el = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
    return el === btn || btn.contains(el);
  });
  assert(cancelHit, "(3) elementFromPoint at the confirm's Cancel centre must hit that button");
  log(`(3) two backdrops, confirm z=${cz} > tmdlg z=${tz}, Cancel hit-tests correctly ✓`);

  await page.keyboard.press('Escape');
  await page.locator('.confirm').first().waitFor({ state: 'detached', timeout: 5000 });
  await page.locator('.tmdlg').first().waitFor({ state: 'visible', timeout: 5000 });
  log('(3) Escape dismissed only the top entry (confirm); .tmdlg remains ✓');
  // The composer is still dirty (typed above, never armed) — a second Escape reopens the SAME
  // discard confirm rather than closing outright, so finish through it via its own Discard button.
  await page.keyboard.press('Escape');
  await page.locator('.confirm').first().waitFor({ state: 'visible', timeout: 5000 });
  await page.locator('.confirm .confirm__actions button', { hasText: 'Discard' }).click();
  await page.locator('.tmdlg').first().waitFor({ state: 'detached', timeout: 5000 });

  // ── (5) Mermaid fullscreen viewer backdrop fills the real viewport ──────────────────────────
  await page.locator('.rtab', { hasText: 'Files' }).click();
  await page.waitForFunction(
    () =>
      Array.from(document.querySelectorAll('.filerow__name')).some(
        (e) => e.textContent === 'diagram.md',
      ),
    null,
    { timeout: 20000 },
  );
  await page.evaluate(() => {
    const el = Array.from(document.querySelectorAll('.filerow__name')).find(
      (e) => e.textContent === 'diagram.md',
    );
    el?.closest('.filerow')?.click();
  });
  await page.waitForSelector('.mermaid-diagram__svg svg', { state: 'attached', timeout: 30000 });
  await page.evaluate(() => document.querySelector('.mermaid-diagram__expand')?.click());
  await page.waitForFunction(
    () => {
      const svg = document.querySelector('.mermaid-zoom__content svg');
      return !!svg && svg.getBoundingClientRect().width > 0;
    },
    null,
    { timeout: 20000 },
  );
  const viewport5 = await page.evaluate(() => ({
    w: document.documentElement.clientWidth,
    h: document.documentElement.clientHeight,
  }));
  const geo5 = await backdropGeometry(page, '.mermaid-zoom__backdrop');
  assert(geo5, '(5) .mermaid-zoom__backdrop must be present once the viewer is open');
  assert(
    geo5.parentIsBody,
    `(5) the mermaid backdrop must be a direct child of body — measured ${JSON.stringify(geo5)}`,
  );
  assert(
    closeTo(geo5.rect.w, viewport5.w, 2) && closeTo(geo5.rect.h, viewport5.h, 2),
    `(5) backdrop rect ${JSON.stringify(geo5.rect)} must equal the viewport ${JSON.stringify(viewport5)}`,
  );
  log(`(5) mermaid backdrop fills the viewport (${geo5.rect.w}x${geo5.rect.h}), parent body ✓`);
  await page.evaluate(() =>
    document.querySelector('.mermaid-zoom__btn[aria-label="Close diagram viewer"]')?.click(),
  );
  await page
    .locator('.mermaid-zoom__backdrop')
    .first()
    .waitFor({ state: 'detached', timeout: 5000 });

  // ── (1) Explorer name-collision confirm is centred on the WINDOW ────────────────────────────
  await page.locator('.rtab', { hasText: 'Files' }).click();
  await page.waitForSelector('.filerow', { state: 'attached', timeout: 20000 });

  const aDir = join(rootA, 'a');
  const bDir = join(rootA, 'b');
  const bFile = join(bDir, 'x.txt');

  // Expand both folders so their (same-named) x.txt rows are reachable.
  await (await rowByPath(page, aDir)).click();
  await (await rowByPath(page, join(aDir, 'x.txt'))).waitFor({ state: 'attached', timeout: 5000 });
  await (await rowByPath(page, bDir)).click();
  await (await rowByPath(page, bFile)).waitFor({ state: 'attached', timeout: 5000 });

  // The plain clicks above left the last-expanded folder ("b") selected; a Ctrl-click on it
  // TOGGLES it off (rather than replacing the selection) so only the file ends up selected —
  // otherwise the clipboard would hold the whole "b" folder instead of just "b/x.txt".
  await (await rowByPath(page, bDir)).click({ modifiers: ['Control'] });
  await (await rowByPath(page, bFile)).click({ modifiers: ['Control'] });
  await seatTreeFocus(page);
  await page.keyboard.press('Control+c');
  await (await rowByPath(page, aDir)).click({ modifiers: ['Control'] });
  await seatTreeFocus(page);
  await page.keyboard.press('Control+v');

  await page.locator('.confirm').first().waitFor({ state: 'visible', timeout: 10000 });
  const geo1 = await backdropGeometry(page, '.modal__backdrop');
  assert(geo1, '(1) .modal__backdrop must be present for the collision confirm');
  assert(
    geo1.parentIsBody,
    `(1) the collision confirm backdrop must be a direct child of body — measured ${JSON.stringify(geo1)}`,
  );
  // .confirm plays a 0.12s `modal-pop` (translateY(8px) -> none) on mount, and this harness's
  // hidden window can suspend the rendering pipeline that would otherwise advance it — so wait
  // is unreliable. Read the matrix's own translation and back it out instead: the resting
  // (post-animation) position is what "centred" means, not whichever frame happened to paint.
  const box1 = await page.evaluate(() => {
    const el = document.querySelector('.confirm');
    const r = el.getBoundingClientRect();
    const t = getComputedStyle(el).transform;
    const m = t === 'none' ? null : new DOMMatrixReadOnly(t);
    const ty = m?.m42 ?? 0;
    return { cx: r.x + r.width / 2, cy: r.y - ty + r.height / 2 };
  });
  const winCenter = await page.evaluate(() => ({
    cx: document.documentElement.clientWidth / 2,
    cy: document.documentElement.clientHeight / 2,
  }));
  assert(
    closeTo(box1.cx, winCenter.cx, 4) && closeTo(box1.cy, winCenter.cy, 4),
    `(1) .confirm centre ${JSON.stringify(box1)} must be within 4px of the window centre ${JSON.stringify(winCenter)}`,
  );
  const buttonBoxes1 = await page.evaluate(() => {
    const vw = document.documentElement.clientWidth;
    const vh = document.documentElement.clientHeight;
    return Array.from(document.querySelectorAll('.confirm .confirm__actions button')).map((b) => {
      const r = b.getBoundingClientRect();
      return r.left >= 0 && r.top >= 0 && r.right <= vw && r.bottom <= vh;
    });
  });
  assert(buttonBoxes1.length === 3, `(1) expected 3 conflict buttons, got ${buttonBoxes1.length}`);
  assert(
    buttonBoxes1.every(Boolean),
    `(1) all three conflict buttons must be fully inside the viewport: ${JSON.stringify(buttonBoxes1)}`,
  );
  log(
    `(1) collision confirm centred within 4px of window centre, all buttons on-screen, parent body ✓`,
  );
  await page.locator('.confirm .confirm__actions button').first().click(); // Cancel
  await page.locator('.confirm').first().waitFor({ state: 'detached', timeout: 5000 });

  // ── Displacement: pushing a modal (Settings) dismisses an already-open ContextMenu (N7) ─────
  await (await rowByPath(page, join(rootA, 'diagram.md'))).click({ button: 'right' });
  await page.waitForSelector('.ctxmenu', { state: 'visible', timeout: 5000 });
  await page.keyboard.press('Control+,');
  await page.waitForSelector('.ctxmenu', { state: 'detached', timeout: 5000 });
  await page.locator('.settings__navitem').first().waitFor({ state: 'visible', timeout: 5000 });
  assert(
    (await page.locator('.ctxmenu').count()) === 0,
    'displacement: the ContextMenu must be gone once Settings (a modal) mounts',
  );
  log('displacement: opening Settings dismissed the open ContextMenu (pushOverlay N7) ✓');
  await page.keyboard.press('Escape');
  await page.locator('.modal.settings').first().waitFor({ state: 'detached', timeout: 5000 });

  // ── (6) Review navigator row's Discard confirm is a real top-level modal ────────────────────
  const rootB = mkdtempSync(join(tmpdir(), 'conduit-overlay-modals-review-'));
  writeFileSync(join(rootB, 'tracked.txt'), 'line one\n');
  git(rootB, 'init', '-q');
  git(rootB, 'add', '.');
  git(rootB, '-c', 'user.email=e2e@conduit.test', '-c', 'user.name=e2e', 'commit', '-qm', 'base');
  writeFileSync(join(rootB, 'tracked.txt'), 'line one changed\n');

  await openSession(page, { path: rootB });
  await page.click('.topbar__logo');
  if (await page.isVisible('.right')) {
    await page.keyboard.press('Control+Shift+E');
    await page.waitForSelector('.right', { state: 'detached', timeout: 8000 });
  }
  await page.keyboard.press('Control+Shift+R');
  await page.waitForSelector('.right', { state: 'visible', timeout: 15000 });
  await page.waitForFunction(
    () => document.querySelectorAll('.right .review__navrow').length > 0,
    null,
    { timeout: 15000 },
  );

  const navRow = page.locator('.right .review__navrow').first();
  await navRow.hover();
  const discardBtn = navRow.locator('.change__action', { hasText: /^Discard$/ });
  await discardBtn.waitFor({ state: 'visible', timeout: 5000 });
  await discardBtn.click();
  await page.locator('.confirm').first().waitFor({ state: 'visible', timeout: 5000 });

  const viewport6 = await page.evaluate(() => ({
    w: document.documentElement.clientWidth,
    h: document.documentElement.clientHeight,
  }));
  const geo6 = await backdropGeometry(page, '.modal__backdrop');
  assert(geo6, '(6) .modal__backdrop must be present for the Discard confirm');
  assert(
    geo6.parentIsBody,
    `(6) the Discard confirm backdrop must be a direct child of body — measured ${JSON.stringify(geo6)}`,
  );
  assert(
    closeTo(geo6.rect.w, viewport6.w, 2) && closeTo(geo6.rect.h, viewport6.h, 2),
    `(6) backdrop rect ${JSON.stringify(geo6.rect)} must equal the viewport ${JSON.stringify(viewport6)}`,
  );
  log(
    `(6) Discard confirm backdrop fills the viewport (${geo6.rect.w}x${geo6.rect.h}), parent body ✓`,
  );
  await page.keyboard.press('Escape');
  await page.locator('.confirm').first().waitFor({ state: 'detached', timeout: 5000 });
});
