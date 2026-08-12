/**
 * theme-first-paint — the persisted theme must be on <html> from the renderer's FIRST commit.
 *
 * The renderer used to boot on DEFAULT_SETTINGS and only learn the real theme when the host's
 * `state` message landed, so every launch on a non-default theme painted Aero Dark first and
 * snapped to the user's theme a beat later (reported as "a flash of another theme on launch").
 * The fix hands the persisted settings to the renderer synchronously (preload → sendSync), so
 * there is never a frame carrying the wrong theme.
 *
 * Real-app only: the whole seam is preload ↔ main, which the mock preview can't exercise.
 * A `page.reload()` re-runs preload + renderer against the live host — the same boot path as a
 * cold launch, and the only one a scenario can instrument from the start (the app is already
 * loaded by the time Playwright hands us the first window).
 *
 * The assertion is a MutationObserver installed before any page script: it records every
 * data-theme the document is given, in order. One entry, 'neon' ⇒ no wrong-theme frame.
 */

import { assert, closeApp, runScenario } from './harness.mjs';

runScenario('theme-first-paint', async ({ app, page, log }) => {
  // Persist Neon over the real settings channel — the same `updateSettings` the Appearance
  // controls send, so the host coerces, writes settings.json and broadcasts it back. (Driving
  // the command palette instead needs keyboard focus, which the hidden E2E window doesn't
  // reliably hold; a manual data-theme poke would just be overwritten by the settings effect.)
  await page.evaluate(
    () =>
      new Promise((resolve) => {
        // Read the live settings off the host's own `state` (re-requested with `ready`) rather
        // than the bridge value under test, so the setup can't lean on what it's asserting.
        const off = window.agentDeck.subscribe((m) => {
          if (m.type !== 'state') return;
          off();
          window.agentDeck.post({
            type: 'updateSettings',
            settings: { ...m.settings, theme: 'neon' },
          });
          resolve();
        });
        window.agentDeck.post({ type: 'ready' });
      }),
  );
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'neon', null, {
    timeout: 10000,
  });
  log('switched to Neon ✓');

  await page.addInitScript(() => {
    window.__themeSeq = [];
    const observe = () => {
      const root = document.documentElement;
      if (root.dataset.theme) window.__themeSeq.push(root.dataset.theme);
      new MutationObserver(() => {
        const t = root.dataset.theme;
        if (t && window.__themeSeq[window.__themeSeq.length - 1] !== t) window.__themeSeq.push(t);
      }).observe(root, { attributes: true, attributeFilter: ['data-theme'] });
    };
    // documentElement exists by the time an init script runs in practice; the fallback keeps
    // the scenario honest (a missed observer would read as a spurious PASS) rather than lucky.
    if (document.documentElement) observe();
    else document.addEventListener('readystatechange', observe, { once: true });
  });

  await page.reload();
  await page.waitForFunction(() => !!window.agentDeck, null, { timeout: 20000 });
  await page.waitForSelector('.topbar', { state: 'attached', timeout: 20000 });
  // Give the host's `state` reply time to land — that is exactly the message the old code
  // waited for, so a regression has fully played out by now.
  await page.waitForTimeout(1500);

  const seq = await page.evaluate(() => window.__themeSeq);
  log(`data-theme sequence after reload: ${JSON.stringify(seq)}`);

  assert(seq.length > 0, 'the observer recorded no data-theme at all — probe did not install');
  assert(
    seq[0] === 'neon',
    `first painted theme must be the persisted one, got "${seq[0]}" (sequence ${JSON.stringify(seq)})`,
  );
  assert(
    seq.every((t) => t === 'neon'),
    `the theme must never change after boot, got ${JSON.stringify(seq)}`,
  );
  log('no wrong-theme frame on boot ✓');

  await closeApp(app, page);
});
