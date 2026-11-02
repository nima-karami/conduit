import type { IParser } from '@xterm/headless';

/** hc answers these queries from renderer display facts; xterm must not answer twice. */
export function registerTerminalQuerySwallowHandlers(term: { parser: IParser }): void {
  for (const prefix of [undefined, '>', '='] as const) {
    term.parser.registerCsiHandler(
      { ...(prefix === undefined ? {} : { prefix }), final: 'c' },
      () => true,
    );
  }
  for (const prefix of [undefined, '?'] as const) {
    term.parser.registerCsiHandler(
      { ...(prefix === undefined ? {} : { prefix }), final: 'n' },
      () => true,
    );
  }
  for (const ident of [10, 11, 12]) {
    term.parser.registerOscHandler(ident, (data) => data === '?');
  }
  term.parser.registerDcsHandler({ intermediates: '$', final: 'q' }, () => true);
}

interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

function parseRgb(color: string): Rgba | null {
  if (color.trim().toLowerCase() === 'transparent') return { r: 0, g: 0, b: 0, a: 0 };
  const srgb = /^color\(\s*srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)(?:\s*\/\s*([\d.]+))?\s*\)$/i.exec(
    color.trim(),
  );
  if (srgb) {
    return {
      r: Math.max(0, Math.min(255, Number(srgb[1]) * 255)),
      g: Math.max(0, Math.min(255, Number(srgb[2]) * 255)),
      b: Math.max(0, Math.min(255, Number(srgb[3]) * 255)),
      a: Math.max(0, Math.min(1, Number(srgb[4] ?? 1))),
    };
  }
  const hex = /^#([\da-f]{3,4}|[\da-f]{6}|[\da-f]{8})$/i.exec(color.trim());
  if (hex) {
    let digits = hex[1];
    if (digits.length <= 4) digits = [...digits].map((d) => d + d).join('');
    const alpha = digits.length === 8 ? Number.parseInt(digits.slice(6), 16) / 255 : 1;
    return {
      r: Number.parseInt(digits.slice(0, 2), 16),
      g: Number.parseInt(digits.slice(2, 4), 16),
      b: Number.parseInt(digits.slice(4, 6), 16),
      a: alpha,
    };
  }

  const rgb =
    /^rgba?\(\s*([\d.]+%?)\s*[, ]\s*([\d.]+%?)\s*[, ]\s*([\d.]+%?)\s*(?:[,/]\s*([\d.]+%?)\s*)?\)$/i.exec(
      color.trim(),
    );
  if (!rgb) return null;
  const channels = [rgb[1], rgb[2], rgb[3]].map((v) =>
    Math.max(
      0,
      Math.min(255, v.endsWith('%') ? (Number.parseFloat(v) * 255) / 100 : Number.parseFloat(v)),
    ),
  );
  const alphaText = rgb[4];
  const alpha =
    alphaText === undefined
      ? 1
      : Number.parseFloat(alphaText) / (alphaText.endsWith('%') ? 100 : 1);
  return {
    r: channels[0],
    g: channels[1],
    b: channels[2],
    a: Math.max(0, Math.min(1, alpha)),
  };
}

function cssColorToRgb(color: string): Rgba | null {
  const parsed = parseRgb(color);
  if (parsed) return parsed;
  if (typeof document === 'undefined') return null;
  const probe = document.createElement('span');
  probe.style.color = color;
  if (!probe.style.color) return null;
  probe.style.display = 'none';
  document.body.append(probe);
  const resolved = getComputedStyle(probe).color;
  probe.remove();
  return parseRgb(resolved);
}

/** Resolve an xterm/theme CSS color to an opaque #rrggbb over its visible backdrop. */
export function normalizeDisplayColor(
  color: string | null | undefined,
  backdrop: string,
): string | null {
  if (!color) return null;
  const source = cssColorToRgb(color);
  const base = cssColorToRgb(backdrop);
  if (!source) return null;
  const under = base ?? { r: 0, g: 0, b: 0, a: 1 };
  const a = source.a;
  const hex = [source.r, source.g, source.b]
    .map((channel, i) => Math.round(channel * a + [under.r, under.g, under.b][i] * (1 - a)))
    .map((channel) => channel.toString(16).padStart(2, '0'))
    .join('');
  return `#${hex}`;
}
