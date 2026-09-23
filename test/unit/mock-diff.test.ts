import { describe, expect, it } from 'vitest';
import { mockDiffFor, mockDiffs } from '../../webview/mock';

const STAGED = { base: 'head', side: 'index' } as const;
const UNSTAGED = { base: 'index', side: 'worktree' } as const;

describe('mockDiffFor', () => {
  it('unscoped output is byte-identical to the corpus', () => {
    for (const k of Object.keys(mockDiffs))
      expect(mockDiffFor(`/p/${k}`, {})).toEqual(mockDiffs[k]);
    expect(mockDiffFor('/p/unknown.ts', {})).toEqual({
      head: 'const a = 1;\n',
      work: 'const a = 2;\n',
    });
  });

  it('page.tsx differs per scope and the index is consistent', () => {
    const all = mockDiffFor('/p/app/page.tsx', {});
    const staged = mockDiffFor('/p/app/page.tsx', STAGED);
    const unstaged = mockDiffFor('/p/app/page.tsx', UNSTAGED);
    const ser = (d: { head: string; work: string }) => JSON.stringify(d);
    expect(new Set([ser(all), ser(staged), ser(unstaged)]).size).toBe(3);
    expect(staged.work).toBe(unstaged.head);
    expect(staged.head).toBe(all.head);
    expect(unstaged.work).toBe(all.work);
  });

  it('a file with no index entry has no staged side', () => {
    const d = mockDiffFor('/p/layout.tsx', STAGED);
    expect(d.head).toBe(d.work);
    expect(mockDiffFor('/p/layout.tsx', UNSTAGED)).toEqual(mockDiffs['layout.tsx']);
  });
});
