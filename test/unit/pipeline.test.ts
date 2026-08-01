import { describe, expect, it } from 'vitest';
import type { BoardCard } from '../../src/board';
import {
  appendQueueEntry,
  buildQueueEntry,
  CANONICAL_TRANSITIONS,
  emptyPipelineConfig,
  emptyPipelineQueue,
  type PipelineConfig,
  restorePipeline,
  restorePipelineQueue,
  serializePipeline,
  serializePipelineQueue,
  setTransitionSkill,
  setWipLimit,
  skillForTransition,
  transitionKey,
  wipLimitFor,
} from '../../src/pipeline';

const card = (over: Partial<BoardCard> = {}): BoardCard => ({
  id: 'card-1',
  title: 'Project-wide go-to-definition',
  notes: '',
  stage: 'wishlist',
  ...over,
});

describe('transition key', () => {
  it('derives `from->to`', () => {
    expect(transitionKey('wishlist', 'planning')).toBe('wishlist->planning');
    expect(transitionKey('building', 'done')).toBe('building->done');
  });
});

describe('canonical transitions', () => {
  it('lists the three forward-adjacent pipeline stages in order', () => {
    expect(CANONICAL_TRANSITIONS.map((t) => transitionKey(t.from, t.to))).toEqual([
      'wishlist->planning',
      'planning->building',
      'building->done',
    ]);
  });

  it('carries a human label for each transition', () => {
    expect(CANONICAL_TRANSITIONS.every((t) => t.label.length > 0)).toBe(true);
  });
});

describe('skillForTransition', () => {
  it('returns undefined for an empty config', () => {
    expect(skillForTransition(emptyPipelineConfig(), 'wishlist', 'planning')).toBeUndefined();
  });

  it('returns the configured skill for a matching transition', () => {
    const cfg: PipelineConfig = {
      version: 1,
      transitions: { 'planning->building': 'writing-plans' },
      wip: {},
    };
    expect(skillForTransition(cfg, 'planning', 'building')).toBe('writing-plans');
    expect(skillForTransition(cfg, 'wishlist', 'planning')).toBeUndefined();
  });
});

describe('setTransitionSkill', () => {
  it('sets a skill for a transition (immutably)', () => {
    const before = emptyPipelineConfig();
    const after = setTransitionSkill(before, 'wishlist', 'planning', 'feature-spec');
    expect(before.transitions).toEqual({});
    expect(after.transitions).toEqual({ 'wishlist->planning': 'feature-spec' });
  });

  it('trims surrounding whitespace from the skill name', () => {
    const cfg = setTransitionSkill(
      emptyPipelineConfig(),
      'wishlist',
      'planning',
      '  feature-spec  ',
    );
    expect(skillForTransition(cfg, 'wishlist', 'planning')).toBe('feature-spec');
  });

  it('removes the mapping when the skill is empty / whitespace only', () => {
    let cfg = setTransitionSkill(emptyPipelineConfig(), 'wishlist', 'planning', 'feature-spec');
    cfg = setTransitionSkill(cfg, 'wishlist', 'planning', '   ');
    expect(skillForTransition(cfg, 'wishlist', 'planning')).toBeUndefined();
    expect(cfg.transitions).toEqual({});
  });
});

describe('pipeline config round-trip', () => {
  it('serializes + restores a config', () => {
    const cfg = setTransitionSkill(emptyPipelineConfig(), 'planning', 'building', 'writing-plans');
    expect(restorePipeline(serializePipeline(cfg))).toEqual(cfg);
  });

  it('restores an empty config from undefined / garbage / non-object', () => {
    expect(restorePipeline(undefined)).toEqual(emptyPipelineConfig());
    expect(restorePipeline('{ not json')).toEqual(emptyPipelineConfig());
    expect(restorePipeline('[]')).toEqual(emptyPipelineConfig());
    expect(restorePipeline('null')).toEqual(emptyPipelineConfig());
  });

  it('drops non-string transition values rather than throwing', () => {
    const blob = JSON.stringify({
      version: 1,
      transitions: { 'wishlist->planning': 'feature-spec', 'planning->building': 42 },
    });
    expect(restorePipeline(blob)).toEqual({
      version: 1,
      transitions: { 'wishlist->planning': 'feature-spec' },
      wip: {},
    });
  });

  it('trims values on restore and drops empties', () => {
    const blob = JSON.stringify({
      version: 1,
      transitions: { 'wishlist->planning': '  feature-spec ', 'planning->building': '   ' },
    });
    expect(restorePipeline(blob)).toEqual({
      version: 1,
      transitions: { 'wishlist->planning': 'feature-spec' },
      wip: {},
    });
  });
});

