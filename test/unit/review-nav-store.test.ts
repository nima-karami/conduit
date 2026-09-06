import { beforeEach, describe, expect, it } from 'vitest';
import {
  getReviewNav,
  publishReviewNav,
  type ReviewNavModel,
  subscribeReviewNav,
} from '../../webview/review-nav-store';

const model = (over: Partial<ReviewNavModel> = {}): ReviewNavModel => ({
  source: undefined,
  files: [],
  totalCount: 0,
  activePath: null,
  reviewed: new Set<string>(),
  canMark: () => true,
  filter: '',
  onPick: () => undefined,
  onToggleReviewed: () => undefined,
  onFilter: () => undefined,
  ...over,
});

beforeEach(() => {
  publishReviewNav(null);
});

describe('review nav store', () => {
  it('notifies subscribers on publish and hands the model back', () => {
    let calls = 0;
    subscribeReviewNav(() => {
      calls += 1;
    });
    const m = model({ filter: 'src/' });
    publishReviewNav(m);
    expect(calls).toBe(1);
    expect(getReviewNav()).toBe(m);
  });

  it('clears back to null', () => {
    const unsubscribe = subscribeReviewNav(() => undefined);
    publishReviewNav(model());
    publishReviewNav(null);
    expect(getReviewNav()).toBeNull();
    unsubscribe();
  });

  it('stops notifying once unsubscribed', () => {
    let calls = 0;
    const unsubscribe = subscribeReviewNav(() => {
      calls += 1;
    });
    publishReviewNav(model());
    unsubscribe();
    publishReviewNav(model());
    expect(calls).toBe(1);
  });

  it('does not notify when the same reference is published again', () => {
    let calls = 0;
    const unsubscribe = subscribeReviewNav(() => {
      calls += 1;
    });
    const m = model();
    publishReviewNav(m);
    publishReviewNav(m);
    expect(calls).toBe(1);
    expect(getReviewNav()).toBe(m);
    unsubscribe();
  });
});
