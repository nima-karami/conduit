import { describe, expect, it } from 'vitest';
import {
  clampSurfaceFont,
  DEFAULT_SURFACE_FONT,
  fontZoomTarget,
  MAX_SURFACE_FONT,
  MIN_SURFACE_FONT,
} from '../../webview/font-zoom';

const key = (over: Partial<Parameters<typeof fontZoomTarget>[1]>) => ({
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  key: '',
  ...over,
});

describe('clampSurfaceFont', () => {
  it('rounds and clamps into range', () => {
    expect(clampSurfaceFont(13.4)).toBe(13);
    expect(clampSurfaceFont(2)).toBe(MIN_SURFACE_FONT);
    expect(clampSurfaceFont(99)).toBe(MAX_SURFACE_FONT);
  });
});

describe('fontZoomTarget', () => {
  it('grows by one step on Ctrl/Cmd + and =', () => {
    expect(fontZoomTarget(13, key({ ctrlKey: true, key: '+' }))).toBe(14);
    expect(fontZoomTarget(13, key({ metaKey: true, key: '=' }))).toBe(14);
  });

  it('shrinks by one step on Ctrl/Cmd - and _', () => {
    expect(fontZoomTarget(13, key({ ctrlKey: true, key: '-' }))).toBe(12);
    expect(fontZoomTarget(13, key({ ctrlKey: true, key: '_' }))).toBe(12);
  });

  it('resets to the default on Ctrl/Cmd 0', () => {
    expect(fontZoomTarget(20, key({ ctrlKey: true, key: '0' }))).toBe(DEFAULT_SURFACE_FONT);
  });

  it('clamps at the extremes', () => {
    expect(fontZoomTarget(MAX_SURFACE_FONT, key({ ctrlKey: true, key: '+' }))).toBe(
      MAX_SURFACE_FONT,
    );
    expect(fontZoomTarget(MIN_SURFACE_FONT, key({ ctrlKey: true, key: '-' }))).toBe(
      MIN_SURFACE_FONT,
    );
  });

  it('returns null without the modifier, with Alt, or for unrelated keys', () => {
    expect(fontZoomTarget(13, key({ key: '+' }))).toBeNull();
    expect(fontZoomTarget(13, key({ ctrlKey: true, altKey: true, key: '+' }))).toBeNull();
    expect(fontZoomTarget(13, key({ ctrlKey: true, key: 'a' }))).toBeNull();
  });
});
