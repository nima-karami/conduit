import { describe, expect, it } from 'vitest';
import {
  canRedo,
  canUndo,
  type History,
  initHistory,
  push,
  redo,
  undo,
} from '../../src/arch-history';

// Use plain numbers as the document — the stack is generic over the doc type.
const init = (): History<number> => initHistory(0);

describe('arch-history', () => {
  it('starts with nothing to undo or redo', () => {
    const h = init();
    expect(h.present).toBe(0);
    expect(canUndo(h)).toBe(false);
    expect(canRedo(h)).toBe(false);
  });

  it('push then undo restores the prior state; redo re-applies', () => {
    let h = init();
    h = push(h, 1);
    h = push(h, 2);
    expect(h.present).toBe(2);
    expect(canUndo(h)).toBe(true);
    h = undo(h);
    expect(h.present).toBe(1);
    h = undo(h);
    expect(h.present).toBe(0);
    expect(canUndo(h)).toBe(false);
    h = redo(h);
    expect(h.present).toBe(1);
    h = redo(h);
    expect(h.present).toBe(2);
    expect(canRedo(h)).toBe(false);
  });

  it('a new push after an undo clears the redo future (no branching)', () => {
    let h = init();
    h = push(h, 1);
    h = undo(h); // present 0, future [1]
    expect(canRedo(h)).toBe(true);
    h = push(h, 9); // branch
    expect(h.present).toBe(9);
    expect(canRedo(h)).toBe(false);
  });

  it('coalesces consecutive pushes sharing a tag into one undo step', () => {
    let h = init();
    h = push(h, 10, 'drag');
    h = push(h, 11, 'drag');
    h = push(h, 12, 'drag');
    expect(h.present).toBe(12);
    h = undo(h); // one undo returns to before the whole coalesced gesture
    expect(h.present).toBe(0);
  });

  it('does not coalesce the same tag across an undo boundary', () => {
    let h = init();
    h = push(h, 1, 'rename');
    h = undo(h); // tag reset
    h = push(h, 2, 'rename');
    h = undo(h);
    expect(h.present).toBe(0); // the second rename was its own step
  });

  it('bounds history depth', () => {
    let h = init();
    for (let i = 1; i <= 250; i++) h = push(h, i);
    let steps = 0;
    while (canUndo(h)) {
      h = undo(h);
      steps++;
    }
    expect(steps).toBeLessThanOrEqual(100);
  });
});
