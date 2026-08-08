/**
 * Viewer robustness (spec docs/specs/2026-08-08-viewer-robustness.md §5) — real-app proof
 * for the three viewer lanes: the shared pan/zoom core, the mermaid inline + overlay sizing,
 * and the pdf.js worker/fit work.
 *
 * Every defect below is a *rendering* defect — a size, a paint order, a wheel listener's
 * passive flag, or a worker torn down by a document switch. None of them is visible to a
 * unit test: they need a real Chromium laying the content out, the real bundled pdf.worker.js
 * decoding a real file through the host's data-URL transport, and a real mermaid render. So
 * this drives the built app.
 *
 * Thirteen assertions, each guarding one landed fix (pre-fix measurement from the spec's §1
 * flow map, measured against `.autoloop/evidence/viewer-diag.md`):
 *   1. D7 — an oversized image never paints wider than its stage (was 4000px in a 950px stage,
 *      then 10-11 animated intermediate widths).
 *   2. D10 — no "preventDefault inside passive" console error after a wheel (was 15 per run).
 *   3. D8 — an intrinsic-size-less SVG lays out at its natural size (was the 950px stage width
 *      while the readout and pan math used 225x150).
 *   4. D4/D5 — overlay zoom-in actually enlarges the diagram, aspect preserved (the box stayed
 *      pinned at the 948px stage width while the % readout climbed).
 *   5. D6 — overlay fit fills the modal for a small diagram (fill ratio was 0.12).
 *   6. D1/D2 — a very wide inline diagram holds the legibility floor and scrolls (was 0.09x,
 *      a 6-pixel-tall smear that could never scroll).
 *   7. D3 — a parse error leaves no orphan `#dmermaid-*` node in <body>.
 *   8. D11 (critical) — PDF -> PDF switching loads (4 of 5 switches reported a good file as
 *      "corrupt or invalid PDF", because the shared worker went down with the first document).
 *   9. D12 — a landscape PDF opens fitted to width with no horizontal overflow.
 *  10. A3 — `.imgstage__img` transitions opacity only; a transitioned transform is what made
 *      zoom steps and drag-pan lag behind the cursor.
 *  11. C4/N2 — on a floor-scaled diagram the expand affordance is *computed* visible with no
 *      pointer over it (the `domClick` helper below deliberately ignores visibility, so
 *      nothing else in this file can catch it regressing to hover-gated).
 *  12. D11 again, at the acceptance's own count — five consecutive PDF→PDF switches, zero
 *      "could not be opened" notices (assertion 8 only proves the first switch).
 *  13. PD3/D13 — a window resize narrow→wide re-fits, and Fit width's aria-pressed still
 *      matches reality (pre-fix 5 of 5 resizes kept a stale scale under aria-pressed="true").
 *
 * Fixtures are generated here (a hand-encoded PNG via node:zlib, a hand-written PDF with a
 * real xref table) so the scenario owns its corpus and depends on nothing gitignored.
 */

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import { assert, closeApp, openSession, runScenario } from './harness.mjs';

// ──────────────────────────────────────────────────────────────────────────────
// Fixture generation (no dependencies: PNG is hand-encoded, PDF hand-written)
// ──────────────────────────────────────────────────────────────────────────────

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

