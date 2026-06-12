import { describe, expect, it } from 'vitest';
import { isStripOverflowing, scrollTargetTabId, TERMINAL_TABID } from '../../webview/tab-overflow';

describe('isStripOverflowing', () => {
  it('is false when content fits exactly', () => {
    expect(isStripOverflowing(500, 500)).toBe(false);
  });
  it('is false when content is narrower than the viewport', () => {
    expect(isStripOverflowing(300, 500)).toBe(false);
  });
  it('is true when content is clearly wider than the viewport', () => {
    expect(isStripOverflowing(800, 500)).toBe(true);
  });
  it('tolerates sub-pixel rounding (no flicker at <=1px)', () => {
    // scrollWidth can report 1px over clientWidth from fractional layout even
    // when nothing is actually clipped — that must NOT show the chevron.
    expect(isStripOverflowing(501, 500)).toBe(false);
    expect(isStripOverflowing(500.6, 500)).toBe(false);
  });
  it('shows overflow once content exceeds the 1px tolerance', () => {
    expect(isStripOverflowing(502, 500)).toBe(true);
  });
  it('handles zero widths', () => {
    expect(isStripOverflowing(0, 0)).toBe(false);
  });
});

describe('scrollTargetTabId', () => {
  it('maps the terminal/agent tab (null) to the sentinel tabid', () => {
    expect(scrollTargetTabId(null)).toBe(TERMINAL_TABID);
  });
  it('returns a doc id unchanged (file tab)', () => {
    expect(scrollTargetTabId('file:/repo/src/app.ts')).toBe('file:/repo/src/app.ts');
  });
  it('returns a diff doc id unchanged', () => {
    expect(scrollTargetTabId('diff:/repo/src/app.ts')).toBe('diff:/repo/src/app.ts');
  });
  it('round-trips an arbitrary tab id', () => {
    expect(scrollTargetTabId('file:weird:id')).toBe('file:weird:id');
  });
  it('the terminal sentinel is a stable, queryable, non-empty value', () => {
    expect(TERMINAL_TABID).toBeTruthy();
    expect(typeof TERMINAL_TABID).toBe('string');
  });
});
