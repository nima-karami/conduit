import { describe, expect, it } from 'vitest';
import {
  shouldReplaceContent,
  shouldRequestRead,
  shouldUpdateAfterSave,
} from '../../webview/file-freshness';

describe('shouldRequestRead', () => {
  it('returns true when no cached copy exists', () => {
    expect(shouldRequestRead('/foo.md', false)).toBe(true);
  });

  it('returns true even when a cached copy exists (always re-read)', () => {
    expect(shouldRequestRead('/foo.md', true)).toBe(true);
  });

  it('returns true for any path', () => {
    expect(shouldRequestRead('/deeply/nested/path/file.ts', true)).toBe(true);
    expect(shouldRequestRead('/deeply/nested/path/file.ts', false)).toBe(true);
  });
});

describe('shouldReplaceContent', () => {
  it('returns true when the file is clean (not dirty)', () => {
    expect(shouldReplaceContent('/foo.md', false)).toBe(true);
  });

  it('returns true even when the file is dirty (dirty-buffer rule: map is always updated)', () => {
    // The files map is updated regardless; CodeViewer is responsible for
    // not re-seeding the Monaco model when the effect deps change.
    expect(shouldReplaceContent('/foo.md', true)).toBe(true);
  });

  it('returns true for any path and any dirty state', () => {
    const paths = ['/a.ts', '/b/c.md', '/README.md'];
    for (const p of paths) {
      expect(shouldReplaceContent(p, false)).toBe(true);
      expect(shouldReplaceContent(p, true)).toBe(true);
    }
  });
});

describe('shouldUpdateAfterSave', () => {
  it('returns true: saved content is authoritative, update map immediately', () => {
    expect(shouldUpdateAfterSave('/foo.md')).toBe(true);
  });

  it('returns true for any path', () => {
    expect(shouldUpdateAfterSave('/any/path/file.ts')).toBe(true);
  });
});
