import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, THEME_DEFAULTS } from '../../src/settings';
import { coupleThemeDefaults, THEMES } from '../../webview/themes';

/**
 * The token contract's own instruction: "Add a contrast test. A 12-token x 9-theme matrix is
 * exactly where a hand-checked palette rots." Every --syn-* / --code-* / --diff-* FOREGROUND is
 * measured against the theme's own code surface (--code-base), which is ink in all three themes.
 *
 * Three ratios are deliberately below 4.5:1 and signed off in the design language, so they are
 * asserted AT their published value rather than skipped — a regression still fails, a re-tune
 * still has to be a deliberate edit. See docs/design-handoff/revamp/spec/Conduit Token Contract.txt
 * ("These are the Design Language's own values and are signed off as-is").
 */

const CSS = readFileSync(join(__dirname, '..', '..', 'webview', 'styles.css'), 'utf8');

/** Custom properties declared in one selector block, e.g. `:root` or `:root[data-theme="neon"]`. */
function tokensFor(selector: string): Record<string, string> {
  const start = CSS.indexOf(`${selector} {`);
  if (start < 0) throw new Error(`no ${selector} block in styles.css`);
  const body = CSS.slice(start, CSS.indexOf('\n}', start));
  const out: Record<string, string> = {};
  for (const m of body.matchAll(/^\s{2}(--[\w-]+):\s*([^;]+);/gm)) out[m[1]] = m[2].trim();
  return out;
}

const ROOT = tokensFor(':root');

/**
 * The terminal surface. Aero re-scopes the page tiers to ink inside it, and a custom property
 * resolves where it is DECLARED — so anything painted over a terminal has to be measured with
 * this block layered on, not against :root. Without it a chip token can read 4.5:1 in the test
 * and under 3:1 on screen.
 */
const AERO_TERM = tokensFor(
  ':root[data-theme="aero"] :is(.termwrap, .inkbox, .markdown pre, .markdown code)',
);

/** The tiers in scope for something rendered inside `.termwrap` on `id`. */
function terminalScope(id: string): Record<string, string> {
  return id === 'aero' ? { ...theme(id), ...AERO_TERM } : theme(id);
}

/**
 * The scope a token's VALUE is computed in, which is where it is declared — not where it is read.
 * `--timer-armed: var(--accent)` stated on `:root` resolves against `:root`'s accent and inherits
 * that computed colour into `.termwrap`; only a restatement inside the terminal block picks up the
 * ink tiers. Modelling the declaration site is what makes this test able to fail.
 */
function declaringScope(id: string, token: string): Record<string, string> {
  return id === 'aero' && AERO_TERM[token] ? terminalScope(id) : theme(id);
}

/** :root carries Aero Dark, so a theme block only needs to state what it changes. */
function theme(id: string): Record<string, string> {
  return id === 'aero-dark' ? ROOT : { ...ROOT, ...tokensFor(`:root[data-theme="${id}"]`) };
}

/** Resolve one level of `var(--x)` indirection (Neon states --syn-comment as var(--text-faint)). */
function resolve(tokens: Record<string, string>, name: string): string {
  const raw = tokens[name];
  if (!raw) throw new Error(`token ${name} is not declared`);
  const ref = /^var\((--[\w-]+)\)$/.exec(raw);
  return ref ? resolve(tokens, ref[1]) : raw;
}

function channels(hex: string): [number, number, number] {
  const m = /^#([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) throw new Error(`not an opaque hex colour: ${hex}`);
  const n = Number.parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function luminance(hex: string): number {
  const lin = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  const [r, g, b] = channels(hex);
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/** Composite an `rgba(r, g, b, a)` wash over an opaque hex — how the current-line row is built. */
function over(wash: string, base: string): string {
  const m = /^rgba\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)\s*\)$/.exec(wash.trim());
  if (!m) throw new Error(`not an rgba wash: ${wash}`);
  const a = Number(m[4]);
  const [br, bg, bb] = channels(base);
  const mix = (fg: number, back: number) => Math.round(fg * a + back * (1 - a));
  const hex = (n: number) => n.toString(16).padStart(2, '0');
  return `#${hex(mix(Number(m[1]), br))}${hex(mix(Number(m[2]), bg))}${hex(mix(Number(m[3]), bb))}`;
}