/** 8-bit RGB PNG in coarse 64px blocks — legible, and compresses to a few KB. */
function encodeBlockyPng(width, height) {
  const stride = width * 3;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    const rowStart = y * (stride + 1);
    raw[rowStart] = 0; // filter type: None
    for (let x = 0; x < width; x++) {
      const o = rowStart + 1 + x * 3;
      raw[o] = (Math.floor(x / 64) * 37) % 256;
      raw[o + 1] = (Math.floor(y / 64) * 53) % 256;
      raw[o + 2] = ((Math.floor(x / 64) + Math.floor(y / 64)) * 29) % 256;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: truecolour
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 6 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** Build a PDF from `pages` = [{ w, h, text }]. ASCII only, so string length == byte
 *  offset and the xref table is exact — pdf.js then takes its normal (non-recovery) path. */
function makePdf(pages) {
  const n = pages.length;
  const fontNum = 3 + n * 2;
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>'];
  const kids = pages.map((_, i) => `${3 + i * 2} 0 R`).join(' ');
  objects.push(`<< /Type /Pages /Kids [${kids}] /Count ${n} >>`);

  pages.forEach((p, i) => {
    const contentNum = 4 + i * 2;
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${p.w} ${p.h}] ` +
        `/Resources << /Font << /F1 ${fontNum} 0 R >> >> /Contents ${contentNum} 0 R >>`,
    );
    const ty = Math.max(36, p.h - 92);
    const body =
      `BT /F1 28 Tf 48 ${ty} Td (${p.text}) Tj ET\n` +
      `1 0 0 RG 4 w 24 24 ${p.w - 48} ${p.h - 48} re S\n`;
    objects.push(`<< /Length ${body.length} >>\nstream\n${body}endstream`);
  });

  objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');

  let out = '%PDF-1.4\n';
  const offsets = [];
  objects.forEach((body, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xrefOffset = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) out += `${String(off).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(out, 'ascii');
}

const fence = (src) => `\`\`\`mermaid\n${src}\n\`\`\`\n`;

/** A left-to-right chain wide enough to fall far past the legibility floor (~9800px). */
function wideChain(count) {
  const lines = ['flowchart LR'];
  for (let i = 0; i < count - 1; i++) lines.push(`  n${i}[Step ${i}] --> n${i + 1}[Step ${i + 1}]`);
  return lines.join('\n');
}

function writeCorpus(root) {
  const w = (name, data) => writeFileSync(join(root, name), data);
  w('img-big.png', encodeBlockyPng(4000, 1200));
  // viewBox but no width/height: Chrome reports a 225x150 concrete size for this 3:2 box.
  w(
    'img-vector.svg',
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 200">\n' +
      '  <rect width="300" height="200" fill="#123"/>\n' +
      '  <circle cx="150" cy="100" r="70" fill="#4af"/>\n' +
      '</svg>\n',
  );
  w('diagram.md', `# diagram\n\n${fence('flowchart TD\n  a[Start] --> b[End]')}`);
  w('wide.md', `# wide\n\n${fence(wideChain(60))}`);
  w(
    'broken.md',
    `# broken\n\n${fence('flowchart TD\n  a[Unclosed --> b{{{\n  ??? not a diagram at all\n  --> -->')}`,
  );
  w('doc-a.pdf', makePdf([{ w: 612, h: 792, text: 'Doc A - portrait Letter' }]));
  w(
    'doc-b.pdf',
    makePdf(
      Array.from({ length: 3 }, (_, i) => ({
        w: 1224,
        h: 792,
        text: `Doc B - landscape ${i + 1}`,
      })),
    ),
  );
}

// ──────────────────────────────────────────────────────────────────────────────
// Page-side helpers
// ──────────────────────────────────────────────────────────────────────────────

const nap = (ms) => new Promise((r) => setTimeout(r, ms));

/** Click a file row by exact basename (DOM click: a row scrolled out of the virtualised
 *  tree still opens), then block until it is the active tab — otherwise a probe reads the
 *  previous document's still-mounted viewer and reports its geometry as this one's. */
async function openFile(page, name) {
  await page.waitForFunction(
    (n) => Array.from(document.querySelectorAll('.filerow__name')).some((e) => e.textContent === n),
    name,
    { timeout: 25000 },
  );
  await page.evaluate((n) => {
    const el = Array.from(document.querySelectorAll('.filerow__name')).find(
      (e) => e.textContent === n,
    );
    el?.closest('.filerow')?.click();
  }, name);
  await page.waitForFunction(
    (n) => document.querySelector('.tab--active span')?.textContent?.trim() === n,
    name,
    { timeout: 25000 },
  );
}

/** DOM-click a selector (React's onClick still fires, and an opacity:0 hover affordance is
 *  still reachable). Returns false when the element is absent. */
const domClick = (page, sel) =>
  page.evaluate((s) => {
    const el = document.querySelector(s);
    if (!el) return false;
    el.click();
    return true;
  }, sel);

/**
 * Sample the rendered `<img>` box on every inline-style write AND every animation frame.
 * The MutationObserver is the load-bearing half: the app runs hidden, so rAF is throttled to
 * ~1fps and a frame series alone can miss the whole first-paint transition. Both callbacks
 * read the live DOM, so a fit applied before paint (in a layout effect, within the same task
 * as the insertion) is already in every sample — while a fit applied after paint, as the
 * pre-fix code did, leaves the natural-size box standing in the insertion sample.
 */
const startSampler = (page) =>
  page.evaluate(() => {
    window.__vrMo?.disconnect();
    window.__vrSamples = [];
    window.__vrStop = false;
    const sample = (why) => {
      const img = document.querySelector('.imgstage__img');
      const stage = document.querySelector('.imgstage__stage');
      if (!img || !stage) return;
      const r = img.getBoundingClientRect();
      window.__vrSamples.push({
        why,
        w: Math.round(r.width * 100) / 100,
        h: Math.round(r.height * 100) / 100,
        stageW: stage.clientWidth,
        stageH: stage.clientHeight,
      });
    };
    window.__vrMo = new MutationObserver((recs) => {
      for (const rec of recs) {
        if (rec.type === 'attributes') {
          if (rec.target instanceof Element && rec.target.matches('.imgstage__img'))
            sample('style');
          continue;
        }
        for (const n of rec.addedNodes) {
          if (!(n instanceof Element)) continue;
          if (n.matches('.imgstage__img') || n.querySelector('.imgstage__img')) sample('added');
        }
      }
    });
    window.__vrMo.observe(document.body, {
      attributes: true,
      attributeFilter: ['style', 'class'],
      subtree: true,
      childList: true,
    });
    const tick = () => {
      if (window.__vrStop) return;
      sample('raf');
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });

const stopSampler = (page) =>
  page.evaluate(() => {
    window.__vrStop = true;
    window.__vrMo?.disconnect();
    return window.__vrSamples || [];
  });

/** Wheel over the centre of `selector`. Returns false when the element has no box. */
async function wheelOver(page, selector, deltaY) {
  const box = await page
    .locator(selector)
    .boundingBox()
    .catch(() => null);
  if (!box) return false;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(0, deltaY);
  await nap(400);
  return true;
}

const probeOverlay = () => {
  const stage = document.querySelector('.mermaid-zoom__stage');
  const svg = document.querySelector('.mermaid-zoom__content svg');
  if (!stage || !svg) return null;
  const r = svg.getBoundingClientRect();
  const vb = (svg.getAttribute('viewBox') || '')
    .trim()
    .split(/[\s,]+/)
    .map(Number);
  return {
    w: Math.round(r.width * 100) / 100,
    h: Math.round(r.height * 100) / 100,
    stageW: stage.clientWidth,
    stageH: stage.clientHeight,
    vbW: vb.length === 4 ? vb[2] : 0,
    vbH: vb.length === 4 ? vb[3] : 0,
    pct: document.querySelector('.mermaid-zoom__pct')?.textContent ?? null,
  };
};

/** Resize the (hidden) window, or just read its width with `width = 0`. setBounds still
 *  applies to a window launched with `show: false`, so the renderer really re-lays out. */
async function resizeWindow(app, width) {
  return app.evaluate(({ BrowserWindow }, w) => {
    const win = BrowserWindow.getAllWindows()[0];
    if (!win) return 0;
    const b = win.getBounds();
    if (w > 0) win.setBounds({ ...b, width: w });
    return win.getBounds().width;
  }, width);
}

/**
 * Wait until the rendered page is narrower than `under` / wider than `over` (CSS px).
 * Waiting on the *outcome* rather than napping is load-bearing: ResizeObserver
 * notifications are delivered on the rendering lifecycle, and the app runs hidden, so that
 * tick can be a second or more behind the layout a forced `clientWidth` read already sees.
 * A fit that never recomputes still fails — this only waits, the assertions judge.
 */
function waitForPageWidth(page, bound) {
  return page
    .waitForFunction(
      (b) => {
        const c = document.querySelector('.pdfview__canvas');
        if (!c) return false;
        const w = Math.round(c.getBoundingClientRect().width);
        return b.under != null ? w < b.under : w > b.over;
      },
      bound,
      { timeout: 20000, polling: 250 },
    )
    .catch(() => {});
}

const probePdf = () => {
  const scroll = document.querySelector('.pdfview__scroll');
  const canvas = document.querySelector('.pdfview__canvas');
  return {
    mounted: !!document.querySelector('.pdfview'),
    pageTotal: document.querySelector('.pdfview__pagetotal')?.textContent?.trim() ?? null,
    canvasWidth: canvas instanceof HTMLCanvasElement ? canvas.width : 0,
    // CSS px, so it is comparable across a resize without the devicePixelRatio factor.
    canvasCssW: canvas ? Math.round(canvas.getBoundingClientRect().width) : 0,
    clientW: scroll?.clientWidth ?? 0,
    scrollW: scroll?.scrollWidth ?? 0,
    fitWidthPressed:
      document
        .querySelector('.pdfview__btn[aria-label="Fit width"]')
        ?.getAttribute('aria-pressed') ?? null,
    notices: Array.from(document.querySelectorAll('.viewer__notice')).map((e) => e.textContent),
  };
};

// ──────────────────────────────────────────────────────────────────────────────
// Scenario
// ──────────────────────────────────────────────────────────────────────────────

runScenario('viewer-robustness', async ({ app, page, log }) => {
  // Collected for the whole run: the passive-listener violation is a console error the
  // browser emits once per wheel gesture, so it can only be counted this way (D10).
  const consoleMsgs = [];
  page.on('console', (m) => consoleMsgs.push(`${m.type()} ${m.text()}`));

  const root = mkdtempSync(join(tmpdir(), 'conduit-viewers-'));
  writeCorpus(root);

  await openSession(page, { path: root.replace(/\\/g, '/') });
  await page.locator('.rtab', { hasText: 'Files' }).click();

  // ── 1. Oversized image: no full-size flash before the fit (D7) ───────────────
  await startSampler(page);
  await openFile(page, 'img-big.png');
  await page.waitForFunction(
    () => {
      const img = document.querySelector('.imgstage__img');
      return img instanceof HTMLImageElement && img.naturalWidth > 0;
    },
    null,
    { timeout: 25000 },
  );
  await nap(600); // let any post-paint shrink land in the series before reading it
  const samples = await stopSampler(page);
  const sized = samples.filter((s) => s.w > 0 && s.stageW > 0);
  assert(
    sized.length > 0,
    'sampler recorded no sized <img> frames — the probe never saw the image',
  );
  const widest = sized.reduce((a, b) => (b.w > a.w ? b : a));
  assert(
    widest.w <= widest.stageW + 1,
    `D7 first-paint flash: the image rendered ${widest.w}px in a ${widest.stageW}px stage ` +
      `(sample "${widest.why}", ${sized.length} samples). A 4000px image must never paint ` +
      'wider than its stage — pre-fix it painted at 4000px and animated down over 10-11 widths.',
  );
  log(
    `PASS 1 (D7): ${sized.length} samples, widest rendered ${widest.w}px in a ${widest.stageW}px stage ✓`,
  );

  // ── 2. Wheel over the stage raises no passive-listener violation (D10) ───────
  const wheeled = await wheelOver(page, '.imgstage__stage', -300);
  assert(wheeled, 'image stage had no bounding box — the wheel gesture never happened');
  const passive = consoleMsgs.filter((t) => /preventDefault inside passive/i.test(t));
  assert(
    passive.length === 0,
    `D10 passive wheel listener: ${passive.length} console error(s) after a wheel over the ` +
      `image stage (first: "${passive[0]}"). The wheel handler must be bound natively with ` +
      "{ passive: false } — pre-fix React's onWheel prop produced 15 of these per run.",
  );
  log('PASS 2 (D10): 0 "preventDefault inside passive" console errors after a wheel gesture ✓');

  // ── 3. Intrinsic-size-less SVG lays out at its natural size (D8/A4) ──────────
  await openFile(page, 'img-vector.svg');
  await page.waitForFunction(
    () => {
      const img = document.querySelector('.imgstage__img');
      return img instanceof HTMLImageElement && img.naturalWidth > 0;
    },
    null,
    { timeout: 20000 },
  );
  const vector = await page.evaluate(() => {
    const img = document.querySelector('.imgstage__img');
    const stage = document.querySelector('.imgstage__stage');
    return {
      layout: { w: img.offsetWidth, h: img.offsetHeight },
      natural: { w: img.naturalWidth, h: img.naturalHeight },
      stageW: stage?.clientWidth ?? 0,
    };
  });
  assert(
    vector.layout.w === vector.natural.w && vector.layout.h === vector.natural.h,
    `D8 unpinned layout box: the <img> laid out at ${vector.layout.w}x${vector.layout.h} for a ` +
      `${vector.natural.w}x${vector.natural.h} SVG. The box must equal the natural size or the ` +
      'zoom readout, the caption and the pan math disagree — pre-fix it was the 950px stage width.',
  );
  assert(
    vector.layout.w < vector.stageW,
    `D8 unpinned layout box: the <img> filled its ${vector.stageW}px stage instead of laying ` +
      `out at its ${vector.natural.w}px natural width.`,
  );
  log(
    `PASS 3 (D8): layout box ${vector.layout.w}x${vector.layout.h} == natural, in a ${vector.stageW}px stage ✓`,
  );

  // ── 10. The image transitions opacity only, never transform (A3) ─────────────
  const imgTransition = await page.evaluate(() => {
    const img = document.querySelector('.imgstage__img');
    if (!img) return null;
    const cs = getComputedStyle(img);
    return { property: cs.transitionProperty, duration: cs.transitionDuration };
  });
  assert(imgTransition, 'the image stage had no <img> to read a computed transition off');
  assert(
    !/\btransform\b|\ball\b/.test(imgTransition.property),
    `A3 transitioned transform: .imgstage__img computes transition-property ` +
      `"${imgTransition.property}" (${imgTransition.duration}). Only opacity may transition — a ` +
      'transitioned transform animated an oversized image down into place and made every ' +
      'drag-pan frame lag the cursor.',
  );
  log(`PASS 10 (A3): transition-property is "${imgTransition.property}", no transform ✓`);

  // ── 4/5. Mermaid zoom overlay: fit fills the modal, and zoom-in enlarges ─────
  await openFile(page, 'diagram.md');
  await page.waitForSelector('.mermaid-diagram__svg svg', { state: 'attached', timeout: 30000 });
  assert(
    await domClick(page, '.mermaid-diagram__expand'),
    'the expand affordance was absent — the zoom overlay could not be opened',
  );
  await page.waitForFunction(
    () => {
      const svg = document.querySelector('.mermaid-zoom__content svg');
      return !!svg && svg.getBoundingClientRect().width > 0;
    },
    null,
    { timeout: 20000 },
  );
  await nap(300);

  const atFit = await page.evaluate(probeOverlay);
  assert(atFit, 'the zoom overlay never rendered an SVG');
  const fill = Math.max(atFit.w / atFit.stageW, atFit.h / atFit.stageH);
  assert(
    fill >= 0.9,
    `D6 fit never upscales: at fit the diagram fills ${fill.toFixed(2)} of the ` +
      `${atFit.stageW}x${atFit.stageH} modal (${atFit.w}x${atFit.h}). A vector diagram must fill ` +
      'the modal on at least one axis — pre-fix a small diagram sat there at a 0.12 fill ratio.',
  );
  log(`PASS 5 (D6): overlay fit fills ${fill.toFixed(2)} of the modal at ${atFit.pct} ✓`);

  const vbAspect = atFit.vbW / atFit.vbH;
  const widths = [atFit.w];
  for (let i = 0; i < 3; i++) {
    assert(
      await domClick(page, '.mermaid-zoom__btn[aria-label="Zoom in"]'),
      'the overlay Zoom in button was absent',
    );
    await nap(350);
    const step = await page.evaluate(probeOverlay);
    assert(step, 'the zoom overlay lost its SVG mid-zoom');
    assert(
      step.w > widths[widths.length - 1] + 0.5,
      `D4 zoom does not enlarge: zoom-in #${i + 1} left the rendered SVG at ${step.w}px ` +
        `(was ${widths[widths.length - 1]}px) while the readout says ${step.pct}. Every step must ` +
        `strictly increase the width — pre-fix the box stayed pinned at the ${step.stageW}px ` +
        'stage width for 4 of 4 steps.',
    );
    const aspectDrift = Math.abs(step.w / step.h / vbAspect - 1);
    assert(
      aspectDrift <= 0.01,
      `D5 aspect stretched: at ${step.pct} the SVG rendered ${step.w}x${step.h} (aspect ` +
        `${(step.w / step.h).toFixed(3)}) against a viewBox aspect of ${vbAspect.toFixed(3)} — ` +
        `${(aspectDrift * 100).toFixed(1)}% drift, over the 1% budget. Pre-fix the box grew on ` +
        'the height axis only while the SVG stayed clamped at its intrinsic width.',
    );
    widths.push(step.w);
  }
  log(`PASS 4 (D4/D5): overlay zoom widths ${widths.map((w) => Math.round(w)).join(' → ')}px ✓`);
  await domClick(page, '.mermaid-zoom__btn[aria-label="Close diagram viewer"]');

  // ── 6. Inline: a very wide diagram holds the floor and scrolls (D1/D2) ───────
  await openFile(page, 'wide.md');
  await page.waitForSelector('.mermaid-diagram__svg svg', { state: 'attached', timeout: 40000 });
  // --mm-w is the fitted size mermaid-scale.ts produced; until it lands the SVG has no size
  // of its own to measure (its width/height attributes are stripped by the normaliser).
  await page.waitForFunction(
    () => {
      const wrap = document.querySelector('.mermaid-diagram__svg');
      return !!wrap && getComputedStyle(wrap).getPropertyValue('--mm-w').trim() !== '';
    },
    null,
    { timeout: 20000 },
  );
  const inline = await page.evaluate(() => {
    const wrap = document.querySelector('.mermaid-diagram__svg');
    const svg = wrap.querySelector('svg');
    const r = svg.getBoundingClientRect();
    const vb = (svg.getAttribute('viewBox') || '')
      .trim()
      .split(/[\s,]+/)
      .map(Number);
    return {
      w: Math.round(r.width * 100) / 100,
      h: Math.round(r.height * 100) / 100,
      vbW: vb.length === 4 ? vb[2] : 0,
      vbH: vb.length === 4 ? vb[3] : 0,
      clientW: wrap.clientWidth,
      scrollW: wrap.scrollWidth,
    };
  });
  const scale = inline.w / inline.vbW;
  assert(
    inline.vbW > 2000,
    `fixture drift: the wide diagram rendered only ${inline.vbW}px wide, too narrow to reach ` +
      'the legibility floor — the assertion below would prove nothing',
  );
  assert(
    scale >= 0.349,
    `D1 below the legibility floor: the diagram rendered at ${scale.toFixed(3)}x ` +
      `(${inline.w}x${inline.h} from a ${inline.vbW}x${inline.vbH} viewBox). The floor is 0.35 — ` +
      'pre-fix a 9820x70 diagram was squeezed to 0.09x, a 6-pixel-tall smear.',
  );
  assert(
    inline.scrollW > inline.clientW,
    `D2 dead scroll escape: the wrapper is ${inline.scrollW}px wide inside ${inline.clientW}px, ` +
      'so it never scrolls. A diagram held at the floor must overflow its wrapper and scroll — ' +
      'pre-fix the SVG was capped at 100% of the column so scrollWidth could never exceed it.',
  );
  log(
    `PASS 6 (D1/D2): inline scale ${scale.toFixed(3)}x, wrapper scrolls (${inline.scrollW} > ${inline.clientW}) ✓`,
  );

  // ── 11. The escape hatch off a floor-scaled diagram is actually visible (C4/N2) ──
  // Park the pointer in the corner first: the whole defect is that the affordance used to
  // exist only under :hover, and a stray hover would hide the regression.
  await page.mouse.move(2, 2);
  // The 0.12s opacity transition is driven by the frame clock, and the app runs hidden, so
  // rAF is throttled to ~1fps — poll on a timer rather than napping a fixed (frame-less)
  // 300ms. A genuine regression still fails: this only waits, the assertion below judges.
  await page
    .waitForFunction(
      () => {
        const el = document.querySelector('.mermaid-diagram__expand');
        return !!el && Number(getComputedStyle(el).opacity) >= 0.99;
      },
      null,
      { timeout: 10000, polling: 250 },
    )
    .catch(() => {});
  const affordance = await page.evaluate(() => {
    const btn = document.querySelector('.mermaid-diagram__expand');
    if (!btn) return null;
    const cs = getComputedStyle(btn);
    const r = btn.getBoundingClientRect();
    return {
      opacity: Number(cs.opacity),
      pointerEvents: cs.pointerEvents,
      visibility: cs.visibility,
      display: cs.display,
      w: Math.round(r.width),
      h: Math.round(r.height),
      hovered: btn.matches(':hover'),
      constrained: !!document.querySelector('.mermaid-diagram--constrained'),
    };
  });
  assert(affordance, 'the floor-scaled diagram rendered no expand affordance at all');
  assert(
    !affordance.hovered,
    'the pointer was still over the expand button — this assertion only means something ' +
      'with the pointer away from it',
  );
  assert(
    affordance.constrained,
    'the diagram is not marked constrained, so C4 would not apply — the fixture or the ' +
      'scale rule drifted',
  );
  assert(
    affordance.opacity >= 0.99 &&
      affordance.pointerEvents !== 'none' &&
      affordance.visibility === 'visible' &&
      affordance.display !== 'none' &&
      affordance.w > 0 &&
      affordance.h > 0,
    `C4/N2 hidden escape hatch: with no pointer over the diagram the expand button computes ` +
      `opacity ${affordance.opacity}, pointer-events ${affordance.pointerEvents}, visibility ` +
      `${affordance.visibility}, box ${affordance.w}x${affordance.h}. A diagram held at the ` +
      'legibility floor can only be read in the overlay, so its way there must not be a hover ' +
      'secret — pre-fix it was opacity: 0; pointer-events: none until :hover.',
  );
  log(
    `PASS 11 (C4/N2): expand button computed visible unhovered (opacity ${affordance.opacity}, ${affordance.w}x${affordance.h}) ✓`,
  );

  // ── 7. Parse error leaves no orphan temp node (D3) ───────────────────────────
  await openFile(page, 'broken.md');
  await page.waitForSelector('.mermaid-error', { state: 'visible', timeout: 30000 });
  const orphans = await page.evaluate(() => ({
    count: document.querySelectorAll('[id^="dmermaid-"]').length,
    errorShown: !!document.querySelector('.mermaid-error'),
  }));
  assert(orphans.errorShown, 'the mermaid parse-error card was not displayed');
  assert(
    orphans.count === 0,
    `D3 orphan temp node: ${orphans.count} [id^="dmermaid-"] node(s) left in the document while ` +
      'the error card shows. mermaid.render() throws before its own cleanup, so the catch must ' +
      'remove the node — pre-fix one was left behind per failed render.',
  );
  log('PASS 7 (D3): parse error shown, 0 orphan [id^="dmermaid-"] nodes ✓');

  // ── 8/9. PDF -> PDF switching, and fit on open (D11/D12) ─────────────────────
  await openFile(page, 'doc-a.pdf');
  await page.waitForFunction(
    () => {
      const c = document.querySelector('.pdfview__canvas');
      return c instanceof HTMLCanvasElement && c.width > 0;
    },
    null,
    { timeout: 30000 },
  );
  const first = await page.evaluate(probePdf);
  assert(
    /\/\s*1$/.test(first.pageTotal ?? ''),
    `doc-a.pdf did not load in isolation (page total "${first.pageTotal}") — the switch below ` +
      'would prove nothing',
  );
  log(`doc-a.pdf loaded (${first.pageTotal}) — now switching straight to a second document`);

  await openFile(page, 'doc-b.pdf');
  await page.waitForFunction(
    () => {
      const c = document.querySelector('.pdfview__canvas');
      const total = document.querySelector('.pdfview__pagetotal')?.textContent ?? '';
      return c instanceof HTMLCanvasElement && c.width > 0 && /\/\s*3/.test(total);
    },
    null,
    { timeout: 30000 },
  );
  await nap(600); // let the fit settle as the remaining page sizes stream in
  const second = await page.evaluate(probePdf);
  const corrupt = second.notices.filter((t) => /could not be opened/i.test(t ?? ''));
  assert(
    corrupt.length === 0,
    `D11 shared worker torn down by a document switch: the second PDF reported "${corrupt[0]}". ` +
      'A per-document task.destroy() must not take the shared pdf.js worker with it — pre-fix ' +
      '4 of 5 PDF→PDF switches failed this way on files that load fine in isolation.',
  );
  assert(
    second.canvasWidth > 0 && /\/\s*3$/.test(second.pageTotal ?? ''),
    `D11: the second PDF did not render (canvas ${second.canvasWidth}px, page total ` +
      `"${second.pageTotal}", notices ${JSON.stringify(second.notices)})`,
  );
  log(`PASS 8 (D11): PDF → PDF switch loaded ${second.pageTotal} pages, 0 corruption notices ✓`);

  assert(
    second.fitWidthPressed === 'true',
    `D12 no fit on open: Fit width reads aria-pressed="${second.fitWidthPressed}" on a freshly ` +
      'opened landscape document. It must open fitted, and the toolbar must say so truthfully.',
  );
  assert(
    second.scrollW <= second.clientW + 1,
    `D12 overflow on open: a 1224pt landscape page overflows its ${second.clientW}px viewport ` +
      `(scrollWidth ${second.scrollW}px). Pre-fix the viewer opened at 100% and 3 of 5 documents ` +
      'needed a horizontal scroll immediately.',
  );
  log(
    `PASS 9 (D12): opens fit-to-width (aria-pressed=true), no h-overflow (${second.scrollW} <= ${second.clientW}) ✓`,
  );

  // ── 12. Five consecutive PDF → PDF switches all load (Lane D acceptance) ─────
  // Assertion 8 proves one switch; the acceptance criterion is five, which is what the
  // pre-fix build failed 4 of. doc-a is 1 page and doc-b is 3, so the page total also
  // proves the *new* document rendered rather than the previous one still standing.
  const switches = [];
  for (let i = 0; i < 5; i++) {
    const name = i % 2 === 0 ? 'doc-a.pdf' : 'doc-b.pdf';
    const pages = name === 'doc-a.pdf' ? 1 : 3;
    await openFile(page, name);
    await page
      .waitForFunction(
        (n) => {
          if (document.querySelector('.viewer__notice')) return true;
          const c = document.querySelector('.pdfview__canvas');
          const total = document.querySelector('.pdfview__pagetotal')?.textContent ?? '';
          return c instanceof HTMLCanvasElement && c.width > 0 && total.trim() === `/ ${n}`;
        },
        pages,
        { timeout: 30000 },
      )
      .catch(() => {});
    const state = await page.evaluate(probePdf);
    switches.push({ name, pages, state });
    const failed = state.notices.filter((t) => /could not be opened/i.test(t ?? ''));
    assert(
      failed.length === 0,
      `Lane D acceptance — switch ${i + 1} of 5 (to ${name}) reported "${failed[0]}". Five ` +
        'consecutive PDF→PDF switches must all load; pre-fix 4 of 5 failed this way because the ' +
        'shared pdf.js worker went down with the previous document.',
    );
    assert(
      state.canvasWidth > 0 && (state.pageTotal ?? '') === `/ ${pages}`,
      `Lane D acceptance — switch ${i + 1} of 5 (to ${name}) did not render: canvas ` +
        `${state.canvasWidth}px, page total "${state.pageTotal}" (expected "/ ${pages}"), ` +
        `notices ${JSON.stringify(state.notices)}`,
    );
  }
  log(
    `PASS 12 (D11 ×5): ${switches.map((s) => `${s.name}=${s.state.pageTotal}`).join(', ')}, 0 notices ✓`,
  );

  // ── 13. A window resize re-fits, and aria-pressed keeps telling the truth (PD3/D13) ──
  // The last switch above left doc-a (portrait Letter) open and fitted.
  const beforeResize = await page.evaluate(probePdf);
  const baseWidth = await resizeWindow(app, 0);
  assert(baseWidth > 0, 'could not read the window bounds — the resize never happened');
  // Moderate, on purpose: the side panels do not shrink, so a drastic narrowing starves the
  // PDF pane down past fitScaleForPages' minimum scale, where overflow is expected and the
  // assertion would be measuring the clamp instead of the re-fit.
  await resizeWindow(app, baseWidth - 220);
  await waitForPageWidth(page, { under: beforeResize.canvasCssW });
  const narrow = await page.evaluate(probePdf);
  assert(
    narrow.clientW < beforeResize.clientW,
    `the window resize did not reach the PDF scroll container (${beforeResize.clientW}px → ` +
      `${narrow.clientW}px) — the assertions below would prove nothing`,
  );
  assert(
    narrow.canvasCssW < beforeResize.canvasCssW && narrow.scrollW <= narrow.clientW + 1,
    `D13 stale fit after a resize: narrowing to ${narrow.clientW}px left the page at ` +
      `${narrow.canvasCssW}px (was ${beforeResize.canvasCssW}px in ${beforeResize.clientW}px), ` +
      `scrollWidth ${narrow.scrollW}. An active fit must recompute on a container resize.`,
  );
  assert(
    narrow.fitWidthPressed === 'true',
    `D13 untruthful toolbar: Fit width reads aria-pressed="${narrow.fitWidthPressed}" while the ` +
      'fit is still active after a resize.',
  );

  await resizeWindow(app, baseWidth);
  await waitForPageWidth(page, { over: narrow.canvasCssW });
  const wide = await page.evaluate(probePdf);
  assert(
    wide.clientW > narrow.clientW,
    `widening the window did not reach the PDF scroll container (${narrow.clientW}px → ` +
      `${wide.clientW}px)`,
  );
  assert(
    wide.canvasCssW > narrow.canvasCssW && wide.scrollW <= wide.clientW + 1,
    `D13 fit did not grow back: widening to ${wide.clientW}px left the page at ` +
      `${wide.canvasCssW}px (it was ${narrow.canvasCssW}px in ${narrow.clientW}px), scrollWidth ` +
      `${wide.scrollW}. Pre-fix widening back never restored the scale — the fit was computed ` +
      'once and never again.',
  );
  assert(
    wide.fitWidthPressed === 'true',
    `D13 untruthful toolbar: Fit width reads aria-pressed="${wide.fitWidthPressed}" after ` +
      'widening the window back.',
  );
  log(
    `PASS 13 (PD3/D13): page re-fitted ${beforeResize.canvasCssW} → ${narrow.canvasCssW} → ` +
      `${wide.canvasCssW}px across ${beforeResize.clientW} → ${narrow.clientW} → ${wide.clientW}px, ` +
      'aria-pressed truthful throughout ✓',
  );

  const shotDir = join(process.env.TEMP || tmpdir(), 'claude-scratch');
  mkdirSync(shotDir, { recursive: true });
  await page.screenshot({ path: join(shotDir, 'viewer-robustness.png') }).catch(() => {});

  log('All 13 assertions passed ✓');
  await closeApp(app, page);
});
