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
  it('returns true when the file is clean (not dirty) — picks up fresh disk content', () => {
    expect(shouldReplaceContent('/foo.md', false)).toBe(true);
  });

  it('returns false when the file is dirty — protects the unsaved Monaco buffer', () => {
    // The map entry is NOT replaced for a dirty path, so `doc.content` is
    // unchanged and CodeViewer's content-keyed seed effect never re-runs to
    // clobber the user's unsaved edits.
    expect(shouldReplaceContent('/foo.md', true)).toBe(false);
  });

  it('mirrors the dirty flag for any path: clean -> replace, dirty -> keep', () => {
    const paths = ['/a.ts', '/b/c.md', '/README.md'];
    for (const p of paths) {
      expect(shouldReplaceContent(p, false)).toBe(true);
      expect(shouldReplaceContent(p, true)).toBe(false);
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
