import { describe, expect, it } from 'vitest';
import { svgViewBoxSize } from '../../webview/svg-viewbox';

describe('svgViewBoxSize', () => {
  it('parses a standard viewBox', () => {
    expect(svgViewBoxSize('0 0 800 600')).toEqual({ w: 800, h: 600 });
  });

  it('parses a non-zero origin and comma/space separators', () => {
    expect(svgViewBoxSize('-10,-10, 120 , 80')).toEqual({ w: 120, h: 80 });
  });

  it('returns 0x0 for absent or malformed input (caller falls back)', () => {
    expect(svgViewBoxSize(null)).toEqual({ w: 0, h: 0 });
    expect(svgViewBoxSize(undefined)).toEqual({ w: 0, h: 0 });
    expect(svgViewBoxSize('')).toEqual({ w: 0, h: 0 });
    expect(svgViewBoxSize('0 0 800')).toEqual({ w: 0, h: 0 });
    expect(svgViewBoxSize('a b c d')).toEqual({ w: 0, h: 0 });
  });

  it('returns 0x0 for non-positive dimensions', () => {
    expect(svgViewBoxSize('0 0 0 100')).toEqual({ w: 0, h: 0 });
    expect(svgViewBoxSize('0 0 100 -5')).toEqual({ w: 0, h: 0 });
  });
});
