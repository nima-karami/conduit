import { describe, expect, it } from 'vitest';
import { monoStack, terminalBackground } from '../../webview/xterm-theme';

describe('terminalBackground — shared surface colour → xterm theme.background (I1)', () => {
  it('returns the colour unchanged when fully opaque', () => {
    // The terminal uses the SAME colour as the code block; at alpha 1 the xterm
    // background is exactly that hex (so it visibly matches the code surface).
    expect(terminalBackground('#0a0b0e', 1)).toBe('#0a0b0e');
    expect(terminalBackground('#112233', 1)).toBe('#112233');
  });

  it('applies the terminal surface opacity as rgba when translucent', () => {
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
