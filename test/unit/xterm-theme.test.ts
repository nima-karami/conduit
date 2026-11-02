import { describe, expect, it } from 'vitest';
import { MONO_FONTS } from '../../webview/themes';
import { monoStack, terminalBackground } from '../../webview/xterm-theme';

describe('terminalBackground — shared surface colour×opacity → terminal surface (R4.3b)', () => {
  // Derives the single translucent terminal surface (the `.termwrap` container's
  // `--term-surface`): the SAME colour AND the SAME opacity the code block uses, so
  // the editor and terminal are one configurable surface. (The xterm canvas itself
  // is transparent; this is what shows through it.)
  it('returns the colour unchanged when fully opaque', () => {
    // At alpha 1 the surface is exactly that hex (so it visibly matches the code block).
    expect(terminalBackground('#0a0b0e', 1)).toBe('#0a0b0e');
    expect(terminalBackground('#112233', 1)).toBe('#112233');
  });

  it('applies the shared (code) opacity as rgba when translucent', () => {
    // 0x11=17, 0x22=34, 0x33=51
    expect(terminalBackground('#112233', 0.5)).toBe('rgba(17,34,51,0.5)');
    expect(terminalBackground('#ffffff', 0.25)).toBe('rgba(255,255,255,0.25)');
  });

  it('tolerates a hash-less hex', () => {
    expect(terminalBackground('112233', 0.5)).toBe('rgba(17,34,51,0.5)');
  });

  it('returns non-hex input unchanged (defensive)', () => {
    expect(terminalBackground('not-a-color', 0.5)).toBe('not-a-color');
  });

  it('drives the SAME colour to the code block and the terminal', () => {
    // The unified-colour contract: one surfaceColor, identical opaque background
    // on both surfaces. (Monaco uses #rrggbb; the terminal uses the same hex.)
    const surfaceColor = '#1a2b3c';
    expect(terminalBackground(surfaceColor, 1)).toBe(surfaceColor);
  });
});

describe('monoStack', () => {
  it('resolves a known font id and falls back for unknown ids', () => {
    expect(monoStack('jetbrains')).toContain('JetBrains');
    expect(monoStack('totally-unknown')).toContain('monospace');
  });
});

describe('terminal font stacks', () => {
  // Bundled Cascadia Mono, then the OS symbol font, ahead of any generic family: past a generic,
  // Chromium picks the colour-emoji face for ✔ ⚠ ⏺ (spec 2026-11-02 §8).
  const order = (stack: string) =>
    ["'Cascadia Mono'", "'Segoe UI Symbol'", 'ui-monospace'].map((f) => stack.indexOf(f));

  it.each(MONO_FONTS.map((f) => [f.id]))(
    '%s falls back to Cascadia Mono, then Segoe UI Symbol',
    (id) => {
      const stack = monoStack(id);
      expect(stack.startsWith(`'${MONO_FONTS.find((f) => f.id === id)?.label}'`)).toBe(true);
      const [cascadia, symbol, generic] = order(stack);
      expect(cascadia).toBeGreaterThan(0);
      expect(symbol).toBeGreaterThan(cascadia);
      expect(generic).toBeGreaterThan(symbol);
    },
  );

  it('an unknown id gets the same fallbacks', () => {
    const [cascadia, symbol, generic] = order(monoStack('totally-unknown'));
    expect(cascadia).toBeGreaterThan(0);
    expect(symbol).toBeGreaterThan(cascadia);
    expect(generic).toBeGreaterThan(symbol);
  });
});
