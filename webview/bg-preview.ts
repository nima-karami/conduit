/**
 * Pure mapping: in-flight Background appearance settings → the inline style /
 * CSS-variable payload for the live "proof" preview box shown beside the
 * Background controls in Settings → Appearance.
 *
 * The preview is an HONEST reflection of the real surface treatment defined in
 * styles.css: surfaces derive their colour from `--surface-alpha` via the same
 * `color-mix(... )` recipe and their frosted-glass blur from
 * `backdrop-filter: blur(var(--bg-blur))`. We reuse those exact variables so the
 * panel card inside the box reveals the backdrop and blurs it by precisely the
 * amount the real panels will once saved.
 *
 * Approximation note: the real animated backdrop is a fixed full-screen WebGL
 * shader / CSS layer (animated-bg.tsx + styles.css). Spinning up a second live
 * shader instance just for a thumbnail is heavy, so the box paints a small,
 * STATIC but representative backdrop per background type whose *strength* tracks
 * the intensity multiplier (the same MUL/ALPHA scaling the real layer uses).
 * Blur and surface-opacity are a TRUE reflection (pure CSS, identical vars);
 * the backdrop type/intensity is a faithful representation, not the live shader.
 */
import type { AppSettings, Background, BgIntensity } from '../src/settings';

/** Intensity multiplier — mirrors MUL in animated-bg.tsx (CSS modes). */
const INTENSITY_MUL: Record<BgIntensity, number> = {
  subtle: 0.6,
  balanced: 1,
  vivid: 1.6,
};

/** The values that actually drive the preview, plucked from full settings. */
export interface BgPreviewInput {
  background: Background;
  bgIntensity: BgIntensity;
  bgBlur: number; // px
  surfaceOpacity: number; // 0..1
}

/** Narrow full settings down to just the four background inputs. */
export function pickBgPreviewInput(s: AppSettings): BgPreviewInput {
  return {
    background: s.background,
    bgIntensity: s.bgIntensity,
    bgBlur: s.bgBlur,
    surfaceOpacity: s.surfaceOpacity,
  };
}

/** The computed style payload for the preview, split by the element it targets. */
export interface BgPreviewStyle {
  /** True when the background is off — the box drops the backdrop + blur. */
  active: boolean;
  /** CSS-var bundle applied to the preview root (drives the surface/blur recipe). */
  vars: Record<string, string>;
  /** The representative backdrop layer's `background` shorthand for this bg type. */
  backdrop: string;
  /** The intensity multiplier baked into the backdrop opacity. */
  intensity: number;
}

/** A representative (static) backdrop per background type. Strength scales with
 * the intensity multiplier so "vivid" reads stronger than "subtle", matching
 * the real layer's behaviour. Colours reference theme vars so it tracks themes. */
function backdropFor(bg: Background, mul: number): string {
  const a = (base: number) => Math.min(1, base * mul).toFixed(3);
  switch (bg) {
    case 'none':
      return 'transparent';
    case 'grid':
      // Panning line-grid analogue (static).
      return (
        `linear-gradient(var(--border-2) 1px, transparent 1px) 0 0 / 18px 18px, ` +
        `linear-gradient(90deg, var(--border-2) 1px, transparent 1px) 0 0 / 18px 18px, ` +
        `var(--bg)`
      );
    case 'mesh':
      return (
        `radial-gradient(60% 60% at 20% 25%, color-mix(in srgb, var(--accent) ${a(0.5)}, transparent), transparent 60%), ` +
        `radial-gradient(55% 55% at 82% 30%, color-mix(in srgb, var(--blue) ${a(0.45)}, transparent), transparent 60%), ` +
        `radial-gradient(60% 60% at 50% 90%, color-mix(in srgb, var(--violet) ${a(0.4)}, transparent), transparent 60%), ` +
        `var(--bg)`
      );
    default:
      // aurora / flow / shader / custom — two drifting blobs, frozen.
      return (
        `radial-gradient(circle at 22% 18%, color-mix(in srgb, var(--accent) ${a(0.55)}, transparent), transparent 62%), ` +
        `radial-gradient(circle at 80% 82%, color-mix(in srgb, var(--blue) ${a(0.5)}, transparent), transparent 62%), ` +
        `var(--bg)`
      );
  }
}

/**
 * Map the four in-flight Background settings to the preview's style payload.
 * Pure + deterministic so it can be unit-tested without a DOM.
 */
export function bgPreviewStyle(input: BgPreviewInput): BgPreviewStyle {
  const active = input.background !== 'none';
  const mul = INTENSITY_MUL[input.bgIntensity] ?? 1;
  // Clamp defensively — the settings model already clamps, but the preview must
  // never emit a negative blur or an out-of-range alpha.
  const blur = Math.max(0, input.bgBlur);
  const alpha = Math.min(1, Math.max(0, input.surfaceOpacity));
  return {
    active,
    vars: {
      // Reuse the EXACT variable names the real surfaces read (styles.css):
      // the panel inside the box is `color-mix(... --surface-alpha ...)` and its
      // backdrop-filter is `blur(var(--bg-blur))`. Honest, not an approximation.
      '--bg-blur': `${blur}px`,
      '--surface-alpha': String(alpha),
    },
    backdrop: active ? backdropFor(input.background, mul) : 'transparent',
    intensity: mul,
  };
}
