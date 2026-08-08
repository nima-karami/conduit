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

interface RootAttr {
  name: string;
  /** Everything the attribute occupies in the source, INCLUDING the whitespace that
   *  separates it from the one before — so dropping it leaves no doubled space. */
  raw: string;
  /** `raw` up to and including the opening quote, so a rewritten value can be spliced
   *  back in without disturbing the original spacing around `=`. */
  prefix: string;
  /** `"`, `'`, or '' when the value is unquoted or the attribute has none. */
  quote: string;
  value: string;
}

const isSpace = (c: string) => c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f';

/**
 * Split the root tag into its attribute list. Returns null on anything it can't account
 * for, which the caller treats as "leave this markup alone" — a regex over the whole tag
 * instead matches `width=` inside *other* attributes' values (mermaid puts accTitle /
 * accDescr on the root as aria-label / aria-roledescription, so a diagram titled
 * "Bandwidth width=2" lost part of its accessible name).
 */
function parseRootAttrs(tag: string): { attrs: RootAttr[]; trailer: string } | null {
  const attrs: RootAttr[] = [];
  const end = tag.length - 1; // the closing '>'
  let i = '<svg'.length;
  while (i < end) {
    const start = i;
    while (i < end && isSpace(tag[i])) i++;
    if (i >= end || tag[i] === '/') return { attrs, trailer: tag.slice(start) };

    const nameStart = i;
    while (i < end && !isSpace(tag[i]) && tag[i] !== '=' && tag[i] !== '/') i++;
    const name = tag.slice(nameStart, i);
    if (name === '') return null;

    const afterName = i;
    while (i < end && isSpace(tag[i])) i++;
    if (tag[i] !== '=') {
      attrs.push({ name, raw: tag.slice(start, afterName), prefix: '', quote: '', value: '' });
      i = afterName;
      continue;
    }
    i++;
    while (i < end && isSpace(tag[i])) i++;

    const quote = tag[i] === '"' || tag[i] === "'" ? tag[i] : '';
    let value: string;
    if (quote) {
      const valueStart = ++i;
      while (i < end && tag[i] !== quote) i++;
      if (tag[i] !== quote) return null;
      value = tag.slice(valueStart, i);
      i++;
    } else {
      const valueStart = i;
      while (i < end && !isSpace(tag[i]) && tag[i] !== '/') i++;
      value = tag.slice(valueStart, i);
    }
    const raw = tag.slice(start, i);
    attrs.push({
      name,
      raw,
      prefix: raw.slice(0, raw.length - value.length - quote.length),
      quote,
      value,
    });
  }
  return { attrs, trailer: tag.slice(i) };
}

/** Split a declaration list on the semicolons that actually separate declarations —
 *  not the ones inside `url(data:…;base64,…)` or a quoted string. */
function splitDeclarations(value: string): string[] {
  const out: string[] = [];
  let quote: string | null = null;
  let depth = 0;
  let start = 0;
  for (let i = 0; i < value.length; i++) {
    const c = value[i];
    if (quote) {
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") quote = c;
    else if (c === '(') depth++;
    else if (c === ')') depth = Math.max(0, depth - 1);
    else if (c === ';' && depth === 0) {
      out.push(value.slice(start, i));
      start = i + 1;
    }
  }
  out.push(value.slice(start));
  return out;
}

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
  const parsed = parseRootAttrs(tag);
  if (!parsed) return svgHtml;

  let changed = false;
  const kept: string[] = [];
  for (const attr of parsed.attrs) {
    const name = attr.name.toLowerCase();
    if (name === 'width' || name === 'height') {
      changed = true;
      continue;
    }
    if (name === 'style' && attr.quote) {
      const decls = splitDeclarations(attr.value);
      const live = decls.filter((d) => d.trim() !== '');
      const next = live.filter((d) => !/^\s*max-width\s*:/i.test(d)).map((d) => d.trim());
      if (next.length !== live.length) {
        changed = true;
        if (next.length > 0) kept.push(`${attr.prefix}${next.join('; ')}${attr.quote}`);
        continue;
      }
    }
    kept.push(attr.raw);
  }
  if (!changed) return svgHtml;

  const nextTag = tag.slice(0, '<svg'.length) + kept.join('') + parsed.trailer;
  return svgHtml.slice(0, open) + nextTag + svgHtml.slice(close + 1);
}
