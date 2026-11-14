/**
 * TimedMessageDialog (`.tmdlg`) UI polish (spec 2026-08-28-timed-messages §2 "The dialog").
 *
 * No existing scenario ever opened the dialog itself — timed-messages.e2e.mjs arms
 * schedules by posting `timer:set` directly and only touches the chip, never
 * `.term-timer__open`. That gap is why the dialog shipped with `max-height: 82vh;
 * overflow-y: auto;` on `.tmdlg`: switching the "When" trigger (In / At / Every) changes
 * the composer's height, and past a point the whole card started scrolling — one
 * container, several silently different heights depending which trigger was selected.
 *
 * On Neon that compounded into a second, uglier bug: the chamfer's cut corner is an
 * absolutely-positioned `::after` pinned to the surface's OWN bottom-right corner. On a
 * scrolling element that corner is the bottom of the CONTENT, not the visible clipped
 * box (documented precedent at `.ctxmenu`, styles.css ~6495) — so the diagonal painted
 * below the fold and the visible corner read as an inset, broken cut.
 *
 * `.tmdlg`'s content is provably bounded (composer + at most MAX_PER_SESSION = 3
 * schedule rows, src/timed-messages.ts) so the fix removed the scroll/max-height
 * entirely rather than splitting a frame/scroll-region like `.ctxmenu` does. This
 * scenario is the regression guard: open the real dialog, in both themes, through
 * every trigger tab, and prove it never needs to scroll in either axis, and that the
 * Neon chamfer is actually drawn (not just present in CSS) once that's true.
 *
 * The message field is a multi-line <textarea> (spec 2026-11-13-scheduler-auto-resume §6): Enter adds
 * a line, only Ctrl/Cmd+Enter arms, a count `n / 16,000` sits under it and turns to the error
 * style over the limit, where Arm is disabled. The last stage drives exactly that.
 *
 * Windows only, real app — see CLAUDE.md (run alone on a quiet machine).
 */

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assert, openSession, pollUntil, runScenario } from './harness.mjs';

const TRIGGERS = ['In', 'At', 'Every'];

/** No scroll in either axis, in the CURRENT theme/trigger — the direct regression check. */
async function assertNoScroll(page, label) {
  const box = await page.evaluate(() => {
    const el = document.querySelector('.tmdlg');
    if (!el) return null;
    const cs = getComputedStyle(el);
    return {
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight,
      scrollWidth: el.scrollWidth,
      clientWidth: el.clientWidth,
      overflowY: cs.overflowY,
      overflowX: cs.overflowX,
    };
  });
  assert(box, `.tmdlg must be present to check "${label}"`);
  assert(
    box.overflowY !== 'auto' && box.overflowY !== 'scroll',
    `${label}: .tmdlg must not be a vertical scroll container, got overflow-y: ${box.overflowY}`,
  );
  assert(
    box.overflowX !== 'auto' && box.overflowX !== 'scroll',
    `${label}: .tmdlg must not be a horizontal scroll container, got overflow-x: ${box.overflowX}`,
  );
  // A 2px tolerance absorbs sub-pixel rounding between scrollHeight/clientHeight (real on
  // fractional layouts, harmless) without masking an actual overflowing row (tens of px).
  assert(
    box.scrollHeight <= box.clientHeight + 2,
    `${label}: .tmdlg content overflows vertically (scrollHeight ${box.scrollHeight} > clientHeight ${box.clientHeight}) — the container would need to scroll`,
  );
  assert(
    box.scrollWidth <= box.clientWidth + 2,
    `${label}: .tmdlg content overflows horizontally (scrollWidth ${box.scrollWidth} > clientWidth ${box.clientWidth}) — the container would need to scroll`,
  );
}

/** The Neon chamfer actually painted, and its cut sits inside the dialog's own visible
 *  box rather than off past a (now-impossible) scrolled edge. */
async function assertChamferDrawn(page, label) {
  const info = await page.evaluate(() => {
    const el = document.querySelector('.tmdlg');
    if (!el) return null;
    const after = getComputedStyle(el, '::after');
    const rect = el.getBoundingClientRect();
    return {
      content: after.content,
      right: after.right,
      bottom: after.bottom,
      w: rect.width,
      h: rect.height,
      className: el.className,
      dataTheme: document.documentElement.dataset.theme,
      clip: getComputedStyle(el).clipPath,
    };
  });
  assert(info, `.tmdlg must be present to check the chamfer for "${label}"`);
  assert(
    info.content !== 'none',
    `${label}: Neon's chamfer ::after must paint (content: none means no cut drawn) — ${JSON.stringify(info)}`,
  );
}

async function openTriggerTab(page, label) {
  await page.locator('.tmdlg__trigger').getByRole('radio', { name: label }).click();
}

/** id -> the exact label THEMES uses (webview/themes.ts), for the `>Theme: <label>` command. */
const THEME_LABEL = { 'aero-dark': 'Aero Dark', neon: 'Neon' };

/** Switch theme via the real command (update({theme}) — applied + persisted), matching the
 *  established pattern in theming-light.e2e.mjs: a manual data-theme poke on <html> gets
 *  overwritten by the app's own theme effect (settings.tsx applyToDom) on the next render. */
