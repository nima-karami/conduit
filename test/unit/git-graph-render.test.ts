import { describe, expect, it } from 'vitest';
import {
  edgePath,
  edgePaths,
  gutterWidth,
  isMerge,
  LANE_VARS,
  laneColorVar,
  laneX,
  rowY,
  splitBadges,
} from '../../src/git-graph-render';
import type { GitRef, GraphLayout } from '../../src/protocol';

describe('laneColorVar', () => {
  it('maps lane 0 to the indicator branch color (--accent)', () => {
    expect(laneColorVar(0)).toBe('--accent');
  });
  it('cycles the palette and handles wrap-around', () => {
    expect(laneColorVar(LANE_VARS.length)).toBe(laneColorVar(0));
    expect(laneColorVar(LANE_VARS.length + 1)).toBe(laneColorVar(1));
  });
});

describe('geometry', () => {
  it('gutterWidth grows with lane count', () => {
    expect(gutterWidth(0)).toBe(gutterWidth(1));
    expect(gutterWidth(3)).toBeGreaterThan(gutterWidth(1));
  });
  it('laneX/rowY are monotonic', () => {
    expect(laneX(1)).toBeGreaterThan(laneX(0));
    expect(rowY(1)).toBeGreaterThan(rowY(0));
  });
});

describe('edgePath', () => {
  it('draws a straight line for an in-lane edge', () => {
    const p = edgePath({ fromSha: 'a', toSha: 'b', fromLane: 0, toLane: 0 }, 0, 1);
    expect(p.d.startsWith('M')).toBe(true);
    expect(p.d).toContain('L'); // straight segment, no curve
    expect(p.colorLane).toBe(0);
  });
  it('draws a bezier elbow for a lane-changing edge and colors by the parent lane', () => {
    const p = edgePath({ fromSha: 'a', toSha: 'b', fromLane: 0, toLane: 1 }, 0, 2);
    expect(p.d).toContain('C'); // cubic bezier
    expect(p.colorLane).toBe(1);
  });
});

describe('edgePaths', () => {
  it('drops edges whose parent is off the loaded page', () => {
    const layout: GraphLayout = {
      rows: [
        { sha: 'a', lane: 0 },
        { sha: 'b', lane: 0 },
      ],
      edges: [
        { fromSha: 'a', toSha: 'b', fromLane: 0, toLane: 0 },
        { fromSha: 'b', toSha: 'gone', fromLane: 0, toLane: 0 }, // parent not loaded
      ],
      laneCount: 1,
    };
    const index = new Map([
      ['a', 0],
      ['b', 1],
    ]);
    const paths = edgePaths(layout, (sha) => index.get(sha) ?? -1);
    expect(paths).toHaveLength(1);
    expect(paths[0].toSha).toBe('b');
  });
});

describe('splitBadges', () => {
  const ref = (kind: GitRef['kind'], name: string): GitRef => ({ kind, name });
  it('returns all refs when under the cap', () => {
    const refs = [ref('branch', 'main'), ref('tag', 'v1')];
    expect(splitBadges(refs, 3)).toEqual({ visible: refs, overflow: 0 });
  });
  it('caps and always keeps HEAD visible', () => {
    const refs = [
      ref('branch', 'a'),
      ref('branch', 'b'),
      ref('head', 'HEAD'),
      ref('tag', 'c'),
      ref('tag', 'd'),
    ];
    const { visible, overflow } = splitBadges(refs, 2);
    expect(visible.some((r) => r.kind === 'head')).toBe(true);
    expect(visible).toHaveLength(2);
    expect(overflow).toBe(3);
  });
});

describe('isMerge', () => {
  it('is true only for ≥2 parents', () => {
    expect(isMerge([])).toBe(false);
    expect(isMerge(['a'])).toBe(false);
    expect(isMerge(['a', 'b'])).toBe(true);
  });
});
