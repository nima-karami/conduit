import { describe, expect, it } from 'vitest';
import type { PipelineQueueEntry } from '../../src/pipeline';
import {
  QUEUE_SUMMARY_LIMIT,
  type QueueSummaryEntry,
  summarizeQueue,
} from '../../src/queue-summary';

const entry = (over: Partial<PipelineQueueEntry> = {}): PipelineQueueEntry => ({
  id: 'q-1',
  cardId: 'card-1',
  cardTitle: 'My feature',
  from: 'wishlist',
  to: 'planning',
  transition: 'wishlist->planning',
  skill: 'feature-spec',
  at: 1_000_000,
  ...over,
});

describe('summarizeQueue', () => {
  it('returns depth 0 and empty recent for an empty queue', () => {
    const s = summarizeQueue([]);
    expect(s.depth).toBe(0);
    expect(s.recent).toEqual([]);
  });

  it('returns the correct depth for a non-empty queue', () => {
    const entries = [entry({ id: 'q-1' }), entry({ id: 'q-2' }), entry({ id: 'q-3' })];
    expect(summarizeQueue(entries).depth).toBe(3);
  });

  it('sorts entries newest-first by `at`', () => {
    const entries = [
      entry({ id: 'q-old', at: 1_000 }),
      entry({ id: 'q-new', at: 9_000 }),
      entry({ id: 'q-mid', at: 5_000 }),
    ];
    const { recent } = summarizeQueue(entries);
    expect(recent.map((e) => e.id)).toEqual(['q-new', 'q-mid', 'q-old']);
  });

  it('caps the recent list to the default limit', () => {
    const entries = Array.from({ length: QUEUE_SUMMARY_LIMIT + 3 }, (_, i) =>
      entry({ id: `q-${i}`, at: i }),
    );
    const { recent } = summarizeQueue(entries);
    expect(recent.length).toBe(QUEUE_SUMMARY_LIMIT);
  });

  it('respects a custom limit', () => {
    const entries = [entry({ id: 'a' }), entry({ id: 'b' }), entry({ id: 'c' })];
    expect(summarizeQueue(entries, 2).recent.length).toBe(2);
    expect(summarizeQueue(entries, 10).recent.length).toBe(3);
  });

  it('maps all required fields onto QueueSummaryEntry', () => {
    const e = entry({
      id: 'q-x',
      cardTitle: 'Title',
      from: 'planning',
      to: 'building',
      skill: 'writing-plans',
      at: 42_000,
    });
    const { recent } = summarizeQueue([e]);
    const r: QueueSummaryEntry = recent[0];
    expect(r.id).toBe('q-x');
    expect(r.cardTitle).toBe('Title');
    expect(r.from).toBe('planning');
    expect(r.to).toBe('building');
    expect(r.skill).toBe('writing-plans');
    expect(r.at).toBe(42_000);
  });

  it('does not mutate the original entries array', () => {
    const entries = [entry({ id: 'q-2', at: 2_000 }), entry({ id: 'q-1', at: 1_000 })];
    const before = entries.map((e) => e.id);
    summarizeQueue(entries);
    expect(entries.map((e) => e.id)).toEqual(before);
  });

  it('depth reflects the full count even when recent is capped', () => {
    const n = QUEUE_SUMMARY_LIMIT + 5;
    const entries = Array.from({ length: n }, (_, i) => entry({ id: `q-${i}`, at: i }));
    const s = summarizeQueue(entries);
    expect(s.depth).toBe(n);
    expect(s.recent.length).toBe(QUEUE_SUMMARY_LIMIT);
  });

  it('handles a limit of 0', () => {
    const entries = [entry()];
    const s = summarizeQueue(entries, 0);
    expect(s.depth).toBe(1);
    expect(s.recent).toEqual([]);
  });
});
