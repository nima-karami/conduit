import { describe, expect, it } from 'vitest';
import {
  isPlanDocPath,
  PLAN_SLUG_RE,
  PLANS_DIR,
  planRootFromPath,
  planSlugFromPath,
} from '../../src/plan-path';

describe('isPlanDocPath', () => {
  it('accepts posix and win32 plan paths', () => {
    expect(isPlanDocPath('G:\\p\\.conduit\\plans\\a-b.md')).toBe(true);
    expect(isPlanDocPath('/home/u/p/.conduit/plans/a-b.md')).toBe(true);
    expect(isPlanDocPath('G:/p/.Conduit/Plans/a-b.md')).toBe(true);
  });

  it('rejects .conduit/plan.json and nested dirs', () => {
    expect(isPlanDocPath('/p/.conduit/plan.json')).toBe(false);
    expect(isPlanDocPath('/p/.conduit/plans/x/y.md')).toBe(false);
    expect(isPlanDocPath('/p/.conduit/plans/a.txt')).toBe(false);
    expect(isPlanDocPath('/p/.conduit/plans/a.MD')).toBe(false);
    expect(isPlanDocPath('/p/docs/plans/a.md')).toBe(false);
    expect(isPlanDocPath('/p/.conduit/plans')).toBe(false);
  });

  it('is the predicate for PLANS_DIR joined under a root', () => {
    expect(isPlanDocPath(`/p/${PLANS_DIR}/a.md`)).toBe(true);
    expect(PLAN_SLUG_RE.test('a-b_1')).toBe(true);
    expect(PLAN_SLUG_RE.test('a b')).toBe(false);
  });
});

describe('planSlugFromPath', () => {
  it('slug of a bad name is null', () => {
    expect(planSlugFromPath('/p/.conduit/plans/bad slug.md')).toBeNull();
    expect(planSlugFromPath('/p/.conduit/plans/-leading.md')).toBeNull();
    expect(planSlugFromPath(`/p/.conduit/plans/${'a'.repeat(65)}.md`)).toBeNull();
    expect(planSlugFromPath('/p/notes/a.md')).toBeNull();
    expect(planSlugFromPath('/p/.conduit/plans/a-b.md')).toBe('a-b');
    expect(planSlugFromPath('G:\\p\\.conduit\\plans\\Plan_1.md')).toBe('Plan_1');
  });
});

describe('planRootFromPath', () => {
  it('root keeps the original separators', () => {
    expect(planRootFromPath('G:\\p\\q\\.conduit\\plans\\a.md')).toBe('G:\\p\\q');
    expect(planRootFromPath('/home/u/p/.conduit/plans/a.md')).toBe('/home/u/p');
    expect(planRootFromPath('/p/.conduit/plan.json')).toBeNull();
  });
});
