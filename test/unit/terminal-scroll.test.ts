import { describe, expect, it } from 'vitest';
import {
  isViewportAtBottom,
  shouldHandleWheelLocally,
  wheelScrollLines,
} from '../../webview/terminal-scroll';

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

describe('shouldHandleWheelLocally', () => {
  it('takes over the wheel when an app grabbed the mouse in the normal buffer', () => {
    expect(shouldHandleWheelLocally('normal', 'vt200', false)).toBe(true);
    expect(shouldHandleWheelLocally('normal', 'drag', false)).toBe(true);
    expect(shouldHandleWheelLocally('normal', 'any', false)).toBe(true);
  });

  it('defers to xterm when no app grabbed the mouse (native smooth scroll is better)', () => {
    expect(shouldHandleWheelLocally('normal', 'none', false)).toBe(false);
  });

  it('defers in the alternate screen — the wheel drives the full-screen app there', () => {
    expect(shouldHandleWheelLocally('alternate', 'vt200', false)).toBe(false);
  });

  it('defers when Shift is held (xterm’s own no-scroll modifier)', () => {
    expect(shouldHandleWheelLocally('normal', 'vt200', true)).toBe(false);
  });
});

describe('wheelScrollLines', () => {
  // deltaMode constants: 0 = pixel, 1 = line, 2 = page.
  it('line-mode deltas map one-to-one to scrolled lines', () => {
    expect(wheelScrollLines(3, 1, 16, 24, 0)).toEqual({ lines: 3, partial: 0 });
    expect(wheelScrollLines(-2, 1, 16, 24, 0)).toEqual({ lines: -2, partial: 0 });
  });

  it('page-mode scrolls a screenful per notch', () => {
    expect(wheelScrollLines(1, 2, 16, 24, 0)).toEqual({ lines: 24, partial: 0 });
  });

  it('pixel-mode divides by row height and carries the sub-line remainder', () => {
    // 24px / 16px-row = 1.5 -> 1 line now, 0.5 line carried forward.
    const first = wheelScrollLines(24, 0, 16, 24, 0);
    expect(first.lines).toBe(1);
    expect(first.partial).toBeCloseTo(0.5);
    // Next identical notch: 0.5 carried + 1.5 = 2.0 -> 2 lines, 0 remainder.
    const second = wheelScrollLines(24, 0, 16, 24, first.partial);
    expect(second.lines).toBe(2);
    expect(second.partial).toBeCloseTo(0);
  });

  it('does nothing on a zero delta or an unmeasurable row height', () => {
    expect(wheelScrollLines(0, 1, 16, 24, 0)).toEqual({ lines: 0, partial: 0 });
    expect(wheelScrollLines(100, 0, 0, 24, 0)).toEqual({ lines: 0, partial: 0 });
  });
});
