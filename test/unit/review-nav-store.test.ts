import { beforeEach, describe, expect, it } from 'vitest';
import {
  getReviewNav,
  publishReviewNav,
  type ReviewNavGroup,
  type ReviewNavModel,
  subscribeReviewNav,
} from '../../webview/review-nav-store';
import type { ReviewFile } from '../../webview/review-repos';

const model = (over: Partial<ReviewNavModel> = {}): ReviewNavModel => ({
  source: undefined,
  files: [],
  groups: null,
  repoRoot: '/r/a',
  repoCount: 1,
  totalCount: 0,
  activeKey: null,
  reviewed: new Set<string>(),
  canMark: () => true,
  filter: '',
  onPick: () => undefined,
  onToggleReviewed: () => undefined,
  onFilter: () => undefined,
  ...over,
});

const file = (repoRoot: string, path: string): ReviewFile => ({
  path,
  added: 1,
  removed: 0,
  kind: 'M',
  staged: false,
  repoRoot,
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

  it('publish/subscribe round-trips groups and repoRoot', () => {
    const a = file('/r/a', 'src/x.ts');
    const b = file('/r/b', 'src/x.ts');
    const groups: ReviewNavGroup[] = [
      { root: '/r/a', name: 'a', files: [a], reviewed: 1 },
      { root: '/r/b', name: 'b', sub: 'a/b', files: [b], reviewed: 0 },
    ];
    let seen: ReviewNavModel | null = null;
    const unsubscribe = subscribeReviewNav(() => {
      seen = getReviewNav();
    });
    const m = model({
      files: [a, b],
      groups,
      repoRoot: null,
      repoCount: 2,
      totalCount: 2,
      activeKey: '/r/b/src/x.ts',
      reviewed: new Set(['/r/a/src/x.ts']),
    });
    publishReviewNav(m);
    expect(seen).toBe(m);
    const got = getReviewNav();
    expect(got?.repoRoot).toBeNull();
    expect(got?.groups).toBe(groups);
    expect(got?.groups?.map((g) => [g.root, g.sub, g.reviewed])).toEqual([
      ['/r/a', undefined, 1],
      ['/r/b', 'a/b', 0],
    ]);
    expect(got?.repoCount).toBe(2);
    expect(got?.activeKey).toBe('/r/b/src/x.ts');
    unsubscribe();
  });
});