function contrast(fg: string, bg: string): number {
  const a = luminance(fg);
  const b = luminance(bg);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

const FOREGROUNDS = [
  '--syn-default',
  '--syn-comment',
  '--syn-keyword',
  '--syn-string',
  '--syn-number',
  '--syn-type',
  '--syn-title',
  '--syn-built_in',
  '--syn-attr',
  '--syn-literal',
  '--syn-meta',
  '--syn-tag',
  '--code-line-number',
  '--code-cursor',
  '--diff-marker',
  '--diff-gutter-num',
];

/**
 * The signed-off muted tier, per theme: the comment/gutter/meta grey. The contract quotes it
 * on ink at 3.58:1 (Aero), 3.91:1 (Aero Dark) and 4.72:1 (Neon), and says explicitly not to
 * fix it or dim it further — "the gutter is the wrong place to save contrast".
 */
const MUTED: Record<string, { value: string; ratio: number }> = {
  aero: { value: '#6f748a', ratio: 3.58 },
  'aero-dark': { value: '#6f748a', ratio: 3.91 },
  neon: { value: '#7a71b8', ratio: 4.72 },
};

describe('theme token contrast on the code surface', () => {
  for (const { id } of THEMES) {
    const tokens = theme(id);
    const surface = resolve(tokens, '--code-base');
    const muted = MUTED[id];

    it(`${id}: the muted comment/gutter tier holds its signed-off ratio`, () => {
      expect(contrast(muted.value, surface)).toBeCloseTo(muted.ratio, 1);
    });

    it(`${id}: --note-accent is declared and reads on ${surface}`, () => {
      expect(contrast(resolve(tokens, '--note-accent'), surface)).toBeGreaterThanOrEqual(3);
    });

    for (const token of FOREGROUNDS) {
      it(`${id}: ${token} reads on ${surface}`, () => {
        const value = resolve(tokens, token);
        if (value === muted.value) {
          expect(contrast(value, surface)).toBeCloseTo(muted.ratio, 1);
          return;
        }
        expect(contrast(value, surface)).toBeGreaterThanOrEqual(4.5);
      });
    }
  }

  // The contract publishes --syn-keyword's ratio "on the current-line row", not on the base
  // surface — so the row wash is part of the measured palette and gets pinned here too.
  it('aero: --syn-keyword holds its signed-off 4.11:1 on the current-line row', () => {
    const tokens = theme('aero');
    const row = over(resolve(tokens, '--code-line-highlight'), resolve(tokens, '--code-base'));
    expect(contrast(resolve(tokens, '--syn-keyword'), row)).toBeCloseTo(4.11, 1);
  });

  // The third signed-off value: the primary attention button paints --on-accent on --amber.
  it('aero: white on the amber attention fill holds its signed-off 2.62:1', () => {
    const tokens = theme('aero');
    expect(contrast(resolve(tokens, '--on-accent'), resolve(tokens, '--amber'))).toBeCloseTo(
      2.62,
      1,
    );
  });
});

describe('theme registry', () => {
  it('matches the per-theme defaults the host migration seeds from', () => {
    expect(THEMES.map((t) => t.id).sort()).toEqual(Object.keys(THEME_DEFAULTS).sort());
    for (const t of THEMES) {
      expect({ fontUi: t.fontUi, fontMono: t.fontMono }).toEqual({
        fontUi: THEME_DEFAULTS[t.id].fontUi,
        fontMono: THEME_DEFAULTS[t.id].fontMono,
      });
    }
  });

  it('every theme id has a styles.css block, and Aero Dark is :root', () => {
    for (const t of THEMES) {
      if (t.id === 'aero-dark') continue;
      expect(CSS).toContain(`:root[data-theme="${t.id}"] {`);
    }
    expect(CSS).not.toContain(':root[data-theme="aero-dark"] {');
  });

  it("the theme's code surface is the settings default it seeds", () => {
    for (const t of THEMES) {
      expect(resolve(theme(t.id), '--code-base')).toBe(THEME_DEFAULTS[t.id].surfaceColor);
    }
  });

  it('theme blocks own shape and material only, never spacing or size', () => {
    for (const t of THEMES) {
      if (t.id === 'aero-dark') continue;
      const declared = Object.keys(tokensFor(`:root[data-theme="${t.id}"]`));
      expect(declared.filter((n) => n.startsWith('--density-'))).toEqual([]);
    }
    for (const t of THEMES) {
      if (t.id === 'aero-dark') continue;
      const block = CSS.slice(
        CSS.indexOf(`:root[data-theme="${t.id}"] {`),
        CSS.indexOf('\n}', CSS.indexOf(`:root[data-theme="${t.id}"] {`)),
      );
      expect(block).not.toMatch(/^\s{2}(height|padding|gap|font-size):/m);
    }
  });
});

/**
 * Lane A's gutter marks. §11 sets the bar at 3:1 against the gutter, which paints on
 * --code-base; §10 says colour never carries the signal alone, so the shapes are asserted too.
 */
describe('change-marker tokens', () => {
  const CHANGE_TOKENS = ['--change-added', '--change-modified', '--change-deleted'];

  for (const { id } of THEMES) {
    const tokens = theme(id);
    const surface = resolve(tokens, '--code-base');
    for (const token of CHANGE_TOKENS) {
      it(`${id}: ${token} clears 3:1 on ${surface}`, () => {
        expect(contrast(resolve(tokens, token), surface)).toBeGreaterThanOrEqual(3);
      });
    }
  }

  it('distinguishes the three kinds by shape, not colour alone', () => {
    expect(CSS).toMatch(/\.cdec--modified\s*\{[^}]*border-left-style:\s*dashed/);
    expect(CSS).toMatch(/\.cdec--deleted::after\s*\{/);
  });

  it('falls back to system colours under forced colors', () => {
    expect(CSS).toMatch(/@media \(forced-colors: active\)[\s\S]{0,400}\.cdec--added/);
  });

  for (const { id } of THEMES) {
    const tokens = theme(id);
    it(`${id}: the change peek's surface keeps its text legible`, () => {
      // The peek quotes removed lines in the editor's own type, so the code text tier is what
      // has to read on it.
      expect(
        contrast(resolve(tokens, '--syn-default'), resolve(tokens, '--change-peek-bg')),
      ).toBeGreaterThanOrEqual(4.5);
    });
  }

  it('opens the peek without motion where motion is unwelcome', () => {
    expect(CSS).toMatch(
      /@media \(prefers-reduced-motion: reduce\)[\s\S]{0,200}\.peek\s*\{[^}]*animation:\s*none/,
    );
  });
});

/**
 * Timed-message tones (spec 2026-08-28-timed-messages §10, §11). The chip paints on --raise, so
 * that is the surface. §10 puts the bar at 4.5:1 for chip TEXT, which also clears the 3:1 its
 * border needs — the border reuses the same token.
 */
describe('timed-message tokens', () => {
  const TIMER_TOKENS = ['--timer-armed', '--timer-auto', '--timer-late'];

  /** Resolve `color-mix(in srgb, var(--a) N%, var(--b))` — the .attnchip text recipe. */
  function resolveMixed(tokens: Record<string, string>, name: string): string {
    const raw = tokens[name];
    if (!raw) throw new Error(`token ${name} is not declared`);
    const mix = /^color-mix\(in srgb,\s*var\((--[\w-]+)\)\s*([\d.]+)%,\s*var\((--[\w-]+)\)\)$/.exec(
      raw,
    );
    if (!mix) return resolve(tokens, name);
    const a = channels(resolve(tokens, mix[1]));
    const b = channels(resolve(tokens, mix[3]));
    const p = Number(mix[2]) / 100;
    const hex = (n: number) => Math.round(n).toString(16).padStart(2, '0');
    return `#${a.map((v, i) => hex(v * p + b[i] * (1 - p))).join('')}`;
  }

  // The chip lives inside .termwrap, so the tiers it resolves against are that scope's — which
  // on Aero is the ink block, not the page one :root declares.
  for (const { id } of THEMES) {
    const surface = resolve(terminalScope(id), '--raise');
    for (const token of TIMER_TOKENS) {
      it(`${id}: ${token} reads on the chip surface ${surface}`, () => {
        expect(
          contrast(resolveMixed(declaringScope(id, token), token), surface),
        ).toBeGreaterThanOrEqual(4.5);
      });
    }
  }

  it('restates the timer tones inside the terminal scope, where the chip paints', () => {
    // Without this the Aero cases above would silently measure a surface the chip never uses.
    expect(Object.keys(AERO_TERM)).toEqual(
      expect.arrayContaining(['--timer-armed', '--timer-auto', '--timer-late', '--raise']),
    );
  });

  it('never signals with colour alone — Auto and late are words, not hues', () => {
    expect(CSS).toMatch(/\.term-timer__badge\s*\{/);
    expect(CSS).toMatch(/\.term-timer__word\s*\{/);
  });

  it('steps below the find bar instead of out-specifying it', () => {
    expect(CSS).toMatch(/\.term-timer--stacked\s*\{[^}]*top:\s*44px/);
  });

  it('drops the chip animation under BOTH reduced-motion switches', () => {
    expect(CSS).toMatch(/@media \(prefers-reduced-motion: reduce\)[\s\S]{0,400}\.term-timer/);
    expect(CSS).toMatch(/:root\[data-reduce-motion="true"\][^{]*\.term-timer/);
  });

  it('carries state on the border under forced colors, never a background', () => {
    expect(CSS).toMatch(
      /@media \(forced-colors: active\)[\s\S]{0,400}\.term-timer\s*\{[^}]*border-color:\s*CanvasText/,
    );
  });
});

/**
 * The runtime half of the same rule (blockers Q1): switching theme in the app re-derives every
 * unpinned theme-seeded axis. Without this, `surfaceColor` was seeded once at load and then
 * froze — Aero's ink stayed behind Neon's editor for the rest of the session.
 */
describe('coupleThemeDefaults', () => {
  const neon = THEME_DEFAULTS.neon;

  it('applies the new theme to every unpinned axis', () => {
    const patch = coupleThemeDefaults(DEFAULT_SETTINGS, { theme: 'neon' });
    expect(patch).toMatchObject({
      fontUi: neon.fontUi,
      fontMono: neon.fontMono,
      surfaceColor: neon.surfaceColor,
      iconPack: neon.iconPack,
    });
  });

  it('leaves a pinned axis alone', () => {
    const prev = {
      ...DEFAULT_SETTINGS,
      surfaceColorPinned: true,
      iconPackPinned: true,
      fontUiPinned: true,
    };
    const patch = coupleThemeDefaults(prev, { theme: 'neon' });
    expect(patch.surfaceColor).toBeUndefined();
    expect(patch.iconPack).toBeUndefined();
    expect(patch.fontUi).toBeUndefined();
    expect(patch.fontMono).toBe(neon.fontMono);
  });

  it('pins the axis a control just set', () => {
    expect(coupleThemeDefaults(DEFAULT_SETTINGS, { iconPack: 'none' }).iconPackPinned).toBe(true);
    expect(
      coupleThemeDefaults(DEFAULT_SETTINGS, { surfaceColor: '#112233' }).surfaceColorPinned,
    ).toBe(true);
  });

  it('lets "reset to theme" unpin in the same patch', () => {
    const prev = { ...DEFAULT_SETTINGS, iconPackPinned: true };
    const patch = coupleThemeDefaults(prev, { iconPack: 'colored', iconPackPinned: false });
    expect(patch.iconPackPinned).toBe(false);
  });
});