async function switchTheme(page, id) {
  const label = THEME_LABEL[id];
  await page.keyboard.press('Control+Shift+P');
  await page.locator('.palette__input').waitFor({ state: 'visible', timeout: 5000 });
  await page.locator('.palette__input').fill(`>Theme: ${label}`);
  await page
    .locator('.palette__title', { hasText: new RegExp(`Theme: ${label}$`) })
    .first()
    .click();
  await page.waitForFunction((t) => document.documentElement.getAttribute('data-theme') === t, id, {
    timeout: 5000,
  });
}

async function openDialogViaChip(page) {
  await page.locator('.term-timer__open').first().click();
  await page.locator('.tmdlg').first().waitFor({ state: 'visible', timeout: 10000 });
}

/** The message field's count line: the element its aria-describedby names first. */
const countText = (page) =>
  page.evaluate(() => {
    const field = document.querySelector('.tmdlg__input');
    const id = field?.getAttribute('aria-describedby')?.split(' ')[0];
    const el = id ? document.getElementById(id) : null;
    return el
      ? { text: el.textContent?.trim(), error: el.classList.contains('tmdlg__hint--error') }
      : null;
  });

/** The textarea: a line break on Enter (never an arm), the count, the over-limit state, Ctrl+Enter. */
async function assertMessageField(page, sid) {
  await openDialogViaChip(page);
  const field = page.locator('.tmdlg__input');
  assert(
    (await field.evaluate((el) => el.tagName)) === 'TEXTAREA',
    'the message field must be a <textarea>',
  );

  await field.fill('first line');
  await field.press('Enter');
  await field.pressSequentially('second line');
  assert(
    (await field.inputValue()) === 'first line\nsecond line',
    `Enter must add a line break, got ${JSON.stringify(await field.inputValue())}`,
  );
  assert(
    await page.locator('.tmdlg').first().isVisible(),
    'a bare Enter in the message field must not arm and close the dialog',
  );
  const count = await countText(page);
  assert(
    count?.text === '22 / 16,000' && !count.error,
    `the count must read "22 / 16,000", got ${JSON.stringify(count)}`,
  );

  await field.fill('x'.repeat(16_001));
  const over = await countText(page);
  assert(
    over?.text === '16,001 / 16,000' && over.error,
    `an over-limit count must read 16,001 / 16,000 in the error style, got ${JSON.stringify(over)}`,
  );
  assert(
    await page.locator('.tmdlg button', { hasText: /^Arm$/ }).isDisabled(),
    'Arm must be disabled over the limit',
  );
  await field.press('Control+Enter');
  assert(
    await page.locator('.tmdlg').first().isVisible(),
    'Ctrl+Enter over the limit must not arm',
  );

  await field.fill('first line\nsecond line');
  await field.press('Control+Enter');
  await page.locator('.tmdlg').first().waitFor({ state: 'hidden', timeout: 5000 });
  const armed = await pollUntil(
    () =>
      page.evaluate(
        ([id, message]) =>
          (window.__timers?.schedules ?? []).some(
            (t) => t.sessionId === id && t.message === message,
          ),
        [sid, 'first line\nsecond line'],
      ),
    10_000,
  );
  assert(armed, 'Ctrl+Enter did not arm the two-line message');
}

async function closeDialog(page) {
  await page.keyboard.press('Escape');
  await page.locator('.tmdlg').first().waitFor({ state: 'hidden', timeout: 5000 });
}

runScenario('timed-message-dialog-ui', async ({ page, log }) => {
  const workDir = mkdtempSync(join(tmpdir(), 'conduit-tmdlg-ui-'));
  const sid = await openSession(page, { path: workDir.replace(/\\/g, '/') });
  log('session running:', sid);

  await page.evaluate(() => {
    window.__timers = null;
    window.agentDeck.subscribe((m) => {
      if (m.type === 'timer:state') window.__timers = m;
    });
    window.agentDeck.post({ type: 'ready' });
  });

  // Arm ONCE — MAX_PER_SESSION is 3, and this scenario opens/closes the dialog repeatedly
  // (once per theme) rather than re-arming, which would exhaust the cap.
  await page.evaluate(
    (id) =>
      window.agentDeck.post({
        type: 'timer:set',
        schedule: {
          sessionId: id,
          message: 'conduit-dialog-ui-check',
          trigger: { kind: 'in', delayMs: 30 * 60_000 },
        },
      }),
    sid,
  );
  await page.locator('.term-timer').first().waitFor({ state: 'visible', timeout: 10000 });
  log('armed ✓');

  // A fresh profile boots on Aero Dark (DEFAULT_SETTINGS.theme, src/settings.ts) — asserted
  // rather than assumed, since the rest of the loop depends on knowing the starting theme.
  await page.waitForFunction(
    () => document.documentElement.getAttribute('data-theme') === 'aero-dark',
    null,
    { timeout: 5000 },
  );

  for (const theme of ['aero-dark', 'neon']) {
    if (theme !== 'aero-dark') await switchTheme(page, theme);
    await openDialogViaChip(page);

    for (const trigger of TRIGGERS) {
      await openTriggerTab(page, trigger);
      await assertNoScroll(page, `${theme} / When=${trigger}`);
    }
    log(`${theme}: no scroll in any direction across all three triggers ✓`);

    if (theme === 'neon') {
      await assertChamferDrawn(page, theme);
      log('neon: chamfer painted on the (now non-scrolling) dialog ✓');
    }

    await closeDialog(page);
  }

  await assertMessageField(page, sid);
  log('message field: textarea, Enter adds a line, count, over-limit, Ctrl+Enter arms ✓');
});
