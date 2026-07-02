import { describe, expect, it } from 'vitest';
import {
  CLOSED_TAB_LIMIT,
  type ClosedTab,
  isReopenable,
  popClosedTab,
  pushClosedTab,
  toClosedTab,
} from '../../webview/closed-tabs';

const tab = (path: string): ClosedTab => ({ kind: 'file', path, sessionId: 's1' });

describe('closed-tabs stack', () => {
  it('classifies reopenable kinds', () => {
    expect(isReopenable({ kind: 'file' })).toBe(true);
    expect(isReopenable({ kind: 'diff' })).toBe(true);
    expect(isReopenable({ kind: 'web' })).toBe(true);
    expect(isReopenable({ kind: 'review' })).toBe(false);
    expect(isReopenable({ kind: 'git-history' })).toBe(false);
    expect(isReopenable({ kind: 'commit-diff' })).toBe(false);
  });

  it('maps a doc to a descriptor only when reopenable', () => {
    expect(toClosedTab({ kind: 'file', path: '/a.ts', sessionId: 's1' })).toEqual({
      kind: 'file',
      path: '/a.ts',
      sessionId: 's1',
    });
    expect(toClosedTab({ kind: 'git-history', path: '@git-history', sessionId: 's1' })).toBeNull();
  });

  it('pops in LIFO order and shrinks the stack', () => {
    let stack: ClosedTab[] = [];
    stack = pushClosedTab(stack, tab('/a.ts'));
    stack = pushClosedTab(stack, tab('/b.ts'));
    const { tab: top, rest } = popClosedTab(stack);
    expect(top?.path).toBe('/b.ts');
    expect(rest).toHaveLength(1);
    expect(popClosedTab(rest).tab?.path).toBe('/a.ts');
  });

  it('returns null when empty', () => {
    const { tab: top, rest } = popClosedTab([]);
    expect(top).toBeNull();
    expect(rest).toHaveLength(0);
  });

  it('caps the stack, evicting the oldest', () => {
    let stack: ClosedTab[] = [];
    for (let i = 0; i < CLOSED_TAB_LIMIT + 5; i++) stack = pushClosedTab(stack, tab(`/f${i}.ts`));
    expect(stack).toHaveLength(CLOSED_TAB_LIMIT);
    // Oldest survivor is the (5th) entry; the last-pushed is on top.
    expect(stack[0].path).toBe('/f5.ts');
    expect(popClosedTab(stack).tab?.path).toBe(`/f${CLOSED_TAB_LIMIT + 4}.ts`);
  });
});
