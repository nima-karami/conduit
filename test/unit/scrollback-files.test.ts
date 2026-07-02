import { describe, expect, it } from 'vitest';
import { orphanScrollbackFiles, scrollbackFileName } from '../../src/scrollback-files';

describe('scrollbackFileName', () => {
  it('builds the per-session filename', () => {
    expect(scrollbackFileName('abc')).toBe('scrollback-abc.json');
  });

  it('sanitizes path separators and stray characters', () => {
    expect(scrollbackFileName('a/b\\c d')).toBe('scrollback-a_b_c_d.json');
  });
});

describe('orphanScrollbackFiles', () => {
  it('returns files whose session is not live', () => {
    const files = ['scrollback-a.json', 'scrollback-b.json', 'scrollback-c.json'];
    expect(orphanScrollbackFiles(files, ['a', 'c'])).toEqual(['scrollback-b.json']);
  });

  it('returns all scrollback files when nothing is live (restore off)', () => {
    const files = ['scrollback-a.json', 'scrollback-b.json'];
    expect(orphanScrollbackFiles(files, [])).toEqual(['scrollback-a.json', 'scrollback-b.json']);
  });

  it('ignores non-scrollback files', () => {
    const files = ['sessions.json', 'settings.json', 'scrollback-a.json'];
    expect(orphanScrollbackFiles(files, [])).toEqual(['scrollback-a.json']);
  });

  it('keeps files for every live session', () => {
    const files = ['scrollback-a.json', 'scrollback-b.json'];
    expect(orphanScrollbackFiles(files, ['a', 'b'])).toEqual([]);
  });

  it('matches live ids through the same sanitize as the writer', () => {
    const files = [scrollbackFileName('a/b'), 'scrollback-other.json'];
    expect(orphanScrollbackFiles(files, ['a/b'])).toEqual(['scrollback-other.json']);
  });

  it('returns an empty list for no files', () => {
    expect(orphanScrollbackFiles([], ['a'])).toEqual([]);
  });
});
