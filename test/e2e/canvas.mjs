/**
 * Read back what monaco actually painted on a `<canvas>`.
 *
 * The overview ruler, the minimap decorations layer and the split diff's two overview rulers are
 * all canvases: there is no DOM under them to assert, and a screenshot would only prove that some
 * pixels are coloured. `getImageData` in-page is the only way to say "three marks, nine device px
 * wide, at three distinct heights".
 *
 * `sampleCanvas` is written to be handed straight to `page.evaluate` — it closes over nothing.
 */

/**
 * @param {{ selector: string, index?: number }} arg
 * @returns per-colour groups (x extent, pixel count, contiguous y runs) with the dominant colour
 *   treated as background. Alpha is part of a colour's identity: monaco paints an Inline minimap
 *   decoration's line highlight at 50%, so the same token appears twice at different alphas.
 */
export const sampleCanvas = ({ selector, index = 0 }) => {
  const el = document.querySelectorAll(selector)[index];
  if (!el) return { error: `no ${selector}[${index}]` };
  const rect = el.getBoundingClientRect();
  const img = el.getContext('2d').getImageData(0, 0, el.width, el.height);
  const counts = new Map();
  const ys = new Map();
  const xs = new Map();
  for (let y = 0; y < el.height; y++) {
    for (let x = 0; x < el.width; x++) {
      const i = (y * el.width + x) * 4;
      const k = `${img.data[i]},${img.data[i + 1]},${img.data[i + 2]},${img.data[i + 3]}`;
      counts.set(k, (counts.get(k) ?? 0) + 1);
      // Fully transparent pixels count towards the background — the minimap's decorations layer
      // is almost entirely transparent, so leaving them out would make the MARK the background.
      if (img.data[i + 3] === 0) continue;
      if (!ys.has(k)) ys.set(k, new Set());
      ys.get(k).add(y);
      const b = xs.get(k) ?? [1e9, -1];
      xs.set(k, [Math.min(b[0], x), Math.max(b[1], x)]);
    }
  }
  const bg = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  const runsOf = (set) => {
    const sorted = [...set].sort((a, b) => a - b);
    const out = [];
    let start = sorted[0];
    let prev = sorted[0];
    for (const y of sorted.slice(1)) {
      if (y === prev + 1) {
        prev = y;
        continue;
      }
      out.push([start, prev]);
      start = y;
      prev = y;
    }
    if (sorted.length) out.push([start, prev]);
    return out;
  };
  return {
    cssWidth: rect.width,
    cssHeight: rect.height,
    deviceWidth: el.width,
    deviceHeight: el.height,
    dpr: window.devicePixelRatio,
    background: bg,
    groups: [...counts.entries()]
      .filter(([k]) => k !== bg && ys.has(k))
      .map(([k, n]) => ({
        color: k,
        pixels: n,
        xFrom: xs.get(k)[0],
        xTo: xs.get(k)[1],
        widthDevicePx: xs.get(k)[1] - xs.get(k)[0] + 1,
        runs: runsOf(ys.get(k)),
      })),
  };
};

/** A canvas group's colour matches `rgb` within `tol` per channel, alpha ignored. */
export const groupMatches = (group, rgb, tol = 2) =>
  group.color
    .split(',')
    .slice(0, 3)
    .map(Number)
    .every((v, i) => Math.abs(v - rgb[i]) <= tol);

/** The rgb triple a CSS custom property resolves to, on the live page. */
export const tokenRgb = (page, name) =>
  page.evaluate((n) => {
    const probe = document.createElement('span');
    probe.style.color = `var(${n})`;
    document.body.appendChild(probe);
    const v = getComputedStyle(probe).color;
    probe.remove();
    return v
      .match(/[\d.]+/g)
      .slice(0, 3)
      .map(Number);
  }, name);
