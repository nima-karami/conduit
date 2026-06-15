import { describe, expect, it } from 'vitest';
import { isViewportAtBottom } from '../../webview/terminal-scroll';

describe('isViewportAtBottom', () => {
  it('is at the bottom when the viewport equals the base row (following output)', () => {
    expect(isViewportAtBottom(120, 120)).toBe(true);
  });

  it('is NOT at the bottom when the user has scrolled up', () => {
    expect(isViewportAtBottom(40, 120)).toBe(false);
  });

  it('treats a viewport past the base as at the bottom (defensive)', () => {
    expect(isViewportAtBottom(121, 120)).toBe(true);
  });

  it('a fresh, unscrolled buffer (both 0) is at the bottom', () => {
    expect(isViewportAtBottom(0, 0)).toBe(true);
  });
});