describe('WIP limits', () => {
  it('has none by default, and reports undefined rather than a zero', () => {
    expect(wipLimitFor(emptyPipelineConfig(), 'planning')).toBeUndefined();
  });

  it('sets and clears a stage limit immutably', () => {
    const before = emptyPipelineConfig();
    const after = setWipLimit(before, 'planning', 3);
    expect(before.wip).toEqual({});
    expect(wipLimitFor(after, 'planning')).toBe(3);
    expect(wipLimitFor(setWipLimit(after, 'planning', null), 'planning')).toBeUndefined();
  });

  it('refuses a limit no column could show (zero, negative, fractional, NaN)', () => {
    for (const bad of [0, -2, 2.5, Number.NaN]) {
      expect(
        wipLimitFor(setWipLimit(emptyPipelineConfig(), 'building', bad), 'building'),
      ).toBeUndefined();
    }
  });

  it('round-trips through serialize/restore', () => {
    const cfg = setWipLimit(setWipLimit(emptyPipelineConfig(), 'planning', 3), 'building', 2);
    expect(restorePipeline(serializePipeline(cfg))).toEqual(cfg);
  });

  it('drops garbage limits on restore instead of showing 2/undefined', () => {
    const blob = JSON.stringify({
      version: 1,
      transitions: {},
      wip: { planning: 3, building: 'two', done: 0, frobnicate: 5, wishlist: null },
    });
    expect(restorePipeline(blob).wip).toEqual({ planning: 3 });
  });

  it('reconciles a legacy stage spelling in a hand-written file', () => {
    const blob = JSON.stringify({ version: 1, transitions: {}, wip: { 'in-progress': 2 } });
    expect(restorePipeline(blob).wip).toEqual({ building: 2 });
  });

  it('restores an empty map when the file has no wip key at all', () => {
    expect(restorePipeline(JSON.stringify({ version: 1, transitions: {} })).wip).toEqual({});
  });
});

describe('queue entries', () => {
  it('builds a queue entry from a card + transition + skill', () => {
    const entry = buildQueueEntry(card(), 'wishlist', 'planning', 'feature-spec', 1000, 'q1');
    expect(entry).toEqual({
      id: 'q1',
      cardId: 'card-1',
      cardTitle: 'Project-wide go-to-definition',
      from: 'wishlist',
      to: 'planning',
      transition: 'wishlist->planning',
      skill: 'feature-spec',
      at: 1000,
    });
  });

  it('appends immutably', () => {
    const q = emptyPipelineQueue();
    const e = buildQueueEntry(card(), 'wishlist', 'planning', 'feature-spec', 1, 'q1');
    const next = appendQueueEntry(q, e);
    expect(q.entries).toEqual([]);
    expect(next.entries).toEqual([e]);
  });

  it('round-trips a queue', () => {
    const q = appendQueueEntry(
      emptyPipelineQueue(),
      buildQueueEntry(card(), 'planning', 'building', 'writing-plans', 5, 'q1'),
    );
    expect(restorePipelineQueue(serializePipelineQueue(q))).toEqual(q);
  });

  it('restores an empty queue from garbage', () => {
    expect(restorePipelineQueue(undefined)).toEqual(emptyPipelineQueue());
    expect(restorePipelineQueue('{ not json')).toEqual(emptyPipelineQueue());
    expect(restorePipelineQueue('{}')).toEqual(emptyPipelineQueue());
  });

  it('drops malformed queue entries on restore', () => {
    const blob = JSON.stringify({
      version: 1,
      entries: [
        {
          id: 'q1',
          cardId: 'c',
          cardTitle: 't',
          from: 'wishlist',
          to: 'planning',
          transition: 'wishlist->planning',
          skill: 's',
          at: 1,
        },
        { id: 'q2' }, // missing fields
        'nope',
      ],
    });
    const q = restorePipelineQueue(blob);
    expect(q.entries.map((e) => e.id)).toEqual(['q1']);
  });
});
