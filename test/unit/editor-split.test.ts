import { describe, expect, it } from 'vitest';
import { clampSplitRatio, EDITOR_GROUP_MIN_PX, stepSplitRatio } from '../../webview/editor-split';

describe('clampSplitRatio', () => {
  it('clamp keeps each side ≥ 240px at 1000px', () => {
    expect(EDITOR_GROUP_MIN_PX).toBe(240);
    expect(clampSplitRatio(0.1, 1000)).toBe(0.24);
    expect(clampSplitRatio(0.9, 1000)).toBe(0.76);
    expect(clampSplitRatio(0.5, 1000)).toBe(0.5);
  });

  it('narrower than 480px returns the ratio unchanged', () => {
    expect(clampSplitRatio(0.3, 479)).toBe(0.3);
    expect(clampSplitRatio(0.8, 300)).toBe(0.8);
  });

  it('narrower than 480px still bounds the ratio to [0.15, 0.85]', () => {
    expect(clampSplitRatio(0.05, 300)).toBe(0.15);
    expect(clampSplitRatio(0.95, 300)).toBe(0.85);
  });

  it('never leaves the persisted range [0.15, 0.85] on a wide pane', () => {
    expect(clampSplitRatio(0.01, 4000)).toBe(0.15);
    expect(clampSplitRatio(0.99, 4000)).toBe(0.85);
  });
});

describe('stepSplitRatio', () => {
  it('ArrowLeft steps 16px; Shift steps 64px; Home is the min', () => {
    expect(stepSplitRatio(0.5, 1000, 'ArrowLeft', false)).toBeCloseTo(0.484, 10);
    expect(stepSplitRatio(0.5, 1000, 'ArrowLeft', true)).toBeCloseTo(0.436, 10);
    expect(stepSplitRatio(0.5, 1000, 'ArrowRight', false)).toBeCloseTo(0.516, 10);
    expect(stepSplitRatio(0.5, 1000, 'Home', false)).toBe(0.24);
    expect(stepSplitRatio(0.5, 1000, 'End', false)).toBe(0.76);
  });

  it('a step never crosses the clamp', () => {
    expect(stepSplitRatio(0.25, 1000, 'ArrowLeft', true)).toBe(0.24);
  });

  it('narrower than 480px leaves the ratio unchanged', () => {
    expect(stepSplitRatio(0.5, 400, 'ArrowLeft', false)).toBe(0.5);
    expect(stepSplitRatio(0.5, 400, 'Home', false)).toBe(0.5);
  });
});
