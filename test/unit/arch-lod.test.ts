import { describe, expect, it } from 'vitest';
import {
  autoDetail,
  budgetLabel,
  DETAIL_LEVELS,
  type DetailLevel,
  detailLabel,
  isChip,
  isOverBudget,
  LOD_THRESHOLDS,
  NODE_BUDGET,
  showsPortLabels,
  showsSubtitle,
} from '../../src/arch-lod';

describe('autoDetail', () => {
  it('renders everything below the first threshold', () => {
    expect(autoDetail(0)).toBe('full');
    expect(autoDetail(48)).toBe('full');
    expect(autoDetail(LOD_THRESHOLDS.pinsOnly - 1)).toBe('full');
  });

  it('steps down a rung at each threshold, inclusive of the threshold itself', () => {
    expect(autoDetail(LOD_THRESHOLDS.pinsOnly)).toBe('pins-only');
    expect(autoDetail(LOD_THRESHOLDS.noSubtitles - 1)).toBe('pins-only');
    expect(autoDetail(LOD_THRESHOLDS.noSubtitles)).toBe('no-subtitles');
    expect(autoDetail(LOD_THRESHOLDS.chips - 1)).toBe('no-subtitles');
    expect(autoDetail(LOD_THRESHOLDS.chips)).toBe('chips');
  });

  it('bottoms out at chips — a graph past the budget is still drawn', () => {
    expect(autoDetail(NODE_BUDGET)).toBe('chips');
    expect(autoDetail(5000)).toBe('chips');
  });

  it('is monotonic: more nodes never buys back detail', () => {
    const rank = (l: DetailLevel) => DETAIL_LEVELS.indexOf(l);
    let prev = 0;
    for (let n = 0; n <= 600; n += 7) {
      const r = rank(autoDetail(n));
      expect(r).toBeGreaterThanOrEqual(prev);
      prev = r;
    }
  });

  it('orders its thresholds', () => {
    expect(LOD_THRESHOLDS.pinsOnly).toBeLessThan(LOD_THRESHOLDS.noSubtitles);
    expect(LOD_THRESHOLDS.noSubtitles).toBeLessThan(LOD_THRESHOLDS.chips);
    expect(LOD_THRESHOLDS.chips).toBeLessThanOrEqual(NODE_BUDGET);
  });
});

describe('what each level renders', () => {
  it('drops port labels first, then subtitles', () => {
    expect(showsPortLabels('full')).toBe(true);
    expect(showsSubtitle('full')).toBe(true);

    expect(showsPortLabels('pins-only')).toBe(false);
    expect(showsSubtitle('pins-only')).toBe(true);

    expect(showsPortLabels('no-subtitles')).toBe(false);
    expect(showsSubtitle('no-subtitles')).toBe(false);
  });

  it('only the last rung is a chip, and a chip carries nothing but its title', () => {
    expect(DETAIL_LEVELS.filter(isChip)).toEqual(['chips']);
    expect(showsPortLabels('chips')).toBe(false);
    expect(showsSubtitle('chips')).toBe(false);
  });

  // The chip in the corner claims a level; these are the claims it can make.
  it('never gives detail back as it descends the ladder', () => {
    let ports = true;
    let subs = true;
    for (const level of DETAIL_LEVELS) {
      expect(showsPortLabels(level) && !ports).toBe(false);
      expect(showsSubtitle(level) && !subs).toBe(false);
      ports = showsPortLabels(level);
      subs = showsSubtitle(level);
    }
  });
});

describe('budgetLabel', () => {
  it('reads exactly as the frame does', () => {
    expect(budgetLabel(48, 'full')).toBe('48 / 500 nodes · full detail');
  });

  it('names the rung it is actually on', () => {
    expect(budgetLabel(120, autoDetail(120))).toBe('120 / 500 nodes · pins only');
    expect(budgetLabel(250, autoDetail(250))).toBe('250 / 500 nodes · titles only');
    expect(budgetLabel(500, autoDetail(500))).toBe('500 / 500 nodes · chips');
  });

  it('says so when a human pinned the level rather than the ladder choosing it', () => {
    expect(budgetLabel(10, 'chips', true)).toBe('10 / 500 nodes · chips (pinned)');
    expect(budgetLabel(10, 'chips', false)).not.toContain('pinned');
  });

  it('gives every level a distinct label', () => {
    const labels = DETAIL_LEVELS.map(detailLabel);
    expect(new Set(labels).size).toBe(DETAIL_LEVELS.length);
  });
});

describe('isOverBudget', () => {
  it('trips only past the stated ceiling', () => {
    expect(isOverBudget(NODE_BUDGET - 1)).toBe(false);
    expect(isOverBudget(NODE_BUDGET)).toBe(false);
    expect(isOverBudget(NODE_BUDGET + 1)).toBe(true);
  });
});
