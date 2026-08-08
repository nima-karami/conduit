// Pure string normalisation of a rendered SVG's ROOT tag, kept out of the component so
// the parsing is unit-testable (mirrors svg-viewbox.ts / image-zoom.ts).

/** Index of the `>` that closes the tag starting at `start`, ignoring `>` inside a
 *  quoted attribute value. -1 when the tag is unterminated. */
function tagEnd(html: string, start: number): number {
  let quote: string | null = null;
  for (let i = start; i < html.length; i++) {
    const c = html[i];
    if (quote) {
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") quote = c;
    else if (c === '>') return i;
  }
  return -1;
}

// Whole `width=` / `height=` attributes only: the leading \s guard is what keeps
// `stroke-width` / `data-height` (and `max-width` inside a style value) out of it.
const SIZE_ATTR = /\s+(?:width|height)\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'>/]+)/gi;
const STYLE_ATTR = /(\s+style\s*=\s*)(?:"([^"]*)"|'([^']*)')/i;

/**
 * Root `<svg>` only. Body untouched. No-op when neither max-width nor width/height present.
 *
 * Mermaid emits a root `<svg width="100%" height="Npx" style="max-width: Npx">`; the inline
 * max-width beats any stylesheet rule, so the SVG stays clamped at its intrinsic width while
 * its container grows (spec §2 D5/D1). Stripping those three lets the SVG fill whatever box
 * the zoom overlay sizes for it, independent of the mermaid version.
 */
export function normalizeSvgForZoom(svgHtml: string): string {
  const open = svgHtml.search(/<svg[\s/>]/i);
  if (open < 0) return svgHtml;
  const close = tagEnd(svgHtml, open);
  if (close < 0) return svgHtml;

  const tag = svgHtml.slice(open, close + 1);
  let next = tag.replace(SIZE_ATTR, '');

  const style = STYLE_ATTR.exec(next);
  if (style) {
    const quote = style[2] !== undefined ? '"' : "'";
    const value = style[2] ?? style[3] ?? '';
    const kept = value
      .split(';')
      .filter((d) => d.trim() !== '' && !/^\s*max-width\s*:/i.test(d))
      .map((d) => d.trim());
    if (kept.length !== value.split(';').filter((d) => d.trim() !== '').length) {
      const replacement = kept.length ? `${style[1]}${quote}${kept.join('; ')}${quote}` : '';
      next = next.slice(0, style.index) + replacement + next.slice(style.index + style[0].length);
    }
  }

  return next === tag ? svgHtml : svgHtml.slice(0, open) + next + svgHtml.slice(close + 1);
}
