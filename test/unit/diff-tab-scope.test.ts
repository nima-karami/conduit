import { describe, expect, it } from 'vitest';
import type { FileDiffDTO } from '../../src/protocol';
import {
  changeRowTooltip,
  diffScopeForChange,
  diffTabKey,
  diffTabState,
  diffTabTitle,
  emptySideNotice,
} from '../../webview/diff-tab-scope';
import { diffKey } from '../../webview/review-scope';

const dto = (d: Partial<FileDiffDTO> = {}): FileDiffDTO => ({
  path: '/r/a.ts',
  head: 'a\n',
  work: 'b\n',
  binary: false,
  ...d,
});

describe('diffTabState', () => {
  it('state precedence', () => {
    const cases: [FileDiffDTO | undefined, 'staged' | 'unstaged' | undefined, string][] = [
      [undefined, 'staged', 'loading'],
      [undefined, undefined, 'loading'],
      [dto({ error: 'boom', unmerged: true, head: '', work: '' }), 'staged', 'error'],
      [dto({ error: 'boom' }), undefined, 'error'],
      [dto({ unmerged: true, head: '', work: '' }), 'staged', 'conflicted'],
      [dto({ unmerged: true, head: '', work: '' }), 'unstaged', 'conflicted'],
      [dto({ unmerged: true }), undefined, 'populated'],
      [dto({ oversize: { bytes: 3e6 }, head: '', work: '' }), 'staged', 'oversize'],
      [
        dto({ image: { status: 'added', work: { dataUrl: 'x', bytes: 1 } }, head: '', work: '' }),
        'staged',
        'image',
      ],
      [dto({ binary: true, head: '', work: '' }), 'staged', 'binary'],
      [dto({ head: 'same\n', work: 'same\n' }), 'staged', 'empty'],
      [dto({ head: 'same\n', work: 'same\n' }), 'unstaged', 'empty'],
      [dto({ head: 'same\n', work: 'same\n' }), undefined, 'populated'],
      [dto(), 'staged', 'populated'],
      [dto(), undefined, 'populated'],
    ];
    for (const [diff, scope, want] of cases)
      expect([JSON.stringify(diff), scope, diffTabState(diff, scope)]).toEqual([
        JSON.stringify(diff),
        scope,
        want,
      ]);
  });

  it('a scoped tab that becomes unmerged', () => {
    const before = dto();
    expect(diffTabState(before, 'unstaged')).toBe('populated');
    expect(diffTabState({ ...before, head: '', work: '', unmerged: true }, 'unstaged')).toBe(
      'conflicted',
    );
  });

  it('empty-side copy is one template per scope', () => {
    expect(emptySideNotice('staged', 'both.ts')).toBe('No staged changes in both.ts.');
    expect(emptySideNotice('unstaged', 'both.ts')).toBe('No unstaged changes in both.ts.');
  });
});

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
