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
  skillForTransition,
  transitionKey,
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
    });
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
