/**
 * Band baseline alignment — the three chrome bands start on the same row, on whole pixels.
 *
 * Two defects this guards, both ~1px and both invisible to a unit test:
 *   1. `.panel` drew its hairline with a real `border`, so the side panels' content began at
 *      Y+1 while the centre tab strip — deliberately not a panel — began at Y+0.
 *   2. `--density-topbar-h` was `band * 1.5` unsnapped, so Compact's 31px band gave a 46.5px
 *      top bar and put every rect in the workbench below it on a half pixel.
 *
 * Density and theme are poked onto <html> rather than driven through Settings: that is exactly
 * what the app's own `applyToDom` does, and its effect only re-runs when the settings object
 * changes — which nothing here does. Layout (what this asserts) recomputes either way.
 */

import { assert, closeApp, runScenario } from './harness.mjs';

const BANDS = ['.sidebar__head', '.tabbar-wrap', '.right__tabs'];
const THEMES = ['aero', 'aero-dark', 'neon'];
const DENSITIES = ['comfortable', 'compact'];

runScenario('band-alignment', async ({ app, page, log }) => {
  await page.waitForSelector('.tabbar-wrap', { state: 'attached', timeout: 20000 });

  for (const theme of THEMES) {
    for (const density of DENSITIES) {
      const probe = await page.evaluate(
        ({ t, d, sels }) => {
          const el = document.documentElement;
          el.dataset.theme = t;
          el.dataset.density = d;
          el.getBoundingClientRect(); // flush the restyle before measuring
          const panel = document.querySelector('.panel--sessions');
          const ring = getComputedStyle(panel, '::after');
          const bar = document.querySelector('.topbar').getBoundingClientRect();
          return {
            topbar: bar.height,
            flush: panel.getBoundingClientRect().top === bar.bottom,
            ringTop: ring.borderTopColor,
            ringLeft: ring.borderLeftColor,
            tops: Object.fromEntries(
              sels.map((s) => [s, document.querySelector(s)?.getBoundingClientRect().top ?? null]),
            ),
          };
        },
        { t: theme, d: density, sels: BANDS },
      );

      const where = `${theme}/${density}`;
      const tops = BANDS.map((s) => probe.tops[s]);
      assert(
        tops.every((t) => t !== null),
        `${where}: a chrome band is missing — got ${JSON.stringify(probe.tops)}`,
      );
      assert(
        new Set(tops).size === 1,
        `${where}: the three chrome bands must start on the same row, got ${JSON.stringify(probe.tops)}`,
      );
      assert(
        Number.isInteger(tops[0]),
        `${where}: the bands must start on a whole pixel, got ${tops[0]}`,
      );
      assert(
        Number.isInteger(probe.topbar),
        `${where}: the top bar must be a whole number of pixels, got ${probe.topbar}`,
      );
      // B-1: a panel flush under the top bar must not redraw that band's bottom border, or the
      // side columns carry a 2px edge against the borderless centre's 1px. Asserted on computed
      // style rather than pixels — a hidden window's cached layers make paint untrustworthy for
      // any theme but the one the profile booted on, while computed style follows the switch.
      const transparent = /rgba\(0, 0, 0, 0\)|transparent/.test(probe.ringTop);
      assert(
        probe.flush ? transparent : !transparent,
        `${where}: a panel ${probe.flush ? 'flush under' : 'gapped from'} the top bar must ${
          probe.flush ? 'suppress' : 'draw'
        } its top edge — got ${probe.ringTop}`,
      );
      assert(
        !/rgba\(0, 0, 0, 0\)|transparent/.test(probe.ringLeft),
        `${where}: only the TOP edge may be suppressed; the ring's left edge went ${probe.ringLeft}`,
      );
      log(`${where}: topbar ${probe.topbar}px, bands at y=${tops[0]}, ring-top ${probe.ringTop} ✓`);
    }
  }

  // Back to the shipped defaults for the paint assertion — a hidden window caches compositor
  // layers, so pixels are only trustworthy for the theme the profile actually started on.
  await page.evaluate(() => {
    document.documentElement.dataset.theme = 'aero-dark';
    document.documentElement.dataset.density = 'comfortable';
  });
  await page.waitForTimeout(600);

  /** The panel's top edge row and the fill two rows in, as [r,g,b]. */
  const topEdge = async () => {
    const r = await page.evaluate(() => {
      const b = document.querySelector('.panel--sessions').getBoundingClientRect();
      return { top: b.top, left: b.left };
    });
    const shot = await page.screenshot();
    return page.evaluate(
      async ({ b64, x, y }) => {
        const img = new Image();
        await new Promise((res, rej) => {
          img.onload = res;
          img.onerror = rej;
          img.src = `data:image/png;base64,${b64}`;
        });
        const cv = document.createElement('canvas');
        cv.width = img.width;
        cv.height = img.height;
        const ctx = cv.getContext('2d', { willReadFrequently: true });
        ctx.drawImage(img, 0, 0);
        const at = (xx, yy) => Array.from(ctx.getImageData(xx, yy, 1, 1).data).slice(0, 3);
        // The accent is a blue-violet: count how much of the edge reads as a blue bias. A
        // count, not one sample — the drop state is DASHED, so any single pixel may be a gap.
        let accent = 0;
        for (let i = 0; i < 120; i++) {
          const p = at(x + i, y);
          if (p[2] - p[0] > 40) accent++;
        }
        return { ring: at(x, y), fill: at(x, y + 2), accent };
      },
      { b64: shot.toString('base64'), x: Math.round(r.left + 60), y: Math.round(r.top) },
    );
  };
  const spread = (s) => Math.max(...s.ring.map((c, i) => Math.abs(c - s.fill[i])));

  // Alignment is cheap to get by deleting the hairline; prove it is still drawn.
  const rest = await topEdge();
  log(`panel top edge ${JSON.stringify(rest.ring)} vs fill ${JSON.stringify(rest.fill)}`);
  assert(
    spread(rest) >= 8,
    `the panel hairline must still be drawn on its top row (ring ${rest.ring} vs fill ${rest.fill})`,
  );
  assert(rest.accent === 0, `an idle panel edge must not read as the accent (${rest.accent}/120)`);

  // The drop state rides that same ring — an inset outline is painted under the panel's opaque
  // fill and never showed.
  await page.evaluate(() => {
    document.querySelector('.panel--sessions').classList.add('panel--droptarget');
  });
  await page.waitForTimeout(600);
  const dropping = await topEdge();
  log(`droptarget edge: ${dropping.accent}/120 px read as the accent`);
  assert(
    dropping.accent >= 30,
    `the drop target must repaint the panel edge in the accent, got ${dropping.accent}/120 px`,
  );

  await closeApp(app, page);
});
