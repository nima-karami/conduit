import { describe, expect, it } from 'vitest';
import {
  changeRowTooltip,
  diffScopeForChange,
  diffTabKey,
  diffTabTitle,
} from '../../webview/diff-tab-scope';
import { diffKey } from '../../webview/review-scope';

describe('diff-tab-scope routing', () => {
  it('routes a staged row to staged, an unstaged or untracked row to unstaged, a conflicted row to unscoped', () => {
    expect(diffScopeForChange({ staged: true })).toBe('staged');
    expect(diffScopeForChange({ staged: false })).toBe('unstaged');
    expect(diffScopeForChange({ staged: false, conflicted: false })).toBe('unstaged');
    expect(diffScopeForChange({ staged: true, conflicted: true })).toBeUndefined();
    expect(diffScopeForChange({ staged: false, conflicted: true })).toBeUndefined();
  });

  it('tooltips name the side', () => {
    expect(changeRowTooltip({ staged: true })).toBe('Open staged diff');
    expect(changeRowTooltip({ staged: false })).toBe('Open unstaged diff');
    expect(changeRowTooltip({ staged: true, conflicted: true })).toBe('Open diff');
  });

  it('title suffixes', () => {
    expect(diffTabTitle('both.ts', 'staged')).toBe('both.ts (Index)');
    expect(diffTabTitle('both.ts', 'unstaged')).toBe('both.ts (Working Tree)');
  });

  it('unscoped key is the bare path', () => {
    expect(diffTabKey({ path: '/r/a.ts' })).toBe('/r/a.ts');
    expect(diffTabKey({ path: '/r/a.ts', diffScope: 'staged' })).toBe(diffKey('/r/a.ts', 'staged'));
    expect(diffTabKey({ path: '/r/a.ts', diffScope: 'unstaged' })).toBe(
      diffKey('/r/a.ts', 'unstaged'),
    );
  });
});
