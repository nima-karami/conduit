import { describe, expect, it } from 'vitest';
import {
  dirtyCloseMessage,
  dirtyCloseTitle,
  dirtyDocIds,
  needsDirtyPrompt,
} from '../../webview/close-dirty';

describe('needsDirtyPrompt', () => {
  it('returns true when the doc is dirty', () => {
    expect(needsDirtyPrompt(true)).toBe(true);
  });

  it('returns false when the doc is clean', () => {
    expect(needsDirtyPrompt(false)).toBe(false);
  });
});

describe('dirtyDocIds', () => {
  it('returns only the ids that are dirty', () => {
    const isDirty = (id: string) => id === 'a' || id === 'c';
    expect(dirtyDocIds(['a', 'b', 'c'], isDirty)).toEqual(['a', 'c']);
  });

  it('returns an empty array when no docs are dirty', () => {
    expect(dirtyDocIds(['a', 'b'], () => false)).toEqual([]);
  });

  it('returns all ids when all are dirty', () => {
    expect(dirtyDocIds(['x', 'y'], () => true)).toEqual(['x', 'y']);
  });

  it('returns empty array for empty input', () => {
    expect(dirtyDocIds([], () => true)).toEqual([]);
  });
});

describe('dirtyCloseTitle', () => {
  it('includes the file name', () => {
    expect(dirtyCloseTitle('foo.ts')).toBe('Unsaved changes in foo.ts');
  });

  it('works with files that have path separators stripped', () => {
    expect(dirtyCloseTitle('bar.tsx')).toBe('Unsaved changes in bar.tsx');
  });
});

describe('dirtyCloseMessage', () => {
  it('includes the file name in quotes', () => {
    const msg = dirtyCloseMessage('foo.ts');
    expect(msg).toContain('"foo.ts"');
  });

  it('mentions save and discard options', () => {
    const msg = dirtyCloseMessage('foo.ts');
    expect(msg.toLowerCase()).toContain('save');
    expect(msg.toLowerCase()).toContain('discard');
  });
});
