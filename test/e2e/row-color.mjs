/**
 * Composited colour of a Review diff row, read off the live DOM.
 *
 * The trap this exists to avoid: `.rline--add`'s background is a 13-15% wash, and the element it
 * washes is NOT its own parent. `.rhunk__lines` paints nothing; the surface is `.rhunks.inkbox`,
 * whose background is stated in `color(srgb …)` form, which a naive `rgb()` regex silently drops —
 * landing the measurement on `.rcard`'s `--panel` instead and inventing a ratio that no pixel has.
 * So the probe walks ancestors, understands both colour syntaxes, and composites every
 * translucent layer down to the first opaque one.
 *
 * Note also that `--code-bg` follows the SETTINGS' surfaceColor, not `--code-base`: poking
 * `data-theme` onto <html> moves the theme tokens but leaves the diff surface where the profile
 * booted it. Anything per-theme has to boot on that theme (see `review-row-pixels`).
 */

/** Installs `window.__conduitRowProbe(cardEl)`. Idempotent. */
export async function installRowProbe(page) {
  await page.evaluate(() => {
    if (window.__conduitRowProbe) return;
    const parse = (c) => {
      if (!c) return null;
      const rgb = /rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:[\s,/]+([\d.]+))?/.exec(c);
      if (rgb) return { r: +rgb[1], g: +rgb[2], b: +rgb[3], a: rgb[4] === undefined ? 1 : +rgb[4] };
      // Chromium serialises color-mix()/oklch() results as `color(srgb r g b / a)`, 0-1 floats.
      const fn = /color\(srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)(?:\s*\/\s*([\d.]+))?/.exec(c);
      if (fn)
        return {
          r: +fn[1] * 255,
          g: +fn[2] * 255,
          b: +fn[3] * 255,
          a: fn[4] === undefined ? 1 : +fn[4],
        };
      return null;
    };
    const over = (fg, bg) => ({
      r: fg.r * fg.a + bg.r * (1 - fg.a),
      g: fg.g * fg.a + bg.g * (1 - fg.a),
      b: fg.b * fg.a + bg.b * (1 - fg.a),
      a: 1,
    });
    const effectiveBg = (el) => {
      const stack = [];
      for (let n = el; n; n = n.parentElement) {
        const c = parse(getComputedStyle(n).backgroundColor);
        if (!c || c.a === 0) continue;
        stack.push(c);
        if (c.a >= 1) break;
      }
      let out = stack.pop() ?? { r: 0, g: 0, b: 0, a: 1 };
      while (stack.length) out = over(stack.pop(), out);
      return out;
    };
    const rawToken = (scope, name) => {
      const probe = document.createElement('span');
      probe.style.color = `var(${name})`;
      scope.appendChild(probe);
      const v = getComputedStyle(probe).color;
      probe.remove();
      return v;
    };
    window.__conduitRowProbe = (card) => ({
      addRow: effectiveBg(card.querySelector('.rline--add')),
      delRow: effectiveBg(card.querySelector('.rline--del')),
      ctxRow: effectiveBg(card.querySelector('.rline--context')),
      changeAdded: rawToken(card, '--change-added'),
      changeDeleted: rawToken(card, '--change-deleted'),
      marker: rawToken(card, '--diff-marker'),
    });
  });
}

const luminance = ({ r, g, b }) => {
  const f = (v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
};

/** WCAG contrast between two `{r,g,b}` (or `[r,g,b]`) colours, to 3 dp. */
export function contrast(a, b) {
  const norm = (c) => (Array.isArray(c) ? { r: c[0], g: c[1], b: c[2] } : c);
  const [hi, lo] = [luminance(norm(a)), luminance(norm(b))].sort((p, q) => q - p);
  return Math.round(((hi + 0.05) / (lo + 0.05)) * 1000) / 1000;
}

export const toHex = (c) => {
  const [r, g, b] = Array.isArray(c) ? c : [c.r, c.g, c.b];
  return `#${[r, g, b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')}`;
};
