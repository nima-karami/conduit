import { describe, expect, it } from 'vitest';
import { createHoverGate } from '../../webview/hover-gate';

describe('createHoverGate (QA r1 Q3)', () => {
  it('a pointer resting where the picker opened never arms it', () => {
    const moved = createHoverGate();
    expect(moved(10, 20)).toBe(false);
    expect(moved(10, 20)).toBe(false);
    expect(moved(10, 20)).toBe(false);
  });

  it('arms on the first event at a new position, and stays armed', () => {
    const moved = createHoverGate();
    expect(moved(10, 20)).toBe(false);
    expect(moved(11, 20)).toBe(true);
    expect(moved(11, 20)).toBe(true);
  });
});
