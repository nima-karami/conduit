import { describe, expect, it } from 'vitest';
import {
  MODAL_DEPTH_MAX,
  modalDepth,
  type OverlayEntry,
  pushOverlay,
  removeOverlay,
  topOverlay,
} from '../../src/overlay-stack';

describe('pushOverlay', () => {
  it('pushing a modal returns the ids of every popover below it and removes them', () => {
    const stack: OverlayEntry[] = [
      { id: 1, kind: 'popover' },
      { id: 2, kind: 'modal' },
      { id: 3, kind: 'popover' },
    ];
    const result = pushOverlay(stack, { id: 4, kind: 'modal' });
    expect(result.dismissed).toEqual([1, 3]);
    expect(result.stack.map((e) => e.kind)).toEqual(['modal', 'modal']);
  });

  it('pushing a popover displaces nothing', () => {
    const stack: OverlayEntry[] = [
      { id: 1, kind: 'modal' },
      { id: 2, kind: 'popover' },
    ];
    const result = pushOverlay(stack, { id: 3, kind: 'popover' });
    expect(result.dismissed).toEqual([]);
    expect(result.stack.map((e) => e.id)).toEqual([1, 2, 3]);
  });
});

describe('modalDepth', () => {
  it('counts modals only', () => {
    const stack: OverlayEntry[] = [
      { id: 1, kind: 'modal' },
      { id: 2, kind: 'popover' },
      { id: 3, kind: 'modal' },
    ];
    expect(modalDepth(stack, 3)).toBe(1);
  });

  it('clamps at MODAL_DEPTH_MAX', () => {
    const stack: OverlayEntry[] = Array.from({ length: MODAL_DEPTH_MAX + 5 }, (_, i) => ({
      id: i,
      kind: 'modal' as const,
    }));
    const lastId = MODAL_DEPTH_MAX + 4;
    expect(modalDepth(stack, lastId)).toBe(MODAL_DEPTH_MAX);
  });

  it('is -1 when the id is absent', () => {
    const stack: OverlayEntry[] = [{ id: 1, kind: 'modal' }];
    expect(modalDepth(stack, 99)).toBe(-1);
  });
});

describe('removeOverlay', () => {
  it('re-derives depth for the remaining entries', () => {
    const stack: OverlayEntry[] = [
      { id: 1, kind: 'modal' },
      { id: 2, kind: 'modal' },
      { id: 3, kind: 'modal' },
    ];
    const next = removeOverlay(stack, 1);
    expect(modalDepth(next, 3)).toBe(1);
  });
});

describe('topOverlay', () => {
  it('is the last entry; undefined when empty', () => {
    const stack: OverlayEntry[] = [
      { id: 1, kind: 'modal' },
      { id: 2, kind: 'popover' },
    ];
    expect(topOverlay(stack)).toEqual({ id: 2, kind: 'popover' });
    expect(topOverlay([])).toBeUndefined();
  });
});
