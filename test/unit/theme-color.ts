import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Colour maths + CSS-token reading shared by the theme contrast suites.
 *
 * The one rule that matters here: a custom property resolves at its DECLARING element, so a
 * surface that re-scopes the palette has to be layered on explicitly before anything is measured
 * against it (see `theme-tokens.test.ts`'s AERO_TERM). A test that measures the wrong scope
 * passes while the shipped pixel fails — this repo has shipped that bug.
 */

export const CSS = readFileSync(join(__dirname, '..', '..', 'webview', 'styles.css'), 'utf8');

/** Custom properties declared in one selector block, e.g. `:root` or `:root[data-theme="neon"]`. */
export function tokensFor(selector: string): Record<string, string> {
  const start = CSS.indexOf(`${selector} {`);
  if (start < 0) throw new Error(`no ${selector} block in styles.css`);
  const body = CSS.slice(start, CSS.indexOf('\n}', start));
  const out: Record<string, string> = {};
  for (const m of body.matchAll(/^\s{2}(--[\w-]+):\s*([^;]+);/gm)) out[m[1]] = m[2].trim();
  return out;
}

const ROOT = tokensFor(':root');

/** :root carries Aero Dark, so a theme block only needs to state what it changes. */
export function theme(id: string): Record<string, string> {
  return id === 'aero-dark' ? ROOT : { ...ROOT, ...tokensFor(`:root[data-theme="${id}"]`) };
}

/** Resolve one level of `var(--x)` indirection (Neon states --syn-comment as var(--text-faint)). */
export function resolve(tokens: Record<string, string>, name: string): string {
  const raw = tokens[name];
  if (!raw) throw new Error(`token ${name} is not declared`);
  const ref = /^var\((--[\w-]+)\)$/.exec(raw);
  return ref ? resolve(tokens, ref[1]) : raw;
}

export function channels(hex: string): [number, number, number] {
  const m = /^#([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) throw new Error(`not an opaque hex colour: ${hex}`);
  const n = Number.parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

const linear = (c: number): number => {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
};

function luminance(hex: string): number {
  const [r, g, b] = channels(hex);
  return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
}

/** `rgba(r, g, b, a)` split into its channels and alpha. */
export function rgba(wash: string): { rgb: [number, number, number]; alpha: number } {
  const m = /^rgba\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)\s*\)$/.exec(wash.trim());
  if (!m) throw new Error(`not an rgba wash: ${wash}`);
  return { rgb: [Number(m[1]), Number(m[2]), Number(m[3])], alpha: Number(m[4]) };
}

const hex2 = (n: number): string => Math.round(n).toString(16).padStart(2, '0');

/** Composite an `rgba(...)` wash over an opaque hex — how a washed row is built. */
export function over(wash: string, base: string): string {
  const { rgb, alpha } = rgba(wash);
  const [br, bg, bb] = channels(base);
  const mix = (fg: number, back: number) => fg * alpha + back * (1 - alpha);
  return `#${hex2(mix(rgb[0], br))}${hex2(mix(rgb[1], bg))}${hex2(mix(rgb[2], bb))}`;
}

/** The opaque hex an `rgba(...)` wash carries, i.e. its hue with the alpha discarded. */
export function opaquePart(wash: string): string {
  const { rgb } = rgba(wash);
  return `#${rgb.map(hex2).join('')}`;
}

export function contrast(fg: string, bg: string): number {
  const a = luminance(fg);
  const b = luminance(bg);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

/** The published floors are 2-decimal figures, so they are compared at that precision. */
export const round2 = (n: number): number => Math.round(n * 100) / 100;

function lab(hex: string): [number, number, number] {
  const [r, g, b] = channels(hex).map((v) => {
    const s = v / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  const f = (t: number) => (t > 216 / 24389 ? Math.cbrt(t) : (841 / 108) * t + 4 / 29);
  const x = f((r * 0.4124564 + g * 0.3575761 + b * 0.1804375) / 0.95047);
  const y = f(r * 0.2126729 + g * 0.7151522 + b * 0.072175);
  const z = f((r * 0.0193339 + g * 0.119192 + b * 0.9503041) / 1.08883);
  return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
}

/** CIEDE2000. Used ONLY for hue-family claims about two foregrounds — never for
 *  "can I see this at a glance", which is a luminance question (spec §3). */
export function deltaE00(h1: string, h2: string): number {
  const [l1, a1, b1] = lab(h1);
  const [l2, a2, b2] = lab(h2);
  const c1 = Math.hypot(a1, b1);
  const c2 = Math.hypot(a2, b2);
  const cBar = (c1 + c2) / 2;
  const g = 0.5 * (1 - Math.sqrt(cBar ** 7 / (cBar ** 7 + 25 ** 7)));
  const ap1 = (1 + g) * a1;
  const ap2 = (1 + g) * a2;
  const cp1 = Math.hypot(ap1, b1);
  const cp2 = Math.hypot(ap2, b2);
  const angle = (x: number, y: number) => {
    if (x === 0 && y === 0) return 0;
    const d = (Math.atan2(y, x) * 180) / Math.PI;
    return d < 0 ? d + 360 : d;
  };
  const hp1 = angle(ap1, b1);
  const hp2 = angle(ap2, b2);
  const dL = l2 - l1;
  const dC = cp2 - cp1;
  let dh = 0;
  if (cp1 * cp2 !== 0) {
    dh = hp2 - hp1;
    if (dh > 180) dh -= 360;
    else if (dh < -180) dh += 360;
  }
  const dH = 2 * Math.sqrt(cp1 * cp2) * Math.sin((dh * Math.PI) / 360);
  const lBar = (l1 + l2) / 2;
  const cpBar = (cp1 + cp2) / 2;
  let hBar: number;
  if (cp1 * cp2 === 0) hBar = hp1 + hp2;
  else {
    hBar = (hp1 + hp2) / 2;
    if (Math.abs(hp1 - hp2) > 180) hBar += hp1 + hp2 < 360 ? 180 : -180;
  }
  const rad = (deg: number) => (deg * Math.PI) / 180;
  const t =
    1 -
    0.17 * Math.cos(rad(hBar - 30)) +
    0.24 * Math.cos(rad(2 * hBar)) +
    0.32 * Math.cos(rad(3 * hBar + 6)) -
    0.2 * Math.cos(rad(4 * hBar - 63));
  const sL = 1 + (0.015 * (lBar - 50) ** 2) / Math.sqrt(20 + (lBar - 50) ** 2);
  const sC = 1 + 0.045 * cpBar;
  const sH = 1 + 0.015 * cpBar * t;
  const dTheta = 30 * Math.exp(-(((hBar - 275) / 25) ** 2));
  const rC = 2 * Math.sqrt(cpBar ** 7 / (cpBar ** 7 + 25 ** 7));
  const rT = -rC * Math.sin(rad(2 * dTheta));
  return Math.sqrt((dL / sL) ** 2 + (dC / sC) ** 2 + (dH / sH) ** 2 + rT * (dC / sC) * (dH / sH));
}
