import { describe, it, expect } from 'vitest';
import { parseLayout, serializeLayout, centerFacingEdge, DEFAULT_LAYOUT } from '../../src/layout';

describe('layout', () => {
  it('parses a valid permutation', () => {
    expect(parseLayout('explorer,center,sessions')).toEqual(['explorer', 'center', 'sessions']);
    expect(parseLayout('sessions,explorer,center')).toEqual(['sessions', 'explorer', 'center']);
  });

  it('falls back to default for invalid/dupe/short input', () => {
    expect(serializeLayout(parseLayout('sessions,center'))).toBe(DEFAULT_LAYOUT);
    expect(serializeLayout(parseLayout('sessions,sessions,center'))).toBe(DEFAULT_LAYOUT);
    expect(serializeLayout(parseLayout('garbage'))).toBe(DEFAULT_LAYOUT);
  });

  it('computes the center-facing edge', () => {
    const def = parseLayout('sessions,center,explorer');
    expect(centerFacingEdge(def, 'sessions')).toBe('right'); // left of center
    expect(centerFacingEdge(def, 'explorer')).toBe('left');  // right of center
    const both = parseLayout('sessions,explorer,center');
    expect(centerFacingEdge(both, 'sessions')).toBe('right');
    expect(centerFacingEdge(both, 'explorer')).toBe('right'); // still left of center
  });
});
