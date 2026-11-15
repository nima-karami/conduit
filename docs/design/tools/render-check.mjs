// render-check.mjs — render a page and run the mechanical visual checks.
// Usage: node render-check.mjs <page.html|url> <outDir> [--wait=ms]
// Needs playwright-core and a Chrome/Chromium binary (see tools.md). Always headless.
// Writes, per width (desktop 1280, phone 390) and theme (light, dark):
//   <width>-<theme>-page.png, <width>-<theme>-visual-N.png, and metrics.json.
// Exit code 1 if any check fails, so it can gate a delivery.

import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright-core';

const args = process.argv.slice(2);
const target = args.find((a) => !a.startsWith('--'));
const outDir = args.filter((a) => !a.startsWith('--'))[1];
const wait = Number((args.find((a) => a.startsWith('--wait=')) || '--wait=2500').split('=')[1]);
if (!target || !outDir) {
  console.error('usage: node render-check.mjs <page.html|url> <outDir> [--wait=ms]');
  process.exit(2);
}

const candidates = [
  process.env.CHROME_PATH,
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/snap/bin/chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
].filter(Boolean);
const executablePath = candidates.find((p) => fs.existsSync(p));
if (!executablePath) {
  console.error('No Chrome/Chromium found; set CHROME_PATH.');
  process.exit(2);
}

const url = /^https?:|^file:/.test(target) ? target : 'file://' + path.resolve(target);
const MIN = { desktop: 12, phone: 10 };
fs.mkdirSync(outDir, { recursive: true });
const browser = await chromium.launch({ executablePath, headless: true });
const report = {},
  failures = [];

for (const [width, px] of [
  ['desktop', 1280],
  ['phone', 390],
]) {
  for (const theme of ['light', 'dark']) {
    const key = `${width}-${theme}`;
    const page = await browser.newPage({
      viewport: { width: px, height: 900 },
      deviceScaleFactor: 1,
      colorScheme: theme,
    });
    await page.goto(url);
    await page.waitForTimeout(wait);
    await page.screenshot({ path: `${outDir}/${key}-page.png`, fullPage: true });
    const m = await page.evaluate(() => {
      const visuals = [...document.querySelectorAll('svg, canvas, img, video')].filter((el) => {
        const r = el.getBoundingClientRect();
        return r.width > 120 && r.height > 80 && !el.parentElement.closest('svg');
      });
      const inside = (a, b) =>
        a.left >= b.left && a.right <= b.right && a.top >= b.top && a.bottom <= b.bottom;
      return {
        pageOverflow: document.documentElement.scrollWidth > window.innerWidth + 1,
        visuals: visuals.map((el, i) => {
          el.setAttribute('data-rc', i);
          const box = el.getBoundingClientRect();
          // A visual inside a sideways-scroll or zoom container may extend past the viewport on purpose.
          const zoom = !!el.closest('.zoom');
          let visibleFrac = 1;
          for (let p = el.parentElement; p; p = p.parentElement) {
            const s = getComputedStyle(p);
            if (/(auto|scroll)/.test(s.overflowX) && p.scrollWidth > p.clientWidth + 1) {
              visibleFrac = p.clientWidth / box.width;
              break;
            }
          }
          const labels = [
            ...el.querySelectorAll('text, foreignObject div, foreignObject span, foreignObject p'),
          ]
            .filter((t) => t.textContent.trim() && !t.querySelector('text, div, span, p'))
            .map((t) => ({ t: t.textContent.trim().slice(0, 40), r: t.getBoundingClientRect() }))
            .filter((x) => x.r.width > 0 && x.r.height > 0);
          const overlaps = [];
          for (let a = 0; a < labels.length; a++)
            for (let b = a + 1; b < labels.length; b++) {
              const A = labels[a].r,
                B = labels[b].r;
              const ix = Math.min(A.right, B.right) - Math.max(A.left, B.left);
              const iy = Math.min(A.bottom, B.bottom) - Math.max(A.top, B.top);
              if (ix > 2 && iy > 2 && !inside(A, B) && !inside(B, A))
                overlaps.push(`${labels[a].t} × ${labels[b].t}`);
            }
          const clipped = labels
            .filter(
              (x) =>
                !inside(x.r, {
                  left: box.left - 1,
                  right: box.right + 1,
                  top: box.top - 1,
                  bottom: box.bottom + 1,
                }),
            )
            .map((x) => x.t);
          const hs = labels.map((x) => x.r.height);
          return {
            i,
            tag: el.tagName.toLowerCase(),
            width: Math.round(box.width),
            height: Math.round(box.height),
            zoom,
            visibleFrac: Math.round(Math.min(1, visibleFrac) * 100) / 100,
            labels: labels.length,
            minLabelPx: hs.length ? Math.round(Math.min(...hs) * 10) / 10 : null,
            overlaps: overlaps.slice(0, 10),
            overlapCount: overlaps.length,
            clipped: clipped.slice(0, 10),
          };
        }),
      };
    });
    for (const v of m.visuals) {
      const el = await page.$(`[data-rc="${v.i}"]`);
      try {
        await el.screenshot({ path: `${outDir}/${key}-visual-${v.i}.png` });
      } catch {
        /* off-screen or zero-size */
      }
      if (theme !== 'light') continue; // label geometry doesn't change with theme; check once per width
      if (!v.zoom && v.visibleFrac < 0.8)
        failures.push(
          `${width} visual ${v.i}: only ${Math.round(v.visibleFrac * 100)}% in view; it scrolls sideways (reorient, add zoom, or split)`,
        );
      if (v.minLabelPx !== null && v.minLabelPx < MIN[width] && !v.zoom)
        failures.push(`${width} visual ${v.i}: smallest label ${v.minLabelPx}px < ${MIN[width]}px`);
      if (v.overlapCount)
        failures.push(
          `${width} visual ${v.i}: ${v.overlapCount} overlapping label pair(s), e.g. ${v.overlaps[0]}`,
        );
      if (v.clipped.length)
        failures.push(`${width} visual ${v.i}: clipped label(s): ${v.clipped.join(', ')}`);
    }
    if (theme === 'light' && m.pageOverflow && width === 'phone')
      failures.push('phone: page scrolls sideways');
    report[key] = m;
    await page.close();
  }
}
await browser.close();
report.failures = failures;
fs.writeFileSync(`${outDir}/metrics.json`, JSON.stringify(report, null, 2));
console.log(failures.length ? 'FAIL\n- ' + failures.join('\n- ') : 'PASS: no mechanical failures');
console.log(
  `Screenshots and metrics.json in ${outDir}. Now review the images and run the cold read.`,
);
process.exit(failures.length ? 1 : 0);
